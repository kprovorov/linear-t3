import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DEFAULT_PROMPT, loadConfig, type Config, type ProjectSettings } from "./config.ts";
import { EnvFile } from "./env-file.ts";
import {
  createCommentOnce,
  createLinearClient,
  listIssues,
  moveToState,
  type Issue,
  type LinearClient,
} from "./linear.ts";
import { type Paths, resolveStateFile } from "./paths.ts";
import { StateStore, type LaunchRecord } from "./state.ts";
import { T3Client, T3ThreadNotCreated, type T3Project, type WorkspaceStrategy } from "./t3.ts";
import { stableUuid } from "./uuid.ts";

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
    throw new Error(
      `Several T3 projects are titled "${ref}" (${roots}); use the id or workspace path instead`,
    );
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

// The launch RPC failed but the thread may exist, so it counts toward the per-poll cap.
class LaunchMayHaveStarted extends Error {
  constructor(cause: unknown) {
    super((cause as Error).message, { cause });
  }
}

async function recordOrStop(
  state: StateStore,
  issueId: string,
  record: LaunchRecord,
): Promise<void> {
  try {
    await state.record(issueId, record);
  } catch (error) {
    throw new StateWriteError(
      `${record.identifier}: could not record thread ${record.threadId}: ${(error as Error).message}`,
    );
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
  attempt: number,
  ctx: { config: Config; t3: T3Client; linear: LinearClient; state: StateStore },
): Promise<void> {
  const { config, t3, linear, state } = ctx;
  const modelSelection = settings.model ?? project.defaultModelSelection;
  if (!modelSelection) {
    throw new Error(
      `No model configured for project "${projectRef}" and the T3 project has no default model`,
    );
  }

  const { threadId, resumed } = await t3
    .launchThread({
      // Attempt 0 keeps the plain issue id; later attempts get a fresh thread id (see recordLaunchFailure).
      idempotencyKey: attempt === 0 ? issue.id : `${issue.id}:${attempt}`,
      projectId: project.id,
      title: `${issue.identifier}: ${issue.title}`,
      modelSelection,
      runtimeMode: settings.runtimeMode,
      interactionMode: settings.interactionMode,
      workspaceStrategy: workspaceFor(settings, issue),
      message: renderPrompt(settings.promptTemplate ?? DEFAULT_PROMPT, issue),
    })
    .catch((error: unknown) => {
      throw error instanceof T3ThreadNotCreated ? error : new LaunchMayHaveStarted(error);
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
  log(
    `${issue.identifier}: ${resumed ? "found existing" : "started"} T3 thread ${threadId} in "${project.title}"`,
  );
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
      log(
        `${record.identifier}: commenting on Linear failed, will retry: ${(error as Error).message}`,
      );
    }
  }
  if (pendingActions.moveToState) {
    try {
      await moveToState(linear, issue ?? (await linear.issue(issueId)), pendingActions.moveToState);
      delete pendingActions.moveToState;
    } catch (error) {
      log(
        `${record.identifier}: moving Linear issue failed, will retry: ${(error as Error).message}`,
      );
    }
  }
  await recordOrStop(state, issueId, { ...record, pendingActions });
}

// Issues whose launch failed are skipped until `retryAt`, so they can't starve the rest of the queue.
const launchFailures = new Map<string, { count: number; retryAt: number; attempt: number }>();

/**
 * A launch that failed with the thread confirmed absent moves the issue to a new thread id: T3
 * deletes a thread whose bootstrap failed, and a deleted id can't be reused. Any other failure
 * keeps the id, so the retry returns the thread if it exists. Attempts live in memory: after a
 * restart, replaying from 0 steps past dead ids to the live thread or a fresh one.
 */
function recordLaunchFailure(issueId: string, error: unknown): void {
  const previous = launchFailures.get(issueId);
  const count = (previous?.count ?? 0) + 1;
  const attempt = (previous?.attempt ?? 0) + (error instanceof T3ThreadNotCreated ? 1 : 0);
  const delayMs = Math.min(60_000 * 2 ** (count - 1), 60 * 60_000);
  launchFailures.set(issueId, { count, retryAt: Date.now() + delayMs, attempt });
}

async function poll(
  config: Config,
  linear: LinearClient,
  state: StateStore,
  t3Token: string,
  dryRun: boolean,
) {
  if (!dryRun) {
    for (const [issueId, record] of state.withPendingActions()) {
      if (shutdown.signal.aborted) return;
      await runPendingActions(issueId, record, { config, linear, state });
    }
  }

  const candidates = await collectCandidates(config, linear, state);
  if (candidates.length === 0) return;
  log(`${candidates.length} new issue(s): ${candidates.map((p) => p.issue.identifier).join(", ")}`);
  if (dryRun || shutdown.signal.aborted) return;
  await launchCandidates(candidates, { config, linear, state, t3Token });
}

// Linear priority runs 1 (Urgent) to 4 (Low); 0 is "No priority" and goes after Low.
const priorityRank = (priority: number) => (priority === 0 ? 5 : priority);

/** Most urgent first, then oldest first. */
function byLaunchOrder(a: Candidate, b: Candidate): number {
  return (
    priorityRank(a.issue.priority) - priorityRank(b.issue.priority) ||
    a.issue.createdAt.getTime() - b.issue.createdAt.getTime()
  );
}

/**
 * Matching issues not launched yet and not backing off, round-robin across projects. Each
 * project's queue runs by priority, then oldest first.
 */
async function collectCandidates(
  config: Config,
  linear: LinearClient,
  state: StateStore,
): Promise<Candidate[]> {
  const now = Date.now();
  const pending = new Map<string, Candidate>();
  for (const [projectRef, settings] of Object.entries(config.projects)) {
    if (shutdown.signal.aborted) return [];
    // Every poll reads all matching issues: one can start matching without being updated itself,
    // e.g. when its blocker is done.
    const filter = {
      and: [{ team: { key: { eq: settings.linear.team } } }, settings.linear.filter ?? {}],
    };
    const issues = await listIssues(linear, filter, shutdown.signal);
    for (const issue of issues) {
      if (state.has(issue.id) || (launchFailures.get(issue.id)?.retryAt ?? 0) > now) continue;
      // An issue matched by several projects gets a single thread, in the first matching project.
      const existing = pending.get(issue.id);
      if (existing) {
        log(
          `${issue.identifier}: matches both "${existing.projectRef}" and "${projectRef}", using "${existing.projectRef}"`,
        );
        continue;
      }
      pending.set(issue.id, { issue, projectRef, settings });
    }
  }

  // Round-robin across projects so a busy project can't use up the whole per-poll cap.
  const queues = new Map<string, Candidate[]>();
  for (const candidate of pending.values()) {
    const queue = queues.get(candidate.projectRef);
    if (queue) queue.push(candidate);
    else queues.set(candidate.projectRef, [candidate]);
  }
  for (const queue of queues.values()) queue.sort(byLaunchOrder);
  const ordered: Candidate[] = [];
  for (let i = 0; ordered.length < pending.size; i++) {
    for (const queue of queues.values()) if (queue[i]) ordered.push(queue[i]!);
  }
  return ordered;
}

async function launchCandidates(
  candidates: Candidate[],
  ctx: { config: Config; linear: LinearClient; state: StateStore; t3Token: string },
): Promise<void> {
  const { config, linear, state, t3Token } = ctx;
  const t3 = await T3Client.connect(config.t3.url, t3Token, shutdown.signal);
  try {
    // Shutdown may arrive while reading projects; closing the socket ends that wait.
    const closeOnShutdown = () => t3.close();
    shutdown.signal.addEventListener("abort", closeOnShutdown, { once: true });
    const projects = await t3
      .listProjects()
      .finally(() => shutdown.signal.removeEventListener("abort", closeOnShutdown));
    let launched = 0;
    // Keep going past failures until the cap is reached, so a broken issue can't block later ones.
    for (const candidate of candidates) {
      if (launched >= config.maxLaunchesPerPoll || shutdown.signal.aborted) break;
      try {
        const attempt = launchFailures.get(candidate.issue.id)?.attempt ?? 0;
        const project = findProject(projects, candidate.projectRef);
        await launchIssue(candidate, project, attempt, { config, t3, linear, state });
        launchFailures.delete(candidate.issue.id);
        launched++;
      } catch (error) {
        if (error instanceof StateWriteError) throw error;
        if (error instanceof LaunchMayHaveStarted) launched++;
        recordLaunchFailure(candidate.issue.id, error);
        log(`${candidate.issue.identifier}: failed to start thread: ${(error as Error).message}`);
      }
    }
  } finally {
    t3.close();
  }
}

/** A token from the environment, else from the Credentials file. */
function requireToken(key: string, credentials: EnvFile, integration: string): string {
  const value = process.env[key] || credentials.get(key);
  if (!value) {
    throw new Error(
      `Missing ${key}: run \`linear-t3 connect ${integration}\` or set it in the environment`,
    );
  }
  return value;
}

export interface DaemonOptions {
  paths: Paths;
  // Do one poll, then exit.
  once: boolean;
  // List the issues that would be launched without starting threads.
  dryRun: boolean;
}

/** Runs the Daemon's poll loop until SIGINT/SIGTERM, or for a single poll with `once`. */
export async function runDaemon({ paths, once, dryRun }: DaemonOptions): Promise<void> {
  const stop = (signal: string) => {
    log(`received ${signal}, shutting down`);
    shutdown.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const config = await loadConfig(paths.config);
  const credentials = new EnvFile(paths.credentials);
  const linearKey = requireToken("LINEAR_API_KEY", credentials, "linear");
  const linear = createLinearClient(linearKey, shutdown.signal);
  const t3Token = dryRun ? "" : requireToken("T3_TOKEN", credentials, "t3");
  const state = new StateStore(resolveStateFile(paths, config.stateFile));
  await state.load();

  const watching = Object.entries(config.projects).map(([ref, p]) => `${p.linear.team} -> ${ref}`);
  log(`watching ${watching.join(", ")}`);
  while (!shutdown.signal.aborted) {
    try {
      await poll(config, linear, state, t3Token, dryRun);
    } catch (error) {
      if (error instanceof StateWriteError) throw error;
      log(`poll failed: ${(error as Error).message}`);
      if (once) process.exitCode = 1;
    }
    if (once || shutdown.signal.aborted) break;
    await setTimeout(config.pollIntervalSeconds * 1000, undefined, {
      signal: shutdown.signal,
    }).catch(() => {});
  }
}
