# 🔍 Ara Personal AI Control Plane - Gap Analysis

This document identifies feature disparities, architecture constraints, and structural opportunities when comparing Ara's current release candidate (v0.1-RC2) to the observable patterns of Claude Code.

---

## 1. Feature Parity & Gap Matrix

| Feature Concept | Claude Code Behavior | Ara (v0.1-RC2) Status | Gaps Identified |
|:---|:---|:---|:---|
| **Agentic Loop** | Synchronous, token-efficient terminal ReAct loop. | Full asynchronous ReAct loop streaming via SSE. | None. Ara handles async streaming extremely well. |
| **Session State** | JSONL transcripts, Resume session, Fork session. | SQLite database persistence for chat history. | No JSONL file-based export. Cannot resume or fork sessions at specific message indexes. |
| **Workspace Context** | Reads `CLAUDE.md` and appends episodic auto-memories. | SQLite episodic memories + Reads human USER.md/MEMORY.md. | No automatic local memory update mechanism or CLAUDE.md integration. |
| **Local Config Store** | `.claude/` in project workspace. | `~/.ara/config.json` global configuration. | Missing project-specific local configuration support. |
| **Permission Modes** | Global permit modes, Interactive/Non-interactive rules. | Interacts with UI approval gates via Hono routes. | CLI one-shot operations block on gates if running in non-interactive shell pipelines. |
| **Hooks Lifecycle** | `pre-agent`, `post-agent`, and `pre-tool` scripts. | No lifecycle event hooks. | Developers cannot attach automated pre-run or post-run scripts. |
| **Rewind & Recovery** | Undo file changes back to last tool execution state. | Git checkout backups inside `.ara/backups/`. | No CLI commands to trigger manual rollbacks (rewinds) from the command line. |
| **Slash Commands** | `/help`, `/compact`, `/model`, `/doctor`, etc. in terminal prompts. | No command router. Commands are routed via Commander options. | CLI/TUI chat prompt cannot trigger special sub-routines (e.g. changing model inline). |
| **Subagents** | Isolated LLM subprocesses that solve directory search tasks. | Single-agent streaming context loop. | Context gets crowded when the agent processes verbose directory listings. |
| **Context Management** | Summarizes oldest history on-the-fly when full. | Keeps standard chat message array without automatic pruning. | Risk of token limit overflow on extremely long interactive sessions. |
| **Extensibility** | MCP (Model Context Protocol) plugin model. | Markdown YAML frontmatter Skills. | Skills are local-only and lack a dynamic network RPC execution wrapper. |

---

## 2. Priority Gaps to Resolve in Phase 14

To turn Ara into a developer control plane, we will prioritize implementing the following gaps:

1. **Slash Commands System**: Incorporate a command parser and registry inside a new `packages/commands` module to handle inline execution parameters.
2. **Session Transcripts**: Add JSONL log exports to standard file pathways to match observable transcript logging.
3. **Resume & Fork Operations**: Implement Hono routes and corresponding CLI commands (`ara resume`, `ara fork`) to allow developers to resume, inspect, or branch off conversations.
4. **Context Compaction & Doctor Tools**: Provide command utilities to manually summarize chat contexts and diagnose workspace environments.
