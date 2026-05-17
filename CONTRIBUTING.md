# Contributing to Ara

Thank you for your interest in contributing to Ara: Personal AI Control Plane. This document outlines the standards, guidelines, and procedures for proposing improvements, fixing bugs, and writing high-integrity code for this repository.

---

## Code of Conduct

Ara is a collaborative, open developer utility. We expect all contributors to maintain respectful, productive, and clear professional communication in all workspace channels, issue boards, and pull requests.

---

## Development Setup

Ara is designed as a Bun workspace monorepo. Please ensure you have the following prerequisites configured:

* **Runtime Environment**: [Bun](https://bun.sh) (v1.3.x or later).
* **Package Management**: All tasks must utilize `bun` natively. Do not commit package lockfiles from `npm`, `yarn`, or `pnpm`.
* **API Providers**: Configure local environment keys inside `.env` (copied from `.env.example`).

To set up your local development workspace:
```bash
# Clone the repository
git clone https://github.com/JonusNattapong/Ara.git
cd Ara

# Install and link monorepo packages
bun install

# Copy environment template and configure keys
cp .env.example .env
```

---

## Contribution Workflow

### 1. Code Standards and Typings
* **Strict Type Safety**: All contributions must be fully type-safe. Run `bun run typecheck` to execute `tsc --noEmit` before proposing any changes.
* **Monorepo Dependencies**: When importing cross-package modules within this workspace, always register dependencies under `"workspace:*"` inside package configurations instead of hardcoded semantic versions.
* **Security & Path Safety**: Filesystem operations must always pass through the `resolveSafePath` check to ensure strict isolation within the active workspace root.
* **Secret Checks**: Never commit API keys, test tokens, or private environment configurations to the codebase. The Permission Engine strictly enforces active safety blocks for credential files.

### 2. Testing Guidelines
All new features, Hono endpoints, and permission configurations must be validated with comprehensive unit and integration tests under the `tests/` directory or package-specific test folders.

To run the complete test suite:
```bash
bun run test
```

To run a specific test suite:
```bash
bun test tests/ara.test.ts
bun test tests/permissions_integration.test.ts
bun test tests/phase10_hardening.test.ts
```

### 3. Submitting Pull Requests
1. Create a descriptive feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Write clean, modular, and self-documenting code.
3. Validate your changes locally using typecheckers and test runners.
4. Commit your changes using clear, descriptive commit messages.
5. Push to your fork and submit a Pull Request targeting the `main` branch.
