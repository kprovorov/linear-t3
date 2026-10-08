import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PROMPT, loadConfig, requireEnv, type Config, type TeamMapping } from "./config.ts";
import { LinearClient, type LinearIssue } from "./linear.ts";
import { StateStore } from "./state.ts";
import { T3Client, type T3Project, type WorkspaceStrategy } from "./t3.ts";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", default: process.env.CONFIG_PATH ?? "./config.json" },
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function renderPrompt(template: string, issue: LinearIssue): string {
  const vars: Record<string, string> = {
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? "",
    branchName: issue.branchName,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

function findProject(projects: T3Project[], ref: string): T3Project {
  const project = projects.find((p) => p.id === ref || p.title === ref || p.workspaceRoot === ref);
  if (!project) {
    const known = projects.map((p) => `"${p.title}" (${p.workspaceRoot})`).join(", ");
    throw new Error(`No T3 project matches "${ref}". Known projects: ${known}`);
  }
  return project;
}

function workspaceFor(mapping: TeamMapping, config: Config, issue: LinearIssue): WorkspaceStrategy {
  const ws = mapping.workspace ?? config.defaults.workspace ?? { type: "worktree", baseRef: "main", startFromOrigin: true };
  return ws.type === "root" ? { type: "root" } : { ...ws, branch: issue.branchName };
}

async function threadLink(config: Config, threadId: string): Promise<string> {
  if (!config.t3.webUrl) return `\`${threadId}\``;
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const environmentId = (await readFile(join(home, "userdata", "environment-id"), "utf8")).trim();
  return new URL(`/${environmentId}/${threadId}`, config.t3.webUrl).toString();
}

async function launchIssue(
  issue: LinearIssue,
  mapping: TeamMapping,
  project: T3Project,
  ctx: { config: Config; t3: T3Client; linear: LinearClient; state: StateStore },
): Promise<void> {
  const { config, t3, linear, state } = ctx;
  const modelSelection = mapping.model ?? config.defaults.model ?? project.defaultModelSelection;
  if (!modelSelection) {
    throw new Error(`No model configured for team ${mapping.team} and project "${project.title}" has no default model`);
  }

  const { threadId } = await t3.launchThread({
    projectId: project.id,
    title: `${issue.identifier}: ${issue.title}`,
    modelSelection,
    runtimeMode: mapping.runtimeMode ?? config.defaults.runtimeMode ?? "full-access",
    interactionMode: mapping.interactionMode ?? config.defaults.interactionMode ?? "default",
    workspaceStrategy: workspaceFor(mapping, config, issue),
    message: renderPrompt(mapping.promptTemplate ?? config.defaults.promptTemplate ?? DEFAULT_PROMPT, issue),
  });
  // Record before touching Linear: a failed Linear update must never cause a duplicate thread.
  await state.record(issue.id, { identifier: issue.identifier, threadId, launchedAt: new Date().toISOString() });
  log(`${issue.identifier}: started T3 thread ${threadId} in "${project.title}"`);

  const { onLaunch } = config.linear;
  try {
    if (onLaunch.comment) {
      const link = await threadLink(config, threadId);
      await linear.comment(issue.id, `Started a T3 Code thread for this issue: ${link}`);
    }
    if (onLaunch.moveToState) await linear.moveToState(issue, onLaunch.moveToState);
  } catch (error) {
    log(`${issue.identifier}: thread started but updating Linear failed: ${(error as Error).message}`);
  }
}

async function poll(config: Config, linear: LinearClient, state: StateStore, t3Token: string, dryRun: boolean) {
  const pending: { issue: LinearIssue; mapping: TeamMapping }[] = [];
  for (const mapping of config.teams) {
    const filter = {
      and: [{ team: { key: { eq: mapping.team } } }, config.linear.filter ?? {}, mapping.filter ?? {}],
    };
    const issues = await linear.listIssues(filter);
    for (const issue of issues) if (!state.has(issue.id)) pending.push({ issue, mapping });
  }
  if (pending.length === 0) return;

  const batch = pending.slice(0, config.maxLaunchesPerPoll);
  log(`${pending.length} new issue(s), launching ${batch.length}: ${batch.map((p) => p.issue.identifier).join(", ")}`);
  if (dryRun) return;

  const t3 = await T3Client.connect(config.t3.url, t3Token);
  try {
    const projects = await t3.listProjects();
    for (const { issue, mapping } of batch) {
      try {
        await launchIssue(issue, mapping, findProject(projects, mapping.project), { config, t3, linear, state });
      } catch (error) {
        log(`${issue.identifier}: failed to start thread: ${(error as Error).message}`);
      }
    }
  } finally {
    t3.close();
  }
}

async function main() {
  const config = await loadConfig(args.config);
  const linear = new LinearClient(requireEnv("LINEAR_API_KEY"));
  const t3Token = args["dry-run"] ? "" : requireEnv("T3_TOKEN");
  const state = new StateStore(config.stateFile);
  await state.load();

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (signal: string) => {
    log(`received ${signal}, shutting down`);
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`watching ${config.teams.map((t) => `${t.team} -> ${t.project}`).join(", ")}`);
  while (!stopping) {
    try {
      await poll(config, linear, state, t3Token, args["dry-run"]);
    } catch (error) {
      log(`poll failed: ${(error as Error).message}`);
      if (args.once) process.exitCode = 1;
    }
    if (args.once) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalSeconds * 1000);
      wake = () => (clearTimeout(timer), resolve());
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
