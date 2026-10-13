import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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

/** The OS service manager that keeps the Daemon running in the background. See ADR 0001. */
export interface ServiceManager {
  /** What the unit is, e.g. `launchd agent`. */
  kind: string;
  /** The unit file, e.g. the launchd agent. */
  unitPath: string;
  /** Where the Daemon's output goes: a log file, or the command that shows it. */
  logLocation: string;
  installed(): boolean;
  /** The `node` binary the installed unit runs. */
  pinnedNode(): string | undefined;
  /** Writes or refreshes the unit, then enables and starts it. */
  install(unit: Unit): Promise<void>;
  /** Stops the Daemon and keeps it from starting at login. */
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Prints the Daemon's recent output and, with `follow`, keeps printing it. Resolves with an exit code. */
  logs(follow: boolean): Promise<number>;
  /** Stops the Daemon and removes the unit. */
  uninstall(): Promise<void>;
}

/** A failure to report to the user as-is. */
export class ServiceError extends Error {}

/** The service manager for this platform. */
export function serviceManager(paths: Paths): ServiceManager {
  if (process.platform === "darwin") return launchd(paths);
  if (process.platform === "linux") return systemd(paths);
  throw new ServiceError("The background service is macOS and Linux only");
}

// The Daemon reads these to find its files, so the service gets them when `start` had them.
const PASSED_ENV = ["T3CODE_HOME", "LINEAR_T3_CONFIG", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];

/** The unit that runs `cliPath run` for the Config in `paths` with the current `node`. */
export function daemonUnit(paths: Paths, cliPath: string, env = process.env): Unit {
  return {
    program: [process.execPath, cliPath, "run", "--config", paths.config],
    env: Object.fromEntries(
      PASSED_ENV.flatMap((key) => (env[key] ? [[key, env[key]] as const] : [])),
    ),
  };
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
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop).on("SIGTERM", stop);
  return new Promise((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new ServiceError(`Could not run \`${command}\``) : error),
    );
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
