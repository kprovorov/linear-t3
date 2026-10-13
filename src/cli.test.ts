import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { dirname, join } from "node:path";
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
 * The environment of the test run without the tokens or anything that locates the CLI's files,
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
    expect(result.stdout.indexOf("linear-t3 connect")).toBeGreaterThan(-1);
    expect(result.stdout.indexOf("linear-t3 start")).toBeGreaterThan(
      result.stdout.indexOf("linear-t3 connect"),
    );

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

  test.each<{ case: string; args: (path: string) => string[]; env: (path: string) => object }>([
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
    // Lay out the files npm would publish, plus the bundle and the installed dependencies.
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
    const build = spawnSync(
      process.execPath,
      [
        join(root, "node_modules", "vite-plus", "bin", "vp"),
        "pack",
        "src/cli.ts",
        "--format",
        "esm",
        "--platform",
        "node",
        "--no-fixed-extension",
        "--out-dir",
        join(pkg, "dist"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(build.status, build.stderr).toBe(0);

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
  async function servers(t3Options: Partial<FakeT3Options> = {}, config = {}) {
    const linear = await fakeLinear(issues);
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
