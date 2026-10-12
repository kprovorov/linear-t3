# Issue tracker: Linear

Issues and specs for this repo live in the Linear team **Workflow** (key `WF`, e.g. `WF-12`).
Use the Linear MCP tools (`mcp__claude_ai_Linear__*`). Do not use `gh issue` for this repo.

## Conventions

- **Create**: `save_issue` with `team: "Workflow"`, `title`, `description` (markdown, literal newlines).
  Type labels available: `Bug`, `Improvement`, `Feature`.
- **Read**: `get_issue` with the identifier (e.g. `WF-12`), plus `list_comments` for the discussion.
- **List**: `list_issues` with `team: "Workflow"` and `label` / `state` filters.
- **Comment**: `save_comment` on the issue.
- **Labels**: `save_issue` with `id` and `addLabels` / `removeLabels` (never `labels`, which replaces the whole set).
- **Close**: comment with the reason, then `save_issue` with `state: "Done"` (or `"Canceled"` for wontfix, `"Duplicate"` + `duplicateOf` for dupes).

Workflow states: Backlog → Todo → In Progress → In Review → Done (also Canceled, Duplicate).

## Interaction with the linear-t3 daemon

This repo's daemon polls Linear and launches T3 threads for issues matching each project's
`linear.filter` in `config.json`, then may move them (e.g. to "In Progress"). Before relabelling
or moving a WF issue, check whether that would make the daemon pick it up.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the Workflow team.

## When a skill says "fetch the relevant ticket"

`get_issue` with the `WF-<n>` identifier, plus `list_comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single parent issue; **child** issues are its sub-issues.

- **Map**: an issue labelled `wayfinder:map` holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `save_issue` with `parentId: <map>`, labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: native Linear relations via `save_issue` `blockedBy: [...]`. Unblocked when every blocker is Done/Canceled.
- **Frontier query**: `list_issues` with `parentId: <map>`, open states only. Drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `save_issue` with `assignee: "me"`, the session's first write.
- **Resolve**: `save_comment` with the answer, move to Done, then append a gist + link to the map's Decisions-so-far.
