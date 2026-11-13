# One background Daemon per T3 project

Amends [0002](0002-flat-layered-config-one-project-per-run.md), whose consequences said the background service watches one project and that nothing coordinates writes to State.

There was one background service per machine. `linear-t3 start` in a second repository rewrote it, so starting a Daemon for one project stopped the Daemon for another. Watching several projects in the background meant running `linear-t3 run` under your own supervisor.

## Decision

- **One background Daemon per T3 project.** `start` installs a Daemon for the project it resolves. If that project already has one, `start` replaces it. Daemons for other projects keep running.
- **Units are named by the project's id**: `linear-t3.<id>` for launchd, `linear-t3-<id>.service` for systemd. Messages show the project's title next to it.
- **Commands pick a Daemon the way `start` picks a project**: `--project`, then the Local Config, then the repository's T3 project. When nothing resolves and exactly one Daemon is installed, they use it. When several are installed, they fail and list them. `stop`, `restart` and `uninstall` take `--all`. `status` lists every Daemon.
- **One shared State.** Each write takes a lock, rereads the file, merges in its change and saves atomically. Each Daemon rereads State at the start of every poll, so it sees issues the other Daemons launched.
- **The thread cap stays soft.** All Daemons count the same Running threads in T3, but two that poll at the same moment can both see room. They may go over the cap until the next poll.
- **The old single unit migrates itself.** The first `start` or `status` after upgrading reinstalls the old `linear-t3` unit under its project's name, keeps it running if it was running, and removes the old file. An old unit pinned to no project is removed, with a message telling you to run `start` again.

## Considered options

- **A Daemon per Local Config, or per user-chosen name.** These allow two Daemons for one project, for example one per Linear team. That's rare, `run` covers it, and ADR 0002 already ties a run to one project. A name would be one more thing to remember.
- **Units named by a slug of the project title.** Easier to read in `launchctl list`, but titles change and repeat, and a rename would orphan the unit.
- **One State file per project.** This avoids concurrent writes entirely, but `stateFile` is a global key and would have to become a directory or a template. The existing `state.json` would also need splitting. And a foreground `run` alongside a background Daemon for the same project would still share a file.
- **A lock around "count Running threads, then launch".** This would make the cap exact across Daemons, but it serializes every launch on the machine. The cap is already soft, because threads you start by hand count too.

## Consequences

- On macOS, each Daemon logs to its own `daemon-<id>.log`. `uninstall` keeps it, like the Config, Credentials and State.
- `run` warns when its project already has a running background Daemon, but keeps going. The shared State and T3's launch receipts keep the two from launching an issue twice.
- A State write now rereads the whole file, which costs more as State grows.
