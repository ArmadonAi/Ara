# 🛠️ Ara Development & Contribution Guide

Welcome to the development environment of Ara. This document guides you through setting up, writing code, executing tests, and verifying release bundles.

---

## 💻 Sandbox Environment Setup

Ensure you have [Bun](https://bun.sh) (v1.1+) installed.

1. **Clone & Install:**
   ```bash
   bun install
   ```
2. **Environment Configuration:**
   Copy `.env.example` to `.env` and fill in API keys for at least one model provider.
3. **Database initialization:**
   Ara initializes `ara.sqlite` dynamically on first boot. No schema migrations or heavy setup steps are required.

---

## 🏃 Running the Application

### All Concurrently
```bash
bun run dev
```

### Isolated Sub-Apps
- **Web Dashboard:** `bun run dev:web`
- **Hono REST Gateway:** `bun run dev:api`
- **Background Cron Worker:** `bun run dev:worker`
- **CLI Gateway Command:** `bun run dev:cli status` (or `bun run dev:cli tui`)

---

## 🧪 Testing and Quality Control

Ara comes with a comprehensive, lightning-fast test suite running on native `bun:test`.

### Run Test Suite
```bash
bun run test
```

The test suite validates:
- Model router mapping & mock stream behaviors.
- Path traversal blockers.
- Secret leaks detector scanner.
- File system checkpoints backups.
- Approval states transitions.
- Local memory search, indexers, and ranking.
- Skill procedure frontmatter loading.
- CLI Configuration manager persistence.
- SSE Stream decoders event translations & mock REST contracts.

### Run Typechecker
Ensure zero TypeScript compilation errors before any release:
- **Monorepo Core**: `bun run typecheck`
- **CLI Sub-app**: `bun run typecheck:cli`

### Build & Package CLI
To compile the standalone React Ink executable and bundle dependencies:
```bash
bun run build:cli
```
This produces `dist/main.js` and packs the Yoga flexbox WASM library `dist/yoga.wasm` automatically.

---

## 🔌 Adding a Custom Tool

To add a new tool to Ara's registry:
1. Define a class implementing the `Tool` interface inside [packages/tools/src/index.ts](../packages/tools/src/index.ts).
2. Specify Zod schemas for input validation:
   ```typescript
   export class CustomTool implements Tool {
     name = 'custom_tool';
     description = 'Describe what it does';
     dangerLevel = 'safe' as const;
     requiresApproval = false;
     inputSchema = z.object({
       param: z.string()
     });

     async run(input: { param: string }, ctx: ToolContext): Promise<ToolResult> {
       return { success: true, output: 'success' };
     }
   }
   ```
3. Register the tool in `apps/api/src/index.ts` under the `toolsRegistry` section:
   ```typescript
   toolsRegistry.register(new CustomTool());
   ```
