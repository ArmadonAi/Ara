#!/usr/bin/env bash

# Ara Personal AI Control Plane - Linux / macOS Setup Script
set -e

echo "============================================================="
echo "        Ara Personal AI Control Plane Installer (POSIX)      "
echo "============================================================="
echo "Initializing environment setup..."
echo ""

# 1. Verify/Install Bun
if ! command -v bun &> /dev/null; then
    echo "[1/4] Bun runtime not detected. Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    echo "✅ Bun successfully installed."
else
    echo "[1/4] Bun runtime detected: $(bun --version)"
fi
echo ""

# 2. Install dependencies
echo "[2/4] Installing monorepo workspace dependencies..."
bun install
echo "✅ Dependencies successfully resolved and linked."
echo ""

# 3. Copy environment variables
echo "[3/4] Checking environment configurations..."
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ Generated new local configuration: .env (copied from .env.example)"
        echo "👉 Please edit .env to insert your target LLM provider API keys."
    else
        touch .env
        echo "✅ Created blank .env file."
    fi
else
    echo "✅ Existing local .env configuration detected."
fi
echo ""

# 4. Create local directories
echo "[4/4] Creating local workspace directory structure..."
mkdir -p .ara/backups .ara/logs .ara/sessions memory
echo "✅ Created database and session directories."
echo ""

echo "============================================================="
echo "🎉 Setup Completed Successfully!"
echo "============================================================="
echo "Ara Personal AI Control Plane is initialized and ready."
echo ""
echo "To start the web dashboard, Hono backend, and background worker concurrently:"
echo "   bun run dev"
echo ""
echo "To start chatting via interactive console TUI:"
echo "   bun link"
echo "   ara tui"
echo "============================================================="
