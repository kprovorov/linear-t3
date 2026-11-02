import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  type FakeProvider,
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

const LOCAL = "linear-t3.config.json";

/**
 * A temporary Git repository whose Local Config watches Linear team `ENG` for T3 project `my-app`,
 * with `local` merged in. `undefined` values drop a key.
 */
function repoDir(local: Record<string, unknown> = {}) {
  // The real path: on macOS the temp dir is a symlink, and the CLI sees its working directory resolved.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "linear-t3-repo-")));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, LOCAL), JSON.stringify({ project: "my-app", team: "ENG", ...local }));
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

  test("run --help lists --once, --dry-run and --config for the Local Config", () => {
    const result = runCli("run", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: linear-t3 run /);
    expect(result.stdout).toMatch(/^\s+--once\b/m);
    expect(result.stdout).toMatch(/^\s+--dry-run\b/m);
    expect(result.stdout).toMatch(/^\s+--config <path>\s+the Local Config/m);
  });

  test("run --help lists a flag for every non-global key, with its default and scope", () => {
    const result = runCli("run", "--help");
    expect(result.status).toBe(0);
    const help = result.stdout.replace(/\s+/g, " ");
    const flags: [string, string, string][] = [
      ["--project <project>", "default: the T3 project whose folder is the Git root", "local"],
      ["--team <team>", "required", "local"],
      ["--filter <json>", "default: none", "local"],
      ["--set-status <status>", "default: leave the status as it is", "local"],
      ["--comment [true|false]", "default: true", "all"],
      ["--model <model>", "default: the T3 project's default model", "all"],
      ["--provider <provider>", "default: the one enabled Provider that offers `model`", "all"],
      ["--runtime-mode <mode>", "default: full-access", "all"],
      ["--workspace <local|worktree>", "default: worktree", "all"],
      ["--base-ref <ref>", "default: the repository's default branch, as T3 reports it", "all"],
      ["--start-from-origin [true|false]", "default: true", "all"],
      ["--prompt <template>", "default: a built-in template", "all"],
      ["--poll-interval <seconds>", "default: 60", "all"],
    ];
    for (const [flag, fallback, scope] of flags) {
      expect(help).toContain(flag);
      const after = help.slice(help.indexOf(flag));
      // The flag's own help ends at its first ")": the default and scope.
      expect(
        after.slice(0, after.indexOf(")") + 1).endsWith(`(${fallback}; scope: ${scope})`),
      ).toBe(true);
    }
    for (const flag of ["--max-running-threads", "--t3-url", "--state-file"]) {
      expect(help).not.toContain(flag);
    }
  });

  test.each(["--max-running-threads", "--t3-url", "--state-file"])(
    "run %s is an unknown option",
    (flag) => {
      const result = runCliIn({ cwd: repoDir() }, "run", flag, "1");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`unknown option '${flag}'`);
    },
  );

  test.each<{ args: string[]; error: string }>([
    { args: ["--filter", "{not json"], error: "--filter" },
    { args: ["--filter", "[1]"], error: "--filter" },
    { args: ["--comment", "maybe"], error: "--comment" },
    { args: ["--poll-interval", "soon"], error: "--poll-interval" },
    { args: ["--poll-interval", "5"], error: "--poll-interval" },
    { args: ["--workspace", "root"], error: "--workspace" },
  ])("run $args exits non-zero naming $error", ({ args, error }) => {
    const env = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: repoDir(), env }, "run", "--once", ...args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(error);
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
    { missing: "T3_TOKEN", env: { LINEAR_API_KEY: "lin-key" }, args: ["--dry-run"] },
  ])("$args without $missing exits non-zero naming it", ({ missing, env, args }) => {
    const result = runCliIn({ cwd: repoDir(), env }, "run", ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing ${missing}`);
    expect(result.stderr).toContain("linear-t3 connect");
  });

  test("reads the tokens from the Credentials file", () => {
    const home = homeDir();
    const { credentials } = locations(home);
    const run = () => runCliIn({ cwd: repoDir(), env: home }, "run");
    writeFile(credentials, "T3_TOKEN=t3-tok\n");
    expect(run().stderr).toContain("Missing LINEAR_API_KEY");
    writeFile(credentials, "LINEAR_API_KEY=lin-key\n");
    expect(run().stderr).toContain("Missing T3_TOKEN");
  });

  test("ignores tokens in ./.env", () => {
    const dir = repoDir();
    writeFileSync(join(dir, ".env"), "LINEAR_API_KEY=lin-key\nT3_TOKEN=t3-tok\n");
    const result = runCliIn({ cwd: dir }, "run");
    expect(result.stderr).toContain("Missing LINEAR_API_KEY");
  });

  test("a missing Local Config given with --config exits non-zero naming its path", () => {
    const dir = repoDir();
    const env = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: dir, env }, "run", "--once", "--config", "nope.json");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(dir, "nope.json"));
  });

  test.each<{
    case: string;
    env: (dirs: Record<string, string>) => Record<string, string>;
    used: string;
  }>([
    {
      case: "LINEAR_T3_CONFIG moves the Global Config",
      env: (d) => ({ LINEAR_T3_CONFIG: d.env! }),
      used: "env",
    },
    { case: "the Global Config is in the XDG location by default", env: () => ({}), used: "xdg" },
    { case: "CONFIG_PATH is ignored", env: (d) => ({ CONFIG_PATH: d.env! }), used: "xdg" },
  ])("$case", ({ env, used }) => {
    const home = homeDir();
    const base = mkdtempSync(join(tmpdir(), "linear-t3-configs-"));
    const dirs: Record<string, string> = {
      env: join(base, "env.json"),
      xdg: locations(home).config,
    };
    // Both are invalid, so the error names the one that was read.
    for (const path of Object.values(dirs)) writeFile(path, JSON.stringify({ bogus: true }));
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn(
      { cwd: repoDir(), env: { ...home, ...tokens, ...env(dirs) } },
      "run",
      "--once",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Invalid config ${dirs[used]}`);
  });

  test.each<{
    case: string;
    global?: Record<string, unknown>;
    local?: Record<string, unknown>;
    errors: (files: { global: string; local: string }) => string[];
  }>([
    {
      case: "team in the Global Config",
      global: { team: "ENG" },
      errors: (f) => [
        `Invalid config ${f.global}:`,
        "team: only goes in a Local Config (linear-t3.config.json in the repository, or --config)",
      ],
    },
    {
      case: "t3Url in a Local Config",
      local: { t3Url: "http://127.0.0.1:1" },
      errors: (f) => [
        `Invalid config ${f.local}:`,
        `t3Url: only goes in the Global Config (${f.global})`,
      ],
    },
    {
      case: "an unknown key",
      local: { bogus: 1 },
      errors: (f) => [`Invalid config ${f.local}:`, "bogus: unknown key"],
    },
    {
      case: "a renamed key",
      global: { pollIntervalSeconds: 30 },
      errors: (f) => [
        `Invalid config ${f.global}:`,
        'pollIntervalSeconds: renamed to "pollInterval"',
      ],
    },
    {
      case: "an invalid value",
      global: { pollInterval: 5 },
      errors: (f) => [`Invalid config ${f.global}:`, "pollInterval: "],
    },
    {
      case: "the old projects/defaults shape",
      global: {
        t3: { url: "http://127.0.0.1:1" },
        projects: { "my-app": { linear: { team: "ENG" } } },
      },
      errors: (f) => [
        `Invalid config ${f.global}: "projects" and "defaults" are the old Config shape`,
        "linear.onLaunch.moveToState → setStatus",
        "promptTemplate → prompt, pollIntervalSeconds → pollInterval, t3.url → t3Url",
        'workspace.type "root" → workspace "local"',
      ],
    },
    {
      case: "a Local Config in the old nested shape",
      local: { team: undefined, linear: { team: "ENG" }, workspace: { type: "root" } },
      errors: (f) => [
        `Invalid config ${f.local}:`,
        "linear: renamed to team, filter, setStatus and comment",
        "workspace: ",
        'workspace.type "root" → workspace "local"',
      ],
    },
    {
      case: "no team",
      local: { team: undefined },
      errors: (f) => [`Missing "team": pass --team or set it in the Local Config (${f.local})`],
    },
  ])(
    "$case exits non-zero with an error naming the file and the fix",
    ({ global, local, errors }) => {
      const home = homeDir();
      const files = { global: locations(home).config, local: "" };
      if (global) writeFile(files.global, JSON.stringify(global));
      const dir = repoDir(local);
      files.local = join(dir, LOCAL);
      const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
      const result = runCliIn({ cwd: dir, env: { ...home, ...tokens } }, "run", "--once");
      expect(result.status).toBe(1);
      for (const error of errors(files)) expect(result.stderr).toContain(error);
    },
  );

  test("--config naming the Global Config, as older background services do, says to run start again", () => {
    const home = homeDir();
    const { config } = locations(home);
    writeFile(config, JSON.stringify({ t3Url: "http://127.0.0.1:1" }));
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn(
      { cwd: repoDir(), env: { ...home, ...tokens } },
      "run",
      "--config",
      config,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--config ${config} is the Global Config`);
    expect(result.stderr).toContain("run `linear-t3 start` again");
  });

  test("the Local Config isn't looked for above the Git root", () => {
    const parent = mkdtempSync(join(tmpdir(), "linear-t3-parent-"));
    writeFile(join(parent, LOCAL), JSON.stringify({ project: "my-app", team: "ENG" }));
    mkdirSync(join(parent, "repo", ".git"), { recursive: true });
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: join(parent, "repo"), env: tokens }, "run", "--once");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Missing "team": pass --team or set it in the Local Config (${LOCAL} in the repository)`,
    );
  });

  test("outside Git, only the working directory is checked for a Local Config", () => {
    const parent = mkdtempSync(join(tmpdir(), "linear-t3-parent-"));
    writeFile(join(parent, LOCAL), JSON.stringify({ project: "my-app", team: "ENG" }));
    mkdirSync(join(parent, "sub"));
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const result = runCliIn({ cwd: join(parent, "sub"), env: tokens }, "run", "--once");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing "team"');
  });
});

describe("cli setup", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  test("writes a minimal Global Config a run accepts once a Local Config names the project and team", async () => {
    const home = homeDir();
    const { config } = locations(home);
    const result = runCliIn({ env: home }, "setup");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(config);
    expect(result.stdout).toContain(`Add a ${LOCAL} to your repository`);
    expect(result.stdout).toMatch(/linear-t3 connect[^]*linear-t3 start/);

    // With no matching issues, a dry run passes exactly when the Config loads and T3 answers.
    const linear = await fakeLinear([]);
    const project = { id: "project-1", title: "my-app", workspaceRoot: "/work/my-app" };
    const t3 = await fakeT3({ projects: [project] });
    cleanup.push(linear.close, t3.close);
    const starter = JSON.parse(readFileSync(config, "utf8"));
    writeFileSync(config, JSON.stringify({ ...starter, t3Url: t3.url }));
    const env = { ...home, LINEAR_API_URL: linear.url, LINEAR_API_KEY: "lin-key", T3_TOKEN: "t" };
    const dryRun = await startCli({ cwd: repoDir(), env }, ["run", "--dry-run"]).result;
    expect(dryRun).toMatchObject({ status: 0, stderr: "" });
    expect(dryRun.stdout).toContain("T3 has 0/4 running");
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

  test("LINEAR_T3_CONFIG sets where it writes, creating missing directories", () => {
    const home = homeDir();
    const path = join(home.HOME, "elsewhere", "nested", "mine.json");
    const result = runCliIn({ env: { ...home, LINEAR_T3_CONFIG: path } }, "setup");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("t3Url");
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

  test("connect t3 checks the token against t3Url from the XDG Global Config", async () => {
    const t3 = await fakeT3({ projects: [] });
    cleanup.push(t3.close);
    const home = homeDir();
    const { config, credentials } = locations(home);
    writeFile(config, JSON.stringify({ t3Url: t3.url }));
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

  /**
   * Fake servers, a fresh home whose Global Config points at them with `global` merged in, and a
   * repository to run in whose Local Config has `local` merged in.
   */
  async function servers(
    t3Options: Partial<FakeT3Options> = {},
    global: Record<string, unknown> = {},
    linearIssues: FakeIssue[] = issues,
    local: Record<string, unknown> = {},
  ) {
    const linear = await fakeLinear(linearIssues);
    const t3 = await fakeT3({ projects: [project], ...t3Options });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = locations(home);
    writeFile(
      files.config,
      JSON.stringify({
        t3Url: t3.url,
        pollInterval: 10,
        model: "claude-opus-5-5",
        provider: "claudeAgent",
        comment: false,
        ...global,
      }),
    );
    const dir = repoDir(local);
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

  test("a relative stateFile resolves against the Global Config's directory", async () => {
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

  test("polls the Local Config's team and launches into its T3 project", async () => {
    const other = { id: "project-0", title: "other", workspaceRoot: "/work/other" };
    const { linear, t3, dir, env } = await servers(
      { projects: [other, project] },
      {},
      [...issues, { id: "ops-1", identifier: "OPS-1", title: "Ops", team: "OPS" }],
      { filter: { state: { type: { eq: "unstarted" } } } },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("watching ENG -> my-app");
    expect(linear.filters).toEqual([
      { and: [{ team: { key: { eq: "ENG" } } }, { state: { type: { eq: "unstarted" } } }] },
    ]);
    expect(t3.launches.map((launch) => [launch.title, launch.projectId])).toEqual([
      ["ENG-1: First", "project-1"],
      ["ENG-2: Second", "project-1"],
    ]);
  });

  test("with only flags and no Local Config, polls the given team and launches into the given project", async () => {
    const other = { id: "project-0", title: "other", workspaceRoot: "/work/other" };
    const { linear, t3, dir, env, files } = await servers({ projects: [other, project] }, {}, [
      ...issues.map((issue) => ({ ...issue, team: "ENG" })),
      { id: "ops-1", identifier: "OPS-1", title: "Ops", team: "OPS" },
    ]);
    rmSync(join(dir, LOCAL));
    // `t3Url` is a machine setting with no flag, so the Global Config holds only that.
    writeFile(files.config, JSON.stringify({ t3Url: t3.url }));
    const result = await startCli({ cwd: dir, env }, [
      "run",
      "--once",
      "--project",
      "other",
      "--team",
      "OPS",
      "--model",
      "claude-opus-5-5",
      "--provider",
      "claudeAgent",
    ]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(linear.filters).toEqual([{ and: [{ team: { key: { eq: "OPS" } } }, {}] }]);
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]).toMatchObject({
      title: "OPS-1: Ops",
      projectId: "project-0",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
  });

  test("a flag overrides the Local and Global Config; keys without a flag still come from the files", async () => {
    const { t3, dir, env } = await servers(
      {},
      { prompt: "Global {identifier}", runtimeMode: "approval-required", baseRef: "develop" },
      [issues[0]!],
      { prompt: "Local {identifier}", startFromOrigin: true },
    );
    const result = await startCli({ cwd: dir, env }, [
      "run",
      "--once",
      "--prompt",
      "CLI {identifier}",
      "--base-ref",
      "release",
      "--start-from-origin",
      "false",
    ]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]).toMatchObject({
      initialMessage: { text: "CLI ENG-1" },
      runtimeMode: "approval-required",
      workspaceStrategy: { type: "worktree", baseRef: "release", startFromOrigin: false },
    });
  });

  test("a relative --project path resolves against the working directory", async () => {
    const projects: FakeT3Options["projects"] = [];
    const { t3, dir, env } = await servers({ projects }, {}, issues, { project: "missing" });
    const sub = join(dir, "src");
    mkdirSync(sub);
    projects.push({ id: "sub", title: "sub", workspaceRoot: sub });
    const result = await startCli({ cwd: sub, env }, ["run", "--once", "--project", "."]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.projectId)).toEqual(["sub", "sub"]);
  });

  test.each<{ args: string[]; config: "Global" | "Local"; comment: boolean; comments: number }>([
    { args: ["--comment", "false"], config: "Local", comment: true, comments: 0 },
    { args: ["--comment", "false"], config: "Global", comment: true, comments: 0 },
    { args: ["--comment"], config: "Global", comment: false, comments: 1 },
    { args: ["--comment", "true"], config: "Global", comment: false, comments: 1 },
  ])(
    "$args over comment: $comment in the $config Config leaves $comments comment(s)",
    async ({ args, config, comment, comments }) => {
      const { linear, dir, env } = await servers(
        {},
        config === "Global" ? { comment } : {},
        [issues[0]!],
        config === "Local" ? { comment } : {},
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(linear.comments).toHaveLength(comments);
    },
  );

  test("each key takes the Local value, else the Global one, else the built-in default", async () => {
    const { t3, dir, env } = await servers(
      {},
      { prompt: "Global {identifier}", runtimeMode: "approval-required", baseRef: "develop" },
      [issues[0]!],
      { prompt: "Local {identifier}" },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]).toMatchObject({
      initialMessage: { text: "Local ENG-1" },
      runtimeMode: "approval-required",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      workspaceStrategy: {
        type: "worktree",
        baseRef: "develop",
        startFromOrigin: true,
        branch: "eng-1",
      },
    });
  });

  test("built-in defaults apply when neither Config sets a key", async () => {
    const { t3, dir, env } = await servers({}, {}, [issues[0]!]);
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]).toMatchObject({
      initialMessage: {
        text: "Work on Linear issue ENG-1: First\n\nhttps://linear.app/acme/issue/ENG-1\n\n",
      },
      runtimeMode: "full-access",
      workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    });
  });

  test("workspace local launches in the project's own checkout", async () => {
    const { t3, dir, env } = await servers({}, { workspace: "local" }, [issues[0]!]);
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.workspaceStrategy).toEqual({ type: "root" });
    expect(t3.rpcs.map((rpc) => rpc.tag)).not.toContain("vcs.listRefs");
  });

  const listRefsCalls = (t3: { rpcs: { tag: string; payload: unknown }[] }) =>
    t3.rpcs.filter((rpc) => rpc.tag === "vcs.listRefs").map((rpc) => rpc.payload);

  test("without baseRef, worktrees branch from the default branch T3 reports", async () => {
    const { t3, dir, env } = await servers(
      { refPages: [[{ name: "feature" }], [{ name: "master", isDefault: true }]] },
      {},
      issues,
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "worktree", baseRef: "master", startFromOrigin: true, branch: "eng-1" },
      { type: "worktree", baseRef: "master", startFromOrigin: true, branch: "eng-2" },
    ]);
    // Asked once, before the first poll, on the project's folder, a page at a time.
    expect(listRefsCalls(t3)).toEqual([
      expect.objectContaining({ cwd: "/work/my-app" }),
      expect.objectContaining({ cwd: "/work/my-app", cursor: 1 }),
    ]);
  });

  test("an explicit baseRef is used as given, without asking T3", async () => {
    const { t3, dir, env } = await servers({ refPages: null }, {}, [issues[0]!], {
      baseRef: "release",
    });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.workspaceStrategy).toMatchObject({ baseRef: "release" });
    expect(listRefsCalls(t3)).toEqual([]);
  });

  test("no default branch fails before the first poll, asking for --base-ref", async () => {
    const { linear, t3, dir, env } = await servers({ refPages: [[{ name: "feature" }]] });
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--base-ref");
    expect(result.stderr).toContain("/work/my-app");
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test("a T3 without vcs.listRefs fails with a compatibility error, not a guess", async () => {
    const { linear, t3, dir, env } = await servers({ refPages: null });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/T3 .*vcs\.listRefs.*update T3/i);
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test("without a model, threads use the T3 project's default model, options included", async () => {
    const defaultModelSelection = {
      instanceId: "codex",
      model: "gpt-5.5",
      options: { effort: "high" },
    };
    const { t3, dir, env } = await servers(
      { projects: [{ ...project, defaultModelSelection }] },
      { model: undefined, provider: undefined },
      [issues[0]!],
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.modelSelection).toEqual(defaultModelSelection);
  });

  test("--model opus-5.5 launches with the aliased model's slug on the Provider that offers it", async () => {
    const { t3, dir, env } = await servers({}, { provider: undefined }, [issues[0]!]);
    const result = await startCli({ cwd: dir, env }, ["run", "--once", "--model", "opus-5.5"])
      .result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    // An explicit model sends no options, so T3's per-model defaults apply.
    expect(t3.launches[0]!.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  test.each(["claude-sonnet-5-5", "Claude Sonnet 5.5", "claude sonnet 5.5", "sonnet"])(
    "--model %s resolves to claude-sonnet-5-5 on claudeAgent",
    async (model) => {
      const { t3, dir, env } = await servers({}, { provider: undefined }, [issues[0]!]);
      const result = await startCli({ cwd: dir, env }, ["run", "--once", "--model", model]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]!.modelSelection).toEqual({
        instanceId: "claudeAgent",
        model: "claude-sonnet-5-5",
      });
    },
  );

  const opusOn = (instanceId: string, enabled = true): FakeProvider => ({
    instanceId,
    enabled,
    models: [{ slug: `${instanceId}-opus`, name: "Opus", aliases: ["opus-5.5"] }],
  });

  test("a disabled Provider's models are ignored", async () => {
    const { t3, dir, env } = await servers(
      { providers: [opusOn("pi", false), opusOn("claudeAgent")] },
      { provider: undefined },
      [issues[0]!],
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once", "--model", "opus-5.5"])
      .result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claudeAgent-opus",
    });
  });

  test("--provider limits matching to that Provider", async () => {
    const { t3, dir, env } = await servers(
      { providers: [opusOn("pi"), opusOn("claudeAgent")] },
      { provider: undefined },
      [issues[0]!],
    );
    const result = await startCli({ cwd: dir, env }, [
      "run",
      "--once",
      "--model",
      "opus-5.5",
      "--provider",
      "pi",
    ]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.modelSelection).toEqual({ instanceId: "pi", model: "pi-opus" });
  });

  test("a model two enabled Providers offer, with no provider, fails listing both", async () => {
    const { linear, t3, dir, env } = await servers(
      { providers: [opusOn("pi"), opusOn("claudeAgent")] },
      { provider: undefined },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once", "--model", "opus-5.5"])
      .result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pi-opus on pi");
    expect(result.stderr).toContain("claudeAgent-opus on claudeAgent");
    expect(result.stderr).toContain("--provider");
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test.each([
    { args: ["--model", "gpt-9"], searched: "claudeAgent, codex" },
    { args: ["--model", "gpt-5.5", "--provider", "claudeAgent"], searched: '"claudeAgent"' },
    { args: ["--model", "opus", "--provider", "nope"], searched: '"nope"' },
  ])(
    "$args fails before the first poll, naming the Providers searched",
    async ({ args, searched }) => {
      const { linear, t3, dir, env } = await servers({}, { provider: undefined });
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run", ...args]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`No model matches "${args[1]}"`);
      expect(result.stderr).toContain(searched);
      expect(linear.filters).toEqual([]);
      expect(t3.launches).toEqual([]);
    },
  );

  test("a T3 without server.getConfig fails with a compatibility error when a model is set", async () => {
    const { linear, t3, dir, env } = await servers({ providers: null });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/T3 .*server\.getConfig.*update T3/i);
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test("the Local Config is found from a subdirectory of the repository", async () => {
    const { t3, dir, env } = await servers();
    const sub = join(dir, "packages", "web");
    mkdirSync(sub, { recursive: true });
    const result = await startCli({ cwd: sub, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches).toHaveLength(2);
  });

  test("a relative project path resolves against the Local Config's folder", async () => {
    const projects: FakeT3Options["projects"] = [];
    const { t3, dir, env } = await servers({ projects }, {}, issues, { project: "." });
    projects.push({ id: "repo", title: "repo", workspaceRoot: dir });
    const sub = join(dir, "src");
    mkdirSync(sub);
    const result = await startCli({ cwd: sub, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.projectId)).toEqual(["repo", "repo"]);
  });

  describe("with no project set", () => {
    test("launches into the T3 project whose folder is the Git root, run from a subdirectory", async () => {
      const projects: FakeT3Options["projects"] = [project];
      const { t3, dir, env } = await servers({ projects }, {}, issues, { project: undefined });
      // T3 may report the folder with a trailing slash.
      projects.push({ id: "repo", title: "repo", workspaceRoot: `${dir}/` });
      const sub = join(dir, "src", "deep");
      mkdirSync(sub, { recursive: true });
      const result = await startCli({ cwd: sub, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("watching ENG -> repo");
      expect(t3.launches.map((launch) => launch.projectId)).toEqual(["repo", "repo"]);
    });

    test("matches a T3 project whose folder is a symlink to the Git root", async () => {
      const projects: FakeT3Options["projects"] = [];
      const { t3, dir, env } = await servers({ projects }, {}, issues, { project: undefined });
      const link = join(mkdtempSync(join(tmpdir(), "linear-t3-link-")), "repo");
      symlinkSync(dir, link);
      projects.push({ id: "repo", title: "repo", workspaceRoot: link });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches.map((launch) => launch.projectId)).toEqual(["repo", "repo"]);
    });

    test("outside Git, uses the T3 project whose folder is the working directory", async () => {
      const projects: FakeT3Options["projects"] = [];
      const { t3, dir, env } = await servers({ projects }, {}, issues, { project: undefined });
      rmSync(join(dir, ".git"), { recursive: true });
      projects.push({ id: "dir", title: "dir", workspaceRoot: dir });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches.map((launch) => launch.projectId)).toEqual(["dir", "dir"]);
    });

    test("a folder no T3 project has exits non-zero before polling Linear, naming the folder", async () => {
      const { linear, t3, dir, env } = await servers({}, {}, issues, { project: undefined });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`No T3 project has the folder ${dir}`);
      expect(result.stderr).toContain('"my-app" (/work/my-app)');
      expect(linear.filters).toEqual([]);
      expect(t3.launches).toEqual([]);
    });

    test("two T3 projects with the folder exit non-zero, asking for project", async () => {
      const projects: FakeT3Options["projects"] = [];
      const { linear, t3, dir, env } = await servers({ projects }, {}, issues, {
        project: undefined,
      });
      projects.push(
        { id: "a", title: "one", workspaceRoot: dir },
        { id: "b", title: "two", workspaceRoot: dir },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Several T3 projects have the folder ${dir}`);
      expect(result.stderr).toContain('set "project" in the Local Config to one');
      expect(linear.filters).toEqual([]);
      expect(t3.launches).toEqual([]);
    });
  });

  test("an explicit project skips inference, even inside another T3 project's repository", async () => {
    const projects: FakeT3Options["projects"] = [project];
    const { t3, dir, env } = await servers({ projects }, {}, issues, { project: "my-app" });
    projects.push({ id: "repo", title: "repo", workspaceRoot: dir });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.projectId)).toEqual(["project-1", "project-1"]);
  });

  test("an absolute project path wins over a project titled the same", async () => {
    const projects: FakeT3Options["projects"] = [
      { id: "titled", title: "/work/my-app", workspaceRoot: "/work/elsewhere" },
      { id: "rooted", title: "app", workspaceRoot: "/work/my-app" },
    ];
    const { t3, dir, env } = await servers({ projects }, {}, issues, { project: "/work/my-app" });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.projectId)).toEqual(["rooted", "rooted"]);
  });

  test("--config replaces the discovered Local Config", async () => {
    // The discovered one names a project T3 doesn't have.
    const { t3, dir, env } = await servers({}, {}, issues, { project: "missing" });
    writeFile(
      join(dir, "configs", "bugs.json"),
      JSON.stringify({ project: "my-app", team: "ENG" }),
    );
    const result = await startCli({ cwd: dir, env }, [
      "run",
      "--once",
      "--config",
      "configs/bugs.json",
    ]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches).toHaveLength(2);
  });

  test("a project T3 doesn't have fails before the first poll and exits non-zero", async () => {
    const { linear, t3, dir, env } = await servers({}, {}, issues, { project: "missing" });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No T3 project matches "missing"');
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test("--dry-run lists the matching issues, starts no threads and exits 0", async () => {
    const { linear, t3, dir, env, files } = await servers();
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("2 new issue(s): ENG-1, ENG-2");
    expect(result.stdout).toContain("ENG-1 would start");
    expect(result.stdout).toContain("ENG-2 would start");
    expect(linear.queries.some((q) => q.includes("issues"))).toBe(true);
    expect(t3.launches).toEqual([]);
    expect(existsSync(files.state)).toBe(false);
  });

  test("--dry-run leaves State and pending Linear actions alone", async () => {
    const { linear, t3, dir, env, files } = await servers();
    const launched = {
      "issue-1": {
        identifier: "ENG-1",
        threadId: "t-1",
        launchedAt: "2026-01-01T00:00:00.000Z",
        pendingActions: { comment: true },
      },
    };
    const before = JSON.stringify({ launched });
    writeFile(files.state, before);
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("1 new issue(s): ENG-2");
    expect(result.stdout).toContain("ENG-2 would start");
    expect(readFileSync(files.state, "utf8")).toBe(before);
    expect(linear.queries.some((q) => q.includes("commentCreate"))).toBe(false);
    expect(t3.launches).toEqual([]);
  });

  /** Runs `run --once` and returns the identifiers of the issues it launched, in launch order. */
  async function launchOrder(...args: Parameters<typeof servers>) {
    const { dir, env, t3 } = await servers(...args);
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    return t3.launches.map((launch) => String(launch.title).split(":")[0]);
  }

  test("launches the most urgent issue first and issues with no priority last", async () => {
    const order = await launchOrder({}, {}, [
      { id: "none", identifier: "ENG-1", title: "No priority", priority: 0 },
      { id: "medium", identifier: "ENG-2", title: "Medium", priority: 3 },
      { id: "urgent", identifier: "ENG-3", title: "Urgent", priority: 1 },
    ]);
    expect(order).toEqual(["ENG-3", "ENG-2", "ENG-1"]);
  });

  test("issues with the same priority launch oldest first", async () => {
    const order = await launchOrder({}, {}, [
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
    expect(order).toEqual(["ENG-1", "ENG-2"]);
  });

  test("launches every matching issue in one poll when no cap is set", async () => {
    const { t3, dir, env, files } = await servers({}, {}, [
      ...issues,
      { id: "issue-3", identifier: "ENG-3", title: "Third" },
      { id: "issue-4", identifier: "ENG-4", title: "Fourth" },
      { id: "issue-5", identifier: "ENG-5", title: "Fifth" },
      { id: "issue-6", identifier: "ENG-6", title: "Sixth" },
    ]);
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches).toHaveLength(6);
    expect(launchedIds(files.state)).toHaveLength(6);
  });

  test("threads start in T3's default interaction mode", async () => {
    const { t3, dir, env } = await servers();
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches.map((launch) => launch.interactionMode)).toEqual(["default", "default"]);
  });

  test("the Linear comment links the thread under t3Url", async () => {
    const { linear, t3, dir, env } = await servers({}, { comment: true });
    const t3Home = mkdtempSync(join(tmpdir(), "linear-t3-t3home-"));
    writeFile(join(t3Home, "userdata", "environment-id"), "env-1\n");
    const result = await startCli({ cwd: dir, env: { ...env, T3CODE_HOME: t3Home } }, [
      "run",
      "--once",
    ]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(linear.comments.map((c) => c.body)).toEqual(
      t3.launches.map(
        (launch) =>
          `Started a T3 Code thread for this issue: ${t3.url}/env-1/${String(launch.threadId)}`,
      ),
    );
  });

  test("without T3's environment id on this machine, the Linear comment names the thread", async () => {
    const { linear, t3, dir, env } = await servers({}, { comment: true });
    const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(linear.comments.map((c) => c.body)).toEqual(
      t3.launches.map(
        (launch) => `Started a T3 Code thread for this issue: \`${String(launch.threadId)}\``,
      ),
    );
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
      expect(result.stdout).toContain("ENG-2 waiting: T3 has 2/2 running");
      expect(result.stdout).toContain("ENG-3 waiting: T3 has 2/2 running");
    });

    test("--dry-run marks what would start and what would wait, starting nothing", async () => {
      const { t3, dir, env, files } = await servers(
        { threads: [running] },
        { maxRunningThreads: 2 },
        threeIssues,
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("T3 has 1/2 running");
      expect(result.stdout).toContain("ENG-1 would start");
      expect(result.stdout).toContain("ENG-2 would wait (global 2/2)");
      expect(result.stdout).toContain("ENG-3 would wait (global 2/2)");
      expect(t3.launches).toEqual([]);
      expect(existsSync(files.state)).toBe(false);
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
      {
        case: "mid-run but blocked on an approval",
        thread: { activityRunStatus: "running", pendingRuntimeRequest: { kind: "approval" } },
        counts: false,
      },
      {
        case: "mid-run with only an auth refresh pending",
        thread: { activityRunStatus: "running", pendingRuntimeRequest: { kind: "auth_refresh" } },
        counts: true,
      },
      {
        case: "interrupted with a running monitor",
        thread: {
          status: "interrupted",
          pendingBackgroundTasks: [{ taskId: "task-1", kind: "monitor" }],
        },
        counts: true,
      },
      {
        case: "failed with a leftover subagent",
        thread: {
          status: "failed",
          pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent" }],
        },
        counts: false,
      },
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
        if (output.includes("ENG-2 waiting")) threads.splice(0);
        // Once: a second SIGTERM landing while the CLI exits would kill it.
        if (output.includes("ENG-1: started") && !cli.child.killed) cli.child.kill("SIGTERM");
      });
      const result = await cli.result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(1);
      expect(launchedIds(files.state)).toEqual(["issue-1"]);
      expect(result.stdout).not.toContain("failed to start");
    }, 20_000);

    /** Servers where T3 creates ENG-1's thread, but the first `run --once` dies before recording it. */
    async function cutOffFirstLaunch(config: Record<string, unknown>) {
      const threads: FakeThread[] = [];
      let first: ReturnType<typeof startCli> | undefined;
      const setup = await servers(
        {
          threads,
          onLaunch: async () => {
            const dying = first;
            first = undefined;
            dying?.child.kill("SIGKILL");
            await dying?.result;
          },
        },
        config,
      );
      first = startCli({ cwd: setup.dir, env: setup.env }, ["run", "--once"]);
      await first.result;
      expect(launchedIds(setup.files.state)).toEqual([]);
      return { ...setup, threads };
    }

    test("a launch cut off at a full cap is recorded on the next run without taking a slot", async () => {
      const { t3, dir, env, files, threads } = await cutOffFirstLaunch({ maxRunningThreads: 1 });

      // That thread now fills the cap; recording it must not need room.
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launchedIds(files.state)).toEqual(["issue-1"]);
      expect(t3.launches.map((l) => l.threadId)).toEqual([threads[0]!.id, threads[0]!.id]);
      expect(result.stdout).toContain("ENG-2 waiting: T3 has 1/1 running");
    });

    test("--dry-run says a cut-off launch would only be recorded, without taking a slot", async () => {
      const { t3, dir, env } = await cutOffFirstLaunch({ maxRunningThreads: 1 });
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("ENG-1 would record its existing thread");
      expect(result.stdout).toContain("ENG-2 would wait (global 1/1)");
      expect(t3.launches).toHaveLength(1);
    });

    test.each([
      { cap: undefined, launches: 3 },
      { cap: 0, launches: 0 },
    ])("with the cap at $cap, starts $launches of 3", async ({ cap, launches }) => {
      const { t3, dir, env } = await servers(
        { threads: [running] },
        { maxRunningThreads: cap },
        threeIssues,
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(launches);
    });

    test("--dry-run reports issues as failing without a model, without taking a slot", async () => {
      const { t3, dir, env } = await servers(
        {},
        { maxRunningThreads: 1, model: undefined, provider: undefined },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("T3 has 0/1 running");
      const reason = 'No model configured and T3 project "my-app" has no default model';
      expect(result.stdout).toContain(`ENG-1 would fail: ${reason}`);
      expect(result.stdout).toContain(`ENG-2 would fail: ${reason}`);
      expect(t3.launches).toEqual([]);
    });
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
  /** The repository `start` runs in, holding the Local Config. */
  dir: string;
  files: { config: string; local: string; credentials: string; unit: string };
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
    {
      case: "no Local Config",
      breaks: (f) => rmSync(f.local!),
      fix: /Missing "team"[\s\S]*fix it, then run `linear-t3 start` again/,
    },
    {
      case: "no project, which the service can't infer",
      breaks: (f) => writeFile(f.local!, JSON.stringify({ team: "ENG" })),
      fix: /can't infer the T3 project from [\s\S]*set "project" in [\s\S]*run `linear-t3 start` again/,
    },
    {
      case: "an invalid Global Config",
      breaks: (f) => writeFile(f.config!, JSON.stringify({ team: "ENG" })),
      fix: /Invalid config[\s\S]*team: only goes in a Local Config[\s\S]*fix it, then run `linear-t3 start` again/,
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
    const { env, dir, files, calls } = await service();
    failure.breaks(files);
    const result = await startCli({ cwd: dir, env: { ...env, ...failure.env } }, ["start"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(failure.fix);
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("start with T3 down exits non-zero and installs nothing", async () => {
    const { files, cli, calls } = await service();
    writeFile(files.config, JSON.stringify({ t3Url: "http://127.0.0.1:1" }));
    const result = await cli("start");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("T3 not reachable at http://127.0.0.1:1");
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("start from the npx cache refuses and says to install globally", async () => {
    const { env, dir, files, calls } = await service();
    // Where npx puts a package it runs without installing it.
    const npxCli = join(mkdtempSync(join(tmpdir(), "linear-t3-npm-")), "_npx", "1a2b", "cli.ts");
    mkdirSync(dirname(npxCli), { recursive: true });
    symlinkSync(cliPath, npxCli);
    const result = await startCli({ cwd: dir, env, cli: npxCli }, ["start"]).result;
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
    const dir = repoDir();
    const files = {
      ...locations(home),
      log: join(home.XDG_STATE_HOME, "linear-t3", "daemon.log"),
      unit: join(home.HOME, "Library", "LaunchAgents", "linear-t3.plist"),
      local: join(dir, LOCAL),
    };
    writeFile(files.config, JSON.stringify({ t3Url: t3.url }));
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
    const recorded = () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
    return {
      env,
      dir,
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
  function expectedAgent(files: { local: string; log: string }, env: Record<string, string>) {
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
\t\t<string>${files.local}</string>
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
    const { env, dir, files } = await service();
    const t3Home = mkdtempSync(join(tmpdir(), "linear-t3-t3home-"));
    const { status } = await startCli(
      { cwd: dir, env: { ...env, T3CODE_HOME: t3Home, LINEAR_T3_CONFIG: files.config } },
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
    const { env, dir, files } = await service();
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const { status } = await startCli({ cwd: dir, env: { ...env, ...tokens } }, ["start"]).result;
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
    const dir = repoDir();
    const files = {
      ...locations(home),
      unit: join(home.XDG_CONFIG_HOME, "systemd", "user", "linear-t3.service"),
      local: join(dir, LOCAL),
    };
    writeFile(files.config, JSON.stringify({ t3Url: t3.url }));
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
    return {
      env,
      dir,
      files,
      cli: (...args: string[]) => startCli({ cwd: dir, env }, args).result,
      calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
      show: (output: string) => writeFileSync(shown, output),
      enableLinger: () => writeFileSync(linger, ""),
      resetCalls: () => writeFileSync(calls, ""),
    };
  }

  /** The unit `start` should write for `files`, with `env` as its environment. */
  function expectedUnit(files: { local: string }, env: Record<string, string>) {
    const variables = Object.entries(env)
      .map(([key, value]) => `Environment="${key}=${value}"\n`)
      .join("");
    return `[Unit]
Description=linear-t3 Daemon

[Service]
ExecStart="${process.execPath}" "${cliPath}" "run" "--config" "${files.local}"
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
    const { env, dir, files } = await service();
    const t3Home = mkdtempSync(join(tmpdir(), "linear-t3-t3home-"));
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const { status } = await startCli(
      {
        cwd: dir,
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

  test("a relative LINEAR_T3_CONFIG is pinned as an absolute path", async () => {
    const { env, files } = await service();
    const { status } = await startCli(
      { cwd: dirname(files.config), env: { ...env, LINEAR_T3_CONFIG: "config.json" } },
      ["start", "--config", files.local],
    ).result;
    expect(status).toBe(0);
    expect(readFileSync(files.unit, "utf8")).toContain(
      `Environment="LINEAR_T3_CONFIG=${files.config}"\n`,
    );
  });

  test("without XDG variables the unit goes in ~/.config and gets no environment", async () => {
    const { env, dir, files } = await service();
    const home = { HOME: env.HOME, LINEAR_API_URL: env.LINEAR_API_URL, PATH: env.PATH };
    const config = join(env.HOME, ".config", "linear-t3", "config.json");
    writeFile(config, readFileSync(files.config, "utf8"));
    writeFile(
      join(env.HOME, ".config", "linear-t3", "credentials"),
      readFileSync(files.credentials, "utf8"),
    );
    const { status } = await startCli({ cwd: dir, env: home }, ["start"]).result;
    expect(status).toBe(0);
    expect(
      readFileSync(join(env.HOME, ".config", "systemd", "user", "linear-t3.service"), "utf8"),
    ).toBe(expectedUnit(files, {}));
  });

  test("the unit escapes paths so systemd reads them back as written", async () => {
    const { env, files } = await service();
    // A Local Config path with a space, a quote, a backslash and the characters systemd would
    // otherwise expand.
    const dir = mkdtempSync(join(tmpdir(), "linear-t3-odd-"));
    const config = join(dir, 'my "100%" $HOME\\x', "c.json");
    writeFile(config, readFileSync(files.local, "utf8"));
    const { status } = await startCli({ cwd: tmpdir(), env }, ["start", "--config", config]).result;
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
