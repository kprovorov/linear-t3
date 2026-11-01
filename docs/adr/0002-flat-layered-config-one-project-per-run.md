# Flat, layered Config with one T3 project per run

Spec: [Run linear-t3 as a script with flat, layered Config](https://linear.app/provorov/project/run-linear-t3-as-a-script-with-flat-layered-config-5339875350a6).

`linear-t3 run` should work like a script: `npx linear-t3 run --team FIT --status Todo --model opus-5.5`. Before this change, a run took everything from one saved multi-project Config file, so a one-off change meant editing that file.

## Decision

- **One T3 project per run.** A run watches the project given by `project`, or the current repository's T3 project when none is given. A Linear team picks which issues to watch; it doesn't pick where threads go.
- **Flat keys, one flag per key.** The Config has no nesting. Every key has one flag with the same name in kebab-case: `startFromOrigin` ↔ `--start-from-origin`. A boolean flag takes `true` or `false`, and a bare flag means `true`. A list key such as `status` takes a string or an array in a file, and the flag is repeated on the CLI.
- **Layers resolve per key**, highest first: CLI flags, then the Local Config, then the Global Config, then the T3 project's own default, then the built-in default. A key missing from one layer falls through to the next. A higher layer's list replaces a lower one; it never adds to it.
- **Each key has a scope.** Global keys are machine settings: `maxRunningThreads`, `t3Url` and `stateFile`. Local keys say what to watch and are tied to a Linear team: `project`, `team`, `status`, `label`, `assignee`, `priority`, `filter` and `setStatus`. They may appear in the Local Config or on the CLI. Every other key may appear in any layer. A key in the wrong place is an error that names the right place.
- **T3 defaults come first.** When unset, `model`, `provider`, `runtimeMode`, `workspace` and `startFromOrigin` come from the T3 project's settings. `baseRef` comes from the repository's default branch, as T3 reports it. A model alias such as `opus-5.5` resolves through T3's model catalog, among enabled Providers.
- **No support for the old shape.** A Config with `projects` or `defaults` is rejected, with an error that explains how to migrate.
- **The Local Config** is the nearest `linear-t3.config.json` from the working directory up to the Git root. `--config <file>` replaces it. The Global Config stays in the XDG location; `LINEAR_T3_CONFIG` moves it.

## Considered options

- **Nested Config with dotted flags** (`--linear.team`). This would have kept the existing file shape, but the flags are awkward and the layers would need deep-merge rules. Flat keys make both the flag mapping and the layering trivial.
- **Many projects per run.** This was the existing behavior. Per-run filters don't make sense across several projects, so a run watches one project. More projects mean more runs.
- **Our own defaults and alias table.** linear-t3 used to fix the runtime mode and worktree settings itself, and its default base branch was `main`. Reading them from T3 avoids duplicating settings the user has already chosen there and handles repositories whose default branch is `master`.

## Consequences

- This is a breaking change. Existing Configs must be rewritten as one Global Config plus one Local Config per repository.
- The background service watches one project. `start` takes the same flags as `run` and saves the resolved project, the flags and the Config file locations in the service, so the service doesn't depend on its working directory.
- When several runs work on the same machine, nothing coordinates their claims or their writes to State. A stable launch key per issue makes T3 return the existing thread when two runs race for the same issue.
