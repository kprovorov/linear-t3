<img src="assets/icon.svg" width="64" height="64" alt="">

# linear-t3

A small Daemon that polls Linear for issues that match your filters and starts a [T3 Code](https://t3.codes) thread for each one. It runs on the same machine as the T3 Code server.

- Each T3 project sets its Linear team and can set the Linear issue filter, what to do in Linear after launch, and how threads start. Anything a project leaves out comes from the shared `defaults` section. Thread options are the workspace (a git worktree per issue on the issue's Linear branch name, or the main checkout), runtime mode, interaction mode, model, and prompt template.
- After a thread starts, the Daemon can comment on the issue with the thread link and move the issue to another workflow state.
- Launched issues are recorded in the State file, so restarting the Daemon never starts the same issue twice.

It runs on macOS and Linux with Node 22.18+, 24.11+ or 26+, and needs T3 Code 0.1.0 or later.

## Quick start

```sh
npm i -g linear-t3
linear-t3 setup     # writes a starter Config to ~/.config/linear-t3/config.json
```

Edit the Config: list your T3 projects with their Linear teams and filters (see [Configuration](#configuration)). Then, with the T3 Code server running:

```sh
linear-t3 connect   # saves a T3 token and a Linear API key to the Credentials file
linear-t3 run --dry-run   # optional: lists the issues it would launch, then exits
linear-t3 start     # runs the Daemon in the background, now and at every login
linear-t3 status    # shows whether it's running and where its files are
```

To try it without installing, use `npx linear-t3` in place of `linear-t3` for every command except `start`. `start` refuses to run from the npx cache, because npm may clean it up and leave the background service pointing at nothing.

## Commands

Every command takes `--config <path>` to use another Config.

| Command                | What it does                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                | Writes a starter Config from `config.template.json` to the Config path, creating its directory. Never overwrites an existing Config.                                            |
| `connect [t3\|linear]` | Gets, checks and saves the T3 token and the Linear API key in the Credentials file. Without an argument it does both, T3 first. Interactive, so run it in a terminal.           |
| `run`                  | Runs the Daemon in the foreground until SIGINT or SIGTERM. `--once` does one poll and exits. `--dry-run` lists the issues it would launch without starting threads, then exits. |
| `start`                | Checks the Config and both tokens, then installs and starts the Daemon as a background service. Safe to run again, for example after upgrading linear-t3 or Node.               |
| `stop`                 | Stops the Daemon and keeps it from starting at login until the next `start`.                                                                                                    |
| `restart`              | Restarts the Daemon, for example to pick up Config changes.                                                                                                                     |
| `status`               | Shows whether the Daemon is running and where the Config, Credentials, State, log and unit are.                                                                                 |
| `logs [-f]`            | Shows the Daemon's recent output. `-f` (`--follow`) keeps printing new output.                                                                                                  |
| `uninstall`            | Stops the Daemon and removes the background service. The Config, Credentials and State are kept.                                                                                |

### `connect`

`connect t3` runs `t3 auth session issue` for you, checks the token against the T3 server at `t3.url` from the Config (default `http://127.0.0.1:3773`) and saves it as `T3_TOKEN` only if the check passes. The T3 server has to be running and the `t3` CLI has to be on your `PATH`. To do it by hand instead, run `t3 auth session issue --label linear-t3 --ttl 365d --token-only` and put the token in the Credentials file as `T3_TOKEN=...`.

`connect linear` asks for a Linear personal API key (Linear → Settings → Security & access → Personal API keys), checks it against Linear and saves it as `LINEAR_API_KEY` only if the check passes.

Both write the Credentials file with mode `0600` and leave every other line alone. If the saved token still works, they ask before replacing it.

### `run`

`run` reads `LINEAR_API_KEY` and `T3_TOKEN` from the environment, else from the Credentials file (see [Files](#files)). On SIGINT or SIGTERM it lets the current launch finish and starts nothing new.

### Background service

`start` installs the Daemon with the OS service manager, which restarts it if it crashes and starts it at login:

- macOS: a launchd agent, logging to a file.
- Linux: a systemd user unit, logging to the user journal.

See [Files](#files) for where the unit and log are; `status` prints both.

The background service runs `linear-t3 run` with the `node` that ran `start`, so run `start` again after switching Node versions; `status` warns when that `node` is gone. It doesn't inherit your shell's environment, so it reads both tokens from the Credentials file only. `start` refuses to install it if either one is missing or rejected.

On Linux, systemd stops user services when you log out unless lingering is on. To keep the Daemon running after you log out, or to start it at boot without logging in, run `loginctl enable-linger`. `status` reminds you while it's off.

Other platforms can still use `run` under their own supervisor.

## Files

linear-t3 keeps its files in [XDG](https://specifications.freedesktop.org/basedir-spec/latest/) locations, so every command works from any directory:

| File        | Location                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Config      | `--config <path>`, else `$LINEAR_T3_CONFIG`, else `$XDG_CONFIG_HOME/linear-t3/config.json` (default `~/.config/linear-t3/...`)              |
| Credentials | `$XDG_CONFIG_HOME/linear-t3/credentials`, `KEY=value` lines, mode `0600`                                                                    |
| State       | `stateFile` from the Config, relative to the Config's directory, else `$XDG_STATE_HOME/linear-t3/state.json` (default `~/.local/state/...`) |
| Log         | macOS: `$XDG_STATE_HOME/linear-t3/daemon.log`. Linux: the systemd user journal                                                              |
| Unit        | macOS: `~/Library/LaunchAgents/linear-t3.plist`. Linux: `$XDG_CONFIG_HOME/systemd/user/linear-t3.service`                                   |

`LINEAR_API_KEY` and `T3_TOKEN` in the environment take precedence over the Credentials file for `run`, but not for the background service, which only reads the Credentials. `T3CODE_HOME` (default `~/.t3`) is where the Daemon finds T3 Code's environment id for thread links when `t3.webUrl` is set. `start` passes `--config`, `LINEAR_T3_CONFIG`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `T3CODE_HOME` on to the background service, so it finds the same files.

## Configuration

`setup` writes a starter Config. The main keys:

| Key                   | Description                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `pollIntervalSeconds` | How often to poll Linear. Default `60`.                                                     |
| `maxLaunchesPerPoll`  | Maximum number of threads started per poll. Default `5`. See [Launch order](#launch-order). |
| `stateFile`           | Where State is kept, relative to the Config's directory. Default: the XDG State location.   |
| `t3.url`              | T3 server URL. Default `http://127.0.0.1:3773`.                                             |
| `t3.webUrl`           | Optional public T3 web URL. When set, the Linear comment includes a clickable thread link.  |
| `defaults`            | Settings shared by every project. Takes any project setting below except `linear.team`.     |
| `projects`            | One entry per T3 project. The key is the T3 project id, title or workspace path.            |

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

## Launch order

When more issues match than the Daemon can start, it picks them in this order. Within each project, issues go by Linear priority, Urgent first and Low last, with "No priority" after Low. Issues with the same priority go oldest first. Across projects, each poll takes one issue from each project in turn, starting with the first project in the Config. So a busy project can't use up a poll's `maxLaunchesPerPoll` on its own, but when that cap is smaller than the number of projects, the projects listed first get the slots.

## How it talks to T3 Code

T3 Code has no public API for creating threads, so the Daemon uses the same WebSocket RPC as the T3 web client. It needs T3 Code 0.1.0 or later. That is the first stable release to speak orchestration protocol 2 and register `orchestration.launchThread`, the same RPC behind T3's own `t3_thread_launch` tool. Older stable releases don't expose these RPCs.

1. It sends `POST /api/auth/websocket-ticket` with the bearer token and gets back a one-time ticket.
2. It opens `ws://…/ws?wsTicket=…&orchestrationProtocol=2`, which speaks Effect RPC with JSON messages. Servers that require protocol 2 reject sockets that don't declare it with `426 orchestration_protocol_incompatible`.
3. It calls `orchestration.subscribeShell`, takes the project list from the first snapshot, then interrupts the subscription.
4. It calls `orchestration.launchThread` for each issue, with the project, model, workspace strategy and the initial message. The command ID, thread ID and message ID are all derived from the Linear issue ID. T3 keeps a receipt for each command ID, so if the response to a launch is lost and the Daemon retries with the same command ID, T3 returns the thread the first attempt created instead of creating a second one. The Daemon does not send `reuseExistingThread`: in protocol 2 it means "start a run in an existing empty thread", and sending it for a new thread fails with `ProjectionStoreThreadNotFoundError`.

These RPCs are internal and could change in a future T3 Code release. Run `linear-t3 run --once` after updating T3 to confirm launches still work. The client is isolated in `src/t3.ts`.

## Development

linear-t3 is written in TypeScript and uses the official [`@linear/sdk`](https://github.com/linear/linear/tree/master/packages/sdk). It runs from source with Node's built-in type stripping, and uses [Vite+](https://viteplus.dev) for formatting, linting, type checking, tests and the build:

```sh
pnpm install
pnpm cli run --dry-run   # run any command from source: pnpm cli <command>
pnpm check               # format check, lint and type check
pnpm check --fix         # apply formatting and lint fixes
pnpm test                # run the tests
pnpm build               # bundle the CLI into dist/cli.js
```

`pnpm cli` uses the same Config and Credentials as the installed CLI. To try the package as users get it, run `npm pack` and install the tarball with `npm i -g ./linear-t3-*.tgz`.

## Releasing

Run the **Release** workflow from the Actions tab on `main`. It publishes the version in `package.json` to npm with provenance through npm trusted publishing (no npm token), then creates the `vX.Y.Z` tag and a GitHub release with generated notes. It fails before building if that version, tag or release already exists, so bump the version first. npm trusts the workflow by its filename, `.github/workflows/release.yml`, so don't rename it.
