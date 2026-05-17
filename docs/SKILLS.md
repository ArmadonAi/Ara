# 🧠 Ara Dynamic Skills & Procedures System

Skills in Ara are **executable procedures** represented as structured markdown files inside the `skills/` directory.

---

## 📂 Skill Format Schema

Each skill is stored in `skills/{skill-name}/SKILL.md` containing a structured YAML frontmatter section and specific markdown procedures:

```markdown
---
name: code-review
description: Custom code review skill procedure
tags:
  - programming
  - quality
---

## When to use
Use to review code changes.

## Inputs
- repository path
- user goal

## Procedure
1. Inspect git status
2. Review files line-by-line

## Output
Detailed code review report
```

---

## 🔁 Progressive Skill Loading

Ara implements **progressive loading** to conserve system resources and maintain speed:
1. **Metadata Loading:** On dashboard bootstrap, Ara's Hono API calls `listSkills()`, which parses **only the YAML frontmatter headers** of all `SKILL.md` files to display the skills name, tags, and description. The heavy procedure steps are omitted.
2. **Procedural Loading:** The complete procedure sequence and parameters are loaded into the agent system prompt **only when requested** or matched, providing a clean execution context.
