# Excluded labels add up and must exist in the team

Amends [0003](0003-labels-add-up-across-config-layers.md), which covers only labels an issue must carry.

Some labels mark issues a machine must never pick up, such as `windows-only` on a Mac or `ready-for-human` everywhere. `filter` can express this, but it's a local key and is replaced whole, so the rule would have to be repeated in every Local Config.

## Decision

- **A new `excludeLabel` key** (`--exclude-label`), set in any layer, the Global Config included.
- **An issue that carries any excluded label is skipped.** `label` stays "all of", and `excludeLabel` is "none of".
- **Excluded labels add up** across the CLI, the Local Config and the Global Config, each name once, ignoring case, like `label`.
- **Excluded names are checked against the team** before the first poll, like `label`. A name the team doesn't have is an error, not a no-op.
- **A label both required and excluded is an error** before the first poll. The error names the label and the layers that set it, because the run would otherwise match nothing.
- **Exclusion only affects which issues get picked up.** An issue that gains an excluded label after its thread started keeps its thread and its State entry.

## Considered options

- **A higher layer's exclusions replace the lower ones.** A one-off `--exclude-label` would then silently drop the machine's list, and exclusions only ever narrow, so adding up is safe.
- **Ignore excluded names the team doesn't have.** Such a name can't match anything, so ignoring it looks harmless. But a typo would then let through issues the user meant to skip, which is the dangerous direction.
- **A global, ANDed `filter`.** The option 0003 also left aside. It still needs rules for combining arbitrary JSON.

## Consequences

- An excluded label in the Global Config must exist for every team watched on the machine, as with `label`.
