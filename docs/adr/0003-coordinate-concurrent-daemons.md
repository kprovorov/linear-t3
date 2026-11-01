# Coordinate concurrent Daemons with shared caps and temporary watcher caps

Accepted design; implementation is planned in the [parameter-driven CLI project](https://linear.app/provorov/project/run-linear-t3-with-layered-config-and-cli-parameters-bb70c64bd978).

Several Daemons may watch the same T3 project with different filters, such as features and bugs. An issue matching several runs gets one thread: the first run to claim it supplies the model, prompt, and launch actions. Keep persistent shared State so retries, restarts, and different Config files do not relaunch the issue merely because its filter or model changed.

## Caps

All Running-thread caps come only from global Config:

- `maxRunningThreads`: shared cap across the selected T3 server.
- `maxProjectRunningThreads`: shared cap within the selected T3 project.
- `maxWatcherRunningThreads`: temporary cap on Running threads launched by this process.

Shared caps count threads launched by all Daemons and by the user. Each process has its own watcher allowance; there are no watcher names or persistent watcher groups. A restarted process gets a fresh watcher allowance, while existing Running threads still count toward shared caps. All applicable caps must have room before launching. An omitted cap means unlimited; zero pauses launches at that scope. A lower cap never terminates existing threads.

Local Config, explicit run-Config files, CLI value flags, and `--unset` cannot override or clear these caps. Report misplaced cap values clearly. When reading legacy Config, accept global `maxRunningThreads` and global-file project/default thread caps at their original scopes; require moving any thread caps from local files into global Config. Per-poll launch limits remain independently configurable through normal Config layering.

## Coordination and recovery

Coordinate issue claims, State writes, and launch admission across linear-t3 processes on the same machine. Custom State paths must not bypass shared deduplication or cap coordination. Preserve T3 launch idempotency when an outcome is uncertain, and allow recovery after process failure without creating duplicate threads.

Scope pending Linear updates to the selected project/team. Retries use the original claimant's recorded launch actions. A later run changing its comment or state-transition choices does not rewrite an earlier launch's pending actions.

Shared caps govern linear-t3 launch admission using T3's Running-thread counts. User-created threads consume room but remain controlled by T3. `--dry-run` reads counts and reports shared and process limits without claiming issues, launching threads, changing Linear, or writing State.
