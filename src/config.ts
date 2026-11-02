import { readFile } from "node:fs/promises";
import { z } from "zod";

export const DEFAULT_T3_URL = "http://127.0.0.1:3773";

// A raw Linear `IssueFilter` object, passed through to the Linear API as-is.
// See https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/IssueFilter
const IssueFilter = z.record(z.string(), z.unknown());

const ModelSelection = z.object({
  instanceId: z.string(),
  model: z.string(),
  options: z.unknown().optional(),
});

const WorkspaceStrategy = z.discriminatedUnion("type", [
  // Run the thread in the project's main checkout.
  z.object({ type: z.literal("root") }),
  // Create a new git worktree per issue, on the issue's Linear branch name.
  z.object({
    type: z.literal("worktree"),
    baseRef: z.string().default("main"),
    startFromOrigin: z.boolean().default(true),
  }),
]);

const OnLaunch = z.object({
  // Workflow state name to move the issue to once its thread is started.
  moveToState: z.string().optional(),
  comment: z.boolean().optional(),
});

// How threads are started. Every field can be set in `defaults` and overridden per project.
const ThreadSettings = z.object({
  workspace: WorkspaceStrategy.optional(),
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).optional(),
  // Unset everywhere means the T3 project's default model.
  model: ModelSelection.optional(),
  promptTemplate: z.string().optional(),
});

// Settings shared by every project. A project's own value wins; nested objects (`workspace`, `model`,
// `linear.filter`) are replaced as a whole, while `linear.onLaunch` is merged key by key.
const Defaults = ThreadSettings.extend({
  linear: z.object({ filter: IssueFilter.optional(), onLaunch: OnLaunch.optional() }).optional(),
});

// Which Linear issues go to one T3 project, and how their threads are started.
const ProjectEntry = ThreadSettings.extend({
  linear: z.object({
    // Linear team key, e.g. "ENG".
    team: z.string(),
    // Linear `IssueFilter`, AND-ed with the team filter. Only matching issues get a thread.
    filter: IssueFilter.optional(),
    onLaunch: OnLaunch.optional(),
  }),
});

// A project entry merged with `defaults`, with built-in defaults filling whatever is still unset.
const ProjectSettings = z.object({
  linear: z.object({
    team: z.string(),
    filter: IssueFilter.optional(),
    onLaunch: z
      .object({ moveToState: z.string().optional(), comment: z.boolean().default(true) })
      .prefault({}),
  }),
  workspace: WorkspaceStrategy.default({
    type: "worktree",
    baseRef: "main",
    startFromOrigin: true,
  }),
  runtimeMode: ThreadSettings.shape.runtimeMode.unwrap().default("full-access"),
  model: ModelSelection.optional(),
  promptTemplate: z.string().optional(),
});

const Config = z
  .object({
    pollIntervalSeconds: z.number().int().min(10).default(60),
    // Caps Running threads across all of T3, including threads started by hand. Unset means no cap.
    maxRunningThreads: z.number().int().min(0).optional(),
    // Relative to the Config file's directory. Unset means the XDG State location.
    stateFile: z.string().optional(),
    t3: z.object({ url: z.string().url().default(DEFAULT_T3_URL) }).prefault({}),
    defaults: Defaults.prefault({}),
    // Keyed by T3 project id, title, or workspace root path.
    projects: z
      .record(z.string(), ProjectEntry)
      .refine((p) => Object.keys(p).length > 0, "Define at least one project"),
  })
  .transform(({ defaults, projects, ...rest }) => ({
    ...rest,
    projects: Object.fromEntries(
      Object.entries(projects).map(([ref, p]) => [ref, resolveProject(defaults, p)]),
    ),
  }));

function resolveProject(
  defaults: z.infer<typeof Defaults>,
  project: z.infer<typeof ProjectEntry>,
): ProjectSettings {
  const { linear: sharedLinear, ...sharedThread } = defaults;
  const { linear, ...thread } = project;
  return ProjectSettings.parse({
    ...sharedThread,
    ...thread,
    linear: {
      team: linear.team,
      filter: linear.filter ?? sharedLinear?.filter,
      onLaunch: { ...sharedLinear?.onLaunch, ...linear.onLaunch },
    },
  });
}

export type Config = z.infer<typeof Config>;
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export type ModelSelection = z.infer<typeof ModelSelection>;

export const DEFAULT_PROMPT = `Work on Linear issue {identifier}: {title}

{url}

{description}`;

// Settings that no longer exist. Rejected rather than ignored: dropping a cap or a mode silently
// would change what gets launched, and how.
const REMOVED = {
  maxLaunchesPerPoll: "use maxRunningThreads to cap Running threads across T3",
  "t3.webUrl": "the Linear comment links the thread under t3.url",
  maxRunningThreads: "only the top-level maxRunningThreads remains",
  interactionMode: "threads always start in T3's default interaction mode",
};

function removedKeys(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, Record<string, unknown> | undefined>;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  const found: string[] = [];
  if ("maxLaunchesPerPoll" in r) found.push(`maxLaunchesPerPoll: ${REMOVED.maxLaunchesPerPoll}`);
  if (isObject(r.t3) && "webUrl" in r.t3) found.push(`t3.webUrl: ${REMOVED["t3.webUrl"]}`);
  const scopes: [string, unknown][] = [["defaults", r.defaults]];
  if (isObject(r.projects)) {
    for (const [ref, entry] of Object.entries(r.projects)) scopes.push([`projects.${ref}`, entry]);
  }
  for (const [where, settings] of scopes) {
    if (!isObject(settings)) continue;
    for (const key of ["maxRunningThreads", "interactionMode"] as const) {
      if (key in settings) found.push(`${where}.${key}: ${REMOVED[key]}`);
    }
  }
  return found;
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const removed = removedKeys(raw);
  if (removed.length > 0) {
    const lines = removed.map((line) => `  ✖ ${line}`).join("\n");
    throw new Error(`Invalid config ${path}: remove settings that no longer exist:\n${lines}`);
  }
  const result = Config.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
