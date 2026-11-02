import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

const APP = "linear-t3";

const home = (env: Env) => env.HOME || homedir();

/** An XDG base directory: the variable if it holds an absolute path, else `~/<fallback>`. */
function xdgDir(env: Env, variable: string, fallback: string): string {
  const value = env[variable];
  // The XDG spec says relative paths are invalid and should be ignored.
  if (value && isAbsolute(value)) return value;
  return join(home(env), fallback);
}

const xdgConfig = (env: Env) => xdgDir(env, "XDG_CONFIG_HOME", ".config");
const configDir = (env: Env) => join(xdgConfig(env), APP);
const stateDir = (env: Env) => join(xdgDir(env, "XDG_STATE_HOME", ".local/state"), APP);

/** Where linear-t3 keeps its files, resolved from the environment. */
export interface Paths {
  /** The Global Config: `LINEAR_T3_CONFIG`, else the XDG config location. */
  globalConfig: string;
  /** The Credentials file, always in the XDG config location. */
  credentials: string;
  /** Where State goes when the Config doesn't set `stateFile`. */
  defaultState: string;
  /** The background service's log file, on platforms where it doesn't log to a journal. */
  log: string;
  /** The launchd agent that runs the Daemon on macOS. */
  launchAgent: string;
  /** The systemd user unit that runs the Daemon on Linux. */
  systemdUnit: string;
}

export function resolvePaths(env: Env = process.env): Paths {
  return {
    globalConfig: resolve(env.LINEAR_T3_CONFIG || join(configDir(env), "config.json")),
    credentials: join(configDir(env), "credentials"),
    defaultState: join(stateDir(env), "state.json"),
    log: join(stateDir(env), "daemon.log"),
    launchAgent: join(home(env), "Library", "LaunchAgents", `${APP}.plist`),
    systemdUnit: join(xdgConfig(env), "systemd", "user", `${APP}.service`),
  };
}
