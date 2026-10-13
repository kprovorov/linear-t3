import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_T3_URL } from "./config.ts";
import { type CheckResult, ConnectError, type Integration } from "./connect.ts";
import { describeTicketFailure, requestWebsocketTicket } from "./t3.ts";

const CHECK_TIMEOUT_MS = 10_000;
const ISSUE_ARGS = "auth session issue --label linear-t3 --ttl 365d --token-only".split(" ");

/**
 * Checks a T3 bearer token the same way the daemon's T3 client starts: by asking for a websocket
 * ticket. Throws on any status other than 2xx, 401 or 403.
 */
export async function checkT3Token(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<CheckResult> {
  let res: Response;
  try {
    res = await requestWebsocketTicket(
      baseUrl,
      token,
      AbortSignal.timeout(CHECK_TIMEOUT_MS),
      fetchFn,
    );
  } catch {
    return { status: "unreachable", message: notReachable(baseUrl) };
  }
  if (res.ok) return { status: "valid" };
  if (res.status === 401 || res.status === 403) {
    return { status: "unauthorized", message: `T3 at ${baseUrl} rejected the token` };
  }
  throw new ConnectError(await describeTicketFailure(res));
}

const notReachable = (baseUrl: string) => `T3 not reachable at ${baseUrl}, is it running?`;

const T3Url = z.object({ t3: z.object({ url: z.string().url() }) });

/**
 * The T3 server URL from `t3.url` in the config file, or the default. Only that field is read, so
 * a missing, unreadable or otherwise incomplete config never stops `connect`.
 */
export async function t3BaseUrl(configPath: string): Promise<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return DEFAULT_T3_URL;
  }
  const result = T3Url.safeParse(raw);
  return result.success ? result.data.t3.url : DEFAULT_T3_URL;
}

/** Issues a new T3 session token by running `t3 auth session issue`. */
export async function issueT3Token(bin = "t3"): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(bin, ISSUE_ARGS, { encoding: "utf8" }));
  } catch (error) {
    const { code, stderr } = error as NodeJS.ErrnoException & { stderr?: string };
    if (code === "ENOENT") {
      throw new ConnectError("Could not run `t3`: install T3 Code / is `t3` on PATH?");
    }
    throw new ConnectError(`\`t3 auth session issue\` failed: ${stderr?.trim() || String(error)}`);
  }
  const token = stdout.trim();
  if (!token) throw new ConnectError("`t3 auth session issue` printed no token");
  return token;
}

export interface T3IntegrationOptions {
  baseUrl: string;
  check?: (token: string) => Promise<CheckResult>;
  issue?: () => Promise<string>;
}

/**
 * `connect`'s T3 integration: issues tokens through the `t3` CLI and checks them against the server.
 * An unreachable server always aborts, and no token is issued until the server answers.
 */
export function t3Integration({
  baseUrl,
  check = (token) => checkT3Token(baseUrl, token),
  issue = () => issueT3Token(),
}: T3IntegrationOptions): Integration {
  return {
    name: "T3",
    envKey: "T3_TOKEN",
    async obtain(ui) {
      // Probe with no token first, so a down server doesn't leave a fresh 365-day session behind.
      // Any answer at all means the server is up; only a failure to reach it matters here.
      const probe = await ui.spin(`Checking T3 at ${baseUrl}`, () =>
        check("").catch((): CheckResult => ({ status: "unauthorized" })),
      );
      if (probe.status === "unreachable") {
        throw new ConnectError(probe.message ?? notReachable(baseUrl));
      }
      return ui.spin("Issuing a T3 token with `t3 auth session issue`", issue);
    },
    check,
    onFailure: (step, result) =>
      result.status === "unauthorized" && step === "existing" ? "obtain" : "abort",
  };
}
