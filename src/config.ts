import { readFile } from "node:fs/promises";
import { z } from "zod";

// A raw Linear `IssueFilter` object, passed through to the GraphQL API as-is.
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

const TeamMapping = z.object({
  // Linear team key, e.g. "ENG".
  team: z.string(),
  // T3 project, matched against project id, title, or workspace root path.
  project: z.string(),
  // Extra filter for this team, AND-ed with the global filter.
  filter: IssueFilter.optional(),
  workspace: WorkspaceStrategy.optional(),
  // Defaults to the T3 project's default model.
  model: ModelSelection.optional(),
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).optional(),
  interactionMode: z.enum(["default", "plan"]).optional(),
  promptTemplate: z.string().optional(),
});

const Config = z.object({
  pollIntervalSeconds: z.number().int().min(10).default(60),
  // Caps how many threads are started per poll so a broad filter can't flood T3.
  maxLaunchesPerPoll: z.number().int().min(1).default(5),
  stateFile: z.string().default("./state.json"),
  t3: z
    .object({
      url: z.string().url().default("http://127.0.0.1:3773"),
      // Optional public web URL, used to link the thread in the Linear comment.
      webUrl: z.string().url().optional(),
    })
    .prefault({}),
  linear: z
    .object({
      // Applied to every team, AND-ed with the team's own filter.
      filter: IssueFilter.optional(),
      onLaunch: z
        .object({
          // Workflow state name to move the issue to once its thread is started.
          moveToState: z.string().optional(),
          comment: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  defaults: TeamMapping.pick({
    workspace: true,
    model: true,
    runtimeMode: true,
    interactionMode: true,
    promptTemplate: true,
  }).prefault({}),
  teams: z.array(TeamMapping).min(1),
});

export type Config = z.infer<typeof Config>;
export type TeamMapping = z.infer<typeof TeamMapping>;
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
