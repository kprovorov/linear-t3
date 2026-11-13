import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Values } from "./config.ts";
import { flagArgs } from "./flags.ts";
import type { Paths } from "./paths.ts";
import { launchd } from "./launchd.ts";
import { systemd } from "./systemd.ts";

/** What the background service runs: the pinned `node`, the CLI and its arguments. */
export interface Unit {
  program: string[];
  /** Only what the Daemon needs to find its files. Never tokens. */
  env: Record<string, string>;
}

export interface ServiceStatus {
  running: boolean;
  pid?: number;
  /** How long the Daemon has been running, as `ps` prints it, e.g. `01:02:03`. */
  uptime?: string;
  /** Something about the service the user should know, e.g. when it won't run. */
  hint?: string;
}

/** The OS service manager for one unit that runs a Daemon in the background. See ADR 0001. */
export interface UnitManager {
  /** What the unit is called in messages, e.g. `launchd agent`. */
  kind: string;
  /** The unit file, e.g. the launchd agent. */
  unitPath: string;
  /** Where to read the Daemon's output, for messages: a log file, or the command that shows it. */
  logLocation: string;
  installed(): boolean;
  /** What the installed unit runs, read back from it. */
  pinned(): Unit | undefined;
  /**
   * Writes or refreshes the unit, then enables and starts it. With `start` false, it's left stopped
   * and won't start at login, as after `stop`.
   */
  install(unit: Unit, start?: boolean): Promise<void>;
  /** Stops the Daemon and keeps it from starting at login. */
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Prints the Daemon's recent output and, with `follow`, keeps printing it. Resolves with an exit code. */
  logs(follow: boolean): Promise<number>;
  /** Stops the Daemon and removes the unit. */
  uninstall(): Promise<void>;
}

/** The OS service manager that keeps one T3 project's Daemon running in the background. See ADR 0004. */
export interface ServiceManager extends UnitManager {
  /** The T3 project's id, which names the unit. */
  project: string;
}

/** A background Daemon whose unit is installed. */
export interface InstalledDaemon {
  /** The T3 project's id, read from the unit's name. */
  project: string;
  /** What the unit runs. */
  unit: Unit;
}

/** The OS service manager, for every background Daemon on this machine. */
export interface ServicePlatform {
  /** The service manager for the Daemon of the T3 project with id `project`. */
  daemon(project: string): ServiceManager;
  /** Every installed Daemon, found by its unit's name, in project id order. */
  list(): InstalledDaemon[];
  /** The single background service from before each T3 project had its own Daemon. */
  legacy(): UnitManager;
}

/** A failure to report to the user as-is. */
export class ServiceError extends Error {}

// What can go in a unit's name and file name as is. T3's ids are UUIDs.
const UNIT_ID = /^[A-Za-z0-9_-]+$/;

/** Throws unless `project` can name a unit. */
export function checkUnitId(project: string): string {
  if (!UNIT_ID.test(project)) {
    throw new ServiceError(
      `T3 project id "${project}" can't name a background service; use \`linear-t3 run\` for it`,
    );
  }
  return project;
}

/** Whether a unit file's name part could be a project id; other files are skipped. */
export const isUnitId = (text: string) => UNIT_ID.test(text);

/**
 * The Daemons whose unit files in `dir` match `pattern`, which captures the project id, read with
 * `read`. A file that can't be read, such as a dangling link, is skipped.
 */
export function listUnits(
  dir: string,
  pattern: RegExp,
  read: (path: string) => Unit,
): InstalledDaemon[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((file) => {
      const project = pattern.exec(file)?.[1];
      if (!project || !isUnitId(project)) return [];
      try {
        return [{ project, unit: read(join(dir, file)) }];
      } catch {
        return [];
      }
    });
}

/** The service manager for this platform. */
export function servicePlatform(paths: Paths): ServicePlatform {
  if (process.platform === "darwin") return launchd(paths);
  if (process.platform === "linux") return systemd(paths);
  throw new ServiceError("The background service is macOS and Linux only");
}

// The Daemon reads these to find its files, so the service gets them when `start` had them. The
// Global Config is always pinned, as an absolute path.
const PASSED_ENV = ["T3CODE_HOME", "LINEAR_T3_CONFIG", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];

/**
 * Moves the single background service from before per-project Daemons to its project's Daemon:
 * same program and environment, running only if it was. One pinned to no project, from 0.2, is
 * removed. Resolves with what to tell the user, or `undefined` when there was nothing to move.
 */
export async function migrateLegacy(platform: ServicePlatform): Promise<string | undefined> {
  const old = platform.legacy();
  const unit = old.pinned();
  if (!unit) return undefined;
  const { project } = pinnedTo(unit);
  if (project === undefined) {
    await old.uninstall();
    return `Removed the old background service (${old.unitPath}), which watched no T3 project; run \`linear-t3 start\` in the repository it should watch`;
  }
  const manager = platform.daemon(project);
  if (manager.installed()) {
    await old.uninstall();
    return `Removed the old background service (${old.unitPath}); T3 project ${project} already has its Daemon (${manager.unitPath})`;
  }
  const { running } = await old.status();
  // Remove the old one first, so the two never run at once.
  await old.uninstall();
  await manager.install(unit, running);
  return `Moved the old background service (${old.unitPath}) to the Daemon for T3 project ${project} (${manager.unitPath})${running ? "" : ", left stopped"}`;
}

/** What `start` pins the Daemon to, so it runs the same from any working directory. */
export interface Pinned {
  /** The T3 project's id. */
  project: string;
  /** The Local Config, absolute, when there is one. */
  localConfig?: string;
  /** The Global Config, absolute. */
  globalConfig: string;
  /** The keys the flags set, but `project`, which is pinned by id. */
  flags: Values;
}

const PROJECT_ARG = "--project=";
const CONFIG_ARG = "--config=";
// Without it, `run` would look for a Local Config wherever the service manager starts it.
const NO_CONFIG_ARG = "--no-config";

/** The unit that runs `cliPath run` with the current `node`, pinned to `pinned`. */
export function daemonUnit(cliPath: string, pinned: Pinned, env = process.env): Unit {
  const { project: _, ...flags } = pinned.flags;
  return {
    program: [
      process.execPath,
      cliPath,
      "run",
      `${PROJECT_ARG}${pinned.project}`,
      pinned.localConfig === undefined ? NO_CONFIG_ARG : `${CONFIG_ARG}${pinned.localConfig}`,
      ...flagArgs(flags),
    ],
    env: Object.fromEntries(
      PASSED_ENV.flatMap((key) => {
        const value = key === "LINEAR_T3_CONFIG" ? pinned.globalConfig : env[key];
        return value ? [[key, value] as const] : [];
      }),
    ),
  };
}

/** What `unit` is pinned to, as `status` shows it. */
export function pinnedTo(unit: Unit): {
  project?: string;
  localConfig?: string;
  globalConfig?: string;
} {
  const { program } = unit;
  const arg = (prefix: string) =>
    program.find((word) => word.startsWith(prefix))?.slice(prefix.length);
  // Units from before projects were pinned wrote `--config <path>`.
  const legacyConfig = program.indexOf("--config");
  return {
    project: arg(PROJECT_ARG),
    localConfig: arg(CONFIG_ARG) ?? (legacyConfig < 0 ? undefined : program[legacyConfig + 1]),
    globalConfig: unit.env.LINEAR_T3_CONFIG,
  };
}

/** Runs `command`, resolving with whether it succeeded and what it printed. */
export async function runCommand(
  command: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await promisify(execFile)(command, args, { encoding: "utf8" });
    return { ok: true, output: stdout };
  } catch (error) {
    const { code, stdout, stderr } = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (code === "ENOENT") throw new ServiceError(`Could not run \`${command}\``);
    return { ok: false, output: `${stdout ?? ""}${stderr ?? ""}`.trim() };
  }
}

/** How long process `pid` has been running, as `ps` prints it, or `undefined` if `ps` can't say. */
export async function elapsed(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `command` with its output going straight to ours, e.g. to show logs, and resolves with its
 * exit code. Following logs ends with Ctrl-C, so the command stops with us and that's a clean exit.
 */
export function runAttached(command: string, args: string[]): Promise<number> {
  // Listen before spawning: the command can print before spawn() returns, and a Ctrl-C that came
  // before we listened would kill us and leave the command running. Signal handlers only run once
  // this function returns, so `child` is set by then.
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop).on("SIGTERM", stop);
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  return new Promise((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new ServiceError(`Could not run \`${command}\``) : error),
    );
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
