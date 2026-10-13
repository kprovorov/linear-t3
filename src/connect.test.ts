import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type CheckResult,
  ConnectError,
  type Integration,
  type Ui,
  connect,
  connectIntegration,
} from "./connect.ts";
import { EnvFile } from "./env-file.ts";

let env: EnvFile;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "connect-"));
  env = new EnvFile(join(dir, ".env"), join(dir, ".env.example"));
});

const envContents = () => readFileSync(env.path, "utf8");

/** A UI that answers every confirm with `replace` and records what it shows. */
function fakeUi(replace = false): Ui & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    confirm: async () => replace,
    password: async () => "",
    spin: (_message, work) => work(),
    success: (message) => shown.push(`success: ${message}`),
    warn: (message) => shown.push(`warn: ${message}`),
  };
}

/** An integration that hands out `tokens` in order and checks them against `results`. */
function fakeIntegration(
  tokens: string[],
  results: Record<string, CheckResult>,
  overrides: Partial<Integration> = {},
): Integration & { obtained: number } {
  const integration: Integration & { obtained: number } = {
    name: "Fake",
    envKey: "FAKE_TOKEN",
    obtained: 0,
    obtain: async () => {
      const token = tokens[integration.obtained++];
      if (token === undefined) throw new Error("no more tokens");
      return token;
    },
    check: async (token) => results[token] ?? { status: "unauthorized" },
    ...overrides,
  };
  return integration;
}

describe("connectIntegration", () => {
  test("with no existing token, gets a new one, checks it and saves it", async () => {
    const integration = fakeIntegration(["new"], { new: { status: "valid", identity: "Ada" } });
    const outcome = await connectIntegration(integration, env, fakeUi());
    expect(outcome).toEqual({ integration: "Fake", action: "saved", identity: "Ada" });
    expect(envContents()).toBe("FAKE_TOKEN=new\n");
  });

  test("shows who a passing token authenticated as", async () => {
    const ui = fakeUi();
    const integration = fakeIntegration(["new"], { new: { status: "valid", identity: "Ada" } });
    await connectIntegration(integration, env, ui);
    expect(ui.shown).toEqual(["success: Authenticated as Ada"]);
  });

  test("keeps an existing valid token when the user declines to replace it", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const integration = fakeIntegration(["new"], { old: { status: "valid", identity: "Ada" } });
    const outcome = await connectIntegration(integration, env, fakeUi(false));
    expect(outcome).toEqual({ integration: "Fake", action: "kept", identity: "Ada" });
    expect(integration.obtained).toBe(0);
    expect(envContents()).toBe("FAKE_TOKEN=old\n");
  });

  test("replaces an existing valid token when the user agrees", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const integration = fakeIntegration(["new"], {
      old: { status: "valid" },
      new: { status: "valid" },
    });
    const outcome = await connectIntegration(integration, env, fakeUi(true));
    expect(outcome).toEqual({ integration: "Fake", action: "saved" });
    expect(envContents()).toBe("FAKE_TOKEN=new\n");
  });

  test.each(["unauthorized", "unreachable"] as const)(
    "by default, replaces an existing token that is %s",
    async (status) => {
      writeFileSync(env.path, "FAKE_TOKEN=old\n");
      const integration = fakeIntegration(["new"], { old: { status }, new: { status: "valid" } });
      const outcome = await connectIntegration(integration, env, fakeUi());
      expect(outcome).toEqual({ integration: "Fake", action: "saved" });
      expect(envContents()).toBe("FAKE_TOKEN=new\n");
    },
  );

  test.each(["unauthorized", "unreachable"] as const)(
    "by default, fails without saving when the new token is %s",
    async (status) => {
      writeFileSync(env.path, "FAKE_TOKEN=old\n");
      const integration = fakeIntegration(["new"], {
        old: { status: "unauthorized" },
        new: { status, message: "Fake said no" },
      });
      await expect(connectIntegration(integration, env, fakeUi())).rejects.toThrow(
        new ConnectError("Fake said no"),
      );
      expect(envContents()).toBe("FAKE_TOKEN=old\n");
    },
  );

  test("an integration can abort on a failed existing token instead of getting a new one", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const integration = fakeIntegration(
      ["new"],
      { old: { status: "unreachable", message: "Fake not reachable" } },
      { onFailure: (step, result) => (result.status === "unreachable" ? "abort" : "obtain") },
    );
    await expect(connectIntegration(integration, env, fakeUi())).rejects.toThrow(
      "Fake not reachable",
    );
    expect(integration.obtained).toBe(0);
  });

  test("an integration can ask for another token when a new one fails", async () => {
    const integration = fakeIntegration(
      ["typo", "also-bad", "good"],
      { good: { status: "valid", identity: "Ada" } },
      { onFailure: () => "obtain" },
    );
    const outcome = await connectIntegration(integration, env, fakeUi());
    expect(outcome).toEqual({ integration: "Fake", action: "saved", identity: "Ada" });
    expect(integration.obtained).toBe(3);
    expect(envContents()).toBe("FAKE_TOKEN=good\n");
  });
});

describe("connect", () => {
  test("connects the integrations in order and returns what happened to each", async () => {
    const first = fakeIntegration(
      ["a"],
      { a: { status: "valid" } },
      { name: "First", envKey: "A" },
    );
    const second = fakeIntegration(
      ["b"],
      { b: { status: "valid" } },
      { name: "Second", envKey: "B" },
    );
    const outcomes = await connect([first, second], env, fakeUi());
    expect(outcomes).toEqual([
      { integration: "First", action: "saved" },
      { integration: "Second", action: "saved" },
    ]);
    expect(envContents()).toBe("A=a\nB=b\n");
  });

  test("stops at the first integration that fails", async () => {
    const first = fakeIntegration(["a"], {}, { name: "First", envKey: "A" });
    const second = fakeIntegration(
      ["b"],
      { b: { status: "valid" } },
      { name: "Second", envKey: "B" },
    );
    await expect(connect([first, second], env, fakeUi())).rejects.toThrow(ConnectError);
    expect(second.obtained).toBe(0);
  });

  test("fails with 'not implemented yet' for an integration that isn't plugged in", async () => {
    const second = fakeIntegration(["b"], { b: { status: "valid" } });
    await expect(connect([{ name: "Linear" }, second], env, fakeUi())).rejects.toThrow(
      new ConnectError("Connecting Linear is not implemented yet"),
    );
    expect(second.obtained).toBe(0);
  });
});
