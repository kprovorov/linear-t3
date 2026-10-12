import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type CheckResult,
  ConnectError,
  type Service,
  type Ui,
  connect,
  connectService,
} from "./connect.ts";
import { EnvFile } from "./env-file.ts";

let env: EnvFile;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "connect-"));
  env = new EnvFile(join(dir, ".env"), join(dir, ".env.example"));
});

const envContents = () => readFileSync(env.path, "utf8");

/** A UI that answers every confirm with `replace`. */
function fakeUi(replace = false): Ui {
  return {
    confirm: async () => replace,
    spin: (_message, work) => work(),
    warn: () => {},
  };
}

/** A service that hands out `tokens` in order and checks them against `results`. */
function fakeService(
  tokens: string[],
  results: Record<string, CheckResult>,
  overrides: Partial<Service> = {},
): Service & { obtained: number } {
  const service: Service & { obtained: number } = {
    name: "Fake",
    envKey: "FAKE_TOKEN",
    obtained: 0,
    obtain: async () => {
      const token = tokens[service.obtained++];
      if (token === undefined) throw new Error("no more tokens");
      return token;
    },
    check: async (token) => results[token] ?? { status: "unauthorized" },
    ...overrides,
  };
  return service;
}

describe("connectService", () => {
  test("with no existing token, gets a new one, checks it and saves it", async () => {
    const service = fakeService(["new"], { new: { status: "valid", identity: "Ada" } });
    const outcome = await connectService(service, env, fakeUi());
    expect(outcome).toEqual({ service: "Fake", action: "saved", identity: "Ada" });
    expect(envContents()).toBe("FAKE_TOKEN=new\n");
  });

  test("keeps an existing valid token when the user declines to replace it", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const service = fakeService(["new"], { old: { status: "valid", identity: "Ada" } });
    const outcome = await connectService(service, env, fakeUi(false));
    expect(outcome).toEqual({ service: "Fake", action: "kept", identity: "Ada" });
    expect(service.obtained).toBe(0);
    expect(envContents()).toBe("FAKE_TOKEN=old\n");
  });

  test("replaces an existing valid token when the user agrees", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const service = fakeService(["new"], { old: { status: "valid" }, new: { status: "valid" } });
    const outcome = await connectService(service, env, fakeUi(true));
    expect(outcome).toEqual({ service: "Fake", action: "saved" });
    expect(envContents()).toBe("FAKE_TOKEN=new\n");
  });

  test.each(["unauthorized", "unreachable"] as const)(
    "by default, replaces an existing token that is %s",
    async (status) => {
      writeFileSync(env.path, "FAKE_TOKEN=old\n");
      const service = fakeService(["new"], { old: { status }, new: { status: "valid" } });
      const outcome = await connectService(service, env, fakeUi());
      expect(outcome).toEqual({ service: "Fake", action: "saved" });
      expect(envContents()).toBe("FAKE_TOKEN=new\n");
    },
  );

  test.each(["unauthorized", "unreachable"] as const)(
    "by default, fails without saving when the new token is %s",
    async (status) => {
      writeFileSync(env.path, "FAKE_TOKEN=old\n");
      const service = fakeService(["new"], {
        old: { status: "unauthorized" },
        new: { status, message: "Fake said no" },
      });
      await expect(connectService(service, env, fakeUi())).rejects.toThrow(
        new ConnectError("Fake said no"),
      );
      expect(envContents()).toBe("FAKE_TOKEN=old\n");
    },
  );

  test("a service can abort on a failed existing token instead of getting a new one", async () => {
    writeFileSync(env.path, "FAKE_TOKEN=old\n");
    const service = fakeService(
      ["new"],
      { old: { status: "unreachable", message: "Fake not reachable" } },
      { onFailure: (step, result) => (result.status === "unreachable" ? "abort" : "obtain") },
    );
    await expect(connectService(service, env, fakeUi())).rejects.toThrow("Fake not reachable");
    expect(service.obtained).toBe(0);
  });

  test("a service can ask for another token when a new one fails", async () => {
    const service = fakeService(
      ["typo", "also-bad", "good"],
      { good: { status: "valid", identity: "Ada" } },
      { onFailure: () => "obtain" },
    );
    const outcome = await connectService(service, env, fakeUi());
    expect(outcome).toEqual({ service: "Fake", action: "saved", identity: "Ada" });
    expect(service.obtained).toBe(3);
    expect(envContents()).toBe("FAKE_TOKEN=good\n");
  });
});

describe("connect", () => {
  test("connects the services in order and returns what happened to each", async () => {
    const first = fakeService(["a"], { a: { status: "valid" } }, { name: "First", envKey: "A" });
    const second = fakeService(["b"], { b: { status: "valid" } }, { name: "Second", envKey: "B" });
    const outcomes = await connect([first, second], env, fakeUi());
    expect(outcomes).toEqual([
      { service: "First", action: "saved" },
      { service: "Second", action: "saved" },
    ]);
    expect(envContents()).toBe("A=a\nB=b\n");
  });

  test("stops at the first service that fails", async () => {
    const first = fakeService(["a"], {}, { name: "First", envKey: "A" });
    const second = fakeService(["b"], { b: { status: "valid" } }, { name: "Second", envKey: "B" });
    await expect(connect([first, second], env, fakeUi())).rejects.toThrow(ConnectError);
    expect(second.obtained).toBe(0);
  });

  test("fails with 'not implemented yet' for a service that isn't plugged in", async () => {
    const second = fakeService(["b"], { b: { status: "valid" } });
    await expect(connect([{ name: "Linear" }, second], env, fakeUi())).rejects.toThrow(
      new ConnectError("Connecting Linear is not implemented yet"),
    );
    expect(second.obtained).toBe(0);
  });
});
