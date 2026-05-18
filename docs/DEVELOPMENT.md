# Development Guide

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- Node.js 22+ (for compatibility)

## Setup

```bash
git clone <repo-url>
cd ara
bun install
cp .env.example .env
# Edit .env with your API keys
```

## Development Commands

```bash
# Start all services
bun run dev

# Start individual services
bun run dev:api     # Hono API on :3001
bun run dev:web     # Vite frontend on :5173
bun run dev:worker  # Background cron
bun run dev:cli     # CLI / TUI

# Or use the unified server runtime
bun run apps/cli/src/main.tsx server start              # API + Worker
bun run apps/cli/src/main.tsx server start --with-web    # + Web UI
bun run apps/cli/src/main.tsx server stop                # Stop all
bun run apps/cli/src/main.tsx server status              # Check status
bun run apps/cli/src/main.tsx server logs                # View logs

# Build
bun run build       # All apps
bun run build:cli   # CLI binary only

# Test
bun test                     # All tests
bun test "github"            # GitHub package tests
bun test "skill_learning"    # Skill learning tests
bun test tests/ara.test.ts   # Single test file

# Typecheck
bun run typecheck

# Lint (tsc --noEmit)
bun run lint
```

## Project Structure

```
apps/       — Application packages (api, web, worker, cli)
packages/   — Library packages (13 packages)
docs/       — Documentation
skills/     — Skill procedure sheets (SKILL.md)
memory/     — Memory files (USER.md, MEMORY.md)
tests/      — Integration tests
.ara/       — Runtime data (gitignored)
```

## Package Dependencies

All internal packages use `workspace:*` protocol. Packages generally depend upward:
- `shared` is the foundation (types + schemas)
- `tools`, `memory`, `skills`, `model-router` depend on `shared`
- `permissions`, `hooks`, `commands`, `locks` depend on `shared`
- `agent-core` wires all subsystems together
- `apps/api` imports everything

## Adding a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`
2. Use `workspace:*` for internal deps
3. Add to root `tsconfig.json` references
4. Install: `bun install --cwd packages/<name>`
5. Import in API routes as needed

## Testing Guidelines

- Use `bun:test` (not vitest)
- Mock external APIs (no real credentials)
- Keep tests deterministic
- Test failure paths (permission denied, missing config, network errors)
- No secrets in test files

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"`)
- No ESLint — use `tsc --noEmit`
- Zod for runtime validation
- Async/await preferred over raw promises
