import type { Paths } from "./paths.ts";
import { launchd } from "./launchd.ts";

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
}

/** The OS service manager that keeps the Daemon running in the background. See ADR 0001. */
export interface ServiceManager {
  /** The unit file, e.g. the launchd agent. */
  unitPath: string;
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
export function serviceManager(paths: Paths, platform = process.platform): ServiceManager {
  if (platform === "darwin") return launchd(paths);
  if (platform === "linux") {
    throw new ServiceError(
      "The background service isn't available on Linux yet; run `linear-t3 run` under your own supervisor for now",
    );
  }
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
