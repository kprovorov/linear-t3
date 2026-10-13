## Agent skills

### Issue tracker

Issues live in the Linear team "Workflow" (key `WF`), managed through the Linear MCP tools. See `docs/agents/issue-tracker.md`.

- Specs are published as a Linear **project**, with the spec as the project description and no project labels. The implementation issues go inside it.
- Every step only a human can do gets its own `ready-for-human` issue with concrete steps and `blockedBy`/`blocks` relations. Never bury it inside another issue.

### Triage labels

The five canonical triage labels, used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Pull requests

PR titles are Conventional Commits, e.g. `feat(WF-15): pick the version bump from commit history`. Add `!` after the type or scope for a breaking change. PRs are squash-merged, so the title becomes the commit subject the "Bump version" workflow reads: breaking → major, `feat` → minor, anything else → patch. `.github/workflows/pr-title.yml` enforces this and lists the allowed types.
