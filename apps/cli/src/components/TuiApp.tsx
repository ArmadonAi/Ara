import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { ApiClient } from '../api/client';
import type { ChatSession, ChatMessage, ApprovalRequest, AuditLog, Skill, Memory } from '../api/client';
import { getApiBaseUrl } from '../config/manager';
import { createDefaultRegistry } from '@ara/commands';

const commandRegistry = createDefaultRegistry();

export function TuiApp() {
  const { exit } = useApp();
  const client = new ApiClient();

  // Navigation & tabs
  const tabs = ['Chat', 'Approvals', 'Tools', 'Memory', 'Skills', 'Audit', 'Status'] as const;
  type TabType = typeof tabs[number];
  const [activeTab, setActiveTab] = useState<TabType>('Chat');

  // Core entities
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  
  // Status parameters
  const [apiReachable, setApiReachable] = useState<boolean>(true);
  const [version, setVersion] = useState<string>('unknown');
  const [dbStatus, setDbStatus] = useState<string>('unknown');
  const [sandboxMode, setSandboxMode] = useState<boolean>(false);
  const [permissionMode, setPermissionMode] = useState<string>('default');

  // Stdin states
  const [inputVal, setInputVal] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState<number>(0);
  
  // Terminal sizing fallback
  const [terminalWidth, setTerminalWidth] = useState<number>(100);
  const [terminalHeight, setTerminalHeight] = useState<number>(24);

  // 1. Initial bootloader
  useEffect(() => {
    // Read stdout size
    if (process.stdout.columns) {
      setTerminalWidth(process.stdout.columns);
      setTerminalHeight(process.stdout.rows || 24);
    }

    const handleResize = () => {
      setTerminalWidth(process.stdout.columns || 100);
      setTerminalHeight(process.stdout.rows || 24);
    };

    process.stdout.on('resize', handleResize);

    const loadInitialStats = async () => {
      try {
        const stat = await client.getStatus();
        setApiReachable(true);
        setVersion(stat.version);
        setDbStatus(stat.database);
        setSandboxMode(stat.sandboxMode);
        if (stat.activePermissionMode) {
          setPermissionMode(stat.activePermissionMode);
        }

        const sess = await client.listSessions();
        setSessions(sess);
        if (sess.length > 0 && sess[0]) {
          setSelectedSessionId(sess[0].id);
          const full = await client.getSession(sess[0].id);
          setMessages(full.messages || []);
        }

        const apps = await client.listApprovals();
        setApprovals(apps.filter(a => a.status === 'pending'));

        setSkills(await client.listSkills());
        setMemories(await client.listMemory());
        setAuditLogs(await client.listAuditLogs());
      } catch (e) {
        setApiReachable(false);
      }
    };

    loadInitialStats();
    
    // Auto-refresh interval (for live status updates / approvals background check)
    const timer = setInterval(async () => {
      try {
        const stat = await client.getStatus();
        setApiReachable(true);
        setVersion(stat.version);
        if (stat.activePermissionMode) {
          setPermissionMode(stat.activePermissionMode);
        }
        
        const apps = await client.listApprovals();
        setApprovals(apps.filter(a => a.status === 'pending'));

        // Refresh sessions list
        const sess = await client.listSessions();
        setSessions(sess);
      } catch (e) {
        setApiReachable(false);
      }
    }, 5000);

    return () => {
      process.stdout.off('resize', handleResize);
      clearInterval(timer);
    };
  }, []);

  // 2. Refresh active session messages
  useEffect(() => {
    if (!selectedSessionId) return;
    const fetchSess = async () => {
      try {
        const full = await client.getSession(selectedSessionId);
        setMessages(full.messages || []);
      } catch (e) {
        // Handle error silently
      }
    };
    fetchSess();
  }, [selectedSessionId]);

  // 3. Stdin Keypress Router
  useInput(async (input, key) => {
    // Exit handler
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // New conversation trigger
    if (key.ctrl && input === 'n') {
      try {
        const newSess = await client.createSession('Gemini', `Conversation #${sessions.length + 1}`);
        setSessions(prev => [newSess, ...prev]);
        setSelectedSessionId(newSess.id);
        setSelectedSessionIndex(0);
        setMessages([]);
      } catch (e) {}
      return;
    }

    // Clear session trigger
    if (key.ctrl && input === 'l') {
      setMessages([]);
      return;
    }

    // Horizontal Tab switcher
    if (key.tab) {
      const idx = tabs.indexOf(activeTab);
      const nextIdx = key.shift ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
      setActiveTab(tabs[nextIdx]!);
      return;
    }

    // Direct tab shortcut keys
    if (input === 'a') { setActiveTab('Approvals'); return; }
    if (input === 'm') { setActiveTab('Memory'); return; }
    if (input === 's') { setActiveTab('Skills'); return; }
    if (input === 't') { setActiveTab('Tools'); return; }
    if (input === 'g') { setActiveTab('Audit'); return; }

    // Session Switcher Arrow keys (up/down) in Sidebar
    if (key.upArrow && sessions.length > 0) {
      const prevIdx = (selectedSessionIndex - 1 + sessions.length) % sessions.length;
      setSelectedSessionIndex(prevIdx);
      const target = sessions[prevIdx];
      if (target) setSelectedSessionId(target.id);
      return;
    }
    if (key.downArrow && sessions.length > 0) {
      const nextIdx = (selectedSessionIndex + 1) % sessions.length;
      setSelectedSessionIndex(nextIdx);
      const target = sessions[nextIdx];
      if (target) setSelectedSessionId(target.id);
      return;
    }

    // TextInput handler (Ink custom simple input reader)
    if (key.return) {
      if (!inputVal.trim() || isStreaming || !selectedSessionId) return;
      const userContent = inputVal;
      setInputVal('');

      if (userContent.startsWith('/')) {
        const userMsg: ChatMessage = {
          id: Math.random().toString(36).substring(7),
          role: 'user',
          content: userContent,
          createdAt: new Date().toISOString()
        };
        setMessages(prev => [...prev, userMsg]);
        
        const assistantId = Math.random().toString(36).substring(7);
        setMessages(prev => [...prev, {
          id: assistantId,
          role: 'system',
          content: 'Processing command...',
          createdAt: new Date().toISOString()
        }]);

        try {
          const res = await commandRegistry.execute(userContent, {
            sessionId: selectedSessionId,
            apiBaseUrl: getApiBaseUrl()
          });
          
          setMessages(prev => prev.map(m => {
            if (m.id === assistantId) return { ...m, content: res.output };
            return m;
          }));

          if (userContent === '/compact') {
            const sess = await client.listSessions();
            setSessions(sess);
            const full = await client.getSession(selectedSessionId);
            setMessages(full.messages || []);
          }
        } catch (e: any) {
          setMessages(prev => prev.map(m => {
            if (m.id === assistantId) return { ...m, content: `Error: ${e.message}` };
            return m;
          }));
        }
        return;
      }

      // Add user message mock
      const userMsg: ChatMessage = {
        id: Math.random().toString(36).substring(7),
        role: 'user',
        content: userContent,
        createdAt: new Date().toISOString()
      };
      setMessages(prev => [...prev, userMsg]);
      setIsStreaming(true);

      // Spawn streaming
      try {
        const assistantId = Math.random().toString(36).substring(7);
        let assistantContent = '';
        
        // Add empty bubble
        setMessages(prev => [...prev, {
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString()
        }]);

        for await (const chunk of client.streamMessage(selectedSessionId, userContent)) {
          if (chunk.type === 'message.delta') {
            assistantContent += chunk.text;
            setMessages(prev => prev.map(m => {
              if (m.id === assistantId) return { ...m, content: assistantContent };
              return m;
            }));
          } else if (chunk.type === 'approval.required') {
            // Trigger refresh
            const apps = await client.listApprovals();
            setApprovals(apps.filter(a => a.status === 'pending'));
          }
        }
      } catch (err) {}
      setIsStreaming(false);
      return;
    }

    // Typing keys
    if (key.backspace) {
      setInputVal(prev => prev.slice(0, -1));
    } else if (input && input.length === 1 && !key.meta && !key.ctrl) {
      // Append key character
      setInputVal(prev => prev + input);
    }
  });

  const handleApproveInline = async (id: string) => {
    try {
      await client.approveRequest(id);
      const apps = await client.listApprovals();
      setApprovals(apps.filter(a => a.status === 'pending'));
    } catch (e) {}
  };

  const handleRejectInline = async (id: string) => {
    try {
      await client.rejectRequest(id);
      const apps = await client.listApprovals();
      setApprovals(apps.filter(a => a.status === 'pending'));
    } catch (e) {}
  };

  // Warning layout if terminal is too compressed
  if (terminalWidth < 60 || terminalHeight < 15) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor="red">
        <Text color="red" bold>⚠️ Terminal layout is too small!</Text>
        <Text>Width: {terminalWidth} cols, Height: {terminalHeight} rows.</Text>
        <Text>Please resize your terminal window to at least 80x20 parameters.</Text>
      </Box>
    );
  }

  // Dashboard Offline Banner
  if (!apiReachable) {
    return (
      <Box flexDirection="column" padding={2} borderStyle="round" borderColor="red" width={terminalWidth - 4}>
        <Text color="red" bold>❌ Ara API Server is not reachable!</Text>
        <Text>Base URL: {getApiBaseUrl()}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Please verify that your backend server is fully running.</Text>
          <Text bold color="yellow">Start it with:  bun run dev:api</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">Press Ctrl+C to close this session.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight} borderStyle="single" borderColor="blue">
      {/* 1. Header Navigation Tabs Bar */}
      <Box borderStyle="classic" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">🤖 Ara Control Plane (TUI) </Text>
          <Text color="gray">v{version}</Text>
        </Box>
        <Box>
          {tabs.map(tab => (
            <Box key={tab} marginX={1}>
              <Text bold={activeTab === tab} color={activeTab === tab ? 'green' : 'white'} inverse={activeTab === tab}>
                [{tab}]
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* 2. Main Content layout (Split sidebar and panel) */}
      <Box flexGrow={1} flexDirection="row">
        {/* Sidebar panels */}
        <Box width={30} borderStyle="single" borderColor="gray" flexDirection="column" justifyContent="space-between">
          <Box flexDirection="column">
            <Box borderStyle="classic" borderColor="gray">
              <Text bold color="yellow">💬 Sessions List</Text>
            </Box>
            {sessions.length === 0 ? (
              <Text color="gray"> No sessions available.</Text>
            ) : (
              sessions.slice(0, 12).map((s) => (
                <Box key={s.id} paddingX={1}>
                  <Text color={selectedSessionId === s.id ? 'green' : 'white'} bold={selectedSessionId === s.id}>
                    {selectedSessionId === s.id ? '👉 ' : '  '}
                    {s.title.slice(0, 20)} ({s.messageCount})
                  </Text>
                </Box>
              ))
            )}
          </Box>
          <Box padding={1} borderStyle="classic" borderColor="gray">
            <Text color="gray">Ctrl+N: New Session</Text>
            <Text color="gray">Tab: Switch tab</Text>
          </Box>
        </Box>

        {/* Main Panel Panels based on Active Tab */}
        <Box flexGrow={1} borderStyle="single" borderColor="gray" padding={1} flexDirection="column">
          {activeTab === 'Chat' && (
            <Box flexDirection="column" flexGrow={1}>
              <Box borderStyle="classic" borderColor="yellow">
                <Text bold color="yellow">Active Session Messages (ID: {selectedSessionId || 'none'})</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} marginY={1}>
                {messages.length === 0 ? (
                  <Text color="gray">Ready for your prompt. Type below and press Enter!</Text>
                ) : (
                  messages.slice(-8).map(msg => {
                    const isSecurityBlock = msg.content.includes('Security Block') || msg.content.includes('🔒 Security Block') || msg.content.includes('🛡️ [Security Block]');
                    return (
                      <Box key={msg.id} flexDirection="column" marginBottom={1}>
                        <Text bold color={isSecurityBlock ? 'red' : (msg.role === 'user' ? 'magenta' : msg.role === 'system' ? 'yellow' : 'cyan')}>
                          {isSecurityBlock ? '🛡️ Security Block' : (msg.role === 'user' ? '> User' : msg.role === 'system' ? '⚙️ System' : '🤖 Ara')}:
                        </Text>
                        <Text color={isSecurityBlock ? 'red' : 'white'}>{msg.content.slice(0, 150)}</Text>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          )}

          {activeTab === 'Approvals' && (
            <Box flexDirection="column" flexGrow={1}>
              <Box borderStyle="classic" borderColor="red">
                <Text bold color="red">🛡️ Pending Approvals Gate ({approvals.length})</Text>
              </Box>
              {approvals.length === 0 ? (
                <Box marginTop={2}>
                  <Text color="gray">No pending actions require authorization.</Text>
                </Box>
              ) : (
                approvals.slice(0, 4).map(app => (
                  <Box key={app.id} borderStyle="round" borderColor="yellow" padding={1} flexDirection="column" marginBottom={1}>
                    <Text bold color="yellow">ID: {app.id} | Tool: {app.toolName}</Text>
                    <Text>Reason: {app.reason}</Text>
                    <Text>Args: {app.input.slice(0, 100)}</Text>
                    <Box flexDirection="row" marginTop={1}>
                      <Text color="green" bold>[Press A] Approve  </Text>
                      <Text color="red" bold>[Press R] Reject</Text>
                    </Box>
                  </Box>
                ))
              )}
            </Box>
          )}

          {activeTab === 'Tools' && (
            <Box flexDirection="column">
              <Box borderStyle="classic" borderColor="cyan">
                <Text bold color="cyan">🛠️ Registered Tools</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text>1. list_files: Read directories paths</Text>
                <Text>2. read_file: View target workspace content</Text>
                <Text>3. write_file: Write and create checkpoints backup</Text>
                <Text>4. run_shell: Run verified subprocess commands</Text>
                <Text>5. git_status: Inspect git status</Text>
                <Text>6. git_diff: Inspect local workspace code diffs</Text>
              </Box>
            </Box>
          )}

          {activeTab === 'Memory' && (
            <Box flexDirection="column">
              <Box borderStyle="classic" borderColor="magenta">
                <Text bold color="magenta">🧠 Search Memory Bullet-points</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                {memories.slice(0, 10).map(m => (
                  <Box key={m.id} marginBottom={1}>
                    <Text color="cyan">- [{m.type}] {m.title}: {m.content}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {activeTab === 'Skills' && (
            <Box flexDirection="column">
              <Box borderStyle="classic" borderColor="green">
                <Text bold color="green">🧠 Executable Skills Loaded ({skills.length})</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                {skills.map(s => (
                  <Box key={s.name} flexDirection="column" marginBottom={1}>
                    <Text bold color="green">{s.name} ({s.dangerLevel})</Text>
                    <Text color="gray">{s.description}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {activeTab === 'Audit' && (
            <Box flexDirection="column">
              <Box borderStyle="classic" borderColor="yellow">
                <Text bold color="yellow">📜 Immutable Audit Logs Trace</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                {auditLogs.slice(0, 6).map(log => (
                  <Box key={log.id} justifyContent="space-between" marginBottom={1}>
                    <Text>[{log.status === 'success' ? '✅' : '❌'}] {log.toolName}</Text>
                    <Text color="gray">{log.createdAt.slice(11, 19)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {activeTab === 'Status' && (
            <Box flexDirection="column">
              <Box borderStyle="classic" borderColor="blue">
                <Text bold color="blue">🖥️ Status Parameters Dashboard</Text>
              </Box>
              <Box flexDirection="column" marginTop={1}>
                <Text>API Reachable: Yes</Text>
                <Text>SQLite Engine status: {dbStatus}</Text>
                <Text>Docker sandbox isolation: {sandboxMode ? 'Enabled' : 'Disabled'}</Text>
                <Text>Active Permission Mode: {permissionMode.toUpperCase()}</Text>
                <Text>Skills loaded count: {skills.length}</Text>
                <Text>Episodic memories: {memories.length}</Text>
                <Text>Workspace root: {process.cwd()}</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {/* 3. Bottom Prompt Input & Shortcuts hints */}
      <Box borderStyle="classic" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Text bold color="magenta">Prompt: </Text>
          <Text>{inputVal}</Text>
          {isStreaming && <Text color="yellow"> ⏳ Streaming...</Text>}
        </Box>
        <Box justifyContent="space-between" marginTop={1}>
          <Text color="gray">Enter: Send prompt | Esc: Cancel | Ctrl+C: Close TUI</Text>
          <Box flexDirection="row">
            <Text color="yellow" bold>Shield Mode: {permissionMode.toUpperCase()}  </Text>
            <Text color="gray">| Active: {activeTab} panel</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
