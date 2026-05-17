import { useState, useEffect, useRef } from 'react';
import './App.css';
import { MessageSquare, Plus, Send, Bot, User, Check, X, AlertTriangle } from 'lucide-react';

interface ChatSession {
  id: string; title: string; model: string; messageCount: number;
}
interface Message {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date;
}
interface Approval {
  id: string; toolName: string; input: string; riskLevel: string; reason: string;
}

const API_BASE = 'http://localhost:3001';

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState('Gemini');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { loadSessions(); loadApprovals(); }, []);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const loadSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
        if (data.length > 0 && !activeId) { setActiveId(data[0].id); loadMessages(data[0].id); }
      }
    } catch {}
  };

  const loadMessages = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${id}`);
      if (res.ok) { const data = await res.json(); setMessages(data.messages || []); setModel(data.model); }
    } catch {}
  };

  const loadApprovals = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/approvals`);
      if (res.ok) setApprovals((await res.json()).filter((a: any) => a.status === 'pending'));
    } catch {}
  };

  const createSession = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, title: 'New Chat' }),
      });
      if (res.ok) {
        const s = await res.json();
        setSessions(prev => [s, ...prev]);
        setActiveId(s.id);
        setMessages([]);
      }
    } catch {}
  };

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;
    let sid = activeId;
    if (!sid) {
      try {
        const res = await fetch(`${API_BASE}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, title: input.slice(0, 40) }),
        });
        if (!res.ok) return;
        const s = await res.json();
        sid = s.id;
        setSessions(prev => [s, ...prev]);
        setActiveId(s.id);
      } catch { return; }
    }

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: input, createdAt: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);

    try {
      const res = await fetch(`${API_BASE}/api/sessions/${sid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg.content }),
      });
      if (!res.ok) { setStreaming(false); return; }

      const reader = res.body?.getReader();
      if (!reader) { setStreaming(false); return; }

      const decoder = new TextDecoder();
      let fullText = '';
      const assistantMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', content: '', createdAt: new Date() };
      setMessages(prev => [...prev, assistantMsg]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: fullText } : m));

        // Check for approval gate
        if (fullText.includes('awaitingApproval')) {
          loadApprovals();
          break;
        }
      }
    } catch {}

    setStreaming(false);
    loadSessions();
  };

  const handleApprove = async (id: string, action: 'approve' | 'reject') => {
    try {
      await fetch(`${API_BASE}/api/approvals/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      loadApprovals();
    } catch {}
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div className="app">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="sidebar">
          <div className="sidebar-header">
            <Bot size={20} color="#1a73e8" />
            <h1>Ara</h1>
          </div>
          <button className="new-chat-btn" onClick={createSession}>
            <Plus size={16} /> New Chat
          </button>
          <div className="session-list">
            {sessions.map(s => (
              <button key={s.id} className={`session-item ${s.id === activeId ? 'active' : ''}`}
                onClick={() => { setActiveId(s.id); loadMessages(s.id); }}>
                <MessageSquare size={14} />
                <span className="title">{s.title}</span>
              </button>
            ))}
            {sessions.length === 0 && <div style={{ padding: '16px', fontSize: 13, color: '#9ca3af', textAlign: 'center' }}>No conversations yet</div>}
          </div>
          <div className="sidebar-footer">Ara v0.1.0</div>
        </div>
      )}

      {/* Main */}
      <div className="main">
        <div className="chat-header">
          {!sidebarOpen && <button onClick={() => setSidebarOpen(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>☰</button>}
          {sidebarOpen && <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#9ca3af' }}>◀</button>}
          <div className="header-actions">
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="Gemini">Gemini</option>
              <option value="OpenAI">OpenAI</option>
              <option value="Anthropic">Anthropic</option>
            </select>
          </div>
        </div>

        {/* Approval bar */}
        {approvals.length > 0 && (
          <div className="approval-bar">
            <AlertTriangle size={16} />
            <span style={{ flex: 1 }}>{approvals.length} tool call{approvals.length > 1 ? 's' : ''} pending approval</span>
            {approvals.slice(0, 1).map(a => (
              <span key={a.id} style={{ fontSize: 12, color: '#856404' }}>{a.toolName}</span>
            ))}
            <button className="btn-approve" onClick={() => handleApprove(approvals[0].id, 'approve')}><Check size={14} /> Approve</button>
            <button className="btn-reject" onClick={() => handleApprove(approvals[0].id, 'reject')}><X size={14} /> Reject</button>
          </div>
        )}

        {/* Messages */}
        <div className="messages">
          {messages.map(m => (
            <div key={m.id} className={`message ${m.role}`}>
              <div className="message-row">
                <div className={`avatar ${m.role}`}>
                  {m.role === 'assistant' ? <Bot size={16} /> : <User size={16} />}
                </div>
                <div className="bubble">{m.content || (streaming && m.role === 'assistant' ? <div className="typing"><span/><span/><span/></div> : '')}</div>
              </div>
            </div>
          ))}
          {messages.length === 0 && !streaming && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#9ca3af' }}>
              <Bot size={40} color="#d1d5db" />
              <div style={{ fontSize: 20, fontWeight: 600, color: '#4a4a6a' }}>What can I help with?</div>
              <div style={{ fontSize: 14 }}>Ask me anything — I can read files, run commands, and access GitHub.</div>
            </div>
          )}
          <div ref={messagesEnd} />
        </div>

        {/* Input */}
        <div className="input-area">
          <div className="input-box">
            <textarea rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Message Ara..." disabled={streaming}
              onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }} />
            <button className="send-btn" onClick={sendMessage} disabled={streaming || !input.trim()}>
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
