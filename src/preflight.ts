import { type Config, type Values, loadConfig } from "./config.ts";
import type { CheckResult } from "./connect.ts";
import { checkT3Token, t3BaseUrl } from "./connect-t3.ts";
import { EnvFile } from "./env-file.ts";
import type { Paths } from "./paths.ts";
import { findProject } from "./project.ts";
import { T3Client, type T3Project } from "./t3.ts";
import { checkLinear } from "./token-check.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why a token check failed, with the fix when a new token would help. */
async function checkToken(
  check: () => Promise<CheckResult>,
  integration: string,
): Promise<string | undefined> {
  let result: CheckResult;
  try {
    result = await check();
  } catch (error) {
    return message(error);
  }
  if (result.status === "valid") return undefined;
  const reason = result.message ?? `${integration} check failed`;
  return result.status === "unauthorized"
    ? `${reason}\n  run \`linear-t3 connect ${integration}\``
    : reason;
}

const fixThenStart = (error: unknown) =>
  `${message(error)}\n  fix it, then run \`linear-t3 start\` again`;

// How long to wait for T3's projects once connected.
const SHELL_TIMEOUT_MS = 30_000;

/** The T3 project `config` names, or infers from its folder, as T3 reports it now. */
async function resolveProject(config: Config, t3Token: string): Promise<T3Project> {
  const t3 = await T3Client.connect(config.t3Url, t3Token, new AbortController().signal);
  // Closing the socket ends a wait for a snapshot that never comes.
  const timer = setTimeout(() => t3.close(), SHELL_TIMEOUT_MS);
  try {
    const shell = await t3.readShell().catch((error: unknown) => {
      throw new Error(`T3 at ${config.t3Url} didn't list its projects: ${message(error)}`);
    });
    return findProject(shell.projects, config);
  } finally {
    clearTimeout(timer);
    t3.close();
  }
}

/**
 * Everything that would stop the background Daemon from starting: an invalid or incomplete Config,
 * a token missing from the Credentials, one its Integration rejects or can't check, or no T3
 * project to watch. Each problem names its fix. Otherwise, the T3 project to pin the Daemon to,
 * and the Local Config it read, if any.
 */
export async function preflight(
  paths: Paths,
  { localConfig, flags }: { localConfig?: string | false; flags: Values },
): Promise<{ problems: string[]; localConfig?: string; project?: T3Project }> {
  const problems: string[] = [];
  let config: Config | undefined;
  try {
    config = await loadConfig({
      global: paths.globalConfig,
      local: localConfig,
      cwd: process.cwd(),
      flags,
      defaultState: paths.defaultState,
    });
  } catch (error) {
    problems.push(fixThenStart(error));
  }

  const credentials = new EnvFile(paths.credentials);
  // The service gets no tokens from this environment, so the Daemon only has the Credentials.
  const token = (key: string, integration: string) => {
    const value = credentials.get(key);
    if (value) return value;
    const fix = `run \`linear-t3 connect ${integration}\``;
    problems.push(
      process.env[key]
        ? `${key} is only set in the environment, which the background service doesn't get: ${fix}`
        : `Missing ${key}: ${fix}`,
    );
    return undefined;
  };
  const t3Token = token("T3_TOKEN", "t3");
  const linearKey = token("LINEAR_API_KEY", "linear");
  const t3Url = config?.t3Url ?? (await t3BaseUrl(paths.globalConfig));
  const failures = await Promise.all([
    t3Token === undefined ? undefined : checkToken(() => checkT3Token(t3Url, t3Token), "t3"),
    linearKey === undefined ? undefined : checkToken(() => checkLinear(linearKey), "linear"),
  ]);
  problems.push(...failures.filter((failure) => failure !== undefined));
  if (problems.length > 0 || !config || !t3Token) return { problems };

  try {
    const project = await resolveProject(config, t3Token);
    return { problems, localConfig: config.files.local, project };
  } catch (error) {
    return { problems: [fixThenStart(error)] };
  }
}
