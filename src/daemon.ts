import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { loadConfig, type Config, type Values } from "./config.ts";
import { EnvFile } from "./env-file.ts";
import {
  createCommentOnce,
  createLinearClient,
  listIssues,
  moveToState,
  teamIssueFilter,
  type Issue,
  type LinearClient,
  type LinearDocument,
} from "./linear.ts";
import type { Paths } from "./paths.ts";
import { findProject } from "./project.ts";
import { StateStore, type LaunchRecord } from "./state.ts";
import {
  T3Client,
  T3ThreadNotCreated,
  isRunningThread,
  threadIdFor,
  type ModelSelection,
  type T3Project,
  type T3Model,
  type T3Provider,
  type WorkspaceStrategy,
} from "./t3.ts";
import { stableUuid } from "./uuid.ts";

type IssueFilter = LinearDocument.IssueFilter;

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

/** T3's projects and threads, from one snapshot. Shutdown ends the wait by closing the socket. */
async function readShell(t3: T3Client) {
  const closeOnShutdown = () => t3.close();
  shutdown.signal.addEventListener("abort", closeOnShutdown, { once: true });
  return t3
    .readShell()
    .finally(() => shutdown.signal.removeEventListener("abort", closeOnShutdown));
}

function workspaceFor(config: Config, issue: Issue): WorkspaceStrategy {
  if (config.workspace === "local") return { type: "root" };
  const { baseRef, startFromOrigin } = config;
  // prepare fills it in before the first poll.
  if (baseRef === undefined) throw new Error("baseRef is unresolved");
  return { type: "worktree", baseRef, startFromOrigin, branch: issue.branchName };
}

/**
 * The enabled Provider `provider` names: its instance id, else its display name ignoring case.
 * Throws, listing the enabled Providers, when none or several match.
 */
function resolveProvider(providers: T3Provider[], provider: string): T3Provider {
  const enabled = providers.filter((p) => p.enabled);
  const byId = enabled.find((p) => p.instanceId === provider);
  if (byId) return byId;
  const lower = provider.toLowerCase();
  const named = (p: T3Provider) => p.displayName?.toLowerCase() === lower;
  const byName = enabled.filter(named);
  if (byName.length === 1) return byName[0]!;
  const describe = (ps: T3Provider[]) =>
    ps.map((p) => `${p.displayName ?? p.instanceId} (${p.instanceId})`).join(", ") || "none";
  if (byName.length > 1) {
    throw new Error(
      `provider "${provider}" names several enabled T3 Providers: ${describe(byName)}. Pick one by instance id`,
    );
  }
  const disabled = providers.some((p) => !p.enabled && (p.instanceId === provider || named(p)));
  throw new Error(
    `provider "${provider}" matches no enabled T3 Provider${disabled ? " (it is disabled in T3)" : ""}; the enabled ones are ${describe(enabled)}`,
  );
}

/**
 * The Provider and exact slug for the model `model` names, among enabled Providers (only
 * `provider`, when set): the exact slug, else the name ignoring case, else an alias. When several
 * Providers offer it, `preferred` (the T3 project's default Provider) wins if it's one of them.
 */
function resolveModel(
  providers: T3Provider[],
  model: string,
  provider: T3Provider | undefined,
  preferred: string | undefined,
): { instanceId: string; model: string } {
  const searched = provider ? [provider] : providers.filter((p) => p.enabled);
  const lower = model.toLowerCase();
  const tiers: ((m: T3Model) => boolean)[] = [
    (m) => m.slug === model,
    (m) => m.name?.toLowerCase() === lower,
    (m) => (m.aliases ?? []).includes(model),
  ];
  for (const matches of tiers) {
    const candidates = searched.flatMap((p) => {
      // T3 may leave out the models of a Provider that isn't installed.
      const found = (p.models ?? []).find(matches);
      return found ? [{ instanceId: p.instanceId, model: found.slug }] : [];
    });
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length > 1) {
      const tiebreak = candidates.find((c) => c.instanceId === preferred);
      if (tiebreak) return tiebreak;
      const list = candidates.map((c) => `${c.model} on ${c.instanceId}`).join(", ");
      throw new Error(
        `Model "${model}" is offered by several T3 Providers: ${list}. Pick one with --provider`,
      );
    }
  }
  const where = provider
    ? `T3 Provider "${provider.instanceId}"`
    : `the enabled T3 Providers (${searched.map((p) => p.instanceId).join(", ") || "none"})`;
  throw new Error(`No model matches "${model}" in ${where}`);
}

/**
 * Before the first poll: the T3 project this run watches, `config` with `model` and `provider`
 * resolved through T3's model catalog and `baseRef` set, as configured or else the project's
 * default branch, and the issue filter, with its status and label names checked against the team.
 * Worktrees need `baseRef`; `workspace: local` creates none, so it isn't looked up.
 */
async function prepare(
  loaded: Config,
  t3Token: string,
  linear: LinearClient,
): Promise<{ config: Config; project: T3Project; filter: IssueFilter }> {
  const filter = await teamIssueFilter(linear, loaded, shutdown.signal);
  const t3 = await T3Client.connect(loaded.t3Url, t3Token, shutdown.signal);
  // Shutdown ends the wait for T3 by closing the socket.
  const closeOnShutdown = () => t3.close();
  shutdown.signal.addEventListener("abort", closeOnShutdown, { once: true });
  try {
    const needsCatalog = loaded.model !== undefined || loaded.provider !== undefined;
    const [shell, providers] = await Promise.all([
      t3.readShell(),
      needsCatalog ? t3.providers() : undefined,
    ]);
    const project = findProject(shell.projects, loaded);
    if (providers !== undefined) {
      const provider =
        loaded.provider === undefined ? undefined : resolveProvider(providers, loaded.provider);
      if (loaded.model === undefined) {
        if (provider) {
          const fallback = project.defaultModelSelection;
          if (fallback && provider.instanceId !== fallback.instanceId) {
            throw new Error(
              `provider is "${loaded.provider}" but no model is set, and T3 project "${project.title}" defaults to "${fallback.model}" on "${fallback.instanceId}"`,
            );
          }
          if (provider.instanceId !== loaded.provider) {
            log(`provider "${loaded.provider}" is ${provider.instanceId}`);
          }
          loaded = { ...loaded, provider: provider.instanceId };
        }
      } else {
        const preferred = project.defaultModelSelection?.instanceId;
        const { instanceId, model } = resolveModel(providers, loaded.model, provider, preferred);
        if (model !== loaded.model || instanceId !== loaded.provider) {
          log(`model "${loaded.model}" is ${model} on ${instanceId}`);
        }
        loaded = { ...loaded, model, provider: instanceId };
      }
    }
    if (loaded.workspace === "local" || loaded.baseRef !== undefined) {
      return { config: loaded, project, filter };
    }
    const baseRef = await t3.defaultBranch(project.workspaceRoot);
    if (baseRef === undefined) {
      throw new Error(
        `T3 reports no default branch for "${project.title}" (${project.workspaceRoot}); set the branch new worktrees start from with --base-ref or baseRef`,
      );
    }
    log(`worktrees branch from ${baseRef}, the default branch of "${project.title}"`);
    return { config: { ...loaded, baseRef }, project, filter };
  } finally {
    shutdown.signal.removeEventListener("abort", closeOnShutdown);
    t3.close();
  }
}

async function threadLink(config: Config, threadId: string): Promise<string> {
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  let environmentId: string;
  try {
    environmentId = (await readFile(join(home, "userdata", "environment-id"), "utf8")).trim();
  } catch (error) {
    // T3 isn't on this machine, so there's no link to build; retrying won't change that.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return `\`${threadId}\``;
    throw error;
  }
  return new URL(`/${environmentId}/${threadId}`, config.t3Url).toString();
}

// Launching without being able to record launches risks duplicate threads, so this stops the daemon.
class StateWriteError extends Error {}

// The launch RPC failed but the thread may exist, so it counts as Running until the next snapshot.
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

// Attempt 0 keeps the plain issue id; later attempts get a fresh thread id (see recordLaunchFailure).
function launchKey(issueId: string, attempt: number): string {
  return attempt === 0 ? issueId : `${issueId}:${attempt}`;
}

/**
 * `model` on `provider`, as `prepare` resolved them; with no `model`, the T3 project's default
 * model, options included.
 */
function modelFor(config: Config, project: T3Project): ModelSelection {
  const fallback = project.defaultModelSelection;
  if (config.model === undefined) {
    if (!fallback) {
      throw new Error(`No model configured and T3 project "${project.title}" has no default model`);
    }
    if (config.provider !== undefined && config.provider !== fallback.instanceId) {
      throw new Error(
        `provider is "${config.provider}" but no model is set, and T3 project "${project.title}" defaults to "${fallback.model}" on "${fallback.instanceId}"`,
      );
    }
    return fallback;
  }
  // prepare resolves the Provider whenever a model is set.
  if (config.provider === undefined) throw new Error("provider is unresolved");
  return { instanceId: config.provider, model: config.model };
}

async function launchIssue(
  issue: Issue,
  project: T3Project,
  attempt: number,
  ctx: { config: Config; t3: T3Client; linear: LinearClient; state: StateStore },
): Promise<void> {
  const { config, t3, linear, state } = ctx;
  const modelSelection = modelFor(config, project);

  const { threadId, resumed } = await t3
    .launchThread({
      idempotencyKey: launchKey(issue.id, attempt),
      projectId: project.id,
      title: `${issue.identifier}: ${issue.title}`,
      modelSelection,
      runtimeMode: config.runtimeMode,
      workspaceStrategy: workspaceFor(config, issue),
      message: renderPrompt(config.prompt, issue),
    })
    .catch((error: unknown) => {
      throw error instanceof T3ThreadNotCreated ? error : new LaunchMayHaveStarted(error);
    });
  // Record before touching Linear: a failed Linear update must never cause a duplicate thread.
  const record: LaunchRecord = {
    identifier: issue.identifier,
    threadId,
    launchedAt: new Date().toISOString(),
    pendingActions: {
      ...(config.comment && { comment: true }),
      ...(config.setStatus && { moveToState: config.setStatus }),
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

function failLaunch(issue: Issue, error: unknown): void {
  recordLaunchFailure(issue.id, error);
  log(`${issue.identifier}: failed to start thread: ${(error as Error).message}`);
}

async function poll(
  config: Config,
  filter: IssueFilter,
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

  const candidates = await collectCandidates(filter, linear, state);
  // A dry run still reads T3, to show the Running counts.
  if (candidates.length === 0 && !dryRun) return;
  if (candidates.length > 0)
    log(
      `${candidates.length} new issue(s): ${candidates.map((issue) => issue.identifier).join(", ")}`,
    );
  if (shutdown.signal.aborted) return;
  await launchCandidates(candidates, { config, linear, state, t3Token, dryRun });
}

// Linear priority runs 1 (Urgent) to 4 (Low); 0 is "No priority" and goes after Low.
const priorityRank = (priority: number) => (priority === 0 ? 5 : priority);

/** Most urgent first, then oldest first. */
function byLaunchOrder(a: Issue, b: Issue): number {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/** Matching issues not launched yet and not backing off, by priority, then oldest first. */
async function collectCandidates(
  filter: IssueFilter,
  linear: LinearClient,
  state: StateStore,
): Promise<Issue[]> {
  const now = Date.now();
  // Every poll reads all matching issues: one can start matching without being updated itself,
  // e.g. when its blocker is done.
  const issues = await listIssues(linear, filter, shutdown.signal);
  return issues
    .filter((issue) => !state.has(issue.id) && (launchFailures.get(issue.id)?.retryAt ?? 0) <= now)
    .sort(byLaunchOrder);
}

/**
 * Launches what fits under the caps, in order. A dry run walks the same order and caps, logging
 * what would start and what would wait, and launches nothing.
 */
async function launchCandidates(
  candidates: Issue[],
  ctx: {
    config: Config;
    linear: LinearClient;
    state: StateStore;
    t3Token: string;
    dryRun: boolean;
  },
): Promise<void> {
  const { config, linear, state, t3Token, dryRun } = ctx;
  const t3 = await T3Client.connect(config.t3Url, t3Token, shutdown.signal);
  try {
    const { projects, threads } = await readShell(t3);
    // Running threads in T3, plus new threads this poll, which count as Running until the next
    // snapshot.
    let runningInT3 = threads.filter(isRunningThread).length;
    const cap = config.maxRunningThreads;
    const threadIds = new Set(threads.map((thread) => thread.id));
    if (dryRun) log(`T3 has ${runningInT3}${cap === undefined ? "" : `/${cap}`} running`);
    // Matched again each poll, so a project re-added in T3 is picked up. One gone since the run
    // started fails the poll, even when nothing has room.
    const project = findProject(projects, config);
    // Keep going past failures, so one can't block later candidates.
    for (const issue of candidates) {
      if (shutdown.signal.aborted) break;
      const attempt = launchFailures.get(issue.id)?.attempt ?? 0;
      // T3 already has this issue's thread from a launch whose outcome was lost, and counts it.
      // Launching again only records it, so it needs no room under any limit.
      const inT3 = threadIds.has(threadIdFor(launchKey(issue.id, attempt)));
      if (!inT3) {
        // Held back, not failed: no backoff, so it's a candidate again next poll.
        if (cap !== undefined && runningInT3 >= cap) {
          if (dryRun) log(`${issue.identifier} would wait (global ${runningInT3}/${cap})`);
          else log(`${issue.identifier} waiting: T3 has ${runningInT3}/${cap} running`);
          continue;
        }
      }
      let started = dryRun;
      if (dryRun) {
        try {
          modelFor(config, project);
          log(`${issue.identifier} ${inT3 ? "would record its existing thread" : "would start"}`);
        } catch (error) {
          log(`${issue.identifier} would fail: ${(error as Error).message}`);
          continue;
        }
      } else {
        try {
          await launchIssue(issue, project, attempt, { config, t3, linear, state });
          launchFailures.delete(issue.id);
          started = true;
        } catch (error) {
          if (error instanceof StateWriteError) throw error;
          started = error instanceof LaunchMayHaveStarted;
          failLaunch(issue, error);
        }
      }
      if (started && !inT3) runningInT3++;
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
  // `--config`: the Local Config to use instead of the one found from the working directory;
  // `false` for none.
  localConfig?: string | false;
  // The keys the CLI flags set; they win over both Configs.
  flags?: Values;
  // Do one poll, then exit.
  once: boolean;
  // Show which issues would start and which would wait on a cap, without starting threads.
  dryRun: boolean;
}

/** Runs the Daemon's poll loop until SIGINT/SIGTERM, or for a single poll with `once`. */
export async function runDaemon({
  paths,
  localConfig,
  flags,
  once,
  dryRun,
}: DaemonOptions): Promise<void> {
  const stop = (signal: string) => {
    log(`received ${signal}, shutting down`);
    shutdown.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const loaded = await loadConfig({
    global: paths.globalConfig,
    local: localConfig,
    cwd: process.cwd(),
    flags,
    defaultState: paths.defaultState,
  });
  const credentials = new EnvFile(paths.credentials);
  const linearKey = requireToken("LINEAR_API_KEY", credentials, "linear");
  const linear = createLinearClient(linearKey, shutdown.signal);
  const t3Token = requireToken("T3_TOKEN", credentials, "t3");
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(loaded, t3Token, linear);
  } catch (error) {
    // Ctrl+C while connecting isn't a failure.
    if (shutdown.signal.aborted) return;
    throw error;
  }
  const { config, project, filter } = prepared;
  const state = new StateStore(config.stateFile);
  // A dry run launches nothing, so it never writes State.
  await state.load({ checkWritable: !dryRun });

  log(`watching ${config.team} -> ${project.title}`);
  while (!shutdown.signal.aborted) {
    try {
      await poll(config, filter, linear, state, t3Token, dryRun);
    } catch (error) {
      if (error instanceof StateWriteError) throw error;
      log(`poll failed: ${(error as Error).message}`);
      if (once) process.exitCode = 1;
    }
    if (once || shutdown.signal.aborted) break;
    await setTimeout(config.pollInterval * 1000, undefined, {
      signal: shutdown.signal,
    }).catch(() => {});
  }
}
