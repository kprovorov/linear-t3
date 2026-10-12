import { LinearClient, LinearError, LinearErrorType } from "@linear/sdk";
import type { CheckResult } from "./connect.ts";

const LINEAR_TIMEOUT_MS = 15_000;

/** The innermost cause's message, e.g. "getaddrinfo ENOTFOUND" rather than "fetch failed". */
function rootMessage(error: unknown): string {
  let current = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return current instanceof Error ? current.message : String(current);
}

/** Checks a Linear API key by asking Linear who it belongs to. */
export async function checkLinear(apiKey: string): Promise<CheckResult> {
  // The SDK spreads unknown options into every fetch call, so this times out the request.
  const client = new LinearClient({ apiKey, signal: AbortSignal.timeout(LINEAR_TIMEOUT_MS) });
  try {
    const viewer = await client.viewer;
    return { status: "valid", identity: `${viewer.name} (${viewer.email})` };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    if (
      error.type === LinearErrorType.AuthenticationError ||
      error.type === LinearErrorType.Forbidden
    ) {
      return { status: "unauthorized", message: `Linear rejected the key: ${error.message}` };
    }
    // No HTTP status means the request never got an answer: DNS, connection or timeout.
    if (error.status === undefined || error.type === LinearErrorType.NetworkError) {
      return {
        status: "unreachable",
        message: `Linear is not reachable: ${rootMessage(error.raw)}`,
      };
    }
    // Linear answered but neither accepted nor rejected the key (5xx, rate limit). A new key
    // won't fix that any more than it fixes an outage, so report it the same way.
    return { status: "unreachable", message: `Linear check failed: ${error.message}` };
  }
}
