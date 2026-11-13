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
  /** Where each background Daemon's log file goes, on platforms where it doesn't log to a journal. */
  logs: string;
  /** Where the launchd agents that run the Daemons go on macOS. */
  launchAgents: string;
  /** Where the systemd user units that run the Daemons go on Linux. */
  systemdUnits: string;
}

export function resolvePaths(env: Env = process.env): Paths {
  return {
    globalConfig: resolve(env.LINEAR_T3_CONFIG || join(configDir(env), "config.json")),
    credentials: join(configDir(env), "credentials"),
    defaultState: join(stateDir(env), "state.json"),
    logs: stateDir(env),
    launchAgents: join(home(env), "Library", "LaunchAgents"),
    systemdUnits: join(xdgConfig(env), "systemd", "user"),
  };
}
