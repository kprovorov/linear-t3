# Layer Config for parameter-driven foreground runs

Accepted design; implementation is planned in the [parameter-driven CLI project](https://linear.app/provorov/project/run-linear-t3-with-layered-config-and-cli-parameters-bb70c64bd978). The examples below describe the intended CLI contract.

Foreground `run` can take its Config from command-line parameters without requiring a Config file. Merge Config fields in ascending precedence: built-in defaults, global Config at the existing XDG location, the nearest `linear-t3.config.json` from the current directory up to the Git root, then command-line parameters. Each source can supply part of the Config: for example, global polling frequency, local project and team, and command-line labels. There is no `--no-config` flag. An explicit `--config <file>` selects the run-Config file instead of automatic file discovery. Thread caps are the exception: always read them from global Config as described in [ADR-0003](0003-coordinate-concurrent-daemons.md), including with explicit `--config`.

The run lifetime stays the same: poll until SIGINT or SIGTERM, or do one poll and exit with `--once`. A single poll launches eligible threads and exits without waiting for their work to finish. Credentials remain separate from Config.

Each run watches exactly one T3 project, selected by `--project <id|name|path>` or the current repository when not supplied by Config. Missing or ambiguous project matches fail clearly. This replaces the previous behavior of watching every configured project in one process. The new Config describes a single project, for example `{ "project": "fitme", "linear": { "team": "FIT" } }`. Continue reading legacy `projects`/`defaults` Config by selecting exactly one matching project entry; ambiguous selection fails.

Merge ordinary objects field by field, with higher-precedence arrays replacing lower-precedence arrays. Treat advanced raw filter JSON and model-options JSON as whole values. Combine raw Linear filters with named filters using AND. A named CLI filter replaces the corresponding saved criterion while preserving unrelated criteria. Repeated statuses mean ANY of those workflow names; repeated labels mean ALL of those labels. Match workflow names case-insensitively, and validate status and label names against the selected team before launching.

Repeatable `--unset <key>` removes an inherited choice for one invocation without editing Config files, restoring the built-in default for that choice. For example, `--unset linear.labels` clears inherited labels and `--unset model` uses the T3 project's default model. Apply unsets after merging files and before explicit CLI values, so explicit value flags win. Support familiar boolean flags such as `--no-comment`.

Every existing Config setting except thread caps is in scope for `run` parameters, with convenient flags for common choices and JSON input for advanced Linear filters and model options. `maxLaunchesPerPoll` remains an ordinary mergeable value: it limits launches in one poll rather than Running threads. Model selection accepts friendly aliases and exact model IDs resolved against T3's live catalog. A configured provider takes precedence; otherwise the T3 project's default provider can disambiguate a model. If the result is still unknown or ambiguous, fail clearly and require an explicit `--provider` when appropriate. Without a configured model, use the T3 project's default model.

Concurrent runs, overlap ownership, and thread caps follow [ADR-0003](0003-coordinate-concurrent-daemons.md).

For `--once` and `--dry-run`, exit 1 when validation, API calls, launches, or requested Linear updates fail. Otherwise exit 0, including zero matching issues and issues waiting on a cap. Continuous runs retry transient failures. SIGINT or SIGTERM stops scheduling, lets the current launch finish, and leaves launched threads running.

Keep background commands. `start` selects one project and pins its identity and Config file locations so the installed Daemon does not depend on its working directory. Background operation remains optional and can coexist with foreground runs.

## Example

Global Config:

```json
{
  "pollIntervalSeconds": 60,
  "maxRunningThreads": 6,
  "maxProjectRunningThreads": 4,
  "maxWatcherRunningThreads": 2
}
```

Local `linear-t3.config.json`:

```json
{
  "project": "fitme",
  "linear": { "team": "FIT", "statuses": ["Todo"] }
}
```

Concurrent invocations, each with its own allowance of two Running threads, sharing the project allowance of four and T3 allowance of six:

```sh
npx linear-t3 run --label Feature --model opus-5.5
npx linear-t3 run --label Bug --model opus-5.5
```

To supply team and status directly instead:

```sh
npx linear-t3 run --team FIT --status Todo --model opus-5.5
```

The CLI uses the current repository when no project is supplied. Add `--once` for one poll or `--dry-run` to report without launching or mutating State or Linear. Add `--provider` if Config and the T3 project's default provider cannot resolve the model uniquely.
