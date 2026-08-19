# Facilix Agent Team

Six agent definitions for building and maintaining Facilix, each scoped to a
specific discipline with a clearly defined skill set, domain context, and
working principles. Written so they can be dropped straight into Claude Code
as subagents, or used as standalone system prompts with any AI assistant.

## The team

| File | Role | Owns |
|---|---|---|
| `product-manager.md` | Product Manager | Scoping, specs, prioritization, acceptance criteria |
| `ui-ux-engineer.md` | UI/UX Engineer | Visual design, interaction design, accessibility |
| `frontend-engineer.md` | Frontend Engineer | React components, state, API integration on the client |
| `backend-engineer.md` | Backend Engineer | API routes, business logic, auth, the maintenance scheduler |
| `database-architect.md` | Database Architect | PostgreSQL/PostGIS schema, migrations, indexing |
| `devops-engineer.md` | DevOps Engineer | CI/CD, containers, deployment, monitoring |
| `qa-engineer.md` | QA / Test Engineer | Test strategy, edge cases, regression coverage |

Each file has:
- **A `description`** telling you (or an orchestrating agent) exactly when to
  reach for this one vs. another
- **Core skills** — a concrete, non-generic list specific to what this role
  actually needs to be good at
- **Domain context** — facts about Facilix specifically (multi-tenancy, the
  four trades, the scheduler's failure modes, field-vs-office usage) that the
  agent should already know rather than have to be re-briefed on every time
- **How you work** — behavioral principles, not just a skills list
- **What you don't do** — explicit handoff boundaries, so agents don't
  silently drift into each other's territory

## Using these with Claude Code

Claude Code supports custom subagents defined exactly in this format
(YAML frontmatter + markdown system prompt). To use them:

1. Copy the `.md` files into your project's `.claude/agents/` directory
   (create it if it doesn't exist):
   ```bash
   mkdir -p .claude/agents
   cp *.md .claude/agents/
   ```
2. Claude Code will pick them up automatically. You can invoke one directly
   by name ("use the backend-engineer agent to build the auth endpoints") or
   let Claude Code route to the right one based on each file's `description`.
3. Check Claude Code's current docs for the exact subagent file format, since
   the schema may evolve — https://docs.claude.com is the source of truth.

## Using these anywhere else

Each file is also just a well-structured system prompt. To use one with any
AI assistant (or as a briefing doc for a human contractor, for that matter):
paste everything after the `---` frontmatter block as the system/instruction
prompt, and the "description" line as a note on when to select this persona.

## Suggested workflow

For a typical new feature, the natural handoff order is:

```
product-manager       → scopes the feature, writes acceptance criteria
      ↓
database-architect     → schema changes, if any
      ↓
backend-engineer       → API implementation
      ↓
ui-ux-engineer         → design for the new UI
      ↓
frontend-engineer      → implementation of that design, wired to the API
      ↓
qa-engineer            → tests the full flow, edge cases, regressions
      ↓
devops-engineer        → ships it (CI/CD, monitoring, deploy)
```

Not every feature touches every role — a pure visual tweak might only need
ui-ux-engineer → frontend-engineer → qa-engineer, for example. Use the
`description` field on each file to decide who's actually needed.

## Customizing

These are written specifically for Facilix's current state (the schema,
scheduler, and roadmap from the project's `README.md`/`schema.sql`). If the
product direction changes significantly, update the "Domain context you must
apply" section in the affected agent files — that's the part most likely to
go stale, since skills and working principles are more durable than specific
product facts.
