import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_T3_URL } from "./config.ts";
import { type CheckResult, ConnectError, type Ui, connectIntegration } from "./connect.ts";
import { checkT3Token, issueT3Token, t3BaseUrl, t3Integration } from "./connect-t3.ts";
import { EnvFile } from "./env-file.ts";

const BASE_URL = "http://t3.test:3773";

/** A `fetch` that records its request and answers with `respond`. */
function stubFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init });
    return respond();
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("checkT3Token", () => {
  test("posts the bearer token to the websocket ticket endpoint", async () => {
    const { fetchFn, calls } = stubFetch(async () => Response.json({ ticket: "t" }));
    await checkT3Token(BASE_URL, "tok", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/auth/websocket-ticket`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  test("200 is valid", async () => {
    const { fetchFn } = stubFetch(async () => Response.json({ ticket: "t" }));
    expect(await checkT3Token(BASE_URL, "tok", fetchFn)).toEqual({ status: "valid" });
  });

  test.each([401, 403])("%i is unauthorized", async (status) => {
    const { fetchFn } = stubFetch(async () => new Response("nope", { status }));
    expect(await checkT3Token(BASE_URL, "tok", fetchFn)).toMatchObject({
      status: "unauthorized",
    });
  });

  test("connection refused is unreachable, naming the url", async () => {
    const { fetchFn } = stubFetch(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    expect(await checkT3Token(BASE_URL, "tok", fetchFn)).toEqual({
      status: "unreachable",
      message: `T3 not reachable at ${BASE_URL}, is it running?`,
    });
  });

  test("a timeout is unreachable", async () => {
    const { fetchFn } = stubFetch(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await checkT3Token(BASE_URL, "tok", fetchFn)).toMatchObject({ status: "unreachable" });
  });

  test("an unexpected status is an error with the status and a snippet of the body", async () => {
    const { fetchFn } = stubFetch(
      async () => new Response(`internal kaboom ${"x".repeat(1000)}`, { status: 500 }),
    );
    const error = await checkT3Token(BASE_URL, "tok", fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("500");
    expect((error as Error).message).toContain("internal kaboom");
    expect((error as Error).message.length).toBeLessThan(400);
  });
});

describe("t3BaseUrl", () => {
  const configFile = (contents?: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "connect-t3-")), "config.json");
    if (contents !== undefined) writeFileSync(path, contents);
    return path;
  };

  test("uses t3.url from the config file", async () => {
    const path = configFile(JSON.stringify({ t3: { url: "http://10.0.0.5:4000" } }));
    expect(await t3BaseUrl(path)).toBe("http://10.0.0.5:4000");
  });

  test.each([
    { case: "the file is missing", contents: undefined },
    { case: "the config has no t3 section", contents: JSON.stringify({ projects: {} }) },
    { case: "t3.url is not a string", contents: JSON.stringify({ t3: { url: 3773 } }) },
    { case: "the file is not valid JSON", contents: "{ nope" },
  ])("falls back to the default when $case", async ({ contents }) => {
    expect(await t3BaseUrl(configFile(contents))).toBe(DEFAULT_T3_URL);
  });
});

describe("issueT3Token", () => {
  /** A stand-in `t3` binary that runs `script` and records its arguments. */
  const fakeT3 = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fake-t3-"));
    const bin = join(dir, "t3");
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\n${script}\n`);
    chmodSync(bin, 0o755);
    return { bin, args: () => readFileSync(join(dir, "args"), "utf8").trim() };
  };

  test("issues a year-long session labelled linear-t3 and returns the trimmed token", async () => {
    const t3 = fakeT3(`printf '  tok-123\\n\\n'`);
    expect(await issueT3Token(t3.bin)).toBe("tok-123");
    expect(t3.args()).toBe("auth session issue --label linear-t3 --ttl 365d --token-only");
  });

  test("fails clearly when t3 is not installed", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "no-t3-")), "t3");
    const error = await issueT3Token(missing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as Error).message).toMatch(/install T3 Code.*on PATH/);
  });

  test("fails with t3's stderr when it exits non-zero", async () => {
    const t3 = fakeT3(`echo "no server running" >&2; exit 3`);
    const error = await issueT3Token(t3.bin).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as Error).message).toContain("no server running");
  });

  test("fails when t3 prints no token", async () => {
    const t3 = fakeT3("true");
    await expect(issueT3Token(t3.bin)).rejects.toThrow(ConnectError);
  });
});

describe("t3Integration", () => {
  const ui = (replace = false): Ui => ({
    confirm: async () => replace,
    password: async () => {
      throw new Error("T3 never asks for a token");
    },
    spin: (_message, work) => work(),
    success: () => {},
    warn: () => {},
  });

  /** A T3 server that answers each token per `results` (anything else is unauthorized); an Error is thrown. */
  function setup(results: Record<string, CheckResult | Error>, savedToken?: string) {
    const dir = mkdtempSync(join(tmpdir(), "connect-t3-"));
    const env = new EnvFile(join(dir, "credentials"));
    if (savedToken) writeFileSync(env.path, `T3_TOKEN=${savedToken}\n`);
    let issued = 0;
    const integration = t3Integration({
      baseUrl: BASE_URL,
      check: async (token) => {
        const result = results[token] ?? { status: "unauthorized" };
        if (result instanceof Error) throw result;
        return result;
      },
      issue: async () => `new-${++issued}`,
    });
    return { env, integration, issued: () => issued, saved: () => env.get("T3_TOKEN") };
  }

  const down: CheckResult = { status: "unreachable", message: "T3 not reachable at X" };

  test("issues a token, checks it and saves it as T3_TOKEN", async () => {
    const t = setup({ "new-1": { status: "valid" } });
    expect(await connectIntegration(t.integration, t.env, ui())).toMatchObject({ action: "saved" });
    expect(t.saved()).toBe("new-1");
  });

  test("with no saved token and T3 down, fails without issuing a token", async () => {
    const t = setup({ "": down, "new-1": down });
    await expect(connectIntegration(t.integration, t.env, ui())).rejects.toThrow(
      "T3 not reachable at X",
    );
    expect(t.issued()).toBe(0);
  });

  test("with a saved token and T3 down, fails without issuing a token", async () => {
    const t = setup({ old: down }, "old");
    await expect(connectIntegration(t.integration, t.env, ui())).rejects.toThrow(
      "T3 not reachable at X",
    );
    expect(t.issued()).toBe(0);
    expect(t.saved()).toBe("old");
  });

  test("a rejected saved token leads to a new one being issued", async () => {
    const t = setup({ old: { status: "unauthorized" }, "new-1": { status: "valid" } }, "old");
    await connectIntegration(t.integration, t.env, ui());
    expect(t.saved()).toBe("new-1");
  });

  test("a valid saved token is kept by default", async () => {
    const t = setup({ old: { status: "valid" } }, "old");
    expect(await connectIntegration(t.integration, t.env, ui())).toMatchObject({ action: "kept" });
    expect(t.issued()).toBe(0);
  });

  test("issues a token when T3 answers the no-token probe with an unexpected status", async () => {
    const t = setup({
      "": new ConnectError("T3 websocket ticket request failed (400)"),
      "new-1": { status: "valid" },
    });
    await connectIntegration(t.integration, t.env, ui());
    expect(t.saved()).toBe("new-1");
  });

  test("a newly issued token that is rejected aborts without saving", async () => {
    const t = setup({}, "old");
    await expect(connectIntegration(t.integration, t.env, ui())).rejects.toThrow(ConnectError);
    expect(t.issued()).toBe(1);
    expect(t.saved()).toBe("old");
  });
});
