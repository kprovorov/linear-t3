<img src="assets/icon.svg" width="64" height="64" alt="">

# linear-t3

A small Daemon that polls Linear for issues that match your filters and starts a [T3 Code](https://t3.codes) thread for each one. It runs on the same machine as the T3 Code server.

- Each run watches one Linear team and launches into one T3 project: the one you name, or the current repository's.
- Filters (status, label, assignee, priority, or any raw Linear filter) pick which issues get a thread.
- After a thread starts, the Daemon moves the issue to `In Progress` and comments with the thread link. Both can be turned off.
- Model, runtime mode, worktree settings and base branch default to what you already chose in T3.
- Launched issues are recorded in the State file, so restarting the Daemon never starts the same issue twice.

It runs on macOS and Linux with Node 22.18+, 24.11+ or 26+, and needs T3 Code 0.1.0 or later.

## Quick start

With the T3 Code server running, save the T3 token and a Linear API key once:

```sh
npx linear-t3 connect
```

Then, from inside a repository that T3 has as a project:

<!-- readme-example: cli -->

```sh
npx linear-t3 run --team FIT --status Todo --model opus-5.5
npx linear-t3 run --team FIT --status Todo --once      # one poll, then exit
npx linear-t3 run --team FIT --status Todo --dry-run   # show what would start, change nothing
```

`run` stays in the foreground until Ctrl+C. It launches a thread in this repository's T3 project for every Todo issue in team `FIT`, on Claude Opus 5.5.

To keep the team and filters with the repository, put them in a [Local Config](#local-config) and run plain `npx linear-t3 run`. To run it in the background, see [Background service](#background-service).

## Commands

| Command                | What it does                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`                | Writes a minimal [Global Config](#global-config) from `config.template.json`, creating its directory. Never overwrites an existing one.                                          |
| `connect [t3\|linear]` | Gets, checks and saves the T3 token and the Linear API key in the Credentials file. Without an argument it does both, T3 first. Interactive, so run it in a terminal.            |
| `run`                  | Runs the Daemon in the foreground until SIGINT or SIGTERM. Takes a flag for every [Config key](#config-keys); see [`run`](#run).                                                 |
| `start`                | Takes the same flags as `run`, checks the Config and both tokens, then installs and starts a background Daemon for the T3 project. Run it again to change that project's Daemon. |
| `stop [--all]`         | Stops a project's Daemon and keeps it from starting at login until the next `start`. `--all` stops every Daemon.                                                                 |
| `restart [--all]`      | Restarts a project's Daemon with what `start` pinned, for example to pick up Config file changes. `--all` restarts every Daemon.                                                 |
| `status`               | Lists every installed Daemon from any directory: its project, whether it's running, its Local Config, log and unit, after the shared files.                                      |
| `logs [-f]`            | Shows a project's Daemon's recent output. `-f` (`--follow`) keeps printing new output.                                                                                           |
| `uninstall [--all]`    | Stops a project's Daemon and removes its background service. `--all` removes every Daemon. The Config, Credentials, State and logs are kept.                                     |

### `connect`

`connect t3` runs `t3 auth session issue` for you, checks the token against the T3 server at `t3Url` from the Global Config (default `http://127.0.0.1:3773`) and saves it as `T3_TOKEN` only if the check passes. The T3 server has to be running and the `t3` CLI has to be on your `PATH`. To do it by hand instead, run `t3 auth session issue --label linear-t3 --ttl 365d --token-only` and put the token in the Credentials file as `T3_TOKEN=...`.

`connect linear` asks for a Linear personal API key (Linear → Settings → Security & access → Personal API keys), checks it against Linear and saves it as `LINEAR_API_KEY` only if the check passes.

Both write the Credentials file with mode `0600` and leave every other line alone. If the saved token still works, they ask before replacing it.

### `run`

`run` reads `LINEAR_API_KEY` and `T3_TOKEN` from the environment, else from the Credentials file (see [Files](#files)). Before the first poll it checks everything: the Config, the T3 project, the team's status and label names, the model and the default branch. Any problem exits 1. On SIGINT or SIGTERM it lets the current launch finish and starts nothing new; threads already launched keep running.

If the T3 project's [background Daemon](#background-service) is running too, `run` logs a warning naming it before the first poll, then polls as usual. Running both is safe, since T3 won't launch an issue twice and they share State when they use the same State file, but it's rarely meant: `linear-t3 stop --project <id>` stops the background one. The warning doesn't change the exit code, and the background Daemon never warns about itself.

Besides a flag for every [Config key](#config-keys), `run` takes:

| Flag              | What it does                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--once`          | Does one poll, then exits.                                                                                                                   |
| `--dry-run`       | Does one poll and shows which issues would start now and which would wait on the cap. Starts no threads, changes nothing in Linear or State. |
| `--config <path>` | Uses this Local Config instead of the nearest `linear-t3.config.json`. The file must exist.                                                  |
| `--no-config`     | Uses no Local Config, even if the repository has one.                                                                                        |

`--once` and `--dry-run` exit 1 when a check before the first poll fails, or when the poll itself fails, for example because Linear or T3 can't be reached. They exit 0 otherwise, including when nothing matches or the cap is full. A failed launch, comment or status move for one issue is logged and retried on a later poll; it doesn't change the exit code, so check the output for `failed`.

`--dry-run` needs both tokens, because it reads T3 to count Running threads. It prints how many threads are Running in T3 against `maxRunningThreads`, then lists the matching issues in launch order, each marked `would start` or `would wait`, for example `FIT-2 would wait (global 2/2)`.

`run --help` lists every flag with its default and scope.

## Configuration

Every setting is a flat Config key with one flag of the same name in kebab-case: `startFromOrigin` ↔ `--start-from-origin`. No Config file is required when flags supply everything.

### Where a key comes from

Each key resolves on its own, highest first:

1. A CLI flag.
2. The Local Config.
3. The Global Config.
4. The T3 project's own setting, or T3's global setting, for keys T3 has one for.
5. The built-in default.

A key a layer doesn't set falls through to the next one. A list set in a higher layer replaces the lower one, so `--status Backlog` means exactly "status Backlog". `label` is the exception: every layer's labels add up, so `"label": "mac"` in the Global Config, `"label": "ready-for-agent"` in the Local Config and `--label bug` watch issues that carry all three. `--config` replaces the discovered Local Config; it doesn't add to it.

Booleans take `true` or `false`, and a bare flag means `true` (`--comment` is `--comment true`). List keys take a string or an array in a file, and a repeated flag on the CLI (`--status Todo --status Backlog`). `--filter` takes JSON.

### Scopes

- **global**: machine settings, only in the Global Config. They have no flag.
- **local**: what to watch, only in the Local Config or on the CLI.
- **all**: anywhere.

A key in the wrong place, for example `team` in the Global Config, is an error that says where it goes. Unknown keys are errors too, so typos are caught.

### Global Config

`$LINEAR_T3_CONFIG`, else `$XDG_CONFIG_HOME/linear-t3/config.json` (default `~/.config/linear-t3/config.json`). It holds the machine settings, plus any **all** keys you want on every run on this machine:

<!-- readme-example: global -->

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "maxRunningThreads": 4,
  "comment": true,
  "pollInterval": 60
}
```

`setup` writes a minimal one.

### Local Config

The nearest `linear-t3.config.json` from the working directory up to the Git root; outside a Git repository, only the working directory is checked. Commit it to the repository so `npx linear-t3 run` from anywhere in it needs no flags:

<!-- readme-example: local -->

```json
{
  "project": "my-app",
  "team": "FIT",
  "status": ["Todo", "Backlog"],
  "label": "agent",
  "priority": "high",
  "setStatus": "In Progress",
  "filter": { "hasBlockedByRelations": { "eq": false } },
  "model": "opus-5.5"
}
```

`--config <file>` uses another file instead, so you can keep several, such as `linear-t3.bugs.json` and `linear-t3.features.json`. Several runs on one machine, background or foreground, can share the State file safely: each sees the issues the others launched and skips them. A missing discovered file is fine, but a missing `--config` file is an error.

### Config keys

| Key                 | Flag                                | Scope  | When unset                                                                           |
| ------------------- | ----------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `project`           | `--project <project>`               | local  | the T3 project whose folder is the Git root                                          |
| `team`              | `--team <team>`                     | local  | required                                                                             |
| `filter`            | `--filter <json>`                   | local  | none                                                                                 |
| `status`            | `--status <status>`                 | local  | any status                                                                           |
| `label`             | `--label <label>`                   | all    | any labels                                                                           |
| `assignee`          | `--assignee <assignee>`             | local  | anyone                                                                               |
| `priority`          | `--priority <priority>`             | local  | any priority                                                                         |
| `setStatus`         | `--set-status <status\|false>`      | local  | In Progress                                                                          |
| `comment`           | `--comment [true\|false]`           | all    | true                                                                                 |
| `model`             | `--model <model>`                   | all    | the T3 project's default model                                                       |
| `provider`          | `--provider <provider>`             | all    | the one enabled Provider that offers `model`, else the T3 project's default Provider |
| `runtimeMode`       | `--runtime-mode <mode>`             | all    | the T3 project's default runtime mode, else T3's                                     |
| `workspace`         | `--workspace <local\|worktree>`     | all    | where the T3 project starts new threads, else where T3 does                          |
| `baseRef`           | `--base-ref <ref>`                  | all    | the repository's default branch, as T3 reports it                                    |
| `startFromOrigin`   | `--start-from-origin [true\|false]` | all    | the T3 project's "new worktrees start from origin", else T3's                        |
| `prompt`            | `--prompt <template>`               | all    | a built-in template                                                                  |
| `pollInterval`      | `--poll-interval <seconds>`         | all    | 60                                                                                   |
| `maxRunningThreads` | —                                   | global | no cap                                                                               |
| `t3Url`             | —                                   | global | `http://127.0.0.1:3773`                                                              |
| `stateFile`         | —                                   | global | `$XDG_STATE_HOME/linear-t3/state.json`                                               |

What each one does:

- **`project`**: the T3 project to launch threads in, by id, unique title or folder path. A relative path is relative to the file that sets it, or on the CLI to the working directory. Unset, the run uses the T3 project whose folder is the current Git root (or the working directory outside Git). No match, or several, is an error.
- **`team`**: the Linear team key whose issues to watch, for example `FIT`.
- **`filter`**: a raw Linear [`IssueFilter`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter), ANDed with the team and the named filters below. Use it for anything they don't cover, such as `{ "hasBlockedByRelations": { "eq": false } }`.
- **`status`**: workflow statuses of the team; an issue must be in any of them. Names match ignoring case.
- **`label`**: labels of the team; an issue must carry all of them. Names match ignoring case. Labels from the CLI, the Local Config and the Global Config add up, so a label in the Global Config, such as one for this machine, applies to every run on it.
- **`assignee`**: `me` (the owner of the Linear API key), an email address, or `none` for unassigned issues.
- **`priority`**: `urgent`, `high`, `medium`, `low`, or `1` to `4`. Matches that priority or anything more urgent, so `high` also picks up urgent issues. Issues with no priority never match.
- **`setStatus`**: the team's workflow status to move an issue to once its thread starts, or `false` to leave it alone.
- **`comment`**: comment on the issue with a link to its thread, built from `t3Url`.
- **`model`**, **`provider`**: see [Models and Providers](#models-and-providers).
- **`runtimeMode`**: `approval-required`, `auto-accept-edits`, `auto` or `full-access`.
- **`workspace`**: `worktree` makes a new Git worktree per issue, on the issue's Linear branch name. `local` uses the project's own checkout.
- **`baseRef`**: the ref new worktrees branch from. If it's unset and T3 can't tell the default branch, the run fails asking for `--base-ref`.
- **`startFromOrigin`**: branch new worktrees from the remote's `baseRef`.
- **`prompt`**: the first message of each thread. `{identifier}`, `{title}`, `{url}`, `{description}` and `{branchName}` are filled in, so `--prompt '/implement {identifier}'` works.
- **`pollInterval`**: seconds between polls of Linear, at least 10.
- **`maxRunningThreads`**: the most [Running threads](CONTEXT.md) T3 may have, counting threads you started by hand, before launches wait. Unset means no cap, and `0` pauses launches. Waiting issues start on a later poll. The cap is soft across Daemons: each counts the same Running threads, but two that poll at the same moment can both see room and go over the cap by a thread or two until the next poll.
- **`t3Url`**: the T3 Code server.
- **`stateFile`**: where State is kept, relative to the Global Config's folder. Every Daemon on the machine can share it: each write takes a lock (`<stateFile>.lock`) and merges its record into the file, and each Daemon rereads it every poll.

Status, label and `setStatus` names are checked against the team before the first poll, including the `In Progress` default, so a typo fails fast instead of matching nothing.

### Defaults from T3

When unset, these keys come from T3, never from a guess:

- `model` and `provider`: the T3 project's default model selection, options included.
- `runtimeMode`, `workspace` and `startFromOrigin`: the T3 project's setting, else T3's global setting.
- `baseRef`: the repository's default branch, as T3 reports it.

Threads always start in T3's default interaction mode.

### Models and Providers

`model` takes a T3 model id, its name, or any alias T3 knows, such as `opus-5.5` for `claude-opus-5-5`. linear-t3 looks it up in T3's model catalog, among enabled Providers only:

1. It matches the exact id first, then the name ignoring case, then an alias.
2. If one Provider offers the model, that Provider is used.
3. If several do, say Claude and Pi, it uses the Provider of the T3 project's default model, if that is one of them.
4. Otherwise the run fails and lists each candidate, so it never picks a Provider you didn't mean.

`provider` limits the lookup to one Provider, by T3's instance id or display name, ignoring case: `--provider pi`. With an explicit `model`, no model options are sent, so T3's own per-model defaults apply. To use options such as effort, set them on the T3 project's default model and leave `model` unset.

## Background service

`start` takes the same flags as `run`. It resolves the T3 project, then installs a Daemon for it with the OS service manager, which restarts it if it crashes and starts it at login:

- macOS: a launchd agent labeled `linear-t3.<project id>`, logging to its own file.
- Linux: a systemd user unit `linear-t3-<project id>.service`, logging to the user journal.

Each T3 project gets its own background Daemon. `start` in a second repository adds a Daemon and leaves the first one running; `start` again in a repository replaces only that project's Daemon. The unit is named by the project's id, so renaming the project in T3 doesn't orphan it, and `start` shows the project's title next to the id.

Each Daemon is pinned to its project. `start` saves the project's id, the flags you passed, the absolute path of the Local Config (if any) and the Global Config location into the unit, so it doesn't depend on the directory you ran `start` from:

```sh
cd ~/projects/my-app
linear-t3 start --team FIT --status Todo --model opus-5.5
```

`restart` keeps what's pinned; it rereads the Config files, so file changes apply. To change the flags, run `start` again.

`status` lists every installed Daemon, wherever you run it: its T3 project by title and id, whether it's running with its pid and uptime, and its Local Config, log and unit. The Global Config, Credentials and State are shared, so they're shown once, at the top.

`stop`, `restart`, `logs` and `uninstall` act on one Daemon, picked the way `start` picks the project: `--project`, then the Local Config, then the repository's T3 project. They also take `--config` and `--no-config`. So in a repository they act on its Daemon, and `--project <id, title or folder>` reaches any Daemon from anywhere:

```sh
linear-t3 logs -f                    # in ~/projects/my-app: my-app's Daemon
linear-t3 restart --project other    # from anywhere
```

When no project resolves, for example outside any repository, they use the only installed Daemon. If several are installed, they fail and list them, so you never act on the wrong one. `stop --all`, `restart --all` and `uninstall --all` act on every installed Daemon instead, from anywhere, and name each one:

```sh
linear-t3 stop --all
```

`start` refuses to run from the npx cache, because npm may clean it up and leave the service pointing at nothing. Install it first with `npm i -g linear-t3`.

The service runs `linear-t3 run` with the `node` that ran `start`, so run `start` again after switching Node versions; `status` warns when that `node` is gone. It doesn't inherit your shell's environment, so it reads both tokens from the Credentials file only, and tokens are never written to the unit. `start` refuses to install it if either one is missing or rejected.

On Linux, systemd stops user services when you log out unless lingering is on. To keep the Daemon running after you log out, or to start it at boot without logging in, run `loginctl enable-linger`. `status` reminds you while it's off.

Other platforms can still use `run` under their own supervisor.

### Upgrading from one background service

Up to linear-t3 1.1, there was one background service per machine: launchd agent `linear-t3`, or systemd user unit `linear-t3.service`. The next `start` or `status` moves it over, with nothing to do by hand:

- Pinned to a T3 project, it becomes that project's Daemon, with the same program and environment. It keeps running if it was running and stays stopped if it was stopped. If the project already has a Daemon, the old service is just removed.
- Pinned to no project, as 0.2 installed it, it's removed, and you're told to run `start` again in the repository it should watch.

When `start` moves it, it then installs the Daemon it was asked for, so you end up with one Daemon for the project. On macOS the old `daemon.log` is kept; the Daemon logs to `daemon-<project id>.log` from then on.

## Files

linear-t3 keeps its files in [XDG](https://specifications.freedesktop.org/basedir-spec/latest/) locations:

| File          | Location                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global Config | `$LINEAR_T3_CONFIG`, else `$XDG_CONFIG_HOME/linear-t3/config.json` (default `~/.config/linear-t3/...`)                                              |
| Local Config  | `--config <path>`, else the nearest `linear-t3.config.json` from the working directory up to the Git root                                           |
| Credentials   | `$XDG_CONFIG_HOME/linear-t3/credentials`, `KEY=value` lines, mode `0600`                                                                            |
| State         | `stateFile` from the Global Config, relative to its folder, else `$XDG_STATE_HOME/linear-t3/state.json` (default `~/.local/state/...`)              |
| Log           | One per Daemon. macOS: `$XDG_STATE_HOME/linear-t3/daemon-<project id>.log`. Linux: the systemd user journal, unit `linear-t3-<project id>`          |
| Unit          | One per Daemon. macOS: `~/Library/LaunchAgents/linear-t3.<project id>.plist`. Linux: `$XDG_CONFIG_HOME/systemd/user/linear-t3-<project id>.service` |

`LINEAR_API_KEY` and `T3_TOKEN` in the environment take precedence over the Credentials file for `run`, but not for the background service, which only reads the Credentials. `T3CODE_HOME` (default `~/.t3`) is where the Daemon finds T3 Code's environment id for the thread link in the Linear comment. `start` passes `LINEAR_T3_CONFIG`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `T3CODE_HOME` on to the background service, so it finds the same files.

## Migrating from the `projects`/`defaults` Config

Up to linear-t3 0.2, one Global Config listed every project under `projects`, with shared settings under `defaults`. That shape is no longer read: a Config with `projects` or `defaults` is rejected with a migration hint. Rewrite it as:

- **One Global Config** with the machine settings (`t3Url`, `maxRunningThreads`, `stateFile`) and anything every run shares from `defaults`.
- **One Local Config per project**: a `linear-t3.config.json` in each repository, holding that entry's `project`, `team`, filters and any other settings it overrode. Keep a project's former key as `project`, or drop it and run from inside the repository.
- **One background service, for one project**: a service installed by 0.2 is pinned to no project, so the next `linear-t3 start` or `linear-t3 status` removes it and tells you to run `linear-t3 start` again in the repository it should watch. To watch other projects in the background too, run `linear-t3 start` in each of their repositories; each gets its own Daemon.

Old keys and their replacements:

| Old key                                      | New key                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `projects` / `defaults`                      | One Local Config per project; shared settings in the Global Config                                                        |
| `projects.<key>`                             | `project` in that project's Local Config                                                                                  |
| `linear.team`                                | `team`                                                                                                                    |
| `linear.filter`                              | `filter`, or the named `status`, `label`, `assignee` and `priority` keys                                                  |
| `linear.onLaunch.moveToState`                | `setStatus`. It now defaults to `In Progress`; set `false` to leave the status alone                                      |
| `linear.onLaunch.comment`                    | `comment`                                                                                                                 |
| `promptTemplate`                             | `prompt`                                                                                                                  |
| `pollIntervalSeconds`                        | `pollInterval`                                                                                                            |
| `t3.url`                                     | `t3Url`                                                                                                                   |
| `workspace: { "type": "root" }`              | `workspace: "local"`                                                                                                      |
| `workspace: { "type": "worktree", ... }`     | `workspace: "worktree"`, plus `baseRef` and `startFromOrigin`                                                             |
| `workspace.baseRef`                          | `baseRef`. It now defaults to the repository's default branch, not `main`                                                 |
| `runtimeMode` (unset)                        | Was `full-access`; now the T3 project's or T3's default runtime mode. Set `runtimeMode` to keep `full-access`             |
| `workspace` (unset)                          | Was a worktree from origin; now where the T3 project starts new threads. Set `workspace` and `startFromOrigin` to keep it |
| `workspace.startFromOrigin`                  | `startFromOrigin`                                                                                                         |
| `model: { "instanceId": ..., "model": ... }` | `model` and `provider`, for example `"model": "opus-5.5"`                                                                 |
| `model.options`                              | Set them on the T3 project's default model and leave `model` unset                                                        |
| `--config <path>` (the Config)               | `--config <path>` now names a Local Config; `LINEAR_T3_CONFIG` still moves the Global one                                 |

Removed settings, with nothing to replace them:

- `maxLaunchesPerPoll`: `maxRunningThreads` is the only throttle.
- Per-project `maxRunningThreads`: the cap is global only.
- `interactionMode`: threads always start in T3's default interaction mode.
- `t3.webUrl`: thread links are always built from `t3Url`.

For example, this old Config:

<!-- readme-example: old -->

```json
{
  "pollIntervalSeconds": 60,
  "maxRunningThreads": 4,
  "t3": { "url": "http://127.0.0.1:3773" },
  "defaults": {
    "linear": { "onLaunch": { "comment": true, "moveToState": "In Progress" } },
    "model": { "instanceId": "claudeAgent", "model": "claude-opus-5-5" }
  },
  "projects": {
    "/home/me/projects/my-app": {
      "linear": {
        "team": "FIT",
        "filter": { "state": { "name": { "eq": "Todo" } } }
      },
      "workspace": { "type": "root" }
    }
  }
}
```

becomes this Global Config:

<!-- readme-example: migrated-global -->

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "maxRunningThreads": 4,
  "runtimeMode": "full-access",
  "model": "claude-opus-5-5",
  "provider": "claudeAgent"
}
```

and this `/home/me/projects/my-app/linear-t3.config.json`:

<!-- readme-example: migrated-local -->

```json
{
  "team": "FIT",
  "status": "Todo",
  "workspace": "local"
}
```

`pollInterval`, `comment` and `setStatus` are left out, because the old values are now the defaults. `runtimeMode` is set because the old built-in `full-access` now comes from T3 when unset.

## Launch order

When more issues match than the Daemon can start, it picks them in this order: Linear priority first, Urgent first and Low last, with "No priority" after Low, then oldest first. With no cap, every matching issue starts in the same poll. Issues held back by `maxRunningThreads` are picked in the same order once there's room.

Issues that already have a thread are skipped, across restarts and Config changes, so changing a filter never relaunches an issue.

## How it talks to T3 Code

T3 Code has no public API for creating threads, so the Daemon uses the same WebSocket RPC as the T3 web client. It needs T3 Code 0.1.0 or later. That is the first stable release to speak orchestration protocol 2 and register `orchestration.launchThread`, the same RPC behind T3's own `t3_thread_launch` tool. Older stable releases don't expose these RPCs.

1. It sends `POST /api/auth/websocket-ticket` with the bearer token and gets back a one-time ticket.
2. It opens `ws://…/ws?wsTicket=…&orchestrationProtocol=2`, which speaks Effect RPC with JSON messages. Servers that require protocol 2 reject sockets that don't declare it with `426 orchestration_protocol_incompatible`.
3. It calls `orchestration.subscribeShell`, takes the project list from the first snapshot, then interrupts the subscription.
4. It calls `server.getConfig` for the Providers, their models and aliases, and T3's settings, and `vcs.listRefs` on the project's folder for the default branch. A T3 without them fails with a compatibility error instead of falling back to guesses.
5. It calls `orchestration.launchThread` for each issue, with the project, model, workspace strategy and the initial message. The command ID, thread ID and message ID are all derived from the Linear issue ID. T3 keeps a receipt for each command ID, so if the response to a launch is lost and the Daemon retries with the same command ID, T3 returns the thread the first attempt created instead of creating a second one. The Daemon does not send `reuseExistingThread`: in protocol 2 it means "start a run in an existing empty thread", and sending it for a new thread fails with `ProjectionStoreThreadNotFoundError`.

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
