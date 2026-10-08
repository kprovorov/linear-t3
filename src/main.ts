import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { DEFAULT_PROMPT, loadConfig, requireEnv, type Config, type ProjectSettings } from "./config.ts";
import { createCommentOnce, LinearClient, listIssues, moveToState, type Issue } from "./linear.ts";
import { StateStore, type LaunchRecord } from "./state.ts";
import { T3Client, type T3Project, type WorkspaceStrategy } from "./t3.ts";
import { stableUuid } from "./uuid.ts";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", default: process.env.CONFIG_PATH ?? "./config.json" },
    once: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// Aborted on SIGTERM/SIGINT: the current launch finishes, nothing new starts.
const shutdown = new AbortController();

function renderPrompt(template: string, issue: Issue): string {
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
  const exact = projects.find((p) => p.id === ref || p.workspaceRoot === ref);
  if (exact) return exact;
  // Titles aren't unique; launching into the wrong workspace is worse than failing.
  const byTitle = projects.filter((p) => p.title === ref);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    const roots = byTitle.map((p) => p.workspaceRoot).join(", ");
    throw new Error(`Several T3 projects are titled "${ref}" (${roots}); use the id or workspace path instead`);
  }
  const known = projects.map((p) => `"${p.title}" (${p.workspaceRoot})`).join(", ");
  throw new Error(`No T3 project matches "${ref}". Known projects: ${known}`);
}

function workspaceFor(settings: ProjectSettings, issue: Issue): WorkspaceStrategy {
  const ws = settings.workspace;
  return ws.type === "root" ? { type: "root" } : { ...ws, branch: issue.branchName };
}

async function threadLink(config: Config, threadId: string): Promise<string> {
  if (!config.t3.webUrl) return `\`${threadId}\``;
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const environmentId = (await readFile(join(home, "userdata", "environment-id"), "utf8")).trim();
  return new URL(`/${environmentId}/${threadId}`, config.t3.webUrl).toString();
}

// Launching without being able to record launches risks duplicate threads, so this stops the daemon.
class StateWriteError extends Error {}

async function recordOrStop(state: StateStore, issueId: string, record: LaunchRecord): Promise<void> {
  try {
    await state.record(issueId, record);
  } catch (error) {
    throw new StateWriteError(`${record.identifier}: could not record thread ${record.threadId}: ${(error as Error).message}`);
  }
}

interface Candidate {
  issue: Issue;
  projectRef: string;
  settings: ProjectSettings;
}

async function launchIssue(
  { issue, projectRef, settings }: Candidate,
  project: T3Project,
  ctx: { config: Config; t3: T3Client; linear: LinearClient; state: StateStore },
): Promise<void> {
  const { config, t3, linear, state } = ctx;
  const modelSelection = settings.model ?? project.defaultModelSelection;
  if (!modelSelection) {
    throw new Error(`No model configured for project "${projectRef}" and the T3 project has no default model`);
  }

  const { threadId, resumed } = await t3.launchThread({
    idempotencyKey: issue.id,
    projectId: project.id,
    title: `${issue.identifier}: ${issue.title}`,
    modelSelection,
    runtimeMode: settings.runtimeMode,
    interactionMode: settings.interactionMode,
    workspaceStrategy: workspaceFor(settings, issue),
    message: renderPrompt(settings.promptTemplate ?? DEFAULT_PROMPT, issue),
  });
  // Record before touching Linear: a failed Linear update must never cause a duplicate thread.
  const { onLaunch } = settings.linear;
  const record: LaunchRecord = {
    identifier: issue.identifier,
    threadId,
    launchedAt: new Date().toISOString(),
    pendingActions: {
      ...(onLaunch.comment && { comment: true }),
      ...(onLaunch.moveToState && { moveToState: onLaunch.moveToState }),
    },
  };
  await recordOrStop(state, issue.id, record);
  log(`${issue.identifier}: ${resumed ? "found existing" : "started"} T3 thread ${threadId} in "${project.title}"`);
  await runPendingActions(issue.id, record, { config, linear, state }, issue);
}

/** Applies a launched issue's outstanding Linear updates, keeping any that fail for the next poll. */
async function runPendingActions(
  issueId: string,
  record: LaunchRecord,
  ctx: { config: Config; linear: LinearClient; state: StateStore },
  issue?: Issue,
): Promise<void> {
  const { config, linear, state } = ctx;
  const pendingActions = { ...record.pendingActions };
  if (pendingActions.comment) {
    try {
      const link = await threadLink(config, record.threadId);
      const body = `Started a T3 Code thread for this issue: ${link}`;
      await createCommentOnce(linear, stableUuid(`${issueId}:comment`, 4), issueId, body);
      delete pendingActions.comment;
    } catch (error) {
      log(`${record.identifier}: commenting on Linear failed, will retry: ${(error as Error).message}`);
    }
  }
  if (pendingActions.moveToState) {
    try {
      await moveToState(linear, issue ?? (await linear.issue(issueId)), pendingActions.moveToState);
      delete pendingActions.moveToState;
    } catch (error) {
      log(`${record.identifier}: moving Linear issue failed, will retry: ${(error as Error).message}`);
    }
  }
  await recordOrStop(state, issueId, { ...record, pendingActions });
}

// Issues whose launch failed are skipped until `retryAt`, so they can't starve the rest of the queue.
const launchFailures = new Map<string, { count: number; retryAt: number }>();

function recordLaunchFailure(issueId: string): void {
  const count = (launchFailures.get(issueId)?.count ?? 0) + 1;
  const delayMs = Math.min(60_000 * 2 ** (count - 1), 60 * 60_000);
  launchFailures.set(issueId, { count, retryAt: Date.now() + delayMs });
}

async function poll(config: Config, linear: LinearClient, state: StateStore, t3Token: string, dryRun: boolean) {
  if (!dryRun) {
    for (const [issueId, record] of state.withPendingActions()) {
      await runPendingActions(issueId, record, { config, linear, state });
    }
  }

  const now = Date.now();
  const pending = new Map<string, Candidate>();
  for (const [projectRef, settings] of Object.entries(config.projects)) {
    const filter = { and: [{ team: { key: { eq: settings.linear.team } } }, settings.linear.filter ?? {}] };
    const issues = await listIssues(linear, filter);
    for (const issue of issues) {
      if (state.has(issue.id) || (launchFailures.get(issue.id)?.retryAt ?? 0) > now) continue;
      // An issue matched by several projects gets a single thread, in the first matching project.
      const existing = pending.get(issue.id);
      if (existing) {
        log(`${issue.identifier}: matches both "${existing.projectRef}" and "${projectRef}", using "${existing.projectRef}"`);
        continue;
      }
      pending.set(issue.id, { issue, projectRef, settings });
    }
  }
  if (pending.size === 0) return;

  // Round-robin across projects so a busy project can't use up the whole per-poll cap.
  const queues = new Map<string, Candidate[]>();
  for (const candidate of pending.values()) {
    const queue = queues.get(candidate.projectRef);
    if (queue) queue.push(candidate);
    else queues.set(candidate.projectRef, [candidate]);
  }
  const ordered: Candidate[] = [];
  for (let i = 0; ordered.length < pending.size; i++) {
    for (const queue of queues.values()) if (queue[i]) ordered.push(queue[i]!);
  }

  log(`${ordered.length} new issue(s): ${ordered.map((p) => p.issue.identifier).join(", ")}`);
  if (dryRun) return;

  const t3 = await T3Client.connect(config.t3.url, t3Token);
  try {
    const projects = await t3.listProjects();
    let launched = 0;
    // Keep going past failures until the cap is reached, so a broken issue can't block later ones.
    for (const candidate of ordered) {
      if (launched >= config.maxLaunchesPerPoll || shutdown.signal.aborted) break;
      try {
        await launchIssue(candidate, findProject(projects, candidate.projectRef), { config, t3, linear, state });
        launchFailures.delete(candidate.issue.id);
        launched++;
      } catch (error) {
        if (error instanceof StateWriteError) throw error;
        recordLaunchFailure(candidate.issue.id);
        log(`${candidate.issue.identifier}: failed to start thread: ${(error as Error).message}`);
      }
    }
  } finally {
    t3.close();
  }
}

async function main() {
  const stop = (signal: string) => {
    log(`received ${signal}, shutting down`);
    shutdown.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const config = await loadConfig(args.config);
  const linear = new LinearClient({ apiKey: requireEnv("LINEAR_API_KEY") });
  const t3Token = args["dry-run"] ? "" : requireEnv("T3_TOKEN");
  const state = new StateStore(config.stateFile);
  await state.load();

  const watching = Object.entries(config.projects).map(([ref, p]) => `${p.linear.team} -> ${ref}`);
  log(`watching ${watching.join(", ")}`);
  while (!shutdown.signal.aborted) {
    try {
      await poll(config, linear, state, t3Token, args["dry-run"]);
    } catch (error) {
      if (error instanceof StateWriteError) throw error;
      log(`poll failed: ${(error as Error).message}`);
      if (args.once) process.exitCode = 1;
    }
    if (args.once || shutdown.signal.aborted) break;
    await setTimeout(config.pollIntervalSeconds * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
