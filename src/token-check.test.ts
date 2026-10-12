import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { checkLinear } from "./token-check.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs `fetch` to answer every request with `body` as JSON and the given HTTP status. */
function stubFetchJson(status: number, body: unknown) {
  const fetch = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("checkLinear", () => {
  test("a key Linear accepts is valid, with the viewer's name and email", async () => {
    const fetch = stubFetchJson(200, {
      data: { viewer: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" } },
    });
    expect(await checkLinear("lin_api_good")).toEqual({
      status: "valid",
      identity: "Ada Lovelace (ada@example.com)",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "lin_api_good" }),
      }),
    );
  });

  test("a key Linear rejects with an authentication error is unauthorized", async () => {
    // What Linear answers for a revoked or mistyped key.
    stubFetchJson(400, {
      errors: [
        {
          message: "Authentication required, not authenticated",
          extensions: {
            type: "authentication error",
            code: "AUTHENTICATION_ERROR",
            userPresentableMessage: "You need to authenticate to access this operation.",
          },
        },
      ],
    });
    expect(await checkLinear("lin_api_bad")).toEqual({
      status: "unauthorized",
      message: expect.stringMatching(/^Linear rejected the key/),
    });
  });

  test("a network failure is unreachable", async () => {
    // What Node's fetch throws when DNS fails or the connection is refused.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
      }),
    );
    expect(await checkLinear("lin_api_good")).toEqual({
      status: "unreachable",
      message: expect.stringMatching(/^Linear is not reachable/),
    });
  });
});
