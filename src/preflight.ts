import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
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
 * Everything that would stop the background Daemon from starting: a missing or invalid Config, a
 * token missing from the Credentials, or one its Integration rejects or can't check. Each problem
 * names its fix.
 */
export async function preflight(paths: Paths): Promise<string[]> {
  const problems: string[] = [];
  if (!existsSync(paths.config)) {
    problems.push(`No Config at ${paths.config}: run \`linear-t3 setup\``);
  } else {
    try {
      await loadConfig(paths.config);
    } catch (error) {
      const reason = message(error).startsWith("Invalid config")
        ? message(error)
        : `Invalid config ${paths.config}: ${message(error)}`;
      problems.push(`${reason}\n  fix it, then run \`linear-t3 start\` again`);
    }
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
  const t3Url = await t3BaseUrl(paths.config);
  const failures = await Promise.all([
    t3Token === undefined ? undefined : checkToken(() => checkT3Token(t3Url, t3Token), "t3"),
    linearKey === undefined ? undefined : checkToken(() => checkLinear(linearKey), "linear"),
  ]);
  return [...problems, ...failures.filter((failure) => failure !== undefined)];
}
