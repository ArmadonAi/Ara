import { useState, useEffect } from 'react';
import { 
  Bot, User, ShieldAlert, Cpu, Database, 
  Terminal, Check, X, ArrowRight, MessageSquare, 
  BookOpen, Plus, Clock 
} from 'lucide-react';
import './App.css';
import { CanvasPage } from './Canvas';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
}

interface Automation {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}

interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  status: 'running' | 'success' | 'failed' | 'awaitingApproval';
  output: string;
  createdAt: string;
}

interface ChatSession {
  id: string;
  title: string;
  model: string;
  messageCount: number;
}

interface Memory {
  id: string;
  type: 'user' | 'project' | 'episodic';
  title: string;
  content: string;
}

interface Skill {
  name: string;
  description: string;
  dangerLevel: string;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface ApprovalRequest {
  id: string;
  toolName: string;
  input: string;
  riskLevel: 'safe' | 'write' | 'network' | 'dangerous';
  reason: string;
  status: string;
}

interface AuditLog {
  id: string;
  toolName: string;
  input: string;
  status: 'success' | 'failed' | 'pending';
}

const API_BASE = 'http://localhost:3001';

let globalIdCounter = 0;
function generateUniqueId(): string {
  globalIdCounter++;
  const randomArr = new Uint32Array(1);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(randomArr);
  }
  return `${Date.now()}-${globalIdCounter}-${randomArr[0] % 100000}`;
}

function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeModel, setActiveModel] = useState('Gemini');
  const [inputVal, setInputVal] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);

  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [page, _setPage] = useState("chat");
  const [newAutoName, setNewAutoName] = useState('');
  const [newAutoCron, setNewAutoCron] = useState('*/5 * * * *');
  const [newAutoPrompt, setNewAutoPrompt] = useState('');
  const [showAutoForm, setShowAutoForm] = useState(false);

  // Onboarding Wizard States
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [anthropicKeyInput, setAnthropicKeyInput] = useState('');
  const [backendKeys, setBackendKeys] = useState({
    GEMINI_API_KEY: false,
    OPENAI_API_KEY: false,
    ANTHROPIC_API_KEY: false
  });


  const loadSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
        if (data.length > 0 && !activeSessionId) {
          setActiveSessionId(data[0].id);
          setActiveModel(data[0].model);
        }
      }
    } catch (e) {
      console.error('Failed to load sessions', e);
    }
  };

  const loadModels = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/models`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.models);
      }
    } catch (e) {
      console.error('Failed to load models', e);
    }
  };

  const loadMemories = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/memories`);
      if (res.ok) {
        const data = await res.json();
        setMemories(data);
      }
    } catch (e) {
      console.error('Failed to load memories', e);
    }
  };

  const loadSkills = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/skills`);
      if (res.ok) {
        const data = await res.json();
        setSkills(data.map((s: Omit<Skill, 'dangerLevel'> & { dangerLevel?: string }) => ({
          ...s,
          dangerLevel: s.dangerLevel || 'safe'
        })));
      }
    } catch (e) {
      console.error('Failed to load skills', e);
    }
  };

  const loadSessionMessages = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${id}`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages);
        setActiveModel(data.model);
      }
    } catch (e) {
      console.error('Failed to load session details', e);
    }
  };

  const loadApprovals = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/approvals`);
      if (res.ok) {
        const data = await res.json();
        // Keep only pending ones for the pending approval gate UI
        setApprovals(data.filter((app: ApprovalRequest) => app.status === 'pending'));
      }
    } catch (e) {
      console.error('Failed to load approvals', e);
    }
  };

  const loadAuditLogs = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/audit-logs`);
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data);
      }
    } catch (e) {
      console.error('Failed to load audit logs', e);
    }
  };

  const loadAutomations = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/automations`);
      if (res.ok) {
        const data = await res.json();
        setAutomations(data);
      }
    } catch (e) {
      console.error('Failed to load automations', e);
    }
  };

  const loadAutomationRuns = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/automations/runs`);
      if (res.ok) {
        const data = await res.json();
        setAutomationRuns(data);
      }
    } catch (e) {
      console.error('Failed to load automation runs', e);
    }
  };

  const handleCreateAutomation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAutoName || !newAutoPrompt) return;
    try {
      const res = await fetch(`${API_BASE}/api/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newAutoName,
          cron: newAutoCron,
          prompt: newAutoPrompt,
          enabled: true
        })
      });
      if (res.ok) {
        setNewAutoName('');
        setNewAutoPrompt('');
        setShowAutoForm(false);
        await loadAutomations();
      }
    } catch (err) {
      console.error('Failed to create automation', err);
    }
  };

  const handleToggleAutomation = async (id: string, currentlyEnabled: boolean) => {
    try {
      await fetch(`${API_BASE}/api/automations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentlyEnabled })
      });
      await loadAutomations();
    } catch (err) {
      console.error('Failed to toggle automation', err);
    }
  };

  const handleDeleteAutomation = async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/automations/${id}`, {
        method: 'DELETE'
      });
      await loadAutomations();
      await loadAutomationRuns();
    } catch (err) {
      console.error('Failed to delete automation', err);
    }
  };

  const handleTriggerAutomation = async (id: string) => {
    try {
      await fetch(`${API_BASE}/api/automations/${id}/trigger`, {
        method: 'POST'
      });
      setTimeout(async () => {
        await loadAutomationRuns();
        await loadSessions();
      }, 1000);
    } catch (err) {
      console.error('Failed to trigger automation', err);
    }
  };

  const checkKeysConfigured = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config/keys`);
      if (res.ok) {
        const data = await res.json();
        setBackendKeys(data);
        const hasSomeKeys = data.GEMINI_API_KEY || data.OPENAI_API_KEY || data.ANTHROPIC_API_KEY;
        const localOnboarded = localStorage.getItem('ara_onboarded') === 'true';
        if (!localOnboarded || !hasSomeKeys) {
          setShowOnboarding(true);
        }
      }
    } catch (e) {
      console.error('Failed to query API key configurations', e);
    }
  };

  const handleSaveKeys = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          GEMINI_API_KEY: geminiKeyInput || undefined,
          OPENAI_API_KEY: openaiKeyInput || undefined,
          ANTHROPIC_API_KEY: anthropicKeyInput || undefined
        })
      });
      if (res.ok) {
        const keysRes = await fetch(`${API_BASE}/api/config/keys`);
        if (keysRes.ok) {
          const keysData = await keysRes.json();
          setBackendKeys(keysData);
        }
        setOnboardingStep(3);
      }
    } catch (err) {
      console.error('Failed to save API keys', err);
    }
  };

  // Load active sessions on mount
  useEffect(() => {
    const init = async () => {
      await checkKeysConfigured();
      await loadSessions();
      await loadModels();
      await loadMemories();
      await loadSkills();
      await loadApprovals();
      await loadAuditLogs();
      await loadAutomations();
      await loadAutomationRuns();
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load session messages when active session changes
  useEffect(() => {
    if (activeSessionId) {
      setTimeout(() => {
        loadSessionMessages(activeSessionId);
      }, 0);
    } else {
      setTimeout(() => {
        setMessages([
          {
            id: '1',
            role: 'system',
            content: 'ระบบ Ara Operating Plane v0.1 พร้อมใช้งาน เชื่อมต่อผ่าน Local-first Sandbox เรียบร้อยแล้ว',
            createdAt: new Date()
          },
          {
            id: '2',
            role: 'assistant',
            content: 'สวัสดีครับเพื่อน! ยินดีต้อนรับสู่ Ara Personal AI Control Plane ของเรา ผมโหลดความทรงจำ (Memory) และสกิลหลักๆ (Skills) ขึ้นมาหมดแล้ว วันนี้เพื่อนอยากให้ผมตรวจโค้ด รันคำสั่ง หรือวิเคราะห์งานชิ้นไหน สั่งการเข้ามาได้เลยครับ!',
            createdAt: new Date()
          }
        ]);
      }, 0);
    }
  }, [activeSessionId]);

  const handleCreateSession = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: activeModel,
          title: `การสนทนาที่ ${sessions.length + 1}`
        })
      });
      if (res.ok) {
        const newSession = await res.json();
        setSessions(prev => [newSession, ...prev]);
        setActiveSessionId(newSession.id);
      }
    } catch (e) {
      console.error('Failed to create session', e);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputVal.trim() || isStreaming) return;

    let currentSessionId = activeSessionId;
    
    // Auto-create session if none active
    if (!currentSessionId) {
      try {
        const res = await fetch(`${API_BASE}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: activeModel,
            title: `การสนทนาใหม่`
          })
        });
        if (res.ok) {
          const newSession = await res.json();
          setSessions(prev => [newSession, ...prev]);
          currentSessionId = newSession.id;
          setActiveSessionId(newSession.id);
        } else {
          return;
        }
      } catch (err) {
        console.error('Failed to auto-create session', err);
        return;
      }
    }

    const userText = inputVal;
    setInputVal('');

    // Append user message to state
    const userMsg: Message = {
      id: Math.random().toString(),
      role: 'user',
      content: userText,
      createdAt: new Date()
    };
    setMessages(prev => [...prev, userMsg]);



    // Call SSE streaming API
    setIsStreaming(true);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${currentSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userText })
      });

      if (!res.ok) throw new Error('API server returned error');

      const reader = res.body?.getReader();
      if (!reader) throw new Error('Readable stream not supported');

      const decoder = new TextDecoder();
      
      // Add empty assistant bubble
      const assistantMsgId = generateUniqueId();
      const assistantMsg: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: new Date()
      };
      setMessages(prev => [...prev, assistantMsg]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const textChunk = decoder.decode(value);
        setMessages(prev => prev.map(msg => {
          if (msg.id === assistantMsgId) {
            return {
              ...msg,
              content: msg.content + textChunk
            };
          }
          return msg;
        }));
      }
    } catch (err: unknown) {
      console.error('Streaming failed', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, {
        id: generateUniqueId(),
        role: 'system',
        content: `Error streaming response: ${errMsg}`,
        createdAt: new Date()
      }]);
    } finally {
      setIsStreaming(false);
      loadSessions(); // Update session message counts
    }
  };

  const resumeAgentExecution = async (sessionId: string) => {
    setIsStreaming(true);
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '' }) // blank content triggers continuation
      });

      if (!res.ok) {
        throw new Error('Continuation stream request failed');
      }

      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Add empty assistant bubble
      const assistantMsgId = generateUniqueId();
      const assistantMsg: Message = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        createdAt: new Date()
      };
      setMessages(prev => [...prev, assistantMsg]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const textChunk = decoder.decode(value);
        setMessages(prev => prev.map(msg => {
          if (msg.id === assistantMsgId) {
            return {
              ...msg,
              content: msg.content + textChunk
            };
          }
          return msg;
        }));
      }
    } catch (err: unknown) {
      console.error('Resume streaming failed', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, {
        id: generateUniqueId(),
        role: 'system',
        content: `Error resuming agent streaming response: ${errMsg}`,
        createdAt: new Date()
      }]);
    } finally {
      setIsStreaming(false);
      loadSessions();
      loadApprovals();
      loadAuditLogs();
    }
  };

  const handleApprove = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/approvals/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' })
      });
      if (res.ok) {
        await loadApprovals();
        await loadAuditLogs();
        if (activeSessionId) {
          await loadSessionMessages(activeSessionId);
          await resumeAgentExecution(activeSessionId);
        }
      }
    } catch (e) {
      console.error('Failed to approve tool call', e);
    }
  };

  const handleReject = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/approvals/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' })
      });
      if (res.ok) {
        await loadApprovals();
        await loadAuditLogs();
        if (activeSessionId) {
          await loadSessionMessages(activeSessionId);
        }
      }
    } catch (e) {
      console.error('Failed to reject tool call', e);
    }
  };

  if (page === "canvas") { return <CanvasPage />; }
  return (
    <div className="ara-container">
      {/* Upper Glassmorphic Navbar */}
      <header className="ara-header">
        <div className="header-logo">
          <Bot className="glow-cyan" />
          <span className="brand-text">ARA</span>
          <span className="badge-beta">v0.1 ACTIVE</span>
        </div>
        <div className="header-meta">
          <div className="provider-selector">
            <Cpu size={16} />
            <select 
              value={activeModel} 
              onChange={async (e) => {
                const selectedModel = e.target.value;
                setActiveModel(selectedModel);
                if (activeSessionId) {
                  try {
                    await fetch(`${API_BASE}/api/sessions/${activeSessionId}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model: selectedModel })
                    });
                    await loadSessions();
                  } catch (err) {
                    console.error('Failed to update session model', err);
                  }
                }
              }}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <span className="sandbox-indicator">
            <span className="status-dot pulsing"></span>
            Local Sandbox Mode
          </span>
        </div>
      </header>

      {/* Main Workspace Layout */}
      <main className="ara-workspace">
        
        {/* Left Sidebar: Sessions and Memory */}
        <section className="workspace-panel panel-left">
          <div className="panel-section">
            <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="section-title" style={{ border: 'none', padding: 0, margin: 0 }}>
                <MessageSquare size={16} style={{ marginRight: 6 }} />
                เซสชันแชท
              </h3>
              <button onClick={handleCreateSession} className="btn-add-session" style={{ background: 'none', border: 'none', color: 'var(--color-cyan)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <Plus size={16} />
              </button>
            </div>
            <div className="session-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {sessions.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center', padding: 12 }}>
                  ไม่มีเซสชันการคุย
                </div>
              ) : (
                sessions.map(s => (
                  <div 
                    key={s.id} 
                    onClick={() => {
                      setActiveSessionId(s.id);
                      setActiveModel(s.model);
                    }}
                    className={`session-item ${activeSessionId === s.id ? 'active' : ''}`}
                  >
                    <span className="session-dot" style={{ backgroundColor: s.model === 'Gemini' ? 'var(--color-cyan)' : s.model === 'Anthropic' ? 'var(--color-magenta)' : 'var(--color-yellow)' }}></span>
                    <span className="session-text" style={{ flex: 1 }}>{s.title}</span>
                    <span style={{ fontSize: 10, opacity: 0.6 }}>{s.messageCount} msg</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel-section">
            <h3 className="section-title">
              <Database size={16} />
              ความทรงจำ (Memory)
            </h3>
            <div className="memory-grid">
              {memories.map(mem => (
                <div key={mem.id} className="memory-card">
                  <div className="memory-header">
                    <span className={`tag-${mem.type}`}>{mem.type.toUpperCase()}</span>
                    <span className="memory-title">{mem.title}</span>
                  </div>
                  <p className="memory-content">{mem.content}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="section-title" style={{ border: 'none', padding: 0, margin: 0 }}>
                <Clock size={16} style={{ marginRight: 6 }} />
                ระบบอัตโนมัติ (Automations)
              </h3>
              <button 
                onClick={() => setShowAutoForm(!showAutoForm)} 
                className="btn-add-session" 
                style={{ background: 'none', border: 'none', color: 'var(--color-cyan)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              >
                <Plus size={16} />
              </button>
            </div>

            {showAutoForm && (
              <form onSubmit={handleCreateAutomation} className="auto-form" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                <input 
                  type="text" 
                  value={newAutoName} 
                  onChange={(e) => setNewAutoName(e.target.value)} 
                  placeholder="ชื่อบอท/งานอัตโนมัติ" 
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--color-text)', fontSize: 11, padding: 4, borderRadius: 4 }} 
                />
                <input 
                  type="text" 
                  value={newAutoCron} 
                  onChange={(e) => setNewAutoCron(e.target.value)} 
                  placeholder="เวลารัน Cron (e.g. */5 * * * *)" 
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--color-text)', fontSize: 11, padding: 4, borderRadius: 4 }} 
                />
                <textarea 
                  value={newAutoPrompt} 
                  onChange={(e) => setNewAutoPrompt(e.target.value)} 
                  placeholder="คำสั่งกระตุ้นการทำงานบอท" 
                  rows={2}
                  style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--color-text)', fontSize: 11, padding: 4, borderRadius: 4, resize: 'none' }} 
                />
                <button type="submit" style={{ background: 'var(--color-cyan)', border: 'none', color: 'var(--color-bg)', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>บันทึกตั้งเวลา</button>
              </form>
            )}

            <div className="automations-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {automations.map(auto => (
                <div key={auto.id} className="auto-card" style={{ background: 'rgba(255,255,255,0.02)', padding: 8, borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 'bold', color: 'var(--color-text)' }}>{auto.name}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input 
                        type="checkbox" 
                        checked={auto.enabled} 
                        onChange={() => handleToggleAutomation(auto.id, auto.enabled)} 
                        style={{ cursor: 'pointer' }}
                      />
                      <button 
                        onClick={() => handleTriggerAutomation(auto.id)} 
                        style={{ background: 'rgba(0,255,240,0.1)', border: '1px solid var(--color-cyan)', color: 'var(--color-cyan)', borderRadius: 4, fontSize: 10, padding: '2px 6px', cursor: 'pointer' }}
                      >
                        รันบอท
                      </button>
                      <button 
                        onClick={() => handleDeleteAutomation(auto.id)} 
                        style={{ background: 'none', border: 'none', color: 'rgba(255,0,0,0.6)', cursor: 'pointer', fontSize: 10 }}
                      >
                        ลบ
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, opacity: 0.6, marginTop: 4 }}>
                    <span>⏱️ {auto.cron}</span>
                    <span>รันล่าสุด: {auto.lastRun ? new Date(auto.lastRun).toLocaleTimeString() : 'ไม่เคยรัน'}</span>
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7, fontStyle: 'italic', marginTop: 4, borderTop: '1px dashed rgba(255,255,255,0.05)', paddingTop: 4 }}>
                    "{auto.prompt}"
                  </div>
                </div>
              ))}
            </div>

            {/* Automation Run History */}
            {automationRuns.length > 0 && (
              <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 'bold', opacity: 0.8, marginBottom: 4 }}>ประวัติการทำงานบอท</div>
                <div style={{ maxHeight: 100, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {automationRuns.map(run => (
                    <div key={run.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, background: 'rgba(0,0,0,0.1)', padding: 4, borderRadius: 4 }}>
                      <span style={{ fontWeight: 'bold' }}>{run.automationName}</span>
                      <span className={`status-${run.status}`} style={{ color: run.status === 'success' ? 'var(--color-cyan)' : run.status === 'running' ? 'var(--color-yellow)' : 'red' }}>
                        {run.status.toUpperCase()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Center: Conversation Stream */}
        <section className="workspace-panel panel-center">
          <div className="chat-messages-container">
            {messages.map(msg => (
              <div key={msg.id} className={`chat-bubble-container role-${msg.role}`}>
                <div className="bubble-avatar">
                  {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                </div>
                <div className="bubble-body">
                  <div className="bubble-sender">
                    {msg.role === 'user' ? 'คุณ' : msg.role === 'assistant' ? 'Ara' : 'ระบบ'}
                  </div>
                  <div className="bubble-content" style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.content}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleSendMessage} className="chat-input-form">
            <div className="input-wrapper">
              <input 
                type="text" 
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="คุยกับ Ara... พิมพ์คำสั่ง เช่น 'write' หรือ 'run' เพื่อทดสอบระบบ Approval Gate"
                disabled={isStreaming}
              />
              <button type="submit" className="btn-send" disabled={isStreaming}>
                <ArrowRight size={18} />
              </button>
            </div>
          </form>
        </section>

        {/* Right Sidebar: Skills, Approvals, and Audit Logs */}
        <section className="workspace-panel panel-right">
          
          {/* Skills System */}
          <div className="panel-section">
            <h3 className="section-title">
              <BookOpen size={16} />
              สกิลระบบ (Skills)
            </h3>
            <div className="skills-list">
              {skills.map(skill => (
                <div key={skill.name} className="skill-card">
                  <div className="skill-meta">
                    <span className="skill-name">{skill.name}</span>
                    <span className="skill-safety">{skill.dangerLevel}</span>
                  </div>
                  <p className="skill-desc">{skill.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Risky Actions Approval Gate */}
          <div className="panel-section">
            <h3 className="section-title glow-alert">
              <ShieldAlert size={16} />
              คำร้องขออนุมัติ (Approval Gate)
            </h3>
            {approvals.length === 0 ? (
              <div className="no-approvals">
                <Check size={16} /> ไม่มีรายการคำขอที่ค้างอยู่
              </div>
            ) : (
              <div className="approvals-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {approvals.map(app => (
                  <div key={app.id} className="approval-card">
                    <div className="approval-head">
                      <span className="app-tool-name">{app.toolName}</span>
                      <span className={`risk-${app.riskLevel}`}>{app.riskLevel.toUpperCase()}</span>
                    </div>
                    <div className="approval-details">
                      <code>{app.input}</code>
                      <p className="reason-text"><strong>เหตุผล:</strong> {app.reason}</p>
                    </div>
                    <div className="approval-actions">
                      <button 
                        onClick={() => handleApprove(app.id)}
                        className="btn-action btn-approve"
                      >
                        <Check size={14} /> อนุมัติ
                      </button>
                      <button 
                        onClick={() => handleReject(app.id)}
                        className="btn-action btn-reject"
                      >
                        <X size={14} /> ปฏิเสธ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Audit Logs */}
          <div className="panel-section">
            <h3 className="section-title">
              <Terminal size={16} />
              บันทึกการทำงาน (Audit Logs)
            </h3>
            <div className="audit-log-terminal">
              {auditLogs.map(log => (
                <div key={log.id} className="audit-line">
                  <span className={`log-status ${log.status}`}>[{log.status.toUpperCase()}]</span>
                  <span className="log-tool">{log.toolName}</span>
                  <span className="log-input">{log.input}</span>
                </div>
              ))}
            </div>
          </div>

        </section>
      </main>

      {showOnboarding && (
        <div className="onboarding-overlay">
          <div className="onboarding-card">
            <div className="onboarding-header">
              <div className="onboarding-logo">
                <Bot size={32} />
              </div>
              <h2 className="onboarding-title">ยินดีต้อนรับสู่ Ara AI Control Plane</h2>
              <p className="onboarding-subtitle">
                Ara คือระบบปัญญาประดิษฐ์ส่วนตัว (Personal AI Control Plane) ที่ทำงานแบบ Local-first ปลอดภัย และควบคุมสิทธิ์การเขียนอ่านไฟล์และรันคำสั่งได้ 100%
              </p>
            </div>

            {onboardingStep === 1 && (
              <div className="onboarding-body">
                <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: 'var(--color-cyan)' }}>ฟีเจอร์เด่นของ Ara:</h4>
                <div className="feature-list">
                  <div className="feature-item">
                    <div className="feature-icon-wrapper">
                      <Terminal size={16} />
                    </div>
                    <div>
                      <div className="feature-title">ReAct Agent Runtime Loop</div>
                      <div className="feature-desc">คิด วางแผน และเรียกใช้งานเครื่องมืออย่างชาญฉลาดผ่านคำสั่ง XML tags</div>
                    </div>
                  </div>
                  <div className="feature-item">
                    <div className="feature-icon-wrapper">
                      <ShieldAlert size={16} />
                    </div>
                    <div>
                      <div className="feature-title">Approval Gate & Permissions Engine</div>
                      <div className="feature-desc">ควบคุมความปลอดภัยขั้นสูงสุด ป้องกัน path traversal และรหัสลับของคุณก่อนถูกเรียกใช้</div>
                    </div>
                  </div>
                  <div className="feature-item">
                    <div className="feature-icon-wrapper">
                      <Database size={16} />
                    </div>
                    <div>
                      <div className="feature-title">Local-first Memory & Skills</div>
                      <div className="feature-desc">จัดเก็บข้อมูลความทรงจำ ทักษะ และประวัติการรันผ่านระบบฐานข้อมูล SQLite และ Markdown ในเครื่อง</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {onboardingStep === 2 && (
              <div className="onboarding-body">
                <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--color-cyan)' }}>ตั้งค่า API Keys เพื่อเริ่มต้นใช้งาน:</h4>
                <p style={{ fontSize: '11px', color: 'var(--color-text-muted)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
                  กรอก API Keys ของผู้ให้บริการที่คุณต้องการใช้ (ข้อมูลจะถูกจัดเก็บลงไฟล์ <code>.env</code> ภายในเครื่องของคุณเท่านั้น ไม่มีการส่งไปที่อื่น):
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div className="key-input-group">
                    <div className="key-label">
                      <span>Gemini API Key (แนะนำสำหรับการวางแผนรวดเร็ว)</span>
                      {backendKeys.GEMINI_API_KEY ? (
                        <span className="badge-configured">ตั้งค่าแล้วในระบบ</span>
                      ) : (
                        <span className="badge-missing">ยังไม่ได้ตั้งค่า</span>
                      )}
                    </div>
                    <input 
                      type="password"
                      className="key-input-field"
                      value={geminiKeyInput}
                      onChange={(e) => setGeminiKeyInput(e.target.value)}
                      placeholder={backendKeys.GEMINI_API_KEY ? "••••••••••••••••" : "กรอก Gemini API Key..."}
                    />
                  </div>

                  <div className="key-input-group">
                    <div className="key-label">
                      <span>OpenAI API Key</span>
                      {backendKeys.OPENAI_API_KEY ? (
                        <span className="badge-configured">ตั้งค่าแล้วในระบบ</span>
                      ) : (
                        <span className="badge-missing">ยังไม่ได้ตั้งค่า</span>
                      )}
                    </div>
                    <input 
                      type="password"
                      className="key-input-field"
                      value={openaiKeyInput}
                      onChange={(e) => setOpenaiKeyInput(e.target.value)}
                      placeholder={backendKeys.OPENAI_API_KEY ? "••••••••••••••••" : "กรอก OpenAI API Key..."}
                    />
                  </div>

                  <div className="key-input-group">
                    <div className="key-label">
                      <span>Anthropic API Key</span>
                      {backendKeys.ANTHROPIC_API_KEY ? (
                        <span className="badge-configured">ตั้งค่าแล้วในระบบ</span>
                      ) : (
                        <span className="badge-missing">ยังไม่ได้ตั้งค่า</span>
                      )}
                    </div>
                    <input 
                      type="password"
                      className="key-input-field"
                      value={anthropicKeyInput}
                      onChange={(e) => setAnthropicKeyInput(e.target.value)}
                      placeholder={backendKeys.ANTHROPIC_API_KEY ? "••••••••••••••••" : "กรอก Anthropic API Key..."}
                    />
                  </div>
                </div>
              </div>
            )}

            {onboardingStep === 3 && (
              <div className="onboarding-body" style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(57, 255, 20, 0.1)', color: 'var(--color-neon-green)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(57, 255, 20, 0.3)', margin: '0 auto' }}>
                    <Check size={24} />
                  </div>
                </div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', color: 'var(--color-neon-green)', textAlign: 'center' }}>เชื่อมต่อและตั้งค่าเรียบร้อย!</h4>
                <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: 1.6, margin: '0 0 16px 0' }}>
                  บันทึก API Keys ลงระบบเรียบร้อยแล้ว คุณสามารถตรวจสอบสถานะการเชื่อมต่อ และควบคุมสิทธิ์ของเครื่องมือทุกอย่างได้โดยตรงผ่านแผงควบคุมหลัก
                </p>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '11px', textAlign: 'left', lineHeight: 1.5 }}>
                  <strong>คำแนะนำการคุย:</strong> คุณสามารถพิมพ์ทดสอบด้วยคำสั่งเช่น <code>รันไฟล์ test.js</code> หรือ <code>เขียนโค้ดแสดงเวลา</code> เพื่อเห็นระบบวิเคราะห์ความปลอดภัยและการส่งต่อเรื่องให้ Approval Gate ทำงานจริง!
                </div>
              </div>
            )}

            <div className="onboarding-footer">
              <div className="step-indicator">ขั้นตอน {onboardingStep} จาก 3</div>
              <div style={{ display: 'flex', gap: 12 }}>
                {onboardingStep > 1 && onboardingStep < 3 && (
                  <button 
                    type="button" 
                    className="btn-onboarding-back"
                    onClick={() => setOnboardingStep(prev => prev - 1)}
                  >
                    ย้อนกลับ
                  </button>
                )}
                {onboardingStep === 1 && (
                  <button 
                    type="button" 
                    className="btn-onboarding-next"
                    onClick={() => setOnboardingStep(2)}
                  >
                    เริ่มตั้งค่า <ArrowRight size={16} />
                  </button>
                )}
                {onboardingStep === 2 && (
                  <button 
                    type="button" 
                    className="btn-onboarding-next"
                    onClick={handleSaveKeys}
                  >
                    บันทึกและตรวจสอบ <Check size={16} />
                  </button>
                )}
                {onboardingStep === 3 && (
                  <button 
                    type="button" 
                    className="btn-onboarding-next"
                    onClick={() => {
                      localStorage.setItem('ara_onboarded', 'true');
                      setShowOnboarding(false);
                    }}
                  >
                    เข้าสู่แดชบอร์ด Ara <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

