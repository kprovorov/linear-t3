import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  type FakeIssue,
  type FakeT3Options,
  type FakeThread,
  fakeLinear,
  fakeT3,
} from "./fake-servers.ts";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

function runCli(...args: string[]) {
  return runCliIn({}, ...args);
}

/** A throwaway `HOME` with its own XDG config and state directories. */
function homeDir() {
  const home = mkdtempSync(join(tmpdir(), "linear-t3-home-"));
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  };
}

/** Where the CLI keeps its files under `home`. */
function locations(home: ReturnType<typeof homeDir>) {
  return {
    config: join(home.XDG_CONFIG_HOME, "linear-t3", "config.json"),
    credentials: join(home.XDG_CONFIG_HOME, "linear-t3", "credentials"),
    state: join(home.XDG_STATE_HOME, "linear-t3", "state.json"),
  };
}

function writeFile(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * The environment of the test run without the tokens or anything that locates the CLI's or T3's files,
 * plus a fresh home (unless `env` brings its own) and `env`.
 */
function cliEnv(env: Record<string, string> = {}) {
  const {
    LINEAR_API_KEY: _,
    T3_TOKEN: __,
    CONFIG_PATH: ___,
    LINEAR_T3_CONFIG: ____,
    XDG_CONFIG_HOME: _____,
    XDG_STATE_HOME: ______,
    T3CODE_HOME: _______,
    ...rest
  } = process.env;
  return { ...rest, ...(env.HOME ? {} : homeDir()), ...env };
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

/**
 * Starts the CLI without blocking, so fake servers in this process can answer it. `cli` runs the
 * CLI from another path; `killAfterMs` is how long it may run.
 */
function startCli(
  options: { cwd: string; env: Record<string, string>; cli?: string; killAfterMs?: number },
  args: string[],
) {
  const child = spawn(process.execPath, [options.cli ?? cliPath, ...args], {
    cwd: options.cwd,
    env: cliEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), options.killAfterMs ?? 10_000);
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    }),
  );
  return { child, result };
}

// Runs argv[1:] on a pseudo-terminal, copying stdin to it and its output to stdout. A new
// terminal is 0 columns wide, so give it a real size first or every prompt wraps at each character.
const PTY_SCRIPT = [
  "import os, pty, sys",
  'argv = ["sh", "-c", \'stty cols 200 rows 50 && exec "$0" "$@"\', *sys.argv[1:]]',
  "sys.exit(os.waitstatus_to_exitcode(pty.spawn(argv)))",
].join("\n");

/**
 * Starts the CLI on a terminal, so interactive commands run. `answer` waits for `prompt` in the
 * output, then types `input`.
 */
function startCliInTerminal(options: { cwd: string; env: Record<string, string> }, args: string[]) {
  const child = spawn("python3", ["-c", PTY_SCRIPT, process.execPath, cliPath, ...args], {
    cwd: options.cwd,
    env: { ...cliEnv(options.env), TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const waiting: { prompt: string; resolve: () => void }[] = [];
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
    for (const wait of waiting.splice(0)) {
      if (output.includes(wait.prompt)) wait.resolve();
      else waiting.push(wait);
    }
  });
  const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 10_000);
  const result = new Promise<{ status: number | null; output: string }>((resolve) =>
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    }),
  );
  const answer = async (prompt: string, input: string) => {
    if (!output.includes(prompt))
      await new Promise<void>((resolve) => waiting.push({ prompt, resolve }));
    child.stdin.write(input);
  };
  return { answer, result };
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
      expect(result.stdout).toMatch(/^\s+connect \[integration\]/m);
      expect(result.stdout).toMatch(/^\s+run \[options\]/m);
      for (const command of ["start", "stop", "restart", "status", "uninstall"]) {
        expect(result.stdout).toMatch(new RegExp(`^\\s+${command}\\s`, "m"));
      }
      expect(result.stdout).toMatch(/^\s+logs \[options\]/m);
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

  test("connect with an unknown integration prints a usage error naming the valid ones", () => {
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
    const result = runCliIn({ cwd: workDir(), env }, "run", "--config", "config.json", ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing ${missing}`);
    expect(result.stderr).toContain("linear-t3 connect");
  });

  test("reads the tokens from the Credentials file", () => {
    const home = homeDir();
    const { credentials } = locations(home);
    const run = () => runCliIn({ cwd: workDir(), env: home }, "run", "--config", "config.json");
    writeFile(credentials, "T3_TOKEN=t3-tok\n");
    expect(run().stderr).toContain("Missing LINEAR_API_KEY");
    writeFile(credentials, "LINEAR_API_KEY=lin-key\n");
    expect(run().stderr).toContain("Missing T3_TOKEN");
  });

  test("ignores tokens in ./.env", () => {
    const dir = workDir();
    writeFileSync(join(dir, ".env"), "LINEAR_API_KEY=lin-key\nT3_TOKEN=t3-tok\n");
    const result = runCliIn({ cwd: dir }, "run", "--config", "config.json");
    expect(result.stderr).toContain("Missing LINEAR_API_KEY");
  });

  test("a missing Config exits non-zero naming the path given with --config", () => {
    const dir = workDir();
    const env = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: dir, env }, "run", "--once", "--config", "nope.json");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, "nope.json"));
  });

  test.each<{
    case: string;
    args: (dirs: Record<string, string>) => string[];
    env: (dirs: Record<string, string>) => Record<string, string>;
    used: string;
  }>([
    {
      case: "--config beats LINEAR_T3_CONFIG",
      args: (d) => ["--config", d.flag!],
      env: (d) => ({ LINEAR_T3_CONFIG: d.env! }),
      used: "flag",
    },
    {
      case: "LINEAR_T3_CONFIG beats the XDG default",
      args: () => [],
      env: (d) => ({ LINEAR_T3_CONFIG: d.env! }),
      used: "env",
    },
    { case: "the XDG default is used last", args: () => [], env: () => ({}), used: "xdg" },
    {
      case: "CONFIG_PATH is ignored",
      args: () => [],
      env: (d) => ({ CONFIG_PATH: d.env! }),
      used: "xdg",
    },
  ])("$case", ({ args, env, used }) => {
    const home = homeDir();
    const base = mkdtempSync(join(tmpdir(), "linear-t3-configs-"));
    const dirs: Record<string, string> = {
      flag: join(base, "flag.json"),
      env: join(base, "env.json"),
      xdg: locations(home).config,
    };
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn(
      { cwd: workDir(), env: { ...home, ...tokens, ...env(dirs) } },
      "run",
      "--once",
      ...args(dirs),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(dirs[used]);
  });
});

describe("cli setup", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  test("writes a starter Config the Daemon accepts, then prints its path and the next steps", async () => {
    const home = homeDir();
    const { config } = locations(home);
    const result = runCliIn({ env: home }, "setup");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(config);
    expect(result.stdout).toMatch(/edit .*projects/i);
    expect(result.stdout).toMatch(/linear-t3 connect[^]*linear-t3 start/);

    // A dry run only talks to Linear, so it passes exactly when the Config loads.
    const linear = await fakeLinear([]);
    cleanup.push(linear.close);
    const env = { ...home, LINEAR_API_URL: linear.url, LINEAR_API_KEY: "lin-key", T3_TOKEN: "t" };
    const dryRun = await startCli({ cwd: home.HOME, env }, ["run", "--dry-run"]).result;
    expect(dryRun).toMatchObject({ status: 0, stderr: "" });
  });

  test("refuses to overwrite an existing Config and exits non-zero", () => {
    const home = homeDir();
    const { config } = locations(home);
    writeFile(config, '{"mine":true}\n');
    const result = runCliIn({ env: home }, "setup");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`already exists at ${config}`);
    expect(readFileSync(config, "utf8")).toBe('{"mine":true}\n');
  });

  test.each<{
    case: string;
    args: (path: string) => string[];
    env: (path: string) => Record<string, string>;
  }>([
    { case: "--config", args: (path) => ["--config", path], env: () => ({}) },
    { case: "LINEAR_T3_CONFIG", args: () => [], env: (path) => ({ LINEAR_T3_CONFIG: path }) },
  ])("$case sets where it writes, creating missing directories", ({ args, env }) => {
    const home = homeDir();
    const path = join(home.HOME, "elsewhere", "nested", "mine.json");
    const result = runCliIn({ env: { ...home, ...env(path) } }, "setup", ...args(path));
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("projects");
    expect(existsSync(locations(home).config)).toBe(false);
  });

  test("the bundled CLI finds the template among the published files", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const pkg = mkdtempSync(join(tmpdir(), "linear-t3-pkg-"));
    // Build with the real pack config, then lay out exactly the files npm would publish.
    const build = spawnSync(
      process.execPath,
      [join(root, "node_modules", "vite-plus", "bin", "vp"), "pack"],
      { cwd: root, encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);
    const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(pack.status).toBe(0);
    for (const { path } of (JSON.parse(pack.stdout) as [{ files: { path: string }[] }])[0].files) {
      mkdirSync(dirname(join(pkg, path)), { recursive: true });
      copyFileSync(join(root, path), join(pkg, path));
    }
    symlinkSync(join(root, "node_modules"), join(pkg, "node_modules"));

    const home = homeDir();
    const result = spawnSync(process.execPath, [join(pkg, "dist", "cli.js"), "setup"], {
      encoding: "utf8",
      input: "",
      timeout: 10_000,
      env: cliEnv(home),
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(locations(home).config, "utf8")).toBe(
      readFileSync(join(root, "config.template.json"), "utf8"),
    );
  });
});

describe("cli connect", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  test("connect linear saves the key to the Credentials file with mode 0600", async () => {
    const linear = await fakeLinear([]);
    cleanup.push(linear.close);
    const home = homeDir();
    const { credentials } = locations(home);
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-cwd-"));
    const cli = startCliInTerminal({ cwd: dir, env: { ...home, LINEAR_API_URL: linear.url } }, [
      "connect",
      "linear",
    ]);
    await cli.answer("Linear API key", "lin-key\r");
    const result = await cli.result;
    expect(result.status).toBe(0);
    expect(result.output).toContain(`Saved to ${credentials}`);
    expect(readFileSync(credentials, "utf8")).toBe("LINEAR_API_KEY=lin-key\n");
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(linear.apiKeys).toContain("lin-key");
    expect(existsSync(join(dir, ".env"))).toBe(false);
  });

  test("connect t3 checks the token against t3.url from the XDG Config", async () => {
    const t3 = await fakeT3({ projects: [] });
    cleanup.push(t3.close);
    const home = homeDir();
    const { config, credentials } = locations(home);
    writeFile(config, JSON.stringify({ t3: { url: t3.url } }));
    // A stand-in `t3` CLI that issues a fixed token.
    const bin = mkdtempSync(join(tmpdir(), "linear-t3-bin-"));
    writeFileSync(join(bin, "t3"), "#!/bin/sh\necho t3-tok\n", { mode: 0o755 });
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-cwd-"));
    const env = { ...home, PATH: `${bin}:${process.env.PATH}` };
    const result = await startCliInTerminal({ cwd: dir, env }, ["connect", "t3"]).result;
    expect(result.status).toBe(0);
    expect(readFileSync(credentials, "utf8")).toBe("T3_TOKEN=t3-tok\n");
    expect(t3.requests).toContain("POST /api/auth/websocket-ticket");
  });

  test("connect help no longer mentions ./.env", () => {
    const result = runCli("connect", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(".env");
    expect(result.stdout).toContain("Credentials");
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

  /** Fake servers, plus a fresh home whose XDG Config points at them; `config` is merged in. */
  async function servers(
    t3Options: Partial<FakeT3Options> = {},
    config = {},
    linearIssues: FakeIssue[] = issues,
  ) {
    const linear = await fakeLinear(linearIssues);
    const t3 = await fakeT3({ projects: [project], ...t3Options });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = locations(home);
    writeFile(
      files.config,
      JSON.stringify({
        projects: { "my-app": { linear: { team: "ENG" } } },
        t3: { url: t3.url },
        pollIntervalSeconds: 10,
        defaults: {
          model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          linear: { onLaunch: { comment: false } },
        },
        ...config,
      }),
    );
    // Run from elsewhere, so nothing can depend on the current directory.
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-cwd-"));
    const env = {
      ...home,
      LINEAR_API_URL: linear.url,
      LINEAR_API_KEY: "lin-key",
      T3_TOKEN: "t3-tok",
    };
    return { linear, t3, dir, env, files };
  }

  const launchedIds = (stateFile: string) =>
    Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).launched);

  test("--dry-run reads the Linear key from the Credentials file", async () => {
    const { linear, dir, env, files } = await servers();
    writeFile(files.credentials, "LINEAR_API_KEY=from-file\n");
    const { LINEAR_API_KEY: _, ...withoutKey } = env;
    const result = await startCli({ cwd: dir, env: withoutKey }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(linear.apiKeys).toContain("from-file");
    expect(linear.apiKeys).not.toContain("lin-key");
  });

  test("--dry-run prefers the env var over the Credentials file", async () => {
    const { linear, dir, env, files } = await servers();
    writeFile(files.credentials, "LINEAR_API_KEY=from-file\n");
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(linear.apiKeys).toContain("lin-key");
    expect(linear.apiKeys).not.toContain("from-file");
  });

  test("--once keeps State in the XDG state location by default", async () => {
    const { dir, env, files } = await servers();
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(launchedIds(files.state)).toEqual(["issue-1", "issue-2"]);
  });

  test("a relative stateFile resolves against the Config's directory", async () => {
    const { dir, env, files } = await servers({}, { stateFile: "data/state.json" });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(launchedIds(join(dirname(files.config), "data", "state.json"))).toEqual([
      "issue-1",
      "issue-2",
    ]);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(existsSync(files.state)).toBe(false);
  });

  test("--dry-run lists the matching issues, starts no threads and exits 0", async () => {
    const { linear, t3, dir, env } = await servers();
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("2 new issue(s): ENG-1, ENG-2");
    expect(linear.queries.some((q) => q.includes("issues"))).toBe(true);
    expect(t3.requests).toEqual([]);
  });

  /** Runs `run --once` `polls` times and returns the State's launched issue ids after each one. */
  async function launchesPerPoll(polls: number, ...args: Parameters<typeof servers>) {
    const { dir, env, files } = await servers(...args);
    const seen: string[][] = [];
    for (let i = 0; i < polls; i++) {
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      seen.push(launchedIds(files.state));
    }
    return seen;
  }

  test("launches the most urgent issue first and issues with no priority last", async () => {
    const seen = await launchesPerPoll(3, {}, { maxLaunchesPerPoll: 1 }, [
      { id: "none", identifier: "ENG-1", title: "No priority", priority: 0 },
      { id: "medium", identifier: "ENG-2", title: "Medium", priority: 3 },
      { id: "urgent", identifier: "ENG-3", title: "Urgent", priority: 1 },
    ]);
    expect(seen).toEqual([["urgent"], ["urgent", "medium"], ["urgent", "medium", "none"]]);
  });

  test("issues with the same priority launch oldest first", async () => {
    const seen = await launchesPerPoll(2, {}, { maxLaunchesPerPoll: 1 }, [
      {
        id: "newer",
        identifier: "ENG-2",
        title: "Newer",
        priority: 2,
        createdAt: "2026-02-01T00:00:00Z",
      },
      {
        id: "older",
        identifier: "ENG-1",
        title: "Older",
        priority: 2,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(seen).toEqual([["older"], ["older", "newer"]]);
  });

  test("launches alternate between projects, whatever their priorities", async () => {
    const t3Projects = ["web", "ops"].map((title) => ({
      id: title,
      title,
      workspaceRoot: `/work/${title}`,
    }));
    const config = {
      maxLaunchesPerPoll: 3,
      projects: { web: { linear: { team: "WEB" } }, ops: { linear: { team: "OPS" } } },
    };
    const seen = await launchesPerPoll(1, { projects: t3Projects }, config, [
      { id: "web-1", identifier: "WEB-1", title: "Web urgent", priority: 1, team: "WEB" },
      { id: "web-2", identifier: "WEB-2", title: "Web high", priority: 2, team: "WEB" },
      { id: "ops-1", identifier: "OPS-1", title: "Ops low", priority: 4, team: "OPS" },
      { id: "ops-2", identifier: "OPS-2", title: "Ops none", priority: 0, team: "OPS" },
    ]);
    expect(seen).toEqual([["web-1", "ops-1", "web-2"]]);
  });

  test("SIGTERM during a launch lets it finish and record, then exits 0 without starting more", async () => {
    let cli: ReturnType<typeof startCli> | undefined;
    const { t3, dir, env, files } = await servers({
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
    expect(launchedIds(files.state)).toEqual(["issue-1"]);
  });

  describe("maxRunningThreads", () => {
    const threeIssues = [...issues, { id: "issue-3", identifier: "ENG-3", title: "Third" }];
    const running: FakeThread = {
      id: "t-run",
      projectId: project.id,
      activityRunStatus: "running",
    };

    test("starts only what fits under the cap and names the issues left waiting", async () => {
      const { t3, dir, env, files } = await servers(
        { threads: [running] },
        { maxRunningThreads: 2 },
        threeIssues,
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(1);
      expect(launchedIds(files.state)).toEqual(["issue-1"]);
      expect(result.stdout).toContain("maxRunningThreads 2 reached");
      expect(result.stdout).toContain("waiting: ENG-2, ENG-3");
    });

    test.each<{ case: string; thread: Omit<FakeThread, "id" | "projectId">; counts: boolean }>([
      {
        case: "waiting only for approval",
        thread: { status: "running", pendingRuntimeRequest: { kind: "approval" } },
        counts: false,
      },
      { case: "queued", thread: { status: "queued" }, counts: true },
      {
        case: "draining after its turn",
        thread: { status: "completed", activityRunStatus: "waiting" },
        counts: true,
      },
      {
        case: "completed with a running subagent",
        thread: { pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent" }] },
        counts: true,
      },
      {
        case: "completed with only a pending command",
        thread: { pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }] },
        counts: false,
      },
      { case: "completed", thread: {}, counts: false },
    ])("a thread that is $case counts: $counts", async ({ thread, counts }) => {
      // Started by hand in another project: it still counts toward the global cap.
      const manual = { id: "t-manual", projectId: "other-project", ...thread };
      const { t3, dir, env } = await servers({ threads: [manual] }, { maxRunningThreads: 1 });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(counts ? 0 : 1);
    });

    // Waits out the 10s minimum poll interval.
    test("a held-back issue starts at the next poll with room, without backing off", async () => {
      const threads = [running];
      const { t3, dir, env, files } = await servers({ threads }, { maxRunningThreads: 1 });
      const cli = startCli({ cwd: dir, env, killAfterMs: 20_000 }, ["run"]);
      let output = "";
      cli.child.stdout!.on("data", (data: Buffer) => {
        output += data.toString();
        // The running thread finishes after the first poll held everything back.
        if (output.includes("waiting: ENG-1, ENG-2")) threads.splice(0);
        // Once: a second SIGTERM landing while the CLI exits would kill it.
        if (output.includes("ENG-1: started") && !cli.child.killed) cli.child.kill("SIGTERM");
      });
      const result = await cli.result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(1);
      expect(launchedIds(files.state)).toEqual(["issue-1"]);
      expect(result.stdout).not.toContain("failed to start");
    }, 20_000);

    test.each([
      { cap: undefined, launches: 2 },
      { cap: 0, launches: 0 },
    ])(
      "with the cap at $cap, starts $launches of 3 under maxLaunchesPerPoll 2",
      async ({ cap, launches }) => {
        const { t3, dir, env } = await servers(
          { threads: [running] },
          { maxRunningThreads: cap, maxLaunchesPerPoll: 2 },
          threeIssues,
        );
        const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(t3.launches).toHaveLength(launches);
      },
    );
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

/** What both background service suites hand `startAndInstalledChecks`. */
interface ServiceSetup {
  env: Record<string, string>;
  files: { config: string; credentials: string; unit: string };
  cli: (...args: string[]) => ReturnType<typeof startCli>["result"];
  /** Every call the stand-in service manager got. */
  calls: () => string[];
}

/** Tests for what `start` checks first and for commands that need the service installed. */
function startAndInstalledChecks(service: () => Promise<ServiceSetup>) {
  test.each<{
    case: string;
    breaks: (files: Record<string, string>) => void;
    env?: Record<string, string>;
    fix: RegExp;
  }>([
    { case: "no Config", breaks: (f) => rmSync(f.config!), fix: /linear-t3 setup/ },
    {
      case: "an invalid Config",
      breaks: (f) => writeFile(f.config!, "{}"),
      fix: /Invalid config[\s\S]*fix it, then run `linear-t3 start` again/,
    },
    {
      case: "no Linear key",
      breaks: (f) => writeFile(f.credentials!, "T3_TOKEN=t3-tok\n"),
      fix: /Missing LINEAR_API_KEY: run `linear-t3 connect linear`/,
    },
    {
      case: "the Linear key only in the environment",
      breaks: (f) => writeFile(f.credentials!, "T3_TOKEN=t3-tok\n"),
      env: { LINEAR_API_KEY: "lin-key" },
      fix: /LINEAR_API_KEY is only set in the environment.*run `linear-t3 connect linear`/,
    },
    {
      case: "no T3 token",
      breaks: (f) => writeFile(f.credentials!, "LINEAR_API_KEY=lin-key\n"),
      fix: /Missing T3_TOKEN: run `linear-t3 connect t3`/,
    },
    {
      case: "a Linear key Linear rejects",
      breaks: (f) => writeFile(f.credentials!, "LINEAR_API_KEY=old\nT3_TOKEN=t3-tok\n"),
      fix: /Linear rejected the key.*\n.*run `linear-t3 connect linear`/,
    },
    {
      case: "a T3 token T3 rejects",
      breaks: (f) => writeFile(f.credentials!, "LINEAR_API_KEY=lin-key\nT3_TOKEN=old\n"),
      fix: /rejected the token.*\n.*run `linear-t3 connect t3`/,
    },
  ])("start with $case exits non-zero with the fix and installs nothing", async (failure) => {
    const { env, files, calls } = await service();
    failure.breaks(files);
    const result = await startCli({ cwd: tmpdir(), env: { ...env, ...failure.env } }, ["start"])
      .result;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(failure.fix);
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("start with T3 down exits non-zero and installs nothing", async () => {
    const { files, cli, calls } = await service();
    const config = {
      projects: { a: { linear: { team: "ENG" } } },
      t3: { url: "http://127.0.0.1:1" },
    };
    writeFile(files.config, JSON.stringify(config));
    const result = await cli("start");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("T3 not reachable at http://127.0.0.1:1");
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("start from the npx cache refuses and says to install globally", async () => {
    const { env, files, calls } = await service();
    // Where npx puts a package it runs without installing it.
    const npxCli = join(mkdtempSync(join(tmpdir(), "linear-t3-npm-")), "_npx", "1a2b", "cli.ts");
    mkdirSync(dirname(npxCli), { recursive: true });
    symlinkSync(cliPath, npxCli);
    const result = await startCli({ cwd: tmpdir(), env, cli: npxCli }, ["start"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm i -g linear-t3");
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test.each(["stop", "restart", "logs", "uninstall"])(
    "%s when the service isn't installed says so and exits non-zero",
    async (command) => {
      const { cli, calls } = await service();
      const result = await cli(command);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "The Daemon isn't installed as a background service; run `linear-t3 start`",
      );
      expect(calls()).toEqual([]);
    },
  );
}

// launchd only exists on macOS; CI runs this suite on a macOS runner.
describe.runIf(process.platform === "darwin")("cli background service on macOS", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  const uid = process.getuid!();
  const target = `gui/${uid}/linear-t3`;

  /**
   * A fresh home with a valid Config and Credentials, fake T3 and Linear servers that accept only
   * those tokens, and a stand-in `launchctl` on `PATH` that records each call. `launchctl print`
   * shows `printed` once it is set, else fails the way it does for an agent that isn't loaded.
   */
  async function service() {
    const linear = await fakeLinear([], { apiKey: "lin-key" });
    const t3 = await fakeT3({ projects: [], token: "t3-tok" });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = {
      ...locations(home),
      log: join(home.XDG_STATE_HOME, "linear-t3", "daemon.log"),
      unit: join(home.HOME, "Library", "LaunchAgents", "linear-t3.plist"),
    };
    writeFile(
      files.config,
      JSON.stringify({
        projects: { "my-app": { linear: { team: "ENG" } } },
        t3: { url: t3.url },
      }),
    );
    writeFile(files.credentials, "LINEAR_API_KEY=lin-key\nT3_TOKEN=t3-tok\n");
    const bin = mkdtempSync(join(tmpdir(), "linear-t3-bin-"));
    const calls = join(bin, "calls");
    const printed = join(bin, "printed");
    writeFileSync(
      join(bin, "launchctl"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${calls}"`,
        'if [ "$1" = print ]; then',
        `  if [ -f "${printed}" ]; then cat "${printed}"; exit 0; fi`,
        `  echo "Could not find service \\"linear-t3\\" in domain for user gui: ${uid}" >&2`,
        "  exit 113",
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = { ...home, LINEAR_API_URL: linear.url, PATH: `${bin}:${process.env.PATH}` };
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-cwd-"));
    const recorded = () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    return {
      env,
      files,
      cli: (...args: string[]) => startCli({ cwd: dir, env }, args).result,
      calls: recorded,
      print: (output: string) => writeFileSync(printed, output),
      resetCalls: () => writeFileSync(calls, ""),
    };
  }

  /** `service()` after a successful `start`, with launchd reporting the agent as `state`. */
  async function installed(state: "running" | "stopped" | "unloaded" = "running") {
    const setup = await service();
    expect((await setup.cli("start")).status).toBe(0);
    if (state === "running") setup.print(printed(`state = running\n\tpid = ${process.pid}`));
    if (state === "stopped") setup.print(printed("state = not running"));
    setup.resetCalls();
    return setup;
  }

  /** What `launchctl print` shows for the agent, around `details`. */
  const printed = (details: string) =>
    `${target} = {\n\tactive count = 1\n\tpath = /x/linear-t3.plist\n\t${details}\n}\n`;

  /** The agent `start` should write for `files`, with `env` as its environment. */
  function expectedAgent(files: { config: string; log: string }, env: Record<string, string>) {
    const variables = Object.entries(env)
      .map(([key, value]) => `\t\t<key>${key}</key>\n\t\t<string>${value}</string>\n`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>linear-t3</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${process.execPath}</string>
\t\t<string>${cliPath}</string>
\t\t<string>run</string>
\t\t<string>--config</string>
\t\t<string>${files.config}</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${variables}\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ExitTimeOut</key>
\t<integer>30</integer>
\t<key>StandardOutPath</key>
\t<string>${files.log}</string>
\t<key>StandardErrorPath</key>
\t<string>${files.log}</string>
</dict>
</plist>
`;
  }

  startAndInstalledChecks(service);

  test("start writes the launchd agent and loads it", async () => {
    const { env, files, cli, calls } = await service();
    const result = await cli("start");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(files.unit, "utf8")).toBe(
      expectedAgent(files, {
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
      }),
    );
    expect(calls()).toEqual([
      `print ${target}`,
      `enable ${target}`,
      `bootstrap gui/${uid} ${files.unit}`,
    ]);
    expect(existsSync(dirname(files.log))).toBe(true);
  });

  test("start again unloads the old agent, then rewrites and reloads it", async () => {
    const { files, cli, calls, print, resetCalls } = await service();
    expect((await cli("start")).status).toBe(0);
    writeFileSync(files.unit, "stale");
    print(printed(`state = running\n\tpid = ${process.pid}`));
    resetCalls();
    const result = await cli("start");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(files.unit, "utf8")).toContain("<string>run</string>");
    expect(calls()).toEqual([
      `print ${target}`,
      `bootout ${target}`,
      `enable ${target}`,
      `bootstrap gui/${uid} ${files.unit}`,
    ]);
  });

  test("the agent gets T3CODE_HOME and LINEAR_T3_CONFIG when set, and never the tokens", async () => {
    const { env, files } = await service();
    const t3Home = mkdtempSync(join(tmpdir(), "linear-t3-t3home-"));
    const { status } = await startCli(
      { cwd: tmpdir(), env: { ...env, T3CODE_HOME: t3Home, LINEAR_T3_CONFIG: files.config } },
      ["start"],
    ).result;
    expect(status).toBe(0);
    expect(readFileSync(files.unit, "utf8")).toBe(
      expectedAgent(files, {
        T3CODE_HOME: t3Home,
        LINEAR_T3_CONFIG: files.config,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
      }),
    );
  });

  test("tokens from the environment stay out of the agent", async () => {
    const { env, files } = await service();
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const { status } = await startCli({ cwd: tmpdir(), env: { ...env, ...tokens } }, ["start"])
      .result;
    expect(status).toBe(0);
    const agent = readFileSync(files.unit, "utf8");
    expect(agent).not.toContain("lin-key");
    expect(agent).not.toContain("t3-tok");
  });

  test("stop unloads the agent and disables it so it doesn't start at login", async () => {
    const { cli, calls } = await installed();
    const result = await cli("stop");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([`print ${target}`, `bootout ${target}`, `disable ${target}`]);
  });

  test("stop when already stopped only disables the agent", async () => {
    const { cli, calls } = await installed("unloaded");
    expect((await cli("stop")).status).toBe(0);
    expect(calls()).toEqual([`print ${target}`, `disable ${target}`]);
  });

  test("restart kills and restarts a loaded agent", async () => {
    const { cli, calls } = await installed();
    expect(await cli("restart")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([`print ${target}`, `kickstart -k ${target}`]);
  });

  test("restart after stop enables and loads the agent again", async () => {
    const { files, cli, calls } = await installed("unloaded");
    expect(await cli("restart")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([
      `print ${target}`,
      `enable ${target}`,
      `bootstrap gui/${uid} ${files.unit}`,
    ]);
  });

  test("uninstall unloads and removes the agent but keeps Config, Credentials, State and log", async () => {
    const { files, cli, calls } = await installed();
    writeFile(files.state, "{}");
    writeFile(files.log, "old output\n");
    const result = await cli("uninstall");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([`print ${target}`, `bootout ${target}`]);
    expect(existsSync(files.unit)).toBe(false);
    for (const kept of [files.config, files.credentials, files.state, files.log]) {
      expect(existsSync(kept)).toBe(true);
    }
  });

  /** The lines `status` prints for where everything lives. */
  const whereLines = (files: Record<string, string>) => [
    `Config:      ${files.config}`,
    `Credentials: ${files.credentials}`,
    `State:       ${files.state}`,
    `Log:         ${files.log}`,
    `Unit:        ${files.unit}`,
  ];

  test("status shows a running Daemon's pid and uptime, and where everything lives", async () => {
    const { files, cli } = await installed("running");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^Daemon:      running \\(pid ${process.pid}, up [\\d:-]+\\)$`),
    );
    expect(lines.slice(1)).toEqual(whereLines(files));
  });

  test.each(["stopped", "unloaded"] as const)(
    "status shows an agent that is %s as stopped",
    async (state) => {
      const { files, cli } = await installed(state);
      const result = await cli("status");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout.trimEnd().split("\n")).toEqual([
        "Daemon:      stopped",
        ...whereLines(files),
      ]);
    },
  );

  test("status without the service says it isn't installed", async () => {
    const { files, cli, calls } = await service();
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "Daemon:      not installed, run `linear-t3 start`",
      ...whereLines(files),
    ]);
    expect(calls()).toEqual([]);
  });

  test("status shows the State path the Config sets", async () => {
    const { files, cli } = await installed("running");
    const config = JSON.parse(readFileSync(files.config, "utf8"));
    writeFile(files.config, JSON.stringify({ ...config, stateFile: "data/state.json" }));
    const result = await cli("status");
    expect(result.stdout).toContain(
      `State:       ${join(dirname(files.config), "data", "state.json")}\n`,
    );
  });

  test("status warns when the node binary the agent runs no longer exists", async () => {
    const { files, cli } = await installed("unloaded");
    const gone = join(tmpdir(), "linear-t3-gone", "node");
    writeFileSync(
      files.unit,
      readFileSync(files.unit, "utf8").replace(
        `<string>${process.execPath}</string>`,
        `<string>${gone}</string>`,
      ),
    );
    const result = await cli("status");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `The Daemon runs ${gone}, which no longer exists; run \`linear-t3 start\` again to use this node`,
    );
  });

  test("logs prints the log file", async () => {
    const { files, cli } = await installed();
    writeFile(files.log, "first\nsecond\n");
    expect(await cli("logs")).toEqual({ status: 0, stdout: "first\nsecond\n", stderr: "" });
  });

  test("logs before the Daemon wrote anything says where the log will be", async () => {
    const { files, cli } = await installed();
    const result = await cli("logs");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(`No logs yet at ${files.log}`);
  });

  test("logs -f keeps printing what the Daemon writes", async () => {
    const { env, files } = await installed();
    writeFile(files.log, "before\n");
    const cli = startCli({ cwd: tmpdir(), env }, ["logs", "-f"]);
    let seen = "";
    await new Promise<void>((resolve) =>
      cli.child.stdout!.on("data", (data: Buffer) => {
        seen += data.toString();
        if (seen === "before\n") appendFileSync(files.log, "after\n");
        if (seen.includes("after\n")) resolve();
      }),
    );
    cli.child.kill("SIGINT");
    expect((await cli.result).stdout).toBe("before\nafter\n");
  });
});

// systemd only exists on Linux; CI runs this suite on an Ubuntu runner.
describe.runIf(process.platform === "linux")("cli background service on Linux", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  const uid = process.getuid!();

  /**
   * A fresh home with a valid Config and Credentials, fake T3 and Linear servers that accept only
   * those tokens, and stand-in `systemctl`, `journalctl` and `loginctl` on `PATH` that record each
   * call. `systemctl show` prints `shown` once it is set, else what systemd shows for a unit that
   * isn't running. `journalctl` prints `journal line` and, with `-f`, waits to be stopped. `loginctl`
   * says whether lingering is on.
   */
  async function service() {
    const linear = await fakeLinear([], { apiKey: "lin-key" });
    const t3 = await fakeT3({ projects: [], token: "t3-tok" });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = {
      ...locations(home),
      unit: join(home.XDG_CONFIG_HOME, "systemd", "user", "linear-t3.service"),
    };
    writeFile(
      files.config,
      JSON.stringify({
        projects: { "my-app": { linear: { team: "ENG" } } },
        t3: { url: t3.url },
      }),
    );
    writeFile(files.credentials, "LINEAR_API_KEY=lin-key\nT3_TOKEN=t3-tok\n");
    const bin = mkdtempSync(join(tmpdir(), "linear-t3-bin-"));
    const calls = join(bin, "calls");
    const shown = join(bin, "shown");
    const linger = join(bin, "linger");
    const stub = (name: string, ...body: string[]) =>
      writeFileSync(
        join(bin, name),
        ["#!/bin/sh", `echo "${name} $*" >> "${calls}"`, ...body].join("\n"),
        { mode: 0o755 },
      );
    stub(
      "systemctl",
      'if [ "$2" = show ]; then',
      `  if [ -f "${shown}" ]; then cat "${shown}"; exit 0; fi`,
      '  printf "MainPID=0\\nActiveState=inactive\\nSubState=dead\\n"',
      "fi",
    );
    stub(
      "journalctl",
      // Set the trap before printing anything, so a stop that comes right after is never missed.
      "trap 'exit 0' TERM",
      'echo "journal line"',
      'for arg in "$@"; do if [ "$arg" = -f ]; then while :; do sleep 0.1; done; fi; done',
    );
    stub("loginctl", `if [ -f "${linger}" ]; then echo yes; else echo no; fi`);
    const env = { ...home, LINEAR_API_URL: linear.url, PATH: `${bin}:${process.env.PATH}` };
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-cwd-"));
    return {
      env,
      files,
      cli: (...args: string[]) => startCli({ cwd: dir, env }, args).result,
      calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
      show: (output: string) => writeFileSync(shown, output),
      enableLinger: () => writeFileSync(linger, ""),
      resetCalls: () => writeFileSync(calls, ""),
    };
  }

  /** The unit `start` should write for `files`, with `env` as its environment. */
  function expectedUnit(files: { config: string }, env: Record<string, string>) {
    const variables = Object.entries(env)
      .map(([key, value]) => `Environment="${key}=${value}"\n`)
      .join("");
    return `[Unit]
Description=linear-t3 Daemon

[Service]
ExecStart="${process.execPath}" "${cliPath}" "run" "--config" "${files.config}"
${variables}Restart=on-failure
RestartSec=10
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  }

  test("start writes the systemd user unit, reloads systemd, then enables and starts it", async () => {
    const { env, files, cli, calls } = await service();
    const result = await cli("start");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(`Started the Daemon (systemd user unit ${files.unit})`);
    expect(readFileSync(files.unit, "utf8")).toBe(
      expectedUnit(files, {
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
      }),
    );
    expect(calls()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable linear-t3.service",
      "systemctl --user restart linear-t3.service",
    ]);
  });

  startAndInstalledChecks(service);

  /** `service()` after a successful `start`, with systemd reporting the unit as `state`. */
  async function installed(state: "running" | "stopped" = "running") {
    const setup = await service();
    expect((await setup.cli("start")).status).toBe(0);
    if (state === "running") {
      setup.show(`MainPID=${process.pid}\nActiveState=active\nSubState=running\n`);
    }
    setup.resetCalls();
    return setup;
  }

  test("start again rewrites the unit, reloads systemd and restarts the Daemon", async () => {
    const { files, cli, calls, resetCalls } = await installed();
    writeFileSync(files.unit, "stale");
    resetCalls();
    const result = await cli("start");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(files.unit, "utf8")).toContain('"run" "--config"');
    expect(calls()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable linear-t3.service",
      "systemctl --user restart linear-t3.service",
    ]);
  });

  test("the unit gets T3CODE_HOME and LINEAR_T3_CONFIG when set, and never the tokens", async () => {
    const { env, files } = await service();
    const t3Home = mkdtempSync(join(tmpdir(), "linear-t3-t3home-"));
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const { status } = await startCli(
      {
        cwd: tmpdir(),
        env: { ...env, ...tokens, T3CODE_HOME: t3Home, LINEAR_T3_CONFIG: files.config },
      },
      ["start"],
    ).result;
    expect(status).toBe(0);
    const unit = readFileSync(files.unit, "utf8");
    expect(unit).toBe(
      expectedUnit(files, {
        T3CODE_HOME: t3Home,
        LINEAR_T3_CONFIG: files.config,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
      }),
    );
    expect(unit).not.toContain("lin-key");
    expect(unit).not.toContain("t3-tok");
  });

  test("without XDG variables the unit goes in ~/.config and gets no environment", async () => {
    const { env, files } = await service();
    const home = { HOME: env.HOME, LINEAR_API_URL: env.LINEAR_API_URL, PATH: env.PATH };
    const config = join(env.HOME, ".config", "linear-t3", "config.json");
    writeFile(config, readFileSync(files.config, "utf8"));
    writeFile(
      join(env.HOME, ".config", "linear-t3", "credentials"),
      readFileSync(files.credentials, "utf8"),
    );
    const { status } = await startCli({ cwd: tmpdir(), env: home }, ["start"]).result;
    expect(status).toBe(0);
    expect(
      readFileSync(join(env.HOME, ".config", "systemd", "user", "linear-t3.service"), "utf8"),
    ).toBe(expectedUnit({ config }, {}));
  });

  test("the unit escapes paths so systemd reads them back as written", async () => {
    const { env, files } = await service();
    // A Config path with a space, a quote, a backslash and the characters systemd would otherwise
    // expand.
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-odd-"));
    const config = join(dir, 'my "100%" $HOME\\x', "c.json");
    writeFile(config, readFileSync(files.config, "utf8"));
    const { status } = await startCli({ cwd: tmpdir(), env }, ["--config", config, "start"]).result;
    expect(status).toBe(0);
    expect(readFileSync(files.unit, "utf8")).toContain(
      `"--config" "${dir}/my \\"100%%\\" $$HOME\\\\x/c.json"\n`,
    );
  });

  test("stop stops the Daemon and disables it so it doesn't start at login", async () => {
    const { cli, calls } = await installed();
    expect(await cli("stop")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual(["systemctl --user disable --now linear-t3.service"]);
  });

  test("restart enables the unit again and restarts the Daemon", async () => {
    const { cli, calls } = await installed("stopped");
    expect(await cli("restart")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([
      "systemctl --user enable linear-t3.service",
      "systemctl --user restart linear-t3.service",
    ]);
  });

  test("uninstall stops, disables and removes the unit, reloads systemd, and keeps the user's files", async () => {
    const { files, cli, calls } = await installed();
    writeFile(files.state, "{}");
    const result = await cli("uninstall");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([
      "systemctl --user disable --now linear-t3.service",
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(files.unit)).toBe(false);
    for (const kept of [files.config, files.credentials, files.state]) {
      expect(existsSync(kept)).toBe(true);
    }
  });

  test("a failing systemctl is reported with its output", async () => {
    const { env, files, cli } = await service();
    writeFileSync(
      join(env.PATH.split(":")[0]!, "systemctl"),
      '#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const result = await cli("start");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "`systemctl --user daemon-reload` failed: Failed to connect to bus: No medium found",
    );
    expect(existsSync(files.unit)).toBe(true);
  });

  const lingerHint =
    "The Daemon only runs while you're logged in. To keep it running after you log out, run `loginctl enable-linger`";

  /** The lines `status` prints for where everything lives. */
  const whereLines = (files: Record<string, string>) => [
    `Config:      ${files.config}`,
    `Credentials: ${files.credentials}`,
    `State:       ${files.state}`,
    "Log:         journalctl --user -u linear-t3",
    `Unit:        ${files.unit}`,
  ];

  test("status shows a running Daemon's pid and uptime, where everything lives, and the linger hint", async () => {
    const { files, cli, calls } = await installed("running");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^Daemon:      running \\(pid ${process.pid}, up [\\d:-]+\\)$`),
    );
    expect(lines.slice(1)).toEqual([...whereLines(files), "", lingerHint]);
    expect(calls()).toEqual([
      "systemctl --user show linear-t3.service --property=ActiveState,SubState,MainPID",
      `loginctl show-user ${uid} --property=Linger --value`,
    ]);
  });

  test("status shows a stopped Daemon as stopped", async () => {
    const { files, cli } = await installed("stopped");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "Daemon:      stopped",
      ...whereLines(files),
      "",
      lingerHint,
    ]);
  });

  test("status leaves out the linger hint when lingering is on, and never turns it on", async () => {
    const { files, cli, calls, enableLinger } = await installed("running");
    enableLinger();
    const result = await cli("status");
    expect(result.stdout.trimEnd().split("\n").slice(1)).toEqual(whereLines(files));
    expect(calls().filter((call) => call.startsWith("loginctl"))).toEqual([
      `loginctl show-user ${uid} --property=Linger --value`,
    ]);
  });

  test("status without the service says it isn't installed", async () => {
    const { files, cli, calls } = await service();
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "Daemon:      not installed, run `linear-t3 start`",
      ...whereLines(files),
    ]);
    expect(calls()).toEqual([]);
  });

  test("status warns when the node binary the unit runs no longer exists", async () => {
    const { files, cli } = await installed("stopped");
    const gone = join(tmpdir(), "linear-t3-gone", "node");
    writeFileSync(
      files.unit,
      readFileSync(files.unit, "utf8").replace(`"${process.execPath}"`, `"${gone}"`),
    );
    const result = await cli("status");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `The Daemon runs ${gone}, which no longer exists; run \`linear-t3 start\` again to use this node`,
    );
  });

  test("logs shows the Daemon's journal", async () => {
    const { cli, calls } = await installed();
    expect(await cli("logs")).toEqual({ status: 0, stdout: "journal line\n", stderr: "" });
    expect(calls()).toEqual(["journalctl --user -u linear-t3 -n 100 --no-pager"]);
  });

  test("logs -f follows the journal until interrupted", async () => {
    const { env, calls } = await installed();
    const cli = startCli({ cwd: tmpdir(), env }, ["logs", "-f"]);
    await new Promise<void>((resolve) => cli.child.stdout!.once("data", () => resolve()));
    cli.child.kill("SIGINT");
    expect(await cli.result).toMatchObject({ status: 0, stdout: "journal line\n" });
    expect(calls()).toEqual(["journalctl --user -u linear-t3 -n 100 --no-pager -f"]);
  });
});
