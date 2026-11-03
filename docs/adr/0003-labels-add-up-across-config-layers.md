# Labels add up across Config layers

Amends [0002](0002-flat-layered-config-one-project-per-run.md), where every list replaced the lower layer's and `label` was a local key.

Some labels belong to a machine, not a repository. A `mac` label marks issues only a Mac can work on, so every run on a Mac should require it, on top of the labels each repository requires. With labels local and replaced whole, `mac` had to be repeated in every Local Config, and `--label` for a one-off run silently dropped the file's labels.

## Decision

- **`label` may be set in any layer**, the Global Config included.
- **Labels add up.** The effective labels are the CLI's, the Local Config's and the Global Config's together, each name once, ignoring case. An issue must carry all of them, as before.
- **Every other list still replaces.** `status` is "any of", so adding up would widen the filter as layers stack. A higher layer's `status` replaces the lower one's.

## Considered options

- **Merge every list.** Adding `status` names across layers would let a Global Config status make every run watch more issues, the opposite of what a higher, more specific layer is for.
- **A separate `extraLabel` key.** Keeps 0002's rule intact but gives one concept two keys. Labels only ever narrow, so adding up is always safe.
- **Global `filter`, ANDed across layers.** Would cover machine-wide raw filters too, but needs rules for combining arbitrary JSON. Left for when it's needed.

## Consequences

- `--label` no longer replaces the Config files' labels. A run can't drop a label a Config file requires; edit the file, or use `--config`/`--no-config` for the Local Config.
- A label in the Global Config must exist for every team watched on the machine, since names are checked against the team before the first poll.
