# Hermes-style Skill Learning Loop

Ara can detect repeated workflows from session transcripts and suggest reusable skills. This is a **safe learning loop**: drafts are created first, reviewed, and only written as live skills after explicit user approval.

## Architecture

```
Session Transcripts
  |
  v
Workflow Detector (workflowDetector.ts)
  - generateWorkflowFingerprint()
  - updateWorkflowFingerprint()
  - findRepeatedWorkflows(threshold)
  |
  v (threshold >= 3)
Draft Generator (skillDraftGenerator.ts)
  - generateDraft()
  - secret redaction
  - saves to .ara/skill-drafts/<id>.json
  |
  v
Review & Approval (CLI / API)
  - ara skills drafts
  - ara skills approve <draftId>
  - ara skills reject <draftId>
  |
  v
Skill Versioning (skillVersioning.ts)
  - approveDraft()
  - writes skills/<name>/SKILL.md
  - versions archived
```

## Flow

1. **Detection**: Repeated workflows are detected via `POST /api/skill-learning/analyze` with goal + tool sequence
2. **Threshold**: When a workflow repeats 3+ times, a skill draft is auto-generated
3. **Draft**: Saved to `.ara/skill-drafts/<id>.json` with `status: draft`
4. **Review**: User reviews the draft via CLI or slash commands
5. **Approve**: User runs `ara skills approve <draftId>`, writes `skills/<name>/SKILL.md`
6. **Version**: If skill exists, previous version is archived to `versions/vN.md`
7. **Reject**: Rejected drafts are retained with `rejectedAt` timestamp

## CLI Commands

```bash
# Detect repeated workflows
ara skills suggest

# List repeated workflows
ara skills workflows --threshold 3

# List skill drafts
ara skills drafts

# Show draft details
ara skills draft <draftId>

# Approve a draft (writes SKILL.md)
ara skills approve <draftId>

# Reject a draft
ara skills reject <draftId>

# Compare draft with existing skill
ara skills diff <draftId>

# Show skill usage statistics
ara skills stats
```

## Slash Commands

```
/skills suggest             — Overview of learning loop
/skills drafts              — List drafts
/skills approve <id>        — Approve draft
/skills reject <id>         — Reject draft
/skills stats               — Usage statistics
```

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | `/api/skill-learning` | Overview counts |
| GET | `/api/skill-learning/workflows` | List repeated workflows |
| POST | `/api/skill-learning/analyze` | Analyze session, generate draft if threshold met |
| GET | `/api/skill-learning/drafts` | List all drafts |
| GET | `/api/skill-learning/drafts/:id` | Get draft details |
| POST | `/api/skill-learning/drafts/:id/approve` | Approve draft (writes SKILL.md) |
| POST | `/api/skill-learning/drafts/:id/reject` | Reject draft |
| GET | `/api/skill-learning/drafts/:id/diff` | Compare draft with existing skill |
| GET | `/api/skill-learning/stats` | Skill usage statistics |

## Redaction Rules

Drafts redact the following patterns before saving:
- OpenAI keys (`sk-...`)
- Anthropic keys (`sk-ant-...`)
- Google API keys (`AIza...`)
- GitHub PATs (`ghp_...`, `github_pat_...`)
- GitLab PATs (`glpat-...`)

Redacted fields include a `redactionWarnings` array in the draft.

## Audit Events

- `skill_learning.workflow_detected`
- `skill_learning.draft_created`
- `skill_learning.draft_approved`
- `skill_learning.draft_rejected`
- `skill_learning.skill_version_created`
- `skill_learning.usage_recorded`

## Evaluation

Skill usage is tracked via `recordSkillUsage()`:
- Use count, success count, failure count
- Average duration
- Last used timestamp
- Optional feedback score

View stats: `ara skills stats` or `GET /api/skill-learning/stats`

## Draft Body Generation

Current draft procedure is derived from the tool sequence and normalized workflow metadata (goal, tool list, file patterns). The body includes:

```
## Procedure
1. Use <tool1>
2. Use <tool2>
...
## Tools
- <tool1>
- <tool2>
```

**Limitation**: Draft body does not yet include semantic content summarization from session transcripts. The tool sequence provides the structural skeleton, but the actual session content (code snippets, search results, GitHub data) is not included. This is planned for a future phase.

Drafts always require user review and approval before becoming live skills.

## Limitations (v0.1)

- **Draft body is tool-sequence-based**: No transcript content summarization in draft body yet
- **No version rollback**: Once a skill is versioned, there's no rollback command
- **Filesystem writes**: Draft approval writes to `skills/<name>/SKILL.md` — requires write permissions
- **Workflow fingerprints**: Persisted to JSONL files (.ara/skill-learning/workflows.jsonl) but no compaction for stale entries
