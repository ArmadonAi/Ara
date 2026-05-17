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

  // Navigation & tabs — primary tabs always visible, secondary grouped
  const primaryTabs = ['Chat', 'Approvals', 'Checkpoints', 'MCP', 'GitHub', 'Status'] as const;
  const secondaryTabs = ['Subagents', 'Locks', 'Canvas', 'Tools', 'Memory', 'Skills', 'Learning', 'Audit'] as const;
  const allTabs = [...primaryTabs, ...secondaryTabs] as const;
  type TabType = typeof allTabs[number];
  const [activeTab, setActiveTab] = useState<TabType>('Chat');

  // Core entities
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [learningData, setLearningData] = useState<any>(null);
  const [learningDrafts, setLearningDrafts] = useState<any[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [subagents, setSubagents] = useState<any[]>([]);
  const [subagentRuns, setSubagentRuns] = useState<any[]>([]);
  
  // Checkpoints states
  const [checkpoints, setCheckpoints] = useState<any[]>([]);
  const [selectedCheckpointIndex, setSelectedCheckpointIndex] = useState<number>(0);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedCheckpointDetails, setSelectedCheckpointDetails] = useState<any | null>(null);
  const [checkpointDiff, setCheckpointDiff] = useState<any | null>(null);
  const [restoreMode, setRestoreMode] = useState<'code_only' | 'conversation_only' | 'both'>('code_only');
  const [showRestoreModal, setShowRestoreModal] = useState<boolean>(false);
  const [restoreStatus, setRestoreStatus] = useState<string>('');

  // MCP states
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [mcpHealth, setMcpHealth] = useState<any[]>([]);
  const [mcpOverview, setMcpOverview] = useState<any>(null);
  const [selectedMcpServerId, setSelectedMcpServerId] = useState<string | null>(null);
  const [selectedMcpServerDetail, setSelectedMcpServerDetail] = useState<any | null>(null);

  // GitHub states
  const [ghStatus, setGhStatus] = useState<any | null>(null);
  const [ghIssues, setGhIssues] = useState<any[]>([]);
  const [ghPrs, setGhPrs] = useState<any[]>([]);
  const [ghChecks, setGhChecks] = useState<any[]>([]);
  const [ghSelectedIssue, setGhSelectedIssue] = useState<any | null>(null);
  const [ghSelectedPr, setGhSelectedPr] = useState<any | null>(null);

  // Lock states
  const [lockList, setLockList] = useState<any[]>([]);
  const [lockAudit, setLockAudit] = useState<any[]>([]);
  const [parallelRuns, setParallelRuns] = useState<any[]>([]);
  const [showForceReleaseModal, setShowForceReleaseModal] = useState(false);
  const [forceReleaseLockId, setForceReleaseLockId] = useState<string | null>(null);

  // Status parameters

  // Canvas states
  const [canvasWorkspaces, setCanvasWorkspaces] = useState<any[]>([]);
  const [selectedCanvasWs, setSelectedCanvasWs] = useState<any | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<any[]>([]);
  const [canvasEdgesCount, setCanvasEdgesCount] = useState(0);
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [apiReachable, setApiReachable] = useState<boolean>(true);
  const [version, setVersion] = useState<string>('unknown');
  const [dbStatus, setDbStatus] = useState<string>('unknown');
  const [sandboxMode, setSandboxMode] = useState<boolean>(false);
  const [permissionMode, setPermissionMode] = useState<string>('default');
  const [hasSomeKeys, setHasSomeKeys] = useState<boolean>(true);

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

        try {
          const keys = await client.getConfigKeys();
          setHasSomeKeys(keys.GEMINI_API_KEY || keys.OPENAI_API_KEY || keys.ANTHROPIC_API_KEY);
        } catch (e) {
          setHasSomeKeys(true);
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
        // Load learning data
        try {
          const sl = await client.getSkillLearningOverview();
          setLearningData(sl);
          const draftsData = await client.listSkillDrafts();
          setLearningDrafts(draftsData.drafts || []);
        } catch (e) {}
        setMemories(await client.listMemory());
        setAuditLogs(await client.listAuditLogs());
        try {
          setSubagents(await client.listSubagents());
          setSubagentRuns(await client.listSubagentRuns());
        } catch (err) {}

        try {
          const chks = await client.listCheckpoints();
          setCheckpoints(chks);
          if (chks.length > 0 && chks[0]) {
            setSelectedCheckpointId(chks[0].id);
            setSelectedCheckpointIndex(0);
            try {
              setSelectedCheckpointDetails(await client.getCheckpoint(chks[0].id));
              setCheckpointDiff(await client.diffCheckpoint(chks[0].id));
            } catch (e) {}
          }
        } catch (e) {}
        // Load MCP data
        try {
          const overview = await client.getMcpOverview();
          setMcpOverview(overview);
          const serverData = await client.listMcpServers();
          setMcpServers(serverData.servers || []);
          if (serverData.servers && serverData.servers.length > 0 && !selectedMcpServerId) {
            setSelectedMcpServerId(serverData.servers[0].id);
          }
          if (selectedMcpServerId) {
            try {
              setSelectedMcpServerDetail(await client.getMcpServer(selectedMcpServerId));
            } catch (e) {}
          }
          const healthData = await client.getMcpHealth();
          setMcpHealth(healthData.results || []);
        } catch (e) {}
        // Load GitHub data
        try {
          const statusData = await client.getGitHubStatus();
          setGhStatus(statusData);
          if (statusData.configured && statusData.defaultOwner && statusData.defaultRepo) {
            const [owner, repo] = [statusData.defaultOwner, statusData.defaultRepo];
            try {
              const issuesData = await client.getGitHubIssues(owner, repo);
              if (issuesData.ok) setGhIssues(JSON.parse(issuesData.output || '[]'));
            } catch (e) {}
            try {
              const prsData = await client.getGitHubPRs(owner, repo);
              if (prsData.ok) setGhPrs(JSON.parse(prsData.output || '[]'));
            } catch (e) {}
          }
        } catch (e) {}
        // Load canvas data
        try {
          const wsData = await client.listCanvasWorkspaces();
          setCanvasWorkspaces(wsData.workspaces || []);
        } catch (e) {}
        // Load lock data
        try {
          const lockData = await client.listLocks();
          setLockList(lockData.locks || []);
          const auditData = await client.getLockAudit(20);
          setLockAudit(auditData.records || []);
          const paraData = await client.listParallelRuns();
          setParallelRuns(paraData.runs || []);
        } catch (e) {}
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
        
        try {
          const keys = await client.getConfigKeys();
          setHasSomeKeys(keys.GEMINI_API_KEY || keys.OPENAI_API_KEY || keys.ANTHROPIC_API_KEY);
        } catch (e) {}

        const apps = await client.listApprovals();
        setApprovals(apps.filter(a => a.status === 'pending'));

        // Refresh sessions list
        const sess = await client.listSessions();
        setSessions(sess);

        try {
          setSubagents(await client.listSubagents());
          setSubagentRuns(await client.listSubagentRuns());
        } catch (err) {}

        try {
          const chks = await client.listCheckpoints();
          setCheckpoints(chks);
        } catch (e) {}
        // Refresh MCP data
        try {
          const serverData = await client.listMcpServers();
          setMcpServers(serverData.servers || []);
          const healthData = await client.getMcpHealth();
          setMcpHealth(healthData.results || []);
        } catch (e) {}
        // Refresh GitHub data
        try {
          const statusData = await client.getGitHubStatus();
          setGhStatus(statusData);
        } catch (e) {}
        // Refresh canvas data
        try {
          const wsData = await client.listCanvasWorkspaces();
          setCanvasWorkspaces(wsData.workspaces || []);
        } catch (e) {}
        // Refresh lock data
        try {
          const lockData = await client.listLocks();
          setLockList(lockData.locks || []);
          const paraData = await client.listParallelRuns();
          setParallelRuns(paraData.runs || []);
        } catch (e) {}
        // Refresh learning data
        try {
          const sl = await client.getSkillLearningOverview();
          setLearningData(sl);
          const draftsData = await client.listSkillDrafts();
          setLearningDrafts(draftsData.drafts || []);
        } catch (e) {}
      } catch (e) {
        setApiReachable(false);
      }
    }, 15000);

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

    // Modal input interceptor
    if (showRestoreModal) {
      if (input === 'y' || input === 'Y') {
        if (selectedCheckpointId) {
          setRestoreStatus('Restoring...');
          try {
            await client.restoreCheckpoint(selectedCheckpointId, restoreMode);
            setRestoreStatus('[OK]');
            setTimeout(async () => {
              setShowRestoreModal(false);
              setRestoreStatus('');
              try {
                const chks = await client.listCheckpoints();
                setCheckpoints(chks);
              } catch (e) {}
            }, 2000);
          } catch (err: any) {
            setRestoreStatus(`Failed: ${err.message}`);
          }
        }
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setShowRestoreModal(false);
        setRestoreStatus('');
        return;
      }
      return; // Freeze all other keypresses
    }

    // Checkpoints Tab specific key interceptors (UP/DOWN/C/V/B/R)
    if (activeTab === 'Checkpoints') {
      if (key.upArrow && checkpoints.length > 0) {
        const prevIdx = (selectedCheckpointIndex - 1 + checkpoints.length) % checkpoints.length;
        setSelectedCheckpointIndex(prevIdx);
        const target = checkpoints[prevIdx];
        if (target) {
          setSelectedCheckpointId(target.id);
          try {
            setSelectedCheckpointDetails(await client.getCheckpoint(target.id));
            setCheckpointDiff(await client.diffCheckpoint(target.id));
          } catch (e) {}
        }
        return;
      }
      if (key.downArrow && checkpoints.length > 0) {
        const nextIdx = (selectedCheckpointIndex + 1) % checkpoints.length;
        setSelectedCheckpointIndex(nextIdx);
        const target = checkpoints[nextIdx];
        if (target) {
          setSelectedCheckpointId(target.id);
          try {
            setSelectedCheckpointDetails(await client.getCheckpoint(target.id));
            setCheckpointDiff(await client.diffCheckpoint(target.id));
          } catch (e) {}
        }
        return;
      }
      if (input === 'c' || input === 'C') {
        setRestoreMode('code_only');
        return;
      }
      if (input === 'v' || input === 'V') {
        setRestoreMode('conversation_only');
        return;
      }
      if (input === 'b' || input === 'B') {
        setRestoreMode('both');
        return;
      }
      if (input === 'r' || input === 'R') {
        if (selectedCheckpointId) {
          setShowRestoreModal(true);
        }
        return;
      }
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
      const idx = allTabs.indexOf(activeTab);
      const nextIdx = key.shift ? (idx - 1 + allTabs.length) % allTabs.length : (idx + 1) % allTabs.length;
      setActiveTab(allTabs[nextIdx]!);
      return;
    }

    // Direct tab shortcut keys
    if (input === 'b') { setActiveTab('Subagents'); return; }
    if (input === 'a') { setActiveTab('Approvals'); return; }
    if (input === 'm') { setActiveTab('Memory'); return; }
    if (input === 's') { setActiveTab('Skills'); return; }
    if (input === 't') { setActiveTab('Tools'); return; }
    if (input === 'g') { setActiveTab('Audit'); return; }

    // Session Switcher Arrow keys (up/down) in Sidebar (only if not activeTab checkpoints)
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
      <Box flexDirection="column" padding={2}>
        <Text color="red" bold>Terminal too small ({terminalWidth}x{terminalHeight}). Resize to 80x20+.</Text>
      </Box>
    );
  }

  // Dashboard Offline Banner
  if (!apiReachable) {
    return (
      <Box flexDirection="column" padding={2} width={terminalWidth - 4}>
        <Text color="red" bold>API server unreachable at {getApiBaseUrl()}</Text>
        <Text color="yellow">Start with: bun run dev:api</Text>
        <Text color="gray">Press Ctrl+C to exit.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      {/* 1. ASCII Header */}
      <Box flexDirection="column">
        <Text color="cyan">
          {'  ___ _  ___    ___ _   _ ___ '.padEnd(terminalWidth - 1, ' ')}
        </Text>
        <Text color="cyan">
          {' / _ \\ |/ _ \\  / __| | | / __|'.padEnd(terminalWidth - 1, ' ')}
        </Text>
        <Text color="cyan">
          {'| (_)   | (_) | (__| |_| \\__ \\'.padEnd(terminalWidth - 1, ' ')}
        </Text>
        <Text color="cyan">
          {' \\___/_|\\___/  \\___|\\__,_|___/'.padEnd(terminalWidth - 1, ' ')}
        </Text>
        <Text color="gray">{''.padEnd(terminalWidth - 1, '─')}</Text>
      </Box>
      {/* Tab bar */}
      <Box flexDirection="row" paddingX={1}>
        {primaryTabs.map(tab => (
          <Box key={tab} marginRight={2}>
            <Text bold={activeTab === tab} color={activeTab === tab ? 'green' : 'white'} inverse={activeTab === tab}>
              {activeTab === tab ? `[${tab}]` : ` ${tab} `}
            </Text>
          </Box>
        ))}
        <Text color="gray">│</Text>
        {secondaryTabs.map(tab => (
          <Box key={tab} marginLeft={1}>
            <Text color={activeTab === tab ? 'green' : 'gray'}>
              {tab}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">{''.padEnd(terminalWidth - 1, '─')}</Text>

      {/* 2. Main Content layout (Split sidebar and panel) */}
      <Box flexGrow={1} flexDirection="row">
        {/* Sidebar */}
        <Box width={28} flexDirection="column" justifyContent="space-between">
          <Box flexDirection="column" paddingX={1}>
            {activeTab === 'Checkpoints' ? (
              <>
                <Text bold color="yellow">Checkpoints</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                {checkpoints.length === 0 ? (
                  <Text color="gray"> (empty)</Text>
                ) : (
                  checkpoints.slice(0, 12).map((c) => (
                    <Text key={c.id} color={selectedCheckpointId === c.id ? 'green' : 'white'} bold={selectedCheckpointId === c.id}>
                      {'> '}{c.id.slice(0, 8)}
                    </Text>
                  ))
                )}
              </>
            ) : activeTab === 'MCP' ? (
              <>
                <Text bold color="yellow">MCP Servers</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                {mcpServers.length === 0 ? (
                  <Text color="gray"> (empty)</Text>
                ) : (
                  mcpServers.slice(0, 12).map((s) => (
                    <Text key={s.id} color={selectedMcpServerId === s.id ? 'green' : 'white'}>
                      {'> '}{s.id.slice(0, 16)}
                    </Text>
                  ))
                )}
              </>
            ) : activeTab === 'GitHub' ? (
              <>
                <Text bold color="yellow">GitHub</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                <Text color="gray">Token: {ghStatus?.tokenPresent ? 'yes' : 'no'}</Text>
                <Text color="gray">Repo: {ghStatus?.defaultOwner || '?'}/{ghStatus?.defaultRepo || '?'}</Text>
              </>
            ) : activeTab === 'Locks' ? (
              <>
                <Text bold color="yellow">Locks</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                {lockList.length === 0 ? (
                  <Text color="gray"> (empty)</Text>
                ) : (
                  lockList.slice(0, 8).map((l: any) => (
                    <Text key={l.id}>{l.mode === 'write' ? 'W' : 'R'} {l.path?.slice(-18)}</Text>
                  ))
                )}
                <Text bold color="yellow">Parallel Runs</Text>
                {parallelRuns.slice(0, 3).map((r: any) => (
                  <Text key={r.id}>{r.status?.slice(0, 6)} {(r.profiles || []).length}a</Text>
                ))}
              </>
            ) : activeTab === 'Canvas' ? (
              <>
                <Text bold color="yellow">Canvas</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                {canvasWorkspaces.length === 0 ? (
                  <Text color="gray"> (empty)</Text>
                ) : (
                  canvasWorkspaces.slice(0, 10).map((ws: any) => (
                    <Text key={ws.id}>{(ws.name || '').slice(0, 20)}</Text>
                  ))
                )}
              </>
            ) : (
              <>
                <Text bold color="yellow">Sessions</Text>
                <Text color="gray">{''.padEnd(26, '─')}</Text>
                {sessions.length === 0 ? (
                  <Text color="gray"> (empty)</Text>
                ) : (
                  sessions.slice(0, 12).map((s) => (
                    <Text key={s.id} color={selectedSessionId === s.id ? 'green' : 'white'} bold={selectedSessionId === s.id}>
                      {'> '}{s.title.slice(0, 20)} ({s.messageCount})
                    </Text>
                  ))
                )}
              </>
            )}
          </Box>
          <Box paddingX={1}>
            <Text color="gray">v{version} [{permissionMode.toUpperCase()}]</Text>
          </Box>
        </Box>

        {/* Separator */}
        <Box width={1}><Text color="gray">│</Text></Box>
        {/* Main Panel */}
        <Box flexGrow={1} paddingX={1} flexDirection="column">
          {activeTab === 'Chat' && (
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="column" flexGrow={1}>
                {messages.length === 0 ? (
                  <Text color="gray">Type a message and press Enter.</Text>
                ) : (
                  messages.slice(-8).map(msg => {
                    const isSecurityBlock = msg.content.includes('Security Block') || msg.content.includes('🔒 Security Block') || msg.content.includes('🛡️ [Security Block]');
                    return (
                      <Box key={msg.id} flexDirection="column" marginBottom={1}>
                        <Text bold color={isSecurityBlock ? 'red' : (msg.role === 'user' ? 'magenta' : msg.role === 'system' ? 'yellow' : 'cyan')}>
                          {isSecurityBlock ? 'Security Block' : (msg.role === 'user' ? 'User' : msg.role === 'system' ? 'System' : 'Ara')}:
                        </Text>
                        <Text color={isSecurityBlock ? 'red' : 'white'}>{msg.content.slice(0, 150)}</Text>
                      </Box>
                    );
                  })
                )}
              </Box>
            </Box>
          )}

          {activeTab === 'Subagents' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="green">Subagent Profiles</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              <Box flexDirection="row" flexGrow={1} marginTop={1}>
                {/* Left panel: Profiles list */}
                <Box width={35} flexDirection="column" marginRight={2}>
                  <Text bold color="yellow">Available Profiles:</Text>
                  {subagents.length === 0 ? (
                    <Text color="gray">None found.</Text>
                  ) : (
                    subagents.map(p => (
                      <Box key={p.name} flexDirection="column" marginY={1}>
                        <Text bold color="cyan">- {p.name}</Text>
                        <Text color="gray">{p.description.slice(0, 30)}...</Text>
                      </Box>
                    ))
                  )}
                </Box>
                {/* Right panel: Recent Runs */}
                <Box flexGrow={1} flexDirection="column">
                  <Text bold color="yellow">Recent Delegation Runs:</Text>
                  {subagentRuns.length === 0 ? (
                    <Text color="gray">None recorded.</Text>
                  ) : (
                    subagentRuns.slice(0, 4).map(r => {
                      const statusIcon = r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'FAIL' : r.status === 'cancelled' ? 'CANCEL' : '...';
                      return (
                        <Box key={r.id} flexDirection="column" paddingX={1} marginY={1}>
                          <Text bold color="cyan">[{statusIcon}] {r.profileName}</Text>
                          <Text color="white">  Task: {r.task.slice(0, 40)}</Text>
                          <Text color="gray">  Status: {r.status}</Text>
                        </Box>
                      );
                    })
                  )}
                </Box>
              </Box>
            </Box>
          )}

          {activeTab === 'Approvals' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="red">Pending Approvals</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              {approvals.length === 0 ? (
                <Box marginTop={2}>
                  <Text color="gray">None pending.</Text>
                </Box>
              ) : (
                approvals.slice(0, 4).map(app => (
                  <Box key={app.id} flexDirection="column" paddingX={1} marginBottom={1}>
                    <Text bold color="yellow">Tool: {app.toolName}</Text>
                    <Text>  Reason: {app.reason}</Text>
                    <Text>  Args: {app.input.slice(0, 80)}</Text>
                    <Box flexDirection="row">
                      <Text color="green" bold>  [A] Approve  </Text>
                      <Text color="red" bold>[R] Reject</Text>
                    </Box>
                  </Box>
                ))
              )}
            </Box>
          )}

          {activeTab === 'Checkpoints' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="green">Checkpoints</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              
              {showRestoreModal ? (
                <Box flexDirection="column" padding={1} marginY={1}>
                  <Text color="red" bold>Restore: {selectedCheckpointId}</Text>
                  <Text color="yellow">Mode: {restoreMode.toUpperCase()}</Text>
                  {restoreStatus ? (
                    <Text color="yellow" bold>{restoreStatus}</Text>
                  ) : (
                    <Box flexDirection="row" marginTop={1}>
                      <Text color="green" bold>[Y] Confirm  </Text>
                      <Text color="red" bold>[N/Esc] Cancel</Text>
                    </Box>
                  )}
                </Box>
              ) : (
                <Box flexDirection="row" flexGrow={1} marginTop={1}>
                  {/* Left Column: Details */}
                  <Box flexGrow={1} flexDirection="column" marginRight={2}>
                    <Text bold color="yellow">Selected Checkpoint Details:</Text>
                    {selectedCheckpointDetails ? (
                      <Box flexDirection="column" marginY={1}>
                        <Text color="white">Reason:      <Text color="cyan" bold>{selectedCheckpointDetails.reason}</Text></Text>
                        <Text color="white">Created By:  <Text color="yellow">{selectedCheckpointDetails.createdBy}</Text></Text>
                        <Text color="white">Time:        <Text color="gray">{selectedCheckpointDetails.createdAt}</Text></Text>
                        <Text color="white">Commit Head: <Text color="gray">{selectedCheckpointDetails.gitHead || 'none'}</Text></Text>
                        <Text color="white">Messages:    <Text color="gray">{selectedCheckpointDetails.messageCount || 0}</Text></Text>
                        <Text color="white">Files Count: <Text color="gray">{selectedCheckpointDetails.files?.length || 0} snapshotted</Text></Text>
                      </Box>
                    ) : (
                      <Box marginY={1}>
                        <Text color="gray">No checkpoint selected.</Text>
                      </Box>
                    )}

                    <Box marginTop={1}>
                      <Text bold color="yellow">Select Restore Mode:</Text>
                    </Box>
                    
                    <Box flexDirection="column" marginY={1}>
                      <Text color={restoreMode === 'code_only' ? 'green' : 'white'} bold={restoreMode === 'code_only'}>
                        {restoreMode === 'code_only' ? '●' : '○'} [Press C] Code Only (Restore workspace code files)
                      </Text>
                      <Text color={restoreMode === 'conversation_only' ? 'green' : 'white'} bold={restoreMode === 'conversation_only'}>
                        {restoreMode === 'conversation_only' ? '●' : '○'} [Press V] Msg Only (Rewind chat messages)
                      </Text>
                      <Text color={restoreMode === 'both' ? 'green' : 'white'} bold={restoreMode === 'both'}>
                        {restoreMode === 'both' ? '●' : '○'} [Press B] Both (Full Code and Chat Rewind)
                      </Text>
                    </Box>

                    {selectedCheckpointId && (
                      <Box marginTop={1}>
                        <Text color="red" bold inverse>  [Press R] Trigger Safe Restore Confirmation Modal  </Text>
                      </Box>
                    )}
                  </Box>

                  {/* Right Column: Diffs */}
                  <Box width={40} flexDirection="column">
                    <Text bold color="yellow">Workspace Diff relative to Checkpoint:</Text>
                    {checkpointDiff ? (
                      <Box flexDirection="column" marginY={1}>
                        {checkpointDiff.modified?.length === 0 && checkpointDiff.created?.length === 0 && checkpointDiff.deleted?.length === 0 ? (
                          <Text color="green">Workspace is identical to checkpoint.</Text>
                        ) : (
                          <>
                            {checkpointDiff.created?.map((f: string) => (
                              <Text key={f} color="green">[+] {f.slice(0, 35)}</Text>
                            ))}
                            {checkpointDiff.modified?.map((f: string) => (
                              <Text key={f} color="yellow">[~] {f.slice(0, 35)}</Text>
                            ))}
                            {checkpointDiff.deleted?.map((f: string) => (
                              <Text key={f} color="red">[-] {f.slice(0, 35)}</Text>
                            ))}
                          </>
                        )}
                        {checkpointDiff.skipped?.length > 0 && (
                          <Box marginTop={1}>
                            <Text color="gray">. Skipped (Large/Secret/Binary): {checkpointDiff.skipped.length} files</Text>
                          </Box>
                        )}
                      </Box>
                    ) : (
                      <Box marginY={1}>
                        <Text color="gray">Select a checkpoint to see the workspace diff.</Text>
                      </Box>
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'MCP' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="green">MCP External Tools</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              {mcpServers.length === 0 ? (
                <Text color="gray"> None configured. Edit .ara/mcp.json</Text>
              ) : (
                <Box flexDirection="row" flexGrow={1} marginTop={1}>
                  <Box width={40} flexDirection="column" marginRight={1}>
                    <Text bold color="yellow">Servers</Text>
                    {mcpServers.map(s => {
                      const sel = selectedMcpServerId === s.id;
                      const health = mcpHealth.find(h => h.serverId === s.id);
                      const st = health?.state || s.state || 'unknown';
                      return (
                        <Box key={s.id} flexDirection="column" marginY={1} paddingX={1}>
                          <Text bold color={sel ? 'green' : 'cyan'}>{sel ? '> ' : '  '}{s.id} {s.enabled ? '' : '(off)'}</Text>
                          <Text color="white">  Type: {s.type} | Mode: {s.permissionMode || 'default'} | State: {st}</Text>
                        </Box>
                      );
                    })}
                  </Box>
                  <Box flexGrow={1} flexDirection="column">
                    <Text bold color="yellow">Server Details</Text>
                    {selectedMcpServerId ? (
                      <Box flexDirection="column" marginTop={1}>
                        <Text>ID: {selectedMcpServerId}</Text>
                        <Text>Tools: {selectedMcpServerDetail?.tools?.length || 0}</Text>
                        <Text>State: {selectedMcpServerDetail?.state || 'unknown'}</Text>
                        <Text>Error: {selectedMcpServerDetail?.lastError || 'none'}</Text>
                        {selectedMcpServerDetail?.tools?.length > 0 && (
                          <>
                            <Text bold color="green" marginTop={1}>Discovered Tools:</Text>
                            {selectedMcpServerDetail.tools.slice(0, 8).map((t: any) => (
                              <Text key={t.name}>  [{t.mutating ? 'M' : ' '}] {t.name} ({t.dangerLevel})</Text>
                            ))}
                          </>
                        )}
                      </Box>
                    ) : (
                      <Text color="gray">Select a server from the sidebar.</Text>
                    )}
                    {mcpHealth.length > 0 && (
                      <>
                        <Text bold color="yellow" marginTop={1}>Health Summary</Text>
                        {mcpHealth.slice(0, 4).map(h => (
                          <Text key={h.serverId}>  {h.serverId}: state={h.state} tools={h.toolCount}</Text>
                        ))}
                      </>
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'GitHub' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="green">GitHub Integration</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              {!ghStatus?.configured ? (
                <Text color="gray"> GitHub not configured. See docs/GITHUB.md</Text>
              ) : (
                <Box flexDirection="row" flexGrow={1} marginTop={1}>
                  <Box width={40} flexDirection="column" marginRight={1}>
                    <Text bold color="yellow">Configuration</Text>
                    <Text>Status: {ghStatus.tokenPresent ? 'Connected' : 'No Token'}</Text>
                    <Text>ReadOnly: {ghStatus.readOnly ? 'Yes' : 'No'}</Text>
                    <Text>Default: {ghStatus.defaultOwner || '?'}/{ghStatus.defaultRepo || '?'}</Text>
                    <Text bold color="yellow" marginTop={1}>Issues (open)</Text>
                    {ghIssues.length === 0 ? <Text color="gray"> None loaded</Text> : (
                      ghIssues.slice(0, 5).map((i: any) => (
                        <Box key={i.id || i.number} paddingX={1}>
                          <Text color="white">#{i.number} {String(i.title || '').slice(0, 25)}</Text>
                        </Box>
                      ))
                    )}
                    <Text bold color="yellow" marginTop={1}>PRs (open)</Text>
                    {ghPrs.length === 0 ? <Text color="gray"> None loaded</Text> : (
                      ghPrs.slice(0, 5).map((p: any) => (
                        <Box key={p.id || p.number} paddingX={1}>
                          <Text color="white">#{p.number} {String(p.title || '').slice(0, 25)}</Text>
                        </Box>
                      ))
                    )}
                  </Box>
                  <Box flexGrow={1} flexDirection="column">
                    <Text bold color="yellow">Allowed Repos</Text>
                    <Text color="gray">{(ghStatus.allowedRepos || []).length > 0 ? ghStatus.allowedRepos.join(', ') : 'All repos allowed'}</Text>
                    <Text bold color="yellow" marginTop={1}>Token Environment Variable</Text>
                    <Text color="gray">{ghStatus.tokenEnv || 'GITHUB_TOKEN'}</Text>
                    <Text color="gray" marginTop={1}>Token value is never displayed</Text>
                    <Text bold color="yellow" marginTop={1}>Rate Limits</Text>
                    <Text color="gray">Check via CLI: ara github status</Text>
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'Locks' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="yellow">File Locks & Parallel Runs</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              <Box flexDirection="row" flexGrow={1} marginTop={1}>
                <Box width={45} flexDirection="column" marginRight={1}>
                  <Text bold color="yellow">Active Locks ({lockList.length})</Text>
                  {lockList.length === 0 ? <Text color="gray"> No active locks.</Text> : (
                    lockList.slice(0, 8).map((l: any) => (
                      <Box key={l.id} paddingX={1} marginY={1}>
                        <Text>{l.mode === 'write' ? 'Write' : 'Read'} on {l.path?.slice(-30)}</Text>
                        <Text color="gray">  Owner: {l.agentName || l.sessionId}  Expires: {(l.expiresAt || '').slice(11, 19)}</Text>
                      </Box>
                    ))
                  )}
                  <Text bold color="yellow" marginTop={1}>Parallel Runs ({parallelRuns.length})</Text>
                  {parallelRuns.length === 0 ? <Text color="gray"> No parallel runs.</Text> : (
                    parallelRuns.slice(0, 4).map((r: any) => (
                      <Box key={r.id} paddingX={1} marginY={1}>
                        <Text>Status: {r.status}  Agents: {(r.profiles || []).length}  Results: {(r.results || []).length}</Text>
                        <Text color="gray">  ID: {r.id?.slice(0, 20)}</Text>
                      </Box>
                    ))
                  )}
                </Box>
                <Box flexGrow={1} flexDirection="column">
                  <Text bold color="yellow">Recent Lock Audit</Text>
                  {lockAudit.length === 0 ? <Text color="gray"> No audit records.</Text> : (
                    lockAudit.slice(0, 8).map((a: any) => (
                      <Text key={a.id}>[{a.event?.slice(0, 18).padEnd(18)}] {a.path || a.lockId || ''}</Text>
                    ))
                  )}
                  <Text color="gray" marginTop={1}>CLI: ara locks list, ara locks cleanup, ara locks audit</Text>
                  <Text color="gray">Slash: /locks list, /locks cleanup, /parallel-runs</Text>
                </Box>
              </Box>
            </Box>
          )}

          {activeTab === 'Canvas' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="cyan">Canvas Workspaces</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              {!apiReachable ? (
                <Text color="red">API offline.</Text>
              ) : canvasWorkspaces.length === 0 ? (
                <Text color="gray"> None. Create with: ara canvas create "name"</Text>
              ) : (
                <Box flexDirection="row" flexGrow={1} marginTop={1}>
                  <Box width={40} flexDirection="column" marginRight={1}>
                    <Text bold color="yellow">Workspaces ({canvasWorkspaces.length})</Text>
                    {canvasWorkspaces.slice(0, 8).map((ws: any) => (
                      <Box key={ws.id} paddingX={1} marginY={1}>
                        <Text bold color="cyan">{(ws.name || '').slice(0, 24)}</Text>
                        <Text color="gray">  ID: {(ws.id || '').slice(0, 12)}</Text>
                        <Text color="gray">  Created: {(ws.createdAt || '').slice(0, 10)}</Text>
                      </Box>
                    ))}
                  </Box>
                  <Box flexGrow={1} flexDirection="column">
                    <Text bold color="yellow">Commands</Text>
                    <Text color="gray">  ara canvas list              - List workspaces</Text>
                    <Text color="gray">  ara canvas show &lt;id&gt;     - Show workspace</Text>
                    <Text color="gray">  ara canvas create &lt;name&gt; - Create workspace</Text>
                    <Text color="gray">  ara canvas export &lt;id&gt;   - Export workspace</Text>
                    <Text color="gray">  ara canvas add-node &lt;id&gt; - Add node</Text>
                    <Text color="gray">  Slash: /canvas list, /canvas create &lt;name&gt;</Text>
                    <Text color="gray" marginTop={1}>Auto-refresh every 15s</Text>
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'Tools' && (
            <Box flexDirection="column">
              <Text bold color="cyan">Registered Tools</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
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
              <Text bold color="magenta">Memories</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
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
              <Text bold color="green">Skills</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
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

          {activeTab === 'Learning' && (
            <Box flexDirection="column" flexGrow={1}>
              <Text bold color="green">Skill Learning</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              {!apiReachable ? (
                <Text color="red">API offline.</Text>
              ) : (
                <Box flexDirection="row" flexGrow={1} marginTop={1}>
                  <Box width={35} flexDirection="column" marginRight={1}>
                    <Text bold color="yellow">Overview</Text>
                    <Text color="gray">Workflows: {learningData?.workflowCount || 0}</Text>
                    <Text color="gray">Repeated: {learningData?.repeatedCount || 0}</Text>
                    <Text color="gray">Drafts: {learningDrafts.length}</Text>
                    {learningDrafts.length > 0 && (
                      <>
                        <Text bold color="yellow" marginTop={1}>Drafts</Text>
                        {learningDrafts.slice(0, 6).map((d: any) => (
                          <Box key={d.id} paddingX={1}>
                            <Text color="white">{(d.status || '').slice(0, 6).padEnd(8)} {(d.proposedSkillName || '').slice(0, 18)}</Text>
                          </Box>
                        ))}
                      </>
                    )}
                  </Box>
                  <Box flexGrow={1} flexDirection="column">
                    <Text bold color="yellow">Commands</Text>
                    <Text color="gray">ara skills suggest              - Overview</Text>
                    <Text color="gray">ara skills workflows            - Repeated workflows</Text>
                    <Text color="gray">ara skills analyze-recent       - Auto-detect patterns</Text>
                    <Text color="gray">ara skills drafts               - List drafts</Text>
                    <Text color="gray">ara skills draft &lt;id&gt;      - Show draft</Text>
                    <Text color="gray">ara skills approve &lt;id&gt;    - Approve draft</Text>
                    <Text color="gray">ara skills reject &lt;id&gt;     - Reject draft</Text>
                    <Text color="gray" marginTop={1}>Slash: /skills suggest, /skills drafts</Text>
                    <Text color="gray">Note: Approval requires explicit CLI command</Text>
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {activeTab === 'Audit' && (
            <Box flexDirection="column">
              <Text bold color="yellow">Audit Logs</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              <Box flexDirection="column" marginTop={1}>
                {auditLogs.slice(0, 6).map(log => (
                  <Box key={log.id} justifyContent="space-between" marginBottom={1}>
                    <Text>[{log.status === 'success' ? 'ok' : 'FAIL'}] {log.toolName}</Text>
                    <Text color="gray">{log.createdAt.slice(11, 19)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {activeTab === 'Status' && (
            <Box flexDirection="column">
              <Text bold color="blue">Status</Text>
              <Text color="gray">{''.padEnd(terminalWidth - 40, '─')}</Text>
              <Box flexDirection="column" marginTop={1}>
                <Text>API Reachable: Yes</Text>
                <Text>SQLite Engine status: {dbStatus}</Text>
                <Text>Docker sandbox isolation: {sandboxMode ? 'Enabled' : 'Disabled'}</Text>
                <Text>Active Permission Mode: {permissionMode.toUpperCase()}</Text>
                <Text>LLM Provider Credentials: {hasSomeKeys ? 'CONFIGURED ✓' : 'MISSING ✗ (Warning)'}</Text>
                <Text>Skills loaded count: {skills.length}</Text>
                <Text>Episodic memories: {memories.length}</Text>
                <Text>Workspace root: {process.cwd()}</Text>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {/* 3. Bottom Input Bar */}
      <Text color="gray">{''.padEnd(terminalWidth - 1, '─')}</Text>
      <Box paddingX={1} paddingY={0}>
        <Box flexDirection="row" flexGrow={1}>
          <Text bold color="magenta">{'> '}</Text>
          <Text>{inputVal}</Text>
          {isStreaming && <Text color="yellow"> ...</Text>}
        </Box>
        <Box>
          <Text color="gray">Tab:nav | Enter:send | ^N:session</Text>
        </Box>
      </Box>
    </Box>
  );
}
