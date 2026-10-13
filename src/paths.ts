import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

const APP = "linear-t3";

/** An XDG base directory: the variable if it holds an absolute path, else `~/<fallback>`. */
function xdgDir(env: Env, variable: string, fallback: string): string {
  const value = env[variable];
  // The XDG spec says relative paths are invalid and should be ignored.
  if (value && value.startsWith("/")) return value;
  return join(env.HOME || homedir(), fallback);
}

const configDir = (env: Env) => join(xdgDir(env, "XDG_CONFIG_HOME", ".config"), APP);
const stateDir = (env: Env) => join(xdgDir(env, "XDG_STATE_HOME", ".local/state"), APP);

/** Where linear-t3 keeps its files, resolved from the environment. */
export interface Paths {
  /** The Config file: `--config`, else `LINEAR_T3_CONFIG`, else the XDG config location. */
  config: string;
  /** The Credentials file, always in the XDG config location. */
  credentials: string;
  /** Where State goes when the Config doesn't set `stateFile`. */
  defaultState: string;
}

export function resolvePaths(configFlag?: string, env: Env = process.env): Paths {
  return {
    config: resolve(configFlag || env.LINEAR_T3_CONFIG || join(configDir(env), "config.json")),
    credentials: join(configDir(env), "credentials"),
    defaultState: join(stateDir(env), "state.json"),
  };
}

/** The State file: `stateFile` from the Config resolved against the Config's directory, or the default. */
export function resolveStateFile(paths: Paths, stateFile: string | undefined): string {
  return stateFile ? resolve(dirname(paths.config), stateFile) : paths.defaultState;
}
