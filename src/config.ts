import { readFile } from "node:fs/promises";
import { z } from "zod";

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

const LinearSettings = z.object({
  // Linear team key, e.g. "ENG".
  team: z.string(),
  // Linear `IssueFilter`, AND-ed with the team filter. Only matching issues get a thread.
  filter: IssueFilter.optional(),
  onLaunch: z
    .object({
      // Workflow state name to move the issue to once its thread is started.
      moveToState: z.string().optional(),
      comment: z.boolean().default(true),
    })
    .prefault({}),
});

// Which Linear issues go to one T3 project, and how their threads are started.
const ProjectSettings = z.object({
  linear: LinearSettings,
  workspace: WorkspaceStrategy.default({
    type: "worktree",
    baseRef: "main",
    startFromOrigin: true,
  }),
  runtimeMode: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("full-access"),
  interactionMode: z.enum(["default", "plan"]).default("default"),
  // Defaults to the T3 project's default model.
  model: ModelSelection.optional(),
  promptTemplate: z.string().optional(),
});

const Config = z.object({
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Caps how many threads are started per poll so a broad filter can't flood T3.
  maxLaunchesPerPoll: z.number().int().min(1).default(5),
  // Between full scans, polls only read recently updated issues. Full scans catch issues that start
  // matching without being updated themselves (e.g. a referenced label or state is renamed).
  fullScanIntervalMinutes: z.number().min(1).default(60),
  stateFile: z.string().default("./state.json"),
  t3: z
    .object({
      url: z.string().url().default("http://127.0.0.1:3773"),
      // Optional public web URL, used to link the thread in the Linear comment.
      webUrl: z.string().url().optional(),
    })
    .prefault({}),
  // Keyed by T3 project id, title, or workspace root path.
  projects: z
    .record(z.string(), ProjectSettings)
    .refine((p) => Object.keys(p).length > 0, "Define at least one project"),
});

export type Config = z.infer<typeof Config>;
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export type ModelSelection = z.infer<typeof ModelSelection>;

export const DEFAULT_PROMPT = `Work on Linear issue {identifier}: {title}

{url}

{description}`;

export async function loadConfig(path: string): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const result = Config.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
