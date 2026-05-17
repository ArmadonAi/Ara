---
name: code-review
description: Review code changes for bugs, security, architecture, and maintainability.
tags:
  - coding
  - review
---

# Code Review Skill

## When to use
Use this when the user asks to review code, diffs, PRs, or architecture changes.

## Inputs
- repository path
- changed files or diff
- user goal

## Procedure
1. Inspect git status and diff
2. Identify changed files
3. Check for obvious bugs
4. Check test coverage
5. Check security risks
6. Suggest focused fixes
7. Run tests if safe and approved

## Output
Return:
- summary
- issues by severity
- suggested patch
- verification steps
