import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { type FakeT3Options, fakeLinear, fakeT3 } from "./fake-servers.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

function runCli(...args: string[]) {
  return runCliIn({}, ...args);
}

/** The environment of the test run without the tokens, plus `env`. */
function cliEnv(env: Record<string, string> = {}) {
  const { LINEAR_API_KEY: _, T3_TOKEN: __, CONFIG_PATH: ___, ...rest } = process.env;
  return { ...rest, ...env };
}

function runCliIn(options: { cwd?: string; env?: Record<string, string> }, ...args: string[]) {
  // stdin is a pipe, never a TTY, and the timeout catches a command waiting for input.
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    input: "",
    timeout: 10_000,
    cwd: options.cwd,
    env: cliEnv(options.env),
  });
  return { status, stdout, stderr };
}

/** Starts the CLI without blocking, so fake servers in this process can answer it. */
function startCli(options: { cwd: string; env: Record<string, string> }, args: string[]) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: cliEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    }),
  );
  return { child, result };
}

/** A temporary directory holding `config.json` with one project for Linear team `ENG`. */
function workDir(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "linear-t3-cli-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ projects: { "my-app": { linear: { team: "ENG" } } }, ...config }),
  );
  return dir;
}

describe("cli", () => {
  test.each(["--version", "-V"])("%s prints the package version and exits 0", (flag) => {
    const result = runCli(flag);
    expect(result).toEqual({ status: 0, stdout: `${version}\n`, stderr: "" });
  });

  test.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }])(
    "$args prints help and exits 0",
    ({ args }) => {
      const result = runCli(...args);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Usage: linear-t3 /);
      expect(result.stdout).toContain("-V, --version");
      expect(result.stdout).toContain("-h, --help");
      expect(result.stdout).toMatch(/^\s+connect \[service\]/m);
      expect(result.stdout).toMatch(/^\s+run \[options\]/m);
    },
  );

  test("run --help lists --once, --dry-run and --config", () => {
    const result = runCli("run", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: linear-t3 run /);
    expect(result.stdout).toMatch(/^\s+--once\b/m);
    expect(result.stdout).toMatch(/^\s+--dry-run\b/m);
    expect(result.stdout).toMatch(/^\s+--config <path>/m);
  });

  test("an unknown flag prints an error and exits non-zero", () => {
    const result = runCli("--bogus");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option '--bogus'");
  });

  test("connect with an unknown service prints a usage error naming the valid ones", () => {
    const result = runCli("connect", "github");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("'github' is invalid");
    expect(result.stderr).toContain("Allowed choices are t3, linear");
  });

  test.each([{ args: ["connect"] }, { args: ["connect", "t3"] }, { args: ["connect", "linear"] }])(
    "$args without a terminal exits non-zero before prompting",
    ({ args }) => {
      const result = runCli(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("run it in a terminal");
    },
  );
});

describe("cli run", () => {
  test.each<{ missing: string; env: Record<string, string>; args: string[] }>([
    { missing: "LINEAR_API_KEY", env: { T3_TOKEN: "t3-tok" }, args: [] },
    { missing: "T3_TOKEN", env: { LINEAR_API_KEY: "lin-key" }, args: [] },
    { missing: "LINEAR_API_KEY", env: {}, args: ["--dry-run"] },
  ])("$args without $missing exits non-zero naming it", ({ missing, env, args }) => {
    const result = runCliIn({ cwd: workDir(), env }, "run", ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing required environment variable ${missing}`);
  });

  test("reads the tokens from ./.env", () => {
    const dir = workDir();
    writeFileSync(join(dir, ".env"), "T3_TOKEN=t3-tok\n");
    const result = runCliIn({ cwd: dir }, "run", "--once");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing required environment variable LINEAR_API_KEY");
    writeFileSync(join(dir, ".env"), "LINEAR_API_KEY=lin-key\n");
    expect(runCliIn({ cwd: dir }, "run", "--once").stderr).toContain(
      "Missing required environment variable T3_TOKEN",
    );
  });

  test("a missing Config exits non-zero naming the path given with --config", () => {
    const dir = workDir();
    const env = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: dir, env }, "run", "--once", "--config", "nope.json");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, "nope.json"));
  });
});

describe("cli run against fake Linear and T3", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  const issues = [
    { id: "issue-1", identifier: "ENG-1", title: "First" },
    { id: "issue-2", identifier: "ENG-2", title: "Second" },
  ];
  const project = { id: "project-1", title: "my-app", workspaceRoot: "/work/my-app" };

  async function servers(t3Options: Partial<FakeT3Options> = {}) {
    const linear = await fakeLinear(issues);
    const t3 = await fakeT3({ projects: [project], ...t3Options });
    cleanup.push(linear.close, t3.close);
    const dir = workDir({
      t3: { url: t3.url },
      pollIntervalSeconds: 10,
      defaults: {
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        linear: { onLaunch: { comment: false } },
      },
    });
    const env = { LINEAR_API_URL: linear.url, LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    return { linear, t3, dir, env };
  }

  test("--dry-run lists the matching issues, starts no threads and exits 0", async () => {
    const { linear, t3, dir, env } = await servers();
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("2 new issue(s): ENG-1, ENG-2");
    expect(linear.queries.some((q) => q.includes("issues"))).toBe(true);
    expect(t3.requests).toEqual([]);
  });

  test("SIGTERM during a launch lets it finish and record, then exits 0 without starting more", async () => {
    let cli: ReturnType<typeof startCli> | undefined;
    const { t3, dir, env } = await servers({
      onLaunch: async () => {
        cli!.child.kill("SIGTERM");
        await setTimeout(500);
      },
    });
    cli = startCli({ cwd: dir, env }, ["run"]);
    const result = await cli.result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("received SIGTERM, shutting down");
    expect(result.stdout).toMatch(/ENG-1: started T3 thread \S+ in "my-app"/);
    expect(t3.launches).toHaveLength(1);
    const { launched } = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(Object.keys(launched)).toEqual(["issue-1"]);
  });

  test("SIGINT while waiting for the next poll exits 0", async () => {
    const { t3, dir, env } = await servers();
    const cli = startCli({ cwd: dir, env }, ["run"]);
    cli.child.stdout!.on("data", (data: Buffer) => {
      if (data.toString().includes("ENG-2: started")) cli.child.kill("SIGINT");
    });
    const result = await cli.result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("received SIGINT, shutting down");
    expect(t3.launches).toHaveLength(2);
  });
});
