import { LOCAL_CONFIG_NAME, loadConfig } from "./config.ts";
import type { CheckResult } from "./connect.ts";
import { checkT3Token, t3BaseUrl } from "./connect-t3.ts";
import { EnvFile } from "./env-file.ts";
import type { Paths } from "./paths.ts";
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

/**
 * Everything that would stop the background Daemon from starting: an invalid or incomplete Config,
 * a token missing from the Credentials, or one its Integration rejects or can't check. Each problem
 * names its fix. Also says which Local Config the Daemon should be pinned to, if any.
 */
export async function preflight(
  paths: Paths,
  localConfig: string | undefined,
): Promise<{ problems: string[]; localConfig?: string }> {
  const problems: string[] = [];
  let t3Url: string | undefined;
  let pinned: string | undefined;
  try {
    const config = await loadConfig({
      global: paths.globalConfig,
      local: localConfig,
      cwd: process.cwd(),
      defaultState: paths.defaultState,
    });
    t3Url = config.t3Url;
    pinned = config.files.local;
    if ("folder" in config.project) {
      // The service doesn't run in this folder, so it can't infer the T3 project from it.
      const where = config.files.local ?? `a ${LOCAL_CONFIG_NAME} in the repository`;
      problems.push(
        `The background service can't infer the T3 project from ${config.project.folder}: set "project" in ${where}, then run \`linear-t3 start\` again`,
      );
    }
  } catch (error) {
    problems.push(`${message(error)}\n  fix it, then run \`linear-t3 start\` again`);
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
  t3Url ??= await t3BaseUrl(paths.globalConfig);
  const failures = await Promise.all([
    t3Token === undefined ? undefined : checkToken(() => checkT3Token(t3Url, t3Token), "t3"),
    linearKey === undefined ? undefined : checkToken(() => checkLinear(linearKey), "linear"),
  ]);
  return {
    problems: [...problems, ...failures.filter((failure) => failure !== undefined)],
    localConfig: pinned,
  };
}
