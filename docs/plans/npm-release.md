# Plan: release linear-t3 as an npm package

Goal: `npm install -g linear-t3`, then `linear-t3 login`, `linear-t3 init` and `linear-t3` work from any directory, without a `.env` file or a cloned repo. The existing repo workflow (`npm start`, `.env`, `pm2 start`) keeps working.

## Where things stand

- Secrets come from `process.env` (`requireEnv` in `src/config.ts`). They get there through `--env-file-if-exists=.env` in the npm scripts and `--env-file=.env` in `ecosystem.config.js`.
- The config path defaults to `./config.json` (`src/main.ts`) and `stateFile` defaults to `./state.json` (`src/config.ts`). Both are relative to the current directory.
- The code runs as `.ts` through Node's type stripping. Node refuses to strip types for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the package has to ship JS.
- `package.json` is `"private": true` and has no `bin` or `files`.
- The name `linear-t3` is free on npm (checked 2026-10-10).

## 1. One config directory

Add `src/paths.ts` with a single `configDir()`:

1. `$LINEAR_T3_HOME`, if set
2. `$XDG_CONFIG_HOME/linear-t3`
3. `~/.config/linear-t3` on Linux and macOS (the same convention `gh` uses on both)
4. `%APPDATA%\linear-t3` on Windows

The directory holds `config.json`, `credentials.json` and `state.json`.

**State stays next to the config, not under `~/.local/state`.** Losing the state file makes the daemon relaunch every matching issue, so the state location must never change silently. The rule becomes: **a relative `stateFile` resolves against the config file's directory, not the current directory.** The current repo setup (`./config.json` + `./state.json` in the same folder) resolves to the same file as today, so no migration is needed.

Config path order: `--config` → `$CONFIG_PATH` → `./config.json` if it exists (repo checkouts) → `configDir()/config.json`. When none exists, the error says to run `linear-t3 init`.

## 2. Credentials

Add `src/credentials.ts`:

```ts
// Order: environment variable, then credentials.json in the config directory.
export async function loadCredentials(): Promise<{ linearApiKey?: string; t3Token?: string }>;
```

- `LINEAR_API_KEY` / `T3_TOKEN` env vars always win. CI, pm2 `env:` blocks and the `.env` workflow keep working unchanged.
- Otherwise the values come from `configDir()/credentials.json`: `{ "linearApiKey": "...", "t3Token": "..." }`, validated with zod.
- If the file is readable by group or others (`mode & 0o077`), log a warning with the `chmod 600` command, like ssh does. Warn instead of refusing, so a strict check can't take down a running daemon.
- Missing key error: `No Linear API key. Run "linear-t3 login" or set LINEAR_API_KEY.`
- `requireEnv` is removed. `main()` reads from `loadCredentials()`.

No OS keyring for now. The daemon usually runs headless under pm2, where the Secret Service is locked or missing, and the keyring would add a native dependency. It can be added later as opt-in.

## 3. CLI subcommands

`main.ts` switches `parseArgs` to `allowPositionals` and dispatches:

| Command                                  | What it does                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear-t3` (or `linear-t3 run`)         | Today's behaviour, with the existing `--once`, `--dry-run` and `--config` flags.                                                                                                                                                                                 |
| `linear-t3 login`                        | Prompts for the Linear key with hidden input and checks it with a `viewer` query. For the T3 token, it runs `t3 auth session issue --label linear-t3 --ttl 365d --token-only` and falls back to a prompt if `t3` isn't on `PATH`. Writes `credentials.json` (see below). |
| `linear-t3 init`                         | Copies `config.example.json` to `configDir()/config.json` unless it already exists, then prints the path to edit.                                                                                                                                                |
| `linear-t3 paths`                        | Prints the config, credentials and state paths, and which source each credential comes from (env or file). This makes it easy to debug "which key is it using?".                                                                                                |

Write the credentials file safely:

- Create the directory with `mkdir(dir, { recursive: true, mode: 0o700 })`.
- Write to a temp file opened with `mode: 0o600`, then `rename` it over the target. This matches `StateStore`'s atomic write, so the secret is never briefly world-readable.
- `login` keeps a value that isn't re-entered (pressing Enter skips it), so the two tokens can be rotated independently.

Hidden input: `node:readline` has no password mode, so put stdin into raw mode and read characters without echoing. That's about 20 lines in `src/prompt.ts`, with no dependency.

## 4. Build

- Add a `#!/usr/bin/env node` shebang to `src/main.ts`. Type stripping accepts it and `tsc` keeps it.
- Add `tsconfig.build.json`, which extends `tsconfig.json` with `noEmit: false`, `outDir: "dist"` and `rewriteRelativeImportExtensions: true`. The last option turns the existing `./config.ts` imports into `./config.js` in the output, so the source doesn't change.
- Dependencies stay external, with no bundling: `@linear/sdk` and `zod` install as normal dependencies.
- Add `.gitignore` entries for `dist/` and `credentials.json`.

The repo itself still runs `src/main.ts` directly; only the published package uses `dist/`.

## 5. package.json

```jsonc
{
  "name": "linear-t3",
  "version": "0.1.0",
  // "private": true removed
  "bin": { "linear-t3": "dist/main.js" },
  "files": ["dist", "config.example.json"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepublishOnly": "vp check && npm run build",
    // start / once / dry-run unchanged
  },
  "license": "...",      // see open questions
  "repository": "...",
  "keywords": ["linear", "t3code", "daemon"],
}
```

`files` is an allowlist, so `.env`, `config.json`, `state.json` and `credentials.json` can't end up in the tarball even if they sit in the repo.

## 6. pm2 for npm installs

The README gets a second pm2 recipe for global installs. Since credentials and config now come from the config directory, nothing needs to be passed in:

```sh
pm2 start linear-t3 --kill-timeout 30000 --restart-delay 10000
pm2 save && pm2 startup
```

`ecosystem.config.js` stays for repo checkouts, unchanged.

## 7. README

- Lead with "Install": `npm i -g linear-t3` → `linear-t3 login` → `linear-t3 init` → `linear-t3 --dry-run`.
- Move the clone + `.env` setup to a "Running from source" section.
- Document the lookup order for config, credentials and state, plus `LINEAR_T3_HOME`.
- Replace the "no build step" line: the published package is compiled, and running from source still needs no build step.

## 8. Verification

There's no test runner yet, so verification is manual:

1. `npx vp check`
2. `npm pack --dry-run`. The listing should contain only `dist/`, `config.example.json`, `README.md`, `LICENSE` and `package.json`.
3. Install the tarball into a throwaway prefix: `npm pack && npm i -g --prefix /tmp/lt3 ./linear-t3-0.1.0.tgz`.
4. With `HOME` pointed at a temp directory, check that:
   - `linear-t3` fails with the "run linear-t3 init" message
   - `init` creates the directory with `0700`
   - `login` creates `credentials.json` with `0600` (check with `stat -c %a`)
   - `paths` reports `file` as the source
   - `LINEAR_API_KEY=x linear-t3 paths` reports `env`
5. `linear-t3 --dry-run`, then `--once`, against the real T3 server.
6. In the repo: `npm run dry-run` still finds `.env`, `./config.json` and the existing `./state.json`. Confirm that no issue shows up as new.

## 9. Release

- `npm publish --access public`, run by you after the PR merges. The plan doesn't publish anything automatically.
- Optional later step: publish from GitHub Actions with npm provenance (`--provenance`) on tag push.

## Open questions

1. **License:** there's no `LICENSE` file yet. MIT?
2. **Name:** unscoped `linear-t3` or scoped `@kprovorov/linear-t3`? The unscoped name is free today.
3. **Windows:** T3 Code runs there, but the daemon has only been run on Linux. Should the `%APPDATA%` path ship as untested, or should Windows be left out for now?
4. **Changelog and versioning:** use a hand-written `CHANGELOG.md`, or skip it until 1.0?
