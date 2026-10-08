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

// How threads are started in one T3 project.
const ProjectSettings = z.object({
  workspace: WorkspaceStrategy.default({ type: "worktree", baseRef: "main", startFromOrigin: true }),
  runtimeMode: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).default("full-access"),
  interactionMode: z.enum(["default", "plan"]).default("default"),
  // Defaults to the T3 project's default model.
  model: ModelSelection.optional(),
  promptTemplate: z.string().optional(),
});

const TeamMapping = z.object({
  // Linear team key, e.g. "ENG".
  team: z.string(),
  // Key into `projects`.
  project: z.string(),
  // Extra filter for this team, AND-ed with the global filter.
  filter: IssueFilter.optional(),
});

const Config = z
  .object({
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
    // Keyed by T3 project id, title, or workspace root path.
    projects: z.record(z.string(), ProjectSettings),
    teams: z.array(TeamMapping).min(1),
  })
  .superRefine((config, ctx) => {
    config.teams.forEach((mapping, i) => {
      if (!(mapping.project in config.projects)) {
        ctx.addIssue({
          code: "custom",
          path: ["teams", i, "project"],
          message: `"${mapping.project}" is not defined in "projects"`,
        });
      }
    });
  });

export type Config = z.infer<typeof Config>;
export type ProjectSettings = z.infer<typeof ProjectSettings>;
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
