import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { ApiClient } from '../api/client';
import type { ChatSession, ChatMessage, ApprovalRequest, AuditLog, Skill, Memory } from '../api/client';
import { getApiBaseUrl } from '../config/manager';
import { createDefaultRegistry } from '@ara/commands';

const commandRegistry = createDefaultRegistry();

// ─── Tab definitions ────────────────────────────────────────────────
const TABS = ['Chat', 'Approvals', 'MCP', 'GitHub', 'Codex', 'Subagents', 'Locks', 'Canvas', 'Checkpoints', 'Skills', 'Learning', 'Memory', 'Audit', 'Status'] as const;
type Tab = typeof TABS[number];

// ─── Tool call display component ────────────────────────────────────
function ToolCallBlock({ name, input, output, error }: { name: string; input?: string; output?: string; error?: string }) {
  return (
    <Box flexDirection="column" marginLeft={4} marginY={1}>
      <Text color="cyan">┌─ <Text bold>Tool: {name}</Text></Text>
      {input && <Text color="gray">│ {input.slice(0, 200)}</Text>}
      {output && <Text color="green">│ {output.slice(0, 200)}</Text>}
      {error && <Text color="red">│ Error: {error}</Text>}
      <Text color="cyan">└──</Text>
    </Box>
  );
}

export function TuiApp() {
  const { exit } = useApp();
  const client = new ApiClient();

  // ─── State ──────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('Chat');
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [width, setWidth] = useState(process.stdout.columns || 100);
  const inputRef = useRef<string>('');

  // Tool call tracking during streaming
  const [toolCalls, setToolCalls] = useState<Map<string, { name: string; input?: string; output?: string; error?: string }>>(new Map());

  // Other tab states
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpHealth, setMcpHealth] = useState<any[]>([]);
  const [ghStatus, setGhStatus] = useState<any>(null);
  const [ghIssues, setGhIssues] = useState<any[]>([]);
  const [ghPrs, setGhPrs] = useState<any[]>([]);
  const [subagents, setSubagents] = useState<any[]>([]);
  const [subagentRuns, setSubagentRuns] = useState<any[]>([]);
  const [lockList, setLockList] = useState<any[]>([]);
  const [lockAudit, setLockAudit] = useState<any[]>([]);
  const [parallelRuns, setParallelRuns] = useState<any[]>([]);
  const [canvasWorkspaces, setCanvasWorkspaces] = useState<any[]>([]);
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [learningData, setLearningData] = useState<any>(null);
  const [learningDrafts, setLearningDrafts] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [apiReachable, setApiReachable] = useState(true);
  const [version, setVersion] = useState('0.2.0');
  const [permissionMode, setPermissionMode] = useState('default');
  const [dbStatus, setDbStatus] = useState('unknown');
  const [sandboxMode, setSandboxMode] = useState(false);
  const [hasKeys, setHasKeys] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [codexSessions, setCodexSessions] = useState<any[]>([]);
  const [codexOutput, setCodexOutput] = useState('');
  const [selectedCodexId, setSelectedCodexId] = useState<string | null>(null);

  // ─── Terminal resize ────────────────────────────────────────────
  useEffect(() => {
    const handle = () => setWidth(process.stdout.columns || 100);
    process.stdout.on('resize', handle);
    return () => { process.stdout.off('resize', handle); };
  }, []);

  // ─── Data loading ───────────────────────────────────────────────
  const loadAll = async () => {
    try {
      const stat = await client.getStatus();
      setApiReachable(true);
      setVersion(stat.version);
      setDbStatus(stat.database);
      setSandboxMode(stat.sandboxMode);
      if (stat.activePermissionMode) setPermissionMode(stat.activePermissionMode);
      setPendingCount(stat.pendingApprovalsCount || 0);
      setHasKeys(true);

      const sess = await client.listSessions();
      setSessions(sess);
      if (!selectedSessionId && sess.length > 0) {
        setSelectedSessionId(sess[0].id);
        const full = await client.getSession(sess[0].id);
        setMessages(full.messages || []);
      }

      const apps = await client.listApprovals();
      setApprovals(apps.filter((a: any) => a.status === 'pending'));

      setSkills(await client.listSkills());
      setMemories(await client.listMemory());
      setAuditLogs(await client.listAuditLogs());

      try {
        const sl = await client.getSkillLearningOverview();
        setLearningData(sl);
        const dd = await client.listSkillDrafts();
        setLearningDrafts(dd.drafts || []);
      } catch {}
      try {
        setSubagents(await client.listSubagents());
        setSubagentRuns(await client.listSubagentRuns());
      } catch {}
      try {
        const chks = await client.listCheckpoints();
        setCheckpoints(chks);
      } catch {}
      try {
        const ov = await client.getMcpOverview();
        const sd = await client.listMcpServers();
        setMcpServers(sd.servers || []);
        const hd = await client.getMcpHealth();
        setMcpHealth(hd.results || []);
      } catch {}
      try {
        const sd = await client.getGitHubStatus();
        setGhStatus(sd);
      } catch {}
      try {
        const ws = await client.listCanvasWorkspaces();
        setCanvasWorkspaces(ws.workspaces || []);
      } catch {}
      try {
        const ld = await client.listLocks();
        setLockList(ld.locks || []);
        const ad = await client.getLockAudit(20);
        setLockAudit(ad.records || []);
        const pd = await client.listParallelRuns();
        setParallelRuns(pd.runs || []);
      } catch {}
      try {
        const cx = await client.listCodexSessions();
        setCodexSessions(cx);
      } catch {}
    } catch {
      setApiReachable(false);
    }
  };

  // Refresh codex output when Codex tab is active
  useEffect(() => {
    if (activeTab !== 'Codex' || !selectedCodexId) return;
    const t = setInterval(async () => {
      try {
        const r = await client.getCodexOutput(selectedCodexId);
        setCodexOutput(r.output || '');
      } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [activeTab, selectedCodexId]);

  useEffect(() => { loadAll(); }, []);

  // Auto-refresh
  useEffect(() => {
    const t = setInterval(loadAll, 15000);
    return () => clearInterval(t);
  }, []);

  // Refresh messages on session change
  useEffect(() => {
    if (!selectedSessionId) return;
    client.getSession(selectedSessionId).then(full => setMessages(full.messages || [])).catch(() => {});
  }, [selectedSessionId]);

  // ─── Keyboard ──────────────────────────────────────────────────
  useInput(async (ch, key) => {
    if (key.ctrl && ch === 'c') { exit(); return; }

    // Tab navigation
    if (key.tab) {
      const idx = TABS.indexOf(activeTab);
      setActiveTab(TABS[(idx + 1) % TABS.length]);
      return;
    }
    if (key.shift && key.tab) {
      const idx = TABS.indexOf(activeTab);
      setActiveTab(TABS[(idx - 1 + TABS.length) % TABS.length]);
      return;
    }

    // Number shortcuts for tabs (1-9)
    const n = parseInt(ch);
    if (n >= 1 && n <= 9 && TABS[n - 1]) {
      setActiveTab(TABS[n - 1]);
      return;
    }

    // Chat-specific keys
    if (activeTab === 'Chat') {
      // New session
      if (key.ctrl && ch === 'n') {
        try {
          const ns = await client.createSession('Gemini', `Chat #${sessions.length + 1}`);
          setSessions(prev => [ns, ...prev]);
          setSelectedSessionId(ns.id);
          setMessages([]);
        } catch {}
        return;
      }

      // Send message
      if (key.return) {
        if (!input.trim() || isStreaming || !selectedSessionId) return;
        const content = input;
        setInput('');
        setIsStreaming(true);
        setToolCalls(new Map());

        const userMsg: ChatMessage = { id: Math.random().toString(36).slice(2), role: 'user', content, createdAt: new Date().toISOString() };
        setMessages(prev => [...prev, userMsg]);

        if (content.startsWith('/')) {
          const aid = Math.random().toString(36).slice(2);
          setMessages(prev => [...prev, { id: aid, role: 'system', content: '...', createdAt: new Date().toISOString() }]);
          try {
            const res = await commandRegistry.execute(content, { sessionId: selectedSessionId, apiBaseUrl: getApiBaseUrl() });
            setMessages(prev => prev.map(m => m.id === aid ? { ...m, content: res.output } : m));
            if (content === '/compact') loadAll();
          } catch (e: any) {
            setMessages(prev => prev.map(m => m.id === aid ? { ...m, content: `Error: ${e.message}` } : m));
          }
          setIsStreaming(false);
          return;
        }

        // Stream message
        const aid = Math.random().toString(36).slice(2);
        setMessages(prev => [...prev, { id: aid, role: 'assistant', content: '', createdAt: new Date().toISOString() }]);
        let full = '';

        try {
          for await (const evt of client.streamMessage(selectedSessionId, content)) {
            if (evt.type === 'message.delta') {
              full += evt.text;
              setMessages(prev => prev.map(m => m.id === aid ? { ...m, content: full } : m));
            } else if (evt.type === 'tool.started') {
              setToolCalls(prev => {
                const next = new Map(prev);
                next.set(evt.name, { name: evt.name, input: evt.input });
                return next;
              });
            } else if (evt.type === 'tool.finished') {
              setToolCalls(prev => {
                const next = new Map(prev);
                const existing = next.get(evt.name) || { name: evt.name };
                next.set(evt.name, { ...existing, output: evt.output });
                return next;
              });
            } else if (evt.type === 'tool.failed') {
              setToolCalls(prev => {
                const next = new Map(prev);
                const existing = next.get(evt.name) || { name: evt.name };
                next.set(evt.name, { ...existing, error: evt.error });
                return next;
              });
            } else if (evt.type === 'approval.required') {
              loadAll();
            }
          }
        } catch {}
        setIsStreaming(false);
        loadAll();
        return;
      }

      // Typing
      if (key.backspace) {
        setInput(prev => prev.slice(0, -1));
      } else if (ch && ch.length === 1 && !key.meta && !key.ctrl) {
        setInput(prev => prev + ch);
      }

      // Session switching
      if (key.upArrow || key.downArrow) {
        const idx = sessions.findIndex(s => s.id === selectedSessionId);
        const next = key.upArrow
          ? (idx - 1 + sessions.length) % sessions.length
          : (idx + 1) % sessions.length;
        const target = sessions[next];
        if (target) {
          setSelectedSessionId(target.id);
          client.getSession(target.id).then(full => setMessages(full.messages || [])).catch(() => {});
        }
        return;
      }
    }
  });

  // ─── Render helpers ────────────────────────────────────────────
  if (width < 60) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Terminal too small ({width}x{process.stdout.rows || 24}). Resize to 80x20+.</Text>
      </Box>
    );
  }

  if (!apiReachable) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>API unreachable at {getApiBaseUrl()}</Text>
        <Text color="yellow">Start: bun run dev:api</Text>
        <Text color="gray">Ctrl+C to exit</Text>
      </Box>
    );
  }

  // ─── Top bar ────────────────────────────────────────────────────
  const topBar = (
    <Box flexDirection="row" width={width} justifyContent="space-between">
      <Box flexDirection="row">
        <Text bold color="cyan">Ara</Text>
        <Text color="gray"> v{version} </Text>
        <Text color="gray">|</Text>
        <Text color={pendingCount > 0 ? 'yellow' : 'gray'}>
          {' '}{pendingCount > 0 ? `⚠${pendingCount}` : '●'}
        </Text>
      </Box>
      <Box flexDirection="row">
        {TABS.slice(0, 5).map((tab, i) => (
          <Text key={tab} bold={activeTab === tab} color={activeTab === tab ? 'white' : 'gray'} wrap="truncate">
            {' '}{activeTab === tab ? `${tab}` : tab.toLowerCase()}{' '}
          </Text>
        ))}
        <Text color="gray">|</Text>
        {TABS.slice(5).map(tab => (
          <Text key={tab} bold={activeTab === tab} color={activeTab === tab ? 'white' : 'gray'} wrap="truncate">
            {' '}{activeTab === tab ? `${tab}` : tab.toLowerCase()}{' '}
          </Text>
        ))}
      </Box>
    </Box>
  );

  // ─── Tab content ────────────────────────────────────────────────
  const renderTab = () => {
    switch (activeTab) {
      case 'Chat':
        return (
          <Box flexDirection="column" flexGrow={1}>
            {/* Session header */}
            <Box flexDirection="row" justifyContent="space-between" paddingX={1} paddingY={1}>
              <Text bold color="white">
                {sessions.find(s => s.id === selectedSessionId)?.title || 'No session'}
              </Text>
              <Text color="gray">
                {sessions.length} session{sessions.length !== 1 ? 's' : ''} · ↑↓ switch
              </Text>
            </Box>

            {/* Messages */}
            <Box flexDirection="column" flexGrow={1} paddingX={1}>
              {messages.length === 0 && !isStreaming ? (
                <Box flexDirection="column" marginTop={4} alignItems="center">
                  <Text color="gray">Start a conversation. Press Enter to send.</Text>
                  <Text color="gray">Ctrl+N for new session. / for commands.</Text>
                </Box>
              ) : (
                messages.slice(-20).map(msg => {
                  if (msg.role === 'system') {
                    return <Text key={msg.id} color="yellow">  {msg.content}</Text>;
                  }
                  const label = msg.role === 'user' ? 'You' : 'Ara';
                  const color = msg.role === 'user' ? 'magenta' : 'cyan';
                  const lines = msg.content.split('\n');
                  return (
                    <Box key={msg.id} flexDirection="column" marginBottom={1}>
                      <Text bold color={color}>{label}</Text>
                      {lines.map((line, i) => (
                        <Text key={i} color={msg.role === 'user' ? 'white' : 'white'} wrap="wrap">{line}</Text>
                      ))}
                      {isStreaming && msg.role === 'assistant' && msg.content === '' && (
                        <Text color="yellow">...</Text>
                      )}
                    </Box>
                  );
                })
              )}
              {/* Active tool calls */}
              {toolCalls.size > 0 && (
                <Box flexDirection="column" marginY={1}>
                  {Array.from(toolCalls.values()).map(tc => (
                    <ToolCallBlock key={tc.name} {...tc} />
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        );

      case 'Approvals':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="red">Pending Approvals {approvals.length > 0 && `(${approvals.length})`}</Text>
            {approvals.length === 0 ? (
              <Text color="gray">  None pending.</Text>
            ) : (
              approvals.map(a => (
                <Box key={a.id} flexDirection="column" marginY={1}>
                  <Text bold color="yellow">  Tool: {a.toolName}</Text>
                  <Text color="gray">    Reason: {a.reason}</Text>
                  <Text color="gray">    Args: {a.input.slice(0, 120)}</Text>
                </Box>
              ))
            )}
          </Box>
        );

      case 'MCP':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">MCP Servers</Text>
            {mcpServers.length === 0 ? (
              <Text color="gray">  None configured.</Text>
            ) : (
              mcpServers.map(s => {
                const h = mcpHealth.find((h: any) => h.serverId === s.id);
                const st = h?.state || s.state || 'unknown';
                const color = st === 'healthy' ? 'green' : st === 'error' ? 'red' : 'gray';
                return (
                  <Box key={s.id} marginY={1}>
                    <Text bold color={color}>{s.id}</Text>
                    <Text color="gray">  {st} · {s.type} · {s.permissionMode || 'default'}</Text>
                  </Box>
                );
              })
            )}
          </Box>
        );

      case 'GitHub':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">GitHub</Text>
            {!ghStatus?.configured ? (
              <Text color="gray">  Not configured.</Text>
            ) : (
              <>
                <Text color="gray">  {ghStatus.defaultOwner}/{ghStatus.defaultRepo} · {ghStatus.tokenPresent ? 'connected' : 'no token'}</Text>
                {ghIssues.length > 0 && <Text color="white" bold marginTop={1}>  Open Issues</Text>}
                {ghIssues.slice(0, 5).map((i: any) => (
                  <Text key={i.number} color="gray">  #{i.number} {String(i.title || '').slice(0, 50)}</Text>
                ))}
                {ghPrs.length > 0 && <Text color="white" bold marginTop={1}>  Open PRs</Text>}
                {ghPrs.slice(0, 5).map((p: any) => (
                  <Text key={p.number} color="gray">  #{p.number} {String(p.title || '').slice(0, 50)}</Text>
                ))}
              </>
            )}
          </Box>
        );
      case 'Codex':        return (          <Box flexDirection="column" flexGrow={1}>            <Box flexDirection="row" justifyContent="space-between" paddingX={1} paddingY={1}>              <Text bold color="green">Coding Agent (Codex / Claude Code)</Text>              <Text color="gray">{codexSessions.length} session{codexSessions.length !== 1 ? 's' : ''}</Text>            </Box>            <Box flexDirection="row" flexGrow={1}>              <Box width={30} flexDirection="column" marginRight={1} paddingX={1}>                <Text bold color="yellow">Sessions</Text>                {codexSessions.length === 0 ? (                  <Text color="gray">  No sessions.</Text>                ) : (                  codexSessions.slice(0, 8).map((s: any) => (                    <Box key={s.id} paddingY={1}>                      <Text color={s.id === selectedCodexId ? 'green' : 'gray'}                        bold={s.id === selectedCodexId}                        wrap="truncate">                        {s.status === 'running' ? '●' : '○'} {s.id.slice(-18)} {s.status === 'running' ? 'run' : s.status}                      </Text>                    </Box>                  ))                )}              </Box>              <Box flexDirection="column" flexGrow={1}>                <Text bold color="white">Output</Text>                <Box flexGrow={1} paddingX={1} paddingY={1}>                  {!selectedCodexId ? (                    <Text color="gray">Select a session from the list.</Text>                  ) : codexOutput ? (                    <Text color="white" wrap="wrap">                      {codexOutput.slice(-4000)}                    </Text>                  ) : (                    <Text color="gray">Waiting for output...</Text>                  )}                </Box>              </Box>            </Box>          </Box>        );      case 'Subagents':

      case 'Subagents':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">Subagents</Text>
            {subagents.length === 0 ? <Text color="gray">  None.</Text> : subagents.map((p: any) => (
              <Text key={p.name} color="gray">  {p.name} — {p.description?.slice(0, 40)}</Text>
            ))}
            {subagentRuns.length > 0 && (
              <>
                <Text bold color="yellow" marginTop={1}>  Recent Runs</Text>
                {subagentRuns.slice(0, 4).map((r: any) => (
                  <Text key={r.id} color="gray">  [{r.status}] {r.profileName}: {r.task?.slice(0, 40)}</Text>
                ))}
              </>
            )}
          </Box>
        );

      case 'Locks':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="yellow">Locks ({lockList.length})</Text>
            {lockList.length === 0 ? <Text color="gray">  None.</Text> : lockList.slice(0, 8).map((l: any) => (
              <Text key={l.id} color="gray">  {l.mode === 'write' ? 'W' : 'R'} {l.path?.slice(-35)}</Text>
            ))}
            {parallelRuns.length > 0 && (
              <><Text bold color="yellow" marginTop={1}>  Parallel Runs</Text>{parallelRuns.slice(0, 3).map((r: any) => (
                <Text key={r.id} color="gray">  {r.status} · {r.profiles?.length || 0} agents</Text>
              ))}</>
            )}
          </Box>
        );

      case 'Canvas':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="cyan">Canvas</Text>
            {canvasWorkspaces.length === 0 ? <Text color="gray">  None.</Text> : canvasWorkspaces.slice(0, 8).map((ws: any) => (
              <Text key={ws.id} color="gray">  {(ws.name || '').slice(0, 30)} · nodes: {ws.nodeCount || '?'}</Text>
            ))}
          </Box>
        );

      case 'Checkpoints':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">Checkpoints ({checkpoints.length})</Text>
            {checkpoints.length === 0 ? <Text color="gray">  None.</Text> : checkpoints.slice(0, 8).map((c: any) => (
              <Text key={c.id} color="gray">  {c.id?.slice(0, 12)} · {c.reason?.slice(0, 40)}</Text>
            ))}
          </Box>
        );

      case 'Skills':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">Skills ({skills.length})</Text>
            {skills.map(s => (
              <Text key={s.name} color="gray">  {s.name} ({s.dangerLevel})</Text>
            ))}
          </Box>
        );

      case 'Learning':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="green">Skill Learning</Text>
            <Text color="gray">  Workflows: {learningData?.workflowCount || 0}</Text>
            <Text color="gray">  Repeated: {learningData?.repeatedCount || 0}</Text>
            <Text color="gray">  Drafts: {learningDrafts.length}</Text>
            {learningDrafts.filter((d: any) => d.status === 'draft').slice(0, 5).map((d: any) => (
              <Text key={d.id} color="gray">  {(d.proposedSkillName || '').slice(0, 30)} — {Math.round((d.confidence || 0) * 100)}%</Text>
            ))}
          </Box>
        );

      case 'Memory':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="magenta">Memory ({memories.length})</Text>
            {memories.slice(0, 10).map(m => (
              <Text key={m.id} color="gray">  [{m.type}] {m.title}: {m.content?.slice(0, 50)}</Text>
            ))}
          </Box>
        );

      case 'Audit':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="yellow">Audit Logs</Text>
            {auditLogs.slice(0, 8).map(log => (
              <Text key={log.id} color="gray">  [{log.status}] {log.toolName} at {log.createdAt?.slice(11, 19)}</Text>
            ))}
          </Box>
        );

      case 'Status':
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text bold color="blue">Status</Text>
            <Text color="gray">  API: connected</Text>
            <Text color="gray">  DB: {dbStatus}</Text>
            <Text color="gray">  Mode: {permissionMode.toUpperCase()}</Text>
            <Text color="gray">  Sandbox: {sandboxMode ? 'on' : 'off'}</Text>
            <Text color="gray">  Keys: {hasKeys ? 'set' : 'missing'}</Text>
            <Text color="gray">  Skills: {skills.length}</Text>
            <Text color="gray">  Memory: {memories.length}</Text>
            <Text color="gray">  Sessions: {sessions.length}</Text>
            <Text color="gray">  CWD: {process.cwd()}</Text>
          </Box>
        );
    }
  };

  // ─── Main render ───────────────────────────────────────────────
  return (
    <Box flexDirection="column" width={width}>
      {/* Top bar */}
      {topBar}
      <Text color="gray">{''.padEnd(width, '─')}</Text>

      {/* Main content */}
      <Box flexGrow={1} flexDirection="column" paddingY={1}>
        {renderTab()}
      </Box>

      {/* Divider above input */}
      <Text color="gray">{''.padEnd(width, '─')}</Text>

      {/* Input bar — Claude Code style */}
      <Box flexDirection="row" paddingX={1} paddingY={1}>
        <Text bold color="magenta">{'>'}</Text>
        <Text>{' '}{input}</Text>
        {isStreaming && <Text color="yellow"> ■</Text>}
      </Box>

      {/* Status bar */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text color="gray">
          Tab:nav · 1-9:goto · {'^'}N:new · {'^'}C:exit
        </Text>
        <Text color="gray">
          {selectedSessionId && sessions.find(s => s.id === selectedSessionId)
            ? `${sessions.find(s => s.id === selectedSessionId)!.model}`
            : ''}
          {' '}{permissionMode.toUpperCase()}
        </Text>
      </Box>
    </Box>
  );
}
