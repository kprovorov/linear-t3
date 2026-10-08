<img src="assets/icon.svg" width="64" height="64" alt="">

# linear-t3

A small daemon that polls Linear for issues that match your filters and starts a [T3 Code](https://t3.codes) thread for each one. It runs on the same machine as the T3 Code server.

- Each Linear team maps to one T3 project. You can give the project as its id, its title, or its workspace path.
- Each team gets the global Linear `IssueFilter` AND its own team filter.
- By default each issue gets its own git worktree, on the issue's Linear branch name.
- After a thread starts, the daemon can comment on the issue with the thread link and move the issue to another workflow state.
- Launched issues are recorded in `state.json`, so restarting the daemon never starts the same issue twice.

It is written in TypeScript and runs directly on Node ≥ 22.18 using built-in type stripping, so there is no build step.

## Setup

```sh
npm install
cp config.example.json config.json   # edit teams, projects and filters
cp .env.example .env                  # fill in the tokens
t3 auth session issue --label linear-t3 --ttl 365d --token-only   # paste into T3_TOKEN
```

Try it without starting any threads:

```sh
set -a; . ./.env; set +a
npm run dry-run    # lists the issues it would launch
npm run once       # one real poll, then exit
npm start          # run continuously
```

## Configuration

See `config.example.json`. The main keys:

| Key | Description |
| --- | --- |
| `pollIntervalSeconds` | How often to poll Linear. Default `60`. |
| `maxLaunchesPerPoll` | Maximum number of threads started per poll. Default `5`. |
| `t3.url` | T3 server URL. Default `http://127.0.0.1:3773`. |
| `t3.webUrl` | Optional public T3 web URL. When set, the Linear comment includes a clickable thread link. |
| `linear.filter` | Linear [`IssueFilter`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter) applied to every team. |
| `linear.onLaunch.comment` | Comment on the issue with the thread link. Default `true`. |
| `linear.onLaunch.moveToState` | Workflow state name to move the issue to once its thread starts. |
| `defaults` | Defaults for `workspace`, `model`, `runtimeMode`, `interactionMode` and `promptTemplate`. Any team can override them. |
| `teams[]` | One entry per Linear team: `team` (team key), `project` (T3 project id, title or path), plus an optional `filter` and any of the overrides above. |

- **`workspace`**: either `{ "type": "worktree", "baseRef": "main", "startFromOrigin": true }` (the default) or `{ "type": "root" }`.
- **`model`**: `{ "instanceId": "claudeAgent", "model": "claude-opus-5-5" }`. If omitted, the T3 project's default model is used.
- **`promptTemplate` placeholders**: `{identifier}`, `{title}`, `{url}`, `{description}`, `{branchName}`.

## Running as a daemon (systemd)

```sh
cp deploy/linear-t3.service ~/.config/systemd/user/   # adjust WorkingDirectory if needed
systemctl --user daemon-reload
systemctl --user enable --now linear-t3
loginctl enable-linger "$USER"
journalctl --user -u linear-t3 -f
```

## How it talks to T3 Code

T3 Code has no public API for creating threads, so this daemon uses the same WebSocket RPC as the T3 web client:

1. It sends `POST /api/auth/websocket-ticket` with the bearer token and gets back a one-time ticket.
2. It opens `ws://…/ws?wsTicket=…`, which speaks Effect RPC with JSON messages.
3. It calls `orchestration.subscribeShell`, takes the project list from the first snapshot, then interrupts the subscription.
4. It calls `orchestration.launchThread` for each issue, with the project, model, workspace strategy and the initial message.

These RPCs are internal and could change in a future T3 Code release. The client is isolated in `src/t3.ts`.
