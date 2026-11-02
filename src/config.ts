import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";

/** The Local Config's file name, found from the working directory up to the Git root. */
export const LOCAL_CONFIG_NAME = "linear-t3.config.json";

export const DEFAULT_PROMPT = `Work on Linear issue {identifier}: {title}

{url}

{description}`;

/**
 * Where a key may be set. `global`: only the Global Config (machine settings). `local`: only the
 * Local Config, as it says what to watch. `all`: any layer.
 */
export type Scope = "global" | "local" | "all";

/** How a key's value is written, so that a flag can be generated from it. */
export type KeyType = "string" | "boolean" | "integer" | "json";

export interface KeyDeclaration<S extends z.ZodType = z.ZodType> {
  type: KeyType;
  scope: Scope;
  schema: S;
  /** The built-in default, used when no layer sets the key. */
  fallback?: z.output<S>;
  description: string;
  /** The flag's value placeholder in help, e.g. `<team>`. Booleans always get `[true|false]`. */
  arg?: string;
  /** What help says the default is, when `fallback` is unset or doesn't read well. */
  defaultText?: string;
}

const declare = <S extends z.ZodType>(declaration: KeyDeclaration<S>) => declaration;

/**
 * Every Config key, declared once. Scope checks, defaults, validation and the CLI flags come from
 * here: each non-global key's flag is its name in kebab-case.
 */
export const KEYS = {
  project: declare({
    type: "string",
    scope: "local",
    schema: z.string().min(1),
    description:
      "the T3 project to launch threads in: its id, unique title or folder path, relative to the file that sets it or, on the CLI, to the working directory",
    arg: "<project>",
    defaultText: "the T3 project whose folder is the Git root",
  }),
  team: declare({
    type: "string",
    scope: "local",
    schema: z.string().min(1),
    description: 'the Linear team key whose issues to watch, e.g. "ENG"',
    arg: "<team>",
    defaultText: "required",
  }),
  filter: declare({
    type: "json",
    scope: "local",
    // A raw Linear `IssueFilter`, ANDed with the team and passed to the Linear API as-is. See
    // https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter
    schema: z.record(z.string(), z.unknown()),
    description: "a Linear IssueFilter, as JSON, that issues must also match",
    arg: "<json>",
    defaultText: "none",
  }),
  setStatus: declare({
    type: "string",
    scope: "local",
    schema: z.string().min(1),
    description: "the workflow status to move an issue to once its thread starts",
    arg: "<status>",
    defaultText: "leave the status as it is",
  }),
  comment: declare({
    type: "boolean",
    scope: "all",
    schema: z.boolean(),
    fallback: true,
    description: "comment on the Linear issue with a link to its thread",
  }),
  model: declare({
    type: "string",
    scope: "all",
    schema: z.string().min(1),
    description: "the model threads run on: a T3 model id, name or alias",
    arg: "<model>",
    defaultText: "the T3 project's default model",
  }),
  provider: declare({
    type: "string",
    scope: "all",
    schema: z.string().min(1),
    description: "the T3 Provider to find `model` in: its instance id or display name",
    arg: "<provider>",
    defaultText:
      "the one enabled Provider that offers `model`, else the T3 project's default Provider",
  }),
  runtimeMode: declare({
    type: "string",
    scope: "all",
    schema: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]),
    fallback: "full-access",
    description:
      "the T3 runtime mode threads start in: approval-required, auto-accept-edits, auto or full-access",
    arg: "<mode>",
  }),
  workspace: declare({
    type: "string",
    scope: "all",
    schema: z.enum(["local", "worktree"]),
    fallback: "worktree",
    description:
      "`worktree`: a new Git worktree per issue, on its Linear branch; `local`: the project's own checkout",
    arg: "<local|worktree>",
  }),
  baseRef: declare({
    type: "string",
    scope: "all",
    schema: z.string().min(1),
    description: "the ref new worktrees branch from",
    arg: "<ref>",
    defaultText: "the repository's default branch, as T3 reports it",
  }),
  startFromOrigin: declare({
    type: "boolean",
    scope: "all",
    schema: z.boolean(),
    fallback: true,
    description: "branch new worktrees from the remote's `baseRef`",
  }),
  prompt: declare({
    type: "string",
    scope: "all",
    schema: z.string().min(1),
    fallback: DEFAULT_PROMPT,
    description:
      "the first message of each thread; {identifier}, {title}, {url}, {description} and {branchName} are filled in",
    arg: "<template>",
    defaultText: "a built-in template",
  }),
  pollInterval: declare({
    type: "integer",
    scope: "all",
    schema: z.number().int().min(10),
    fallback: 60,
    description: "seconds between polls of Linear, at least 10",
    arg: "<seconds>",
  }),
  maxRunningThreads: declare({
    type: "integer",
    scope: "global",
    schema: z.number().int().min(0),
    description:
      "the most Running threads T3 may have before launches wait; unset means no cap, 0 pauses launches",
  }),
  t3Url: declare({
    type: "string",
    scope: "global",
    schema: z.string().url(),
    fallback: DEFAULT_T3_URL,
    description: "the T3 Code server, also used for thread links",
  }),
  stateFile: declare({
    type: "string",
    scope: "global",
    schema: z.string().min(1),
    description: "where State is kept, relative to the Global Config (default: XDG state)",
  }),
} satisfies Record<string, KeyDeclaration>;

export type Key = keyof typeof KEYS;
type Value<K extends Key> = z.output<(typeof KEYS)[K]["schema"]>;
export type Values = { [K in Key]?: Value<K> };

/** One source of keys: a Config file, or the CLI flags. */
interface Layer {
  /** The file, for messages; none for the CLI. */
  path?: string;
  /** The folder relative paths in it resolve against. */
  base: string;
  values: Values;
}

/** The effective Config for a run: every key resolved, plus where the files are. */
export interface Config {
  /**
   * The T3 project to watch: named by `project`, with the folder a relative path resolves against
   * (that of the file that set it), or else the folder whose T3 project to infer.
   */
  project: { ref: string; base: string } | { folder: string };
  team: string;
  filter?: Value<"filter">;
  setStatus?: string;
  comment: boolean;
  model?: string;
  provider?: string;
  runtimeMode: Value<"runtimeMode">;
  workspace: Value<"workspace">;
  /** Unset: the repository's default branch, which the Daemon asks T3 for. */
  baseRef?: string;
  startFromOrigin: boolean;
  prompt: string;
  pollInterval: number;
  maxRunningThreads?: number;
  t3Url: string;
  /** Absolute. */
  stateFile: string;
  files: { global: string; local?: string };
}

const isKey = (key: string): key is Key => Object.hasOwn(KEYS, key);

/** A key's flag, without the dashes: its name in kebab-case. */
export const flagName = (key: Key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// Keys of the old nested Config that became a flat key under another name.
const RENAMED: Record<string, string> = {
  moveToState: "setStatus",
  promptTemplate: "prompt",
  pollIntervalSeconds: "pollInterval",
  t3: "t3Url",
  linear: "team, filter, setStatus and comment",
  onLaunch: "setStatus and comment",
};

const MIGRATION = [
  "The Config is now flat, one T3 project per run. Rewrite it as:",
  `  - the Global Config: t3Url, maxRunningThreads, stateFile and any shared defaults`,
  `  - a ${LOCAL_CONFIG_NAME} in each repository: project, team, filter, setStatus`,
  "Renamed keys:",
  "  linear.team → team, linear.filter → filter",
  "  linear.onLaunch.moveToState → setStatus, linear.onLaunch.comment → comment",
  "  promptTemplate → prompt, pollIntervalSeconds → pollInterval, t3.url → t3Url",
  '  workspace.type "root" → workspace "local", workspace.type "worktree" → workspace "worktree"',
  "  workspace.baseRef → baseRef, workspace.startFromOrigin → startFromOrigin",
  "  model.instanceId → provider, model.model → model",
].join("\n");

export class ConfigError extends Error {}

const describeScope = (scope: Scope, globalPath: string) =>
  scope === "global"
    ? `the Global Config (${globalPath})`
    : `a Local Config (${LOCAL_CONFIG_NAME} in the repository, or --config)`;

/** Reads one Config file. A missing file is `undefined`; anything else wrong is a `ConfigError`. */
async function readLayer(
  path: string,
  which: "global" | "local",
  globalPath: string,
): Promise<Layer | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`Could not read config ${path}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid config ${path}: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`Invalid config ${path}: expected a JSON object`);
  }
  if ("projects" in raw || "defaults" in raw) {
    throw new ConfigError(
      `Invalid config ${path}: "projects" and "defaults" are the old Config shape.\n${MIGRATION}`,
    );
  }

  const problems: string[] = [];
  // Whether anything looks like the old nested Config, which earns the migration hint.
  let old = false;
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isKey(key)) {
      const renamed = RENAMED[key];
      old ||= renamed !== undefined;
      problems.push(
        renamed
          ? `${key}: renamed to ${renamed.includes(" ") ? renamed : `"${renamed}"`}`
          : `${key}: unknown key, remove it or fix its name`,
      );
      continue;
    }
    const { scope, schema } = KEYS[key];
    if (scope !== "all" && scope !== which) {
      problems.push(`${key}: only goes in ${describeScope(scope, globalPath)}`);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      // `workspace` and `model` used to be objects.
      old ||= KEYS[key].type !== "json" && typeof value === "object" && value !== null;
      problems.push(`${key}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
      continue;
    }
    values[key] = result.data;
  }
  if (problems.length > 0) {
    const lines = problems.map((problem) => `  ✖ ${problem}`).join("\n");
    throw new ConfigError(`Invalid config ${path}:\n${lines}${old ? `\n${MIGRATION}` : ""}`);
  }
  return { path, base: dirname(path), values: values as Values };
}

/** The Git root holding `dir`, or `undefined` outside a Git repository. */
export function gitRoot(dir: string): string | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/**
 * The nearest Local Config from `cwd` up to the Git root. Outside Git, only `cwd` is checked.
 */
export function findLocalConfig(cwd: string): string | undefined {
  const root = gitRoot(cwd) ?? resolve(cwd);
  for (let current = resolve(cwd); ; current = dirname(current)) {
    const candidate = join(current, LOCAL_CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    if (current === root || dirname(current) === current) return undefined;
  }
}

/** A `stateFile` is relative to the Global Config's folder. */
const resolveStateFile = (globalPath: string, stateFile: string) =>
  resolve(dirname(globalPath), stateFile);

/** The Global Config's keys, for commands that only need machine settings (`status`, `connect`). */
export async function loadGlobalConfig(
  globalPath: string,
): Promise<{ t3Url: string; stateFile?: string }> {
  const values = (await readLayer(globalPath, "global", globalPath))?.values ?? {};
  return {
    t3Url: values.t3Url ?? DEFAULT_T3_URL,
    stateFile: values.stateFile && resolveStateFile(globalPath, values.stateFile),
  };
}

export interface ConfigSources {
  /** The Global Config's path; a missing file is fine. */
  global: string;
  /** `--config`: replaces discovery, and must exist. */
  local?: string;
  /** Where to start looking for the Local Config, and what a relative path on the CLI is relative to. */
  cwd: string;
  /** The keys the CLI flags set, already validated. */
  flags?: Values;
  /** The State file when the Global Config sets none. */
  defaultState: string;
}

/**
 * The effective Config: per key, the CLI flags, else the Local Config, else the Global Config,
 * else the built-in default. A value replaces the lower one whole; lists and objects never merge.
 */
export async function loadConfig({
  global: globalPath,
  local: explicitLocal,
  cwd,
  flags = {},
  defaultState,
}: ConfigSources): Promise<Config> {
  const localPath = explicitLocal ? resolve(cwd, explicitLocal) : findLocalConfig(cwd);
  if (localPath === resolve(globalPath)) {
    // Background services installed before the Local Config existed pass the Global one here.
    throw new ConfigError(
      `--config ${localPath} is the Global Config, but --config now names a Local Config. If the background service runs this, run \`linear-t3 start\` again in the repository to watch`,
    );
  }
  const globalLayer = await readLayer(globalPath, "global", globalPath);
  const localLayer = localPath ? await readLayer(localPath, "local", globalPath) : undefined;
  if (explicitLocal && !localLayer) throw new ConfigError(`No config at ${localPath}`);

  const cliLayer: Layer = { base: cwd, values: flags };
  const layers = [cliLayer, localLayer, globalLayer].filter((layer) => layer !== undefined);
  const pick = <K extends Key>(key: K): { value?: Value<K>; layer?: Layer } => {
    for (const layer of layers) {
      if (layer.values[key] !== undefined) return { value: layer.values[key], layer };
    }
    return { value: (KEYS[key] as KeyDeclaration).fallback as Value<K> | undefined };
  };
  const get = <K extends Key>(key: K) => pick(key).value;
  const required = <K extends Key>(key: K): Value<K> => {
    const value = get(key);
    if (value === undefined) {
      const where = localLayer ? localLayer.path : `${LOCAL_CONFIG_NAME} in the repository`;
      throw new ConfigError(
        `Missing "${key}": pass --${flagName(key)} or set it in the Local Config (${where})`,
      );
    }
    return value;
  };

  const project = pick("project");
  const stateFile = get("stateFile");
  return {
    project:
      project.value === undefined
        ? { folder: gitRoot(cwd) ?? resolve(cwd) }
        : { ref: project.value, base: project.layer?.base ?? cwd },
    team: required("team"),
    filter: get("filter"),
    setStatus: get("setStatus"),
    comment: required("comment"),
    model: get("model"),
    provider: get("provider"),
    runtimeMode: required("runtimeMode"),
    workspace: required("workspace"),
    baseRef: get("baseRef"),
    startFromOrigin: required("startFromOrigin"),
    prompt: required("prompt"),
    pollInterval: required("pollInterval"),
    maxRunningThreads: get("maxRunningThreads"),
    t3Url: required("t3Url"),
    stateFile: stateFile ? resolveStateFile(globalPath, stateFile) : defaultState,
    files: { global: globalPath, local: localLayer?.path },
  };
}
