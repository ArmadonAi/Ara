# ==========================================
# Phase 1: Build the Monorepo
# ==========================================
FROM oven/bun:1.3-alpine AS builder

WORKDIR /usr/src/app

# Copy package configurations for monorepo linking
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/cli/package.json ./apps/cli/
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent-core/package.json ./packages/agent-core/
COPY packages/tools/package.json ./packages/tools/
COPY packages/memory/package.json ./packages/memory/
COPY packages/skills/package.json ./packages/skills/
COPY packages/model-router/package.json ./packages/model-router/
COPY packages/permissions/package.json ./packages/permissions/
COPY packages/hooks/package.json ./packages/hooks/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/github/package.json ./packages/github/
COPY packages/locks/package.json ./packages/locks/
COPY packages/subagents/package.json ./packages/subagents/
COPY packages/canvas/package.json ./packages/canvas/
COPY packages/skill-learning/package.json ./packages/skill-learning/
COPY packages/checkpoints/package.json ./packages/checkpoints/

# Install all monorepo dependencies
RUN bun install --frozen-lockfile

# Copy the entire workspace code
COPY . .

# Build Vite frontend and CLI assets
RUN bun run build

# ==========================================
# Phase 2: Production Runner Container
# ==========================================
FROM oven/bun:1.3-alpine AS runner

WORKDIR /usr/src/app

# Production environment variables
ENV NODE_ENV=production
ENV API_PORT=3001
ENV PORT=3001

# Copy built application and dynamic runtime files
COPY --from=builder /usr/src/app /usr/src/app

# Expose backend API and Vite static preview ports
EXPOSE 3001
EXPOSE 5173

# Execute all services concurrently (Hono server, background worker, Vite dashboard)
CMD ["bun", "run", "start"]
