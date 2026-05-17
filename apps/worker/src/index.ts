import { Database } from 'bun:sqlite';
import { AgentRuntime } from '@ara/agent-core';
import { ModelRouter, GeminiProvider, OpenAIProvider, AnthropicProvider, OllamaProvider } from '@ara/model-router';
import { 
  ToolRegistry, 
  ListFilesTool, 
  ReadFileTool, 
  WriteFileTool, 
  RunShellTool, 
  GitStatusTool, 
  GitDiffTool 
} from '@ara/tools';
import { LocalMarkdownMemoryStore } from '@ara/memory';
import { LocalMarkdownSkillLoader } from '@ara/skills';

console.log('🤖 Ara Automation Worker is booting up...');

// 1. Open persistent SQLite database
const db = new Database('ara.sqlite');

// Ensure tables exist in case worker starts first
db.run(`
  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    last_run TEXT,
    created_at TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(automation_id) REFERENCES automations(id)
  )
`);

// 2. Initialize Agent Runtime for headless automation runs
const router = new ModelRouter();
router.register('Gemini', new GeminiProvider());
router.register('OpenAI', new OpenAIProvider());
router.register('Anthropic', new AnthropicProvider());
router.register('Ollama', new OllamaProvider());

const toolsRegistry = new ToolRegistry();
toolsRegistry.register(new ListFilesTool());
toolsRegistry.register(new ReadFileTool());
toolsRegistry.register(new WriteFileTool());
toolsRegistry.register(new RunShellTool());
toolsRegistry.register(new GitStatusTool());
toolsRegistry.register(new GitDiffTool());

const runtime = new AgentRuntime(
  router,
  toolsRegistry,
  new LocalMarkdownMemoryStore(),
  new LocalMarkdownSkillLoader()
);

// 3. Cron Matcher Logic (Pure Zero-Dependency standard cron evaluator)
function shouldRunCron(cronExpr: string, date: Date): boolean {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const currentMin = date.getMinutes();
  const currentHour = date.getHours();
  const currentDay = date.getDate();
  const currentMonth = date.getMonth() + 1; // getMonth is 0-indexed
  const currentDayOfWeek = date.getDay(); // 0 is Sunday, 6 is Saturday

  const matchPart = (part: string, currentVal: number): boolean => {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const step = parseInt(part.substring(2), 10);
      return !isNaN(step) && currentVal % step === 0;
    }
    if (part.includes(',')) {
      const vals = part.split(',').map(v => parseInt(v.trim(), 10));
      return vals.includes(currentVal);
    }
    const val = parseInt(part, 10);
    return !isNaN(val) && currentVal === val;
  };

  return (
    matchPart(parts[0], currentMin) &&
    matchPart(parts[1], currentHour) &&
    matchPart(parts[2], currentDay) &&
    matchPart(parts[3], currentMonth) &&
    matchPart(parts[4], currentDayOfWeek)
  );
}

// 4. Headless Automation Runner Loop
async function runHeadlessAutomation(automation: { id: string; name: string; prompt: string }) {
  const runId = Math.random().toString(36).substring(7);
  console.log(`🚀 [Worker] Starting automation "${automation.name}" (ID: ${automation.id}, Run ID: ${runId})`);

  db.run(
    'INSERT INTO automation_runs (id, automation_id, status, output, created_at) VALUES (?, ?, ?, ?, ?)',
    [runId, automation.id, 'running', '', new Date().toISOString()]
  );
  db.run('UPDATE automations SET last_run = ? WHERE id = ?', [new Date().toISOString(), automation.id]);

  try {
    // Create background episodic session
    const sessionId = 'auto-' + Math.random().toString(36).substring(7);
    db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, `[Auto] ${automation.name}`, 'Gemini', new Date().toISOString(), new Date().toISOString()]
    );

    const session = {
      id: sessionId,
      title: `[Auto] ${automation.name}`,
      model: 'Gemini',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    let output = '';
    const iterator = runtime.streamAgentLoop(session, automation.prompt);

    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value && value.text) {
        output += value.text;
      }

      // If a tool requires manual approval, headless loop pauses safely
      if (value && value.text && value.text.includes('awaitingApproval')) {
        console.log(`⚠️ [Worker] Automation "${automation.name}" paused at approval gate for manual consent.`);
        output += '\n[Headless Run Paused: Tool requires manual user approval in the dashboard]';
        db.run(
          'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
          ['awaitingApproval', output, runId]
        );
        return;
      }
    }

    console.log(`✅ [Worker] Automation "${automation.name}" completed successfully.`);
    db.run(
      'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
      ['success', output || 'Execution finished with no output.', runId]
    );
  } catch (err: any) {
    console.error(`❌ [Worker] Automation "${automation.name}" failed`, err);
    db.run(
      'UPDATE automation_runs SET status = ?, output = ? WHERE id = ?',
      ['failed', `Error: ${err.message}`, runId]
    );
  }
}

// 5. Worker tick interval scheduler (Checks every 60 seconds)
let isChecking = false;

async function checkAutomations() {
  if (isChecking) return;
  isChecking = true;

  const now = new Date();
  try {
    const activeAutomations = db.query('SELECT * FROM automations WHERE enabled = 1').all() as any[];
    for (const auto of activeAutomations) {
      if (shouldRunCron(auto.cron, now)) {
        // Run asynchronously to allow concurrent automation tasks
        runHeadlessAutomation(auto);
      }
    }
  } catch (e) {
    console.error('Worker polling check failed', e);
  } finally {
    isChecking = false;
  }
}

// Poll every 60 seconds precisely aligning with clock minutes
console.log('⏰ Worker Cron Scheduler activated. Checking every minute...');
setInterval(() => {
  checkAutomations();
}, 60000);

// Run initial check on start
checkAutomations();
