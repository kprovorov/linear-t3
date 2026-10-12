<img src="assets/icon.svg" width="64" height="64" alt="">

# linear-t3

A small daemon that polls Linear for issues that match your filters and starts a [T3 Code](https://t3.codes) thread for each one. It runs on the same machine as the T3 Code server.

- Each T3 project sets its Linear team and can set the Linear issue filter, what to do in Linear after launch, and how threads start. Anything a project leaves out comes from the shared `defaults` section. Thread options are the workspace (a git worktree per issue on the issue's Linear branch name, or the main checkout), runtime mode, interaction mode, model, and prompt template.
- After a thread starts, the daemon can comment on the issue with the thread link and move the issue to another workflow state.
- Launched issues are recorded in `state.json`, so restarting the daemon never starts the same issue twice.

It is written in TypeScript, uses the official [`@linear/sdk`](https://github.com/linear/linear/tree/master/packages/sdk), and runs directly on Node 22.18+, 24.11+ or 26+ using built-in type stripping, so there is no build step.

## Setup

```sh
npm install
cp config.example.json config.json   # edit projects, teams and filters
cp .env.example .env                  # fill in the tokens
t3 auth session issue --label linear-t3 --ttl 365d --token-only   # paste into T3_TOKEN
```

Check the CLI works with `npm run cli -- --version`.

Try it without starting any threads:

```sh
npm run dry-run    # lists the issues it would launch
npm run once       # one real poll, then exit
npm start          # run continuously
```

The project uses [Vite+](https://viteplus.dev) for formatting, linting and type checking. `npm install` installs it locally, so run it through `npx`:

```sh
npx vp check         # format check, lint and type check
npx vp check --fix   # apply formatting and lint fixes
```

## Configuration

See `config.example.json`. The main keys:

| Key                       | Description                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pollIntervalSeconds`     | How often to poll Linear. Default `60`.                                                                                 |
| `maxLaunchesPerPoll`      | Maximum number of threads started per poll. Default `5`.                                                                |
| `fullScanIntervalMinutes` | How often each project re-reads every matching issue. Default `60`. Polls in between only read recently updated issues. |
| `t3.url`                  | T3 server URL. Default `http://127.0.0.1:3773`.                                                                         |
| `t3.webUrl`               | Optional public T3 web URL. When set, the Linear comment includes a clickable thread link.                              |
| `defaults`                | Settings shared by every project. Takes any project setting below except `linear.team`.                                 |
| `projects`                | One entry per T3 project. The key is the T3 project id, title or workspace path.                                        |

Project settings. Each value comes from the project if it sets one, otherwise from `defaults`, otherwise from the built-in default below. Objects (`workspace`, `model`, `linear.filter`) are replaced as a whole, but `linear.onLaunch` is merged key by key, so a project can set only `moveToState` and keep the shared `comment`.

| Key                           | Built-in default                                                     | Description                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear.team`                 | required                                                             | Linear team key, for example `ENG`.                                                                                                                                                                             |
| `linear.filter`               | none                                                                 | A Linear [`IssueFilter`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter). It is combined with the team filter, and only issues that match get a thread. |
| `linear.onLaunch.comment`     | `true`                                                               | Comment on the issue with the thread link.                                                                                                                                                                      |
| `linear.onLaunch.moveToState` | none                                                                 | Workflow state name to move the issue to once its thread starts.                                                                                                                                                |
| `workspace`                   | `{ "type": "worktree", "baseRef": "main", "startFromOrigin": true }` | Or `{ "type": "root" }` to use the project's main checkout.                                                                                                                                                     |
| `runtimeMode`                 | `full-access`                                                        | `approval-required`, `auto-accept-edits`, `auto` or `full-access`.                                                                                                                                              |
| `interactionMode`             | `default`                                                            | `default` or `plan`.                                                                                                                                                                                            |
| `model`                       | T3 project's default model                                           | For example `{ "instanceId": "claudeAgent", "model": "claude-opus-5-5" }`.                                                                                                                                      |
| `promptTemplate`              | built-in                                                             | Placeholders: `{identifier}`, `{title}`, `{url}`, `{description}`, `{branchName}`.                                                                                                                              |

## Running as a daemon (pm2)

```sh
pm2 start
pm2 logs linear-t3
pm2 save && pm2 startup   # restart on reboot
```

`ecosystem.config.js`, which pm2 picks up from the current directory, runs `src/main.ts` directly with `--env-file=.env`. When pm2 stops the process, it lets the current launch finish before exiting.

## How it talks to T3 Code

T3 Code has no public API for creating threads, so this daemon uses the same WebSocket RPC as the T3 web client. It was built against T3 Code `0.0.46-nightly.20261006` and updated for orchestration protocol 2 in `0.0.46-nightly.20261008`, whose server registers `orchestration.launchThread`, the same RPC behind T3's own `t3_thread_launch` tool. Other T3 versions may not expose these RPCs.

1. It sends `POST /api/auth/websocket-ticket` with the bearer token and gets back a one-time ticket.
2. It opens `ws://…/ws?wsTicket=…&orchestrationProtocol=2`, which speaks Effect RPC with JSON messages. Servers that require protocol 2 reject sockets that don't declare it with `426 orchestration_protocol_incompatible`.
3. It calls `orchestration.subscribeShell`, takes the project list from the first snapshot, then interrupts the subscription.
4. It calls `orchestration.launchThread` for each issue, with the project, model, workspace strategy and the initial message. The command ID, thread ID and message ID are all derived from the Linear issue ID. T3 keeps a receipt for each command ID, so if the response to a launch is lost and the daemon retries with the same command ID, T3 returns the thread the first attempt created instead of creating a second one. The daemon does not send `reuseExistingThread`: in protocol 2 it means "start a run in an existing empty thread", and sending it for a new thread fails with `ProjectionStoreThreadNotFoundError`.

These RPCs are internal and could change in a future T3 Code release. Run `npm run once` after updating T3 to confirm launches still work. The client is isolated in `src/t3.ts`.
