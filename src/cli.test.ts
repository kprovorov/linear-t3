import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_PROVIDERS,
  FAKE_VIEWER,
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
      ["--status <status>", "default: any status", "local"],
      ["--label <label>", "default: any labels", "all"],
      ["--assignee <assignee>", "default: anyone", "local"],
      ["--priority <priority>", "default: any priority", "local"],
      ["--filter <json>", "default: none", "local"],
      ["--set-status <status|false>", "default: In Progress", "local"],
      ["--comment [true|false]", "default: true", "all"],
      ["--model <model>", "default: the T3 project's default model", "all"],
      [
        "--provider <provider>",
        "default: the one enabled Provider that offers `model`, else the T3 project's default Provider",
        "all",
      ],
      ["--runtime-mode <mode>", "default: the T3 project's default runtime mode, else T3's", "all"],
      [
        "--workspace <local|worktree>",
        "default: where the T3 project starts new threads, else where T3 does",
        "all",
      ],
      ["--base-ref <ref>", "default: the repository's default branch, as T3 reports it", "all"],
      [
        "--start-from-origin [true|false]",
        "default: the T3 project's \"new worktrees start from origin\", else T3's",
        "all",
      ],
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
    { args: ["--set-status", ""], error: "--set-status" },
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
      case: "setStatus in the Global Config",
      global: { setStatus: "In Review" },
      errors: (f) => [
        `Invalid config ${f.global}:`,
        "setStatus: only goes in a Local Config (linear-t3.config.json in the repository, or --config)",
      ],
    },
    {
      case: "status in the Global Config",
      global: { status: ["Todo"], label: ["ready-for-agent"] },
      errors: (f) => [
        `Invalid config ${f.global}:`,
        "status: only goes in a Local Config (linear-t3.config.json in the repository, or --config)",
      ],
    },
    {
      case: "assignee and priority in the Global Config",
      global: { assignee: "me", priority: "high" },
      errors: (f) => [
        `Invalid config ${f.global}:`,
        "assignee: only goes in a Local Config (linear-t3.config.json in the repository, or --config)",
        "priority: only goes in a Local Config (linear-t3.config.json in the repository, or --config)",
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
    linearOptions: Parameters<typeof fakeLinear>[1] = {},
  ) {
    const linear = await fakeLinear(linearIssues, linearOptions);
    // T3 set to start threads in worktrees, unless a test says otherwise.
    const t3 = await fakeT3({
      projects: [project],
      ...t3Options,
      settings: { defaultThreadEnvMode: "worktree", ...t3Options.settings },
    });
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

  describe("several Daemons sharing one State", () => {
    const other = { id: "project-0", title: "other", workspaceRoot: "/work/other" };

    test("two concurrent runs for different projects both keep every record they wrote", async () => {
      const { dir, env, files } = await servers(
        // Slow launches, so each run loads State before the other records anything.
        { projects: [other, project], onLaunch: () => setTimeout(300) },
        {},
        [
          ...issues.map((issue) => ({ ...issue, team: "ENG" })),
          { id: "ops-1", identifier: "OPS-1", title: "Ops one", team: "OPS" },
          { id: "ops-2", identifier: "OPS-2", title: "Ops two", team: "OPS" },
        ],
        {},
        { teams: ["ENG", "OPS"] },
      );
      const opsDir = repoDir({ project: "other", team: "OPS" });
      const results = await Promise.all([
        startCli({ cwd: dir, env }, ["run", "--once"]).result,
        startCli({ cwd: opsDir, env }, ["run", "--once"]).result,
      ]);
      for (const result of results) expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launchedIds(files.state).sort()).toEqual(["issue-1", "issue-2", "ops-1", "ops-2"]);
      expect(existsSync(`${files.state}.lock`)).toBe(false);
    });

    // Waits out the 10s minimum poll interval.
    test("a Daemon skips an issue another Daemon launched since its last poll, without commenting or moving it again", async () => {
      const queue: FakeIssue[] = [];
      const { linear, t3, dir, env } = await servers({ projects: [other, project] }, {}, queue, {
        comment: true,
        setStatus: "In Progress",
      });
      const otherDir = repoDir({ project: "other", comment: true, setStatus: "In Progress" });
      const daemon = startCli({ cwd: otherDir, env, killAfterMs: 25_000 }, ["run"]);
      const polls = async (count: number) => {
        while (linear.filters.length < count) await setTimeout(50);
      };
      // The Daemon's first poll finds nothing; then the other run launches ENG-1.
      await polls(1);
      queue.push(issues[0]!);
      const once = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(once).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(1);
      await polls(3);
      await setTimeout(1000);
      daemon.child.kill("SIGTERM");
      const result = await daemon.result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).not.toContain("new issue(s)");
      expect(t3.launches).toHaveLength(1);
      expect(linear.comments).toHaveLength(1);
      expect(linear.moves).toEqual([{ id: "issue-1", status: "In Progress" }]);
    }, 25_000);

    test("a launch that another Daemon recorded first leaves the record and Linear to that Daemon", async () => {
      const theirs = {
        identifier: "ENG-1",
        threadId: "t-theirs",
        launchedAt: "2026-01-01T00:00:00.000Z",
        projectId: other.id,
      };
      let stateFile = "";
      const { linear, t3, dir, env, files } = await servers(
        {
          projects: [other, project],
          // The other Daemon records ENG-1 while this one is launching it.
          onLaunch: async () =>
            writeFile(stateFile, JSON.stringify({ launched: { "issue-1": theirs } })),
        },
        {},
        [issues[0]!],
        { comment: true, setStatus: "In Progress" },
      );
      stateFile = files.state;
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("ENG-1: another Daemon already launched it");
      expect(t3.launches).toHaveLength(1);
      expect(linear.comments).toEqual([]);
      expect(linear.moves).toEqual([]);
      expect(JSON.parse(readFileSync(files.state, "utf8")).launched).toEqual({ "issue-1": theirs });
    });

    test("pending Linear actions belong to the project whose Daemon recorded them", async () => {
      const { linear, dir, env, files } = await servers({ projects: [other, project] }, {}, []);
      const launched = {
        "issue-1": {
          identifier: "ENG-1",
          threadId: "t-1",
          launchedAt: "2026-01-01T00:00:00.000Z",
          projectId: other.id,
          pendingActions: { comment: true },
        },
      };
      writeFile(files.state, JSON.stringify({ launched }));
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(linear.comments).toEqual([]);
      const state = JSON.parse(readFileSync(files.state, "utf8"));
      expect(state.launched["issue-1"].pendingActions).toEqual({ comment: true });
    });

    test("launches record the project they launched into", async () => {
      const { dir, env, files } = await servers();
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      const state = JSON.parse(readFileSync(files.state, "utf8"));
      expect(state.launched["issue-1"].projectId).toBe(project.id);
    });

    test("a stale lock left by a crashed Daemon doesn't block a run", async () => {
      const { dir, env, files } = await servers();
      const lock = `${files.state}.lock`;
      writeFile(lock, "12345");
      const anHourAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(lock, anHourAgo, anHourAgo);
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launchedIds(files.state)).toEqual(["issue-1", "issue-2"]);
      expect(existsSync(lock)).toBe(false);
    });

    test("a State file that can't be written stops the Daemon before it launches anything", async () => {
      const { t3, dir, env, files } = await servers({}, { stateFile: "blocker/state.json" });
      // A file where the State's directory should be.
      writeFile(join(dirname(files.config), "blocker"), "");
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("blocker");
      expect(t3.launches).toEqual([]);
    });
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

  describe("status and label", () => {
    const queue: FakeIssue[] = [
      { id: "i-1", identifier: "ENG-1", title: "Todo", status: "Todo", labels: ["a"] },
      { id: "i-2", identifier: "ENG-2", title: "Backlog", status: "Backlog", labels: ["a", "b"] },
      { id: "i-3", identifier: "ENG-3", title: "Started", status: "In Progress", labels: ["b"] },
      { id: "i-4", identifier: "ENG-4", title: "Both", status: "Todo", labels: ["B", "A", "c"] },
    ];
    const labels = ["A", "B", "c"];
    const launched = (t3: { launches: Record<string, unknown>[] }) =>
      t3.launches.map((launch) => String(launch.title).split(":")[0]).sort();

    test("--status todo --status backlog launches issues in either status, and nothing else", async () => {
      const { t3, dir, env } = await servers({}, {}, queue, {}, { labels });
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--once",
        "--status",
        "todo",
        "--status",
        "backlog",
      ]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-1", "ENG-2", "ENG-4"]);
    });

    test("--label a --label b launches only issues that carry both labels", async () => {
      const { t3, dir, env } = await servers({}, {}, queue, {}, { labels });
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--once",
        "--label",
        "a",
        "--label",
        "b",
      ]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-2", "ENG-4"]);
    });

    test("--status replaces the Local Config's status rather than adding to it", async () => {
      const { t3, dir, env } = await servers({}, {}, queue, { status: ["Todo"] }, { labels });
      const result = await startCli({ cwd: dir, env }, ["run", "--once", "--status", "Backlog"])
        .result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-2"]);
    });

    test("labels from the Global Config, the Local Config and --label add up", async () => {
      const { t3, dir, env } = await servers(
        {},
        { label: "c" },
        queue,
        { label: ["a"] },
        { labels },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once", "--label", "B"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-4"]);
    });

    test("a label set in more than one layer counts once, ignoring case", async () => {
      const { linear, t3, dir, env } = await servers(
        {},
        { label: "A" },
        queue,
        { label: ["a", "b"] },
        { labels },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once", "--label", "b"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-2", "ENG-4"]);
      expect(JSON.stringify(linear.filters[0]).match(/eqIgnoreCase/g)).toHaveLength(2);
    });

    test("a single status or label in the Local Config may be a string", async () => {
      const local = { status: "backlog", label: "b" };
      const { t3, dir, env } = await servers({}, {}, queue, local, { labels });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-2"]);
    });

    test("status and label from the Local Config, with a raw filter, launch only issues matching all", async () => {
      const { linear, t3, dir, env } = await servers(
        {},
        {},
        queue,
        {
          status: ["todo", "In Progress"],
          label: ["b"],
          filter: { state: { type: { eq: "unstarted" } } },
        },
        { labels },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-4"]);
      expect(linear.filters).toEqual([
        {
          and: [
            { team: { key: { eq: "ENG" } } },
            { state: { name: { in: ["Todo", "In Progress"] } } },
            { labels: { some: { name: { eqIgnoreCase: "B" } } } },
            { state: { type: { eq: "unstarted" } } },
          ],
        },
      ]);
    });

    test.each<{ args: string[]; error: string }>([
      {
        args: ["--status", "Todo", "--status", "Doing"],
        error:
          'Team ENG has no status named "Doing". Valid statuses: Backlog, Done, In Progress, Todo',
      },
      {
        args: ["--label", "a", "--label", "bug", "--label", "z"],
        error: 'Team ENG has no label named "bug", "z". Valid labels: A, B, c',
      },
      {
        args: ["--team", "OPS", "--status", "Todo"],
        error: 'No Linear team has the key "OPS"',
      },
      {
        args: ["--team", "OPS"],
        error: 'No Linear team has the key "OPS"',
      },
    ])(
      "$args exits non-zero before the first poll, listing the valid names",
      async ({ args, error }) => {
        const { linear, t3, dir, env } = await servers({}, {}, queue, {}, { labels });
        const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(error);
        expect(linear.filters).toEqual([]);
        expect(t3.launches).toEqual([]);
      },
    );
  });

  describe("assignee and priority", () => {
    // The fake Linear's token belongs to ada@example.com.
    const queue: FakeIssue[] = [
      { id: "i-1", identifier: "ENG-1", title: "Mine", assignee: "ada@example.com", priority: 3 },
      { id: "i-2", identifier: "ENG-2", title: "Bob's", assignee: "bob@example.com", priority: 1 },
      { id: "i-3", identifier: "ENG-3", title: "Nobody's", priority: 2 },
      { id: "i-4", identifier: "ENG-4", title: "Low", assignee: "bob@example.com", priority: 4 },
      { id: "i-5", identifier: "ENG-5", title: "No priority", priority: 0 },
    ];
    const users = [FAKE_VIEWER, { id: "user-2", email: "bob@example.com" }];
    const launched = (t3: { launches: Record<string, unknown>[] }) =>
      t3.launches.map((launch) => String(launch.title).split(":")[0]).sort();

    test.each<{ args: string[]; expected: string[] }>([
      { args: ["--assignee", "me"], expected: ["ENG-1"] },
      { args: ["--assignee", "None"], expected: ["ENG-3", "ENG-5"] },
      { args: ["--assignee", "Bob@Example.com"], expected: ["ENG-2", "ENG-4"] },
      { args: ["--assignee", "none"], expected: ["ENG-3", "ENG-5"] },
      { args: ["--priority", "high"], expected: ["ENG-2", "ENG-3"] },
      { args: ["--priority", "2"], expected: ["ENG-2", "ENG-3"] },
      { args: ["--priority", "Urgent"], expected: ["ENG-2"] },
      { args: ["--priority", "low"], expected: ["ENG-1", "ENG-2", "ENG-3", "ENG-4"] },
      { args: ["--assignee", "bob@example.com", "--priority", "medium"], expected: ["ENG-2"] },
    ])("$args launches $expected", async ({ args, expected }) => {
      const { t3, dir, env } = await servers({}, {}, queue, {}, { users });
      const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(expected);
    });

    test("assignee and priority from the Local Config, with a raw filter, are ANDed with the team", async () => {
      const local = {
        assignee: "none",
        priority: 3,
        filter: { state: { type: { eq: "unstarted" } } },
      };
      const backlog = {
        id: "i-6",
        identifier: "ENG-6",
        title: "Later",
        priority: 2,
        status: "Backlog",
      };
      const { linear, t3, dir, env } = await servers({}, {}, [...queue, backlog], local);
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(launched(t3)).toEqual(["ENG-3"]);
      expect(linear.filters).toEqual([
        {
          and: [
            { team: { key: { eq: "ENG" } } },
            { assignee: { null: true } },
            { priority: { gte: 1, lte: 3 } },
            { state: { type: { eq: "unstarted" } } },
          ],
        },
      ]);
    });

    test.each<{ args?: string[]; local?: Record<string, unknown>; error: string }>([
      { args: ["--priority", "critical"], error: "--priority" },
      { args: ["--priority", "0"], error: "--priority" },
      { args: ["--priority", "5"], error: "--priority" },
      { args: ["--assignee", "bob"], error: "--assignee" },
      { local: { priority: 5 }, error: "priority:" },
      { local: { assignee: "someone" }, error: "assignee:" },
      { local: { priority: "toString" }, error: "priority:" },
      { local: { priority: true }, error: "Use urgent, high, medium, low, or 1 to 4." },
      {
        args: ["--assignee", "carol@example.com"],
        error: 'No Linear user has the email "carol@example.com"',
      },
    ])(
      "an invalid value ($args $local) exits non-zero before the first poll",
      async ({ args = [], local = {}, error }) => {
        const { linear, t3, dir, env } = await servers({}, {}, queue, local, { users });
        const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(error);
        expect(linear.filters).toEqual([]);
        expect(t3.launches).toEqual([]);
      },
    );
  });

  describe("setStatus", () => {
    const statuses = [
      { name: "Todo", type: "unstarted" },
      { name: "In Progress", type: "started" },
      { name: "In Review", type: "started" },
    ] as const;

    test("with no setStatus, launched issues move to the team's In Progress status", async () => {
      const { linear, dir, env, files } = await servers();
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(linear.moves).toEqual([
        { id: "issue-1", status: "In Progress" },
        { id: "issue-2", status: "In Progress" },
      ]);
      const { launched } = JSON.parse(readFileSync(files.state, "utf8"));
      expect(launched["issue-1"].pendingActions ?? {}).toEqual({});
    });

    test.each([["in review"], ["IN REVIEW"]])(
      "--set-status %s moves launched issues to the matching status",
      async (name) => {
        const { linear, dir, env } = await servers({}, {}, issues, {}, { statuses: [...statuses] });
        const result = await startCli({ cwd: dir, env }, ["run", "--once", "--set-status", name])
          .result;
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(linear.moves).toEqual([
          { id: "issue-1", status: "In Review" },
          { id: "issue-2", status: "In Review" },
        ]);
      },
    );

    test("setStatus in the Local Config moves launched issues to that status", async () => {
      const local = { setStatus: "In Review" };
      const { linear, dir, env } = await servers({}, {}, issues, local, {
        statuses: [...statuses],
      });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(linear.moves.map((move) => move.status)).toEqual(["In Review", "In Review"]);
    });

    test.each<{ case: string; args: string[]; local: Record<string, unknown> }>([
      { case: "--set-status false", args: ["--set-status", "false"], local: {} },
      { case: "setStatus false in the Local Config", args: [], local: { setStatus: false } },
      {
        case: "--set-status false over the Local Config's setStatus",
        args: ["--set-status", "false"],
        local: { setStatus: "In Review" },
      },
    ])("$case leaves the issues' status alone", async ({ args, local }) => {
      const { linear, t3, dir, env, files } = await servers({}, {}, issues, local);
      const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches).toHaveLength(2);
      expect(linear.moves).toEqual([]);
      expect(linear.queries.some((q) => q.includes("workflowStates"))).toBe(false);
      expect(launchedIds(files.state)).toEqual(["issue-1", "issue-2"]);
    });

    test.each<{ case: string; args: string[]; error: string }>([
      {
        case: "a team with no In Progress and no setStatus",
        args: [],
        error:
          'Team ENG has no status named "In Progress". Valid statuses: Done, Todo. Pick the status to move launched issues to with --set-status <name>, or leave it alone with --set-status false',
      },
      {
        case: "an unknown --set-status",
        args: ["--set-status", "Review"],
        error: 'Team ENG has no status named "Review". Valid statuses: Done, Todo. Pick the status',
      },
    ])(
      "$case exits non-zero before the first poll, with the suggestion",
      async ({ args, error }) => {
        const noInProgress = [
          { name: "Todo", type: "unstarted" },
          { name: "Done", type: "completed" },
        ] as const;
        const { linear, t3, dir, env } = await servers(
          {},
          {},
          issues,
          {},
          {
            statuses: [...noInProgress],
          },
        );
        const result = await startCli({ cwd: dir, env }, ["run", "--once", ...args]).result;
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
        expect(linear.filters).toEqual([]);
        expect(t3.launches).toEqual([]);
      },
    );

    test("a failed status move is recorded in State and retried on the next poll", async () => {
      const { linear, dir, env, files } = await servers();
      const launched = {
        "issue-1": {
          identifier: "ENG-1",
          threadId: "t-1",
          launchedAt: "2026-01-01T00:00:00.000Z",
          pendingActions: { moveToState: "in progress" },
        },
      };
      writeFile(files.state, JSON.stringify({ launched }));
      const result = await startCli({ cwd: dir, env }, ["run", "--once", "--set-status", "false"])
        .result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(linear.moves).toEqual([{ id: "issue-1", status: "In Progress" }]);
      const state = JSON.parse(readFileSync(files.state, "utf8"));
      expect(state.launched["issue-1"].pendingActions ?? {}).toEqual({});
    });
  });

  test("with only flags and no Local Config, polls the given team and launches into the given project", async () => {
    const other = { id: "project-0", title: "other", workspaceRoot: "/work/other" };
    const { linear, t3, dir, env, files } = await servers(
      { projects: [other, project] },
      {},
      [
        ...issues.map((issue) => ({ ...issue, team: "ENG" })),
        { id: "ops-1", identifier: "OPS-1", title: "Ops", team: "OPS" },
      ],
      {},
      { teams: ["ENG", "OPS"] },
    );
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

  test("each key takes the Local value, else the Global one, else the default", async () => {
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

  test("T3's and built-in defaults apply when neither Config sets a key", async () => {
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

  describe("runtimeMode, workspace and startFromOrigin default to T3's settings", () => {
    // T3's global settings, all different from T3's own defaults.
    const global = {
      defaultRuntimeMode: "approval-required",
      defaultThreadEnvMode: "worktree" as const,
      newWorktreesStartFromOrigin: false,
    };

    test("the T3 project's own settings win over T3's global ones", async () => {
      const { t3, dir, env } = await servers(
        {
          settings: {
            ...global,
            projectSettingsOverrides: {
              "project-1": { defaultRuntimeMode: "auto", defaultThreadEnvMode: "local" },
              other: { defaultRuntimeMode: "auto-accept-edits" },
            },
          },
        },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]).toMatchObject({
        runtimeMode: "auto",
        workspaceStrategy: { type: "root" },
      });
    });

    test("with no project override, T3's global settings apply", async () => {
      const { t3, dir, env } = await servers(
        {
          settings: {
            ...global,
            projectSettingsOverrides: { other: { defaultRuntimeMode: "auto" } },
          },
        },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]).toMatchObject({
        runtimeMode: "approval-required",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
      });
    });

    test("a project override of startFromOrigin wins over the global one", async () => {
      const { t3, dir, env } = await servers(
        {
          settings: {
            ...global,
            projectSettingsOverrides: { "project-1": { newWorktreesStartFromOrigin: true } },
          },
        },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]!.workspaceStrategy).toMatchObject({ startFromOrigin: true });
    });

    test("flags win over T3's settings", async () => {
      const { t3, dir, env } = await servers(
        {
          settings: {
            projectSettingsOverrides: {
              "project-1": {
                defaultRuntimeMode: "auto",
                defaultThreadEnvMode: "local",
                newWorktreesStartFromOrigin: true,
              },
            },
          },
        },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--once",
        "--runtime-mode",
        "full-access",
        "--workspace",
        "worktree",
        "--start-from-origin",
        "false",
      ]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]).toMatchObject({
        runtimeMode: "full-access",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
      });
    });

    test("with no env mode set in T3, the repository's t3.json picks it, as in T3", async () => {
      // Read through T3, as the project's folder may be on another machine.
      const { t3, dir, env } = await servers(
        {
          files: { "/work/my-app/t3.json": JSON.stringify({ defaultThreadEnvMode: "worktree" }) },
          settings: { defaultThreadEnvMode: undefined },
        },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]!.workspaceStrategy).toMatchObject({ type: "worktree" });
    });

    test("with no env mode set in T3 or t3.json, threads start in the project's checkout, as in T3", async () => {
      const { t3, dir, env } = await servers(
        { settings: { defaultThreadEnvMode: undefined } },
        {},
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]).toMatchObject({
        runtimeMode: "full-access",
        workspaceStrategy: { type: "root" },
      });
    });

    test("--dry-run shows each resolved value and where it came from", async () => {
      const { dir, env } = await servers(
        {
          settings: {
            ...global,
            projectSettingsOverrides: { "project-1": { defaultThreadEnvMode: "local" } },
          },
        },
        {},
        [issues[0]!],
        { startFromOrigin: true },
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("runtimeMode: approval-required (T3's global setting)");
      expect(result.stdout).toContain('workspace: local (T3 project "my-app" setting)');
      expect(result.stdout).toContain(`startFromOrigin: true (${join(dir, LOCAL)})`);
    });

    test("workspace local runs without startFromOrigin, which only worktrees use", async () => {
      const { dir, env } = await servers(
        { settings: { newWorktreesStartFromOrigin: undefined } },
        { workspace: "local", runtimeMode: "auto" },
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("startFromOrigin: unused with workspace local");
    });

    test("--dry-run names the flag a value came from", async () => {
      const { dir, env } = await servers({}, {}, [issues[0]!]);
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--dry-run",
        "--runtime-mode",
        "auto",
      ]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("runtimeMode: auto (--runtime-mode)");
    });

    test("a T3 without server.getConfig fails with a compatibility error when a key falls to T3", async () => {
      const { linear, t3, dir, env } = await servers({ providers: null }, { model: undefined });
      const result = await startCli({ cwd: dir, env }, ["run", "--once"]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/T3 .*server\.getConfig.*update T3/i);
      expect(linear.filters).toEqual([]);
      expect(t3.launches).toEqual([]);
    });
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

  const opusOn = (instanceId: string, enabled = true, displayName?: string): FakeProvider => ({
    instanceId,
    displayName,
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

  const onProvider = (instanceId: string) => ({
    ...project,
    defaultModelSelection: { instanceId, model: "whatever" },
  });

  test("a model several Providers offer runs on the Provider of the T3 project's default model", async () => {
    const { t3, dir, env } = await servers(
      { providers: [opusOn("pi"), opusOn("claudeAgent")], projects: [onProvider("claudeAgent")] },
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

  test("a T3 project default on a Provider that doesn't offer the model breaks no tie", async () => {
    const { linear, t3, dir, env } = await servers(
      {
        providers: [opusOn("pi"), opusOn("claudeAgent"), ...DEFAULT_PROVIDERS.slice(1)],
        projects: [onProvider("codex")],
      },
      { provider: undefined },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once", "--model", "opus-5.5"])
      .result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pi-opus on pi");
    expect(result.stderr).toContain("claudeAgent-opus on claudeAgent");
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test.each(["pi", "PI", "Pi", "pi-agent"])(
    "--provider %s selects Pi by display name or instance id",
    async (provider) => {
      const { t3, dir, env } = await servers(
        { providers: [opusOn("pi-agent", true, "Pi"), opusOn("claudeAgent", true, "Claude")] },
        { provider: undefined },
        [issues[0]!],
      );
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--once",
        "--model",
        "opus-5.5",
        "--provider",
        provider,
      ]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(t3.launches[0]!.modelSelection).toEqual({
        instanceId: "pi-agent",
        model: "pi-agent-opus",
      });
    },
  );

  test("--provider by display name, with no model, matches the T3 project's default", async () => {
    const defaultModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    const { t3, dir, env } = await servers(
      { projects: [{ ...project, defaultModelSelection }] },
      { provider: undefined, model: undefined },
      [issues[0]!],
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--once", "--provider", "claude"])
      .result;
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(t3.launches[0]!.modelSelection).toEqual(defaultModelSelection);
  });

  test.each([{ args: ["--model", "opus"] }, { args: [] }])(
    "an unknown provider with $args fails listing the enabled Providers",
    async ({ args }) => {
      const { linear, t3, dir, env } = await servers(
        {
          providers: [...DEFAULT_PROVIDERS, { ...opusOn("pi", false), displayName: "Pi" }],
          projects: [onProvider("claudeAgent")],
        },
        { provider: undefined, model: undefined },
      );
      const result = await startCli({ cwd: dir, env }, [
        "run",
        "--dry-run",
        "--provider",
        "nope",
        ...args,
      ]).result;
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('"nope"');
      expect(result.stderr).toContain("Claude (claudeAgent), Codex (codex)");
      expect(result.stderr).not.toContain("Pi");
      expect(linear.filters).toEqual([]);
      expect(t3.launches).toEqual([]);
    },
  );

  test("a display name two enabled Providers share fails listing both", async () => {
    const { linear, t3, dir, env } = await servers(
      { providers: [opusOn("claudeAgent", true, "Claude"), opusOn("claudeWork", true, "Claude")] },
      { provider: undefined },
    );
    const result = await startCli({ cwd: dir, env }, [
      "run",
      "--dry-run",
      "--model",
      "opus-5.5",
      "--provider",
      "claude",
    ]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Claude (claudeAgent), Claude (claudeWork)");
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test("a disabled Provider named by provider fails saying it is disabled", async () => {
    const { dir, env } = await servers(
      { providers: [...DEFAULT_PROVIDERS, opusOn("pi", false, "Pi")] },
      { provider: undefined },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run", "--provider", "pi"])
      .result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("disabled");
  });

  test("--provider with no model, off the T3 project's default Provider, fails before the first poll", async () => {
    const { linear, t3, dir, env } = await servers(
      { projects: [onProvider("claudeAgent")] },
      { provider: undefined, model: undefined },
    );
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run", "--provider", "Codex"])
      .result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('defaults to "whatever" on "claudeAgent"');
    expect(linear.filters).toEqual([]);
    expect(t3.launches).toEqual([]);
  });

  test.each([
    { args: ["--model", "gpt-9"], searched: "claudeAgent, codex" },
    { args: ["--model", "gpt-5.5", "--provider", "claudeAgent"], searched: '"claudeAgent"' },
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
  files: { config: string; local: string; credentials: string; state: string; unit: string };
  cli: (...args: string[]) => ReturnType<typeof startCli>["result"];
  /** Every call the stand-in service manager got. */
  calls: () => string[];
  /** What the installed unit runs: its arguments and environment, read back from the unit file. */
  pinned: () => { args: string[]; env: Record<string, string> };
  /** Fake T3's projects; the repository's is `project-1`, titled `my-app`. */
  projects: FakeT3Options["projects"];
  /** The Linear filters the fake Linear got. */
  linearFilters: () => unknown[];
  /** Says the service is running, so commands that act on a running service can be checked. */
  markRunning: () => void;
  /** Says the service is running as the process that asks, as when the Daemon is the one asking. */
  markRunningAsCaller: () => void;
  /** Says T3 project `project`'s Daemon is running or stopped, whatever `markRunning` said. */
  markDaemon: (project: string, running: boolean) => void;
  resetCalls: () => void;
  /** The unit file of T3 project `project`'s Daemon. */
  unitOf: (project: string) => string;
  /** How service manager calls name T3 project `project`'s Daemon. */
  unitName: (project: string) => string;
  /** The unit file of the single background service from before per-project Daemons. */
  legacyUnit: string;
  /**
   * Turns the unit `start` installed for `project-1` into the old single service's, as the
   * previous release wrote it; unpinned, as 0.2 wrote it, with no `--project`.
   */
  makeLegacy: (pinned: boolean) => void;
  /** Whether a call started T3 project `project`'s Daemon. */
  started: (project: string) => boolean;
  /** T3 project `project`'s Daemon's log file, where it writes one. */
  logOf?: (project: string) => string;
}

/** Undoes a unit file's escaping of one quoted word; ExecStart words also doubled `$`. */
const unquoteWord = (word: string, exec: boolean) =>
  (exec ? word.replace(/\$\$/g, "$") : word)
    .replace(/%%/g, "%")
    .replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char));
const quotedWords = (line: string, exec: boolean) =>
  [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => unquoteWord(match[1]!, exec));

/** The arguments and environment of a systemd unit. */
function systemdPinned(unit: string) {
  const args = quotedWords(/^ExecStart=(.*)$/m.exec(unit)![1]!, true);
  const env = Object.fromEntries(
    [...unit.matchAll(/^Environment=(.*)$/gm)].map((match) => {
      const [pair] = quotedWords(match[1]!, false);
      return [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
    }),
  );
  return { args, env };
}

/** The arguments and environment of a launchd agent. */
function launchdPinned(agent: string) {
  const unescape = (text: string) =>
    text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const strings = (xml: string) =>
    [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescape(match[1]!));
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(agent)![1]!;
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(agent)![1]!;
  const keys = [...dict.matchAll(/<key>([^<]*)<\/key>/g)].map((match) => match[1]!);
  const values = strings(dict);
  return {
    args: strings(array),
    env: Object.fromEntries(keys.map((key, i) => [key, values[i]!])),
  };
}

/** Where a launchd agent sends the Daemon's output. */
const launchdLog = (agent: string) =>
  /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(agent)![1]!;

/** Tests for what `start` checks first and for commands that need the service installed. */
function startAndInstalledChecks(service: (labels?: string[]) => Promise<ServiceSetup>) {
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
      case: "a project T3 doesn't have",
      breaks: (f) => writeFile(f.local!, JSON.stringify({ project: "nope", team: "ENG" })),
      fix: /No T3 project matches "nope"[\s\S]*fix it, then run `linear-t3 start` again/,
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

  test("start with no resolvable project exits non-zero and installs nothing", async () => {
    const { env, files, calls } = await service();
    // A repository no T3 project has, with no project set.
    const other = repoDir({ project: undefined });
    const result = await startCli({ cwd: other, env }, ["start"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /No T3 project has the folder [\s\S]*fix it, then run `linear-t3 start` again/,
    );
    expect(existsSync(files.unit)).toBe(false);
    expect(calls()).toEqual([]);
  });

  test("start in a repository pins the inferred project, the flags, the Local Config and the Global Config", async () => {
    const { files, cli, pinned } = await service();
    // No project, so it's inferred from the repository.
    writeFile(files.local, JSON.stringify({ team: "OPS" }));
    const result = await cli(
      "start",
      "--team",
      "ENG",
      "--filter",
      '{"labels":{"some":{"name":{"eq":"agent"}}}}',
      "--comment",
      "false",
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain('Pinned to T3 project "my-app" (project-1)');
    expect(pinned().args).toEqual([
      process.execPath,
      cliPath,
      "run",
      "--project=project-1",
      `--config=${files.local}`,
      "--team=ENG",
      '--filter={"labels":{"some":{"name":{"eq":"agent"}}}}',
      "--comment=false",
    ]);
    expect(pinned().env.LINEAR_T3_CONFIG).toBe(files.config);
  });

  test("without a Local Config, start pins the project and flags alone", async () => {
    const { files, cli, pinned } = await service();
    rmSync(files.local);
    const result = await cli("start", "--team", "ENG");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(pinned().args.slice(2)).toEqual([
      "run",
      "--project=project-1",
      "--no-config",
      "--team=ENG",
    ]);
  });

  test("start pins a repeated list flag as the flag repeated, which run reads back as the list", async () => {
    const setup = await service();
    rmSync(setup.files.local);
    const result = await setup.cli(
      "start",
      "--team",
      "ENG",
      "--status",
      "Todo",
      "--label",
      "ready-for-agent",
      "--label",
      "mac",
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(setup.pinned().args.slice(6)).toEqual([
      "--status=Todo",
      "--label=ready-for-agent",
      "--label=mac",
    ]);
  });

  /** Runs the installed unit's command once, from `cwd`, as the service manager would. */
  function runPinned(setup: ServiceSetup, cwd: string) {
    const { args, env } = setup.pinned();
    const base = {
      HOME: setup.env.HOME!,
      PATH: setup.env.PATH!,
      LINEAR_API_URL: setup.env.LINEAR_API_URL!,
    };
    return startCli({ cwd, env: { ...base, ...env }, cli: args[1] }, [...args.slice(2), "--once"])
      .result;
  }

  test("with no Local Config pinned, the Daemon ignores one where it runs", async () => {
    const setup = await service();
    rmSync(setup.files.local);
    expect((await setup.cli("start", "--team", "OPS")).status).toBe(0);
    const stray = repoDir({ filter: { priority: { eq: 1 } } });
    const result = await runPinned(setup, stray);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(setup.linearFilters()).toEqual([{ and: [{ team: { key: { eq: "OPS" } } }, {}] }]);
  });

  test("the Daemon requires the labels of the Global Config, the Local Config and the pinned --label", async () => {
    const setup = await service(["mac", "ready-for-agent", "ios"]);
    const { files, cli } = setup;
    const global = JSON.parse(readFileSync(files.config, "utf8")) as Record<string, unknown>;
    writeFile(files.config, JSON.stringify({ ...global, label: "mac" }));
    writeFile(files.local, JSON.stringify({ team: "OPS", label: "ready-for-agent" }));
    expect((await cli("start", "--label", "ios")).status).toBe(0);
    const result = await runPinned(setup, tmpdir());
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const filter = JSON.stringify(setup.linearFilters()[0]);
    for (const label of ["mac", "ready-for-agent", "ios"]) {
      expect(filter).toContain(`{"labels":{"some":{"name":{"eqIgnoreCase":"${label}"}}}}`);
    }
  });

  test("a multi-line flag is pinned as written", async () => {
    const { cli, pinned } = await service();
    const prompt = "Work on {identifier}\n\n{description}";
    expect((await cli("start", "--prompt", prompt)).status).toBe(0);
    expect(pinned().args.at(-1)).toBe(`--prompt=${prompt}`);
  });

  test("the installed Daemon launches into the pinned project from any working directory", async () => {
    const setup = await service();
    const { cli, linearFilters } = setup;
    expect((await cli("start", "--team", "OPS")).status).toBe(0);
    // From elsewhere, with the unit's environment and no tokens.
    const result = await runPinned(setup, tmpdir());
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("watching OPS -> my-app");
    expect(linearFilters()).toEqual([{ and: [{ team: { key: { eq: "OPS" } } }, {}] }]);
  });

  test("start again with other flags replaces what's pinned", async () => {
    const { cli, pinned } = await service();
    expect((await cli("start", "--team", "OPS", "--poll-interval", "30")).status).toBe(0);
    expect((await cli("start", "--set-status", "In Progress")).status).toBe(0);
    expect(pinned().args.slice(3)).toEqual([
      "--project=project-1",
      expect.stringMatching(/^--config=/),
      "--set-status=In Progress",
    ]);
  });

  test("--project on start is resolved to the project's id, which names the Daemon", async () => {
    const { files, cli, projects, unitOf } = await service();
    projects.push({ id: "project-2", title: "other", workspaceRoot: "/work/other" });
    expect((await cli("start", "--project", "other")).status).toBe(0);
    expect(existsSync(files.unit)).toBe(false);
    const unit = readFileSync(unitOf("project-2"), "utf8");
    expect(unit).toContain("--project=project-2");
    expect(unit).toContain(`--config=${files.local}`);
  });

  test("restart keeps what's pinned", async () => {
    const { files, cli, markRunning } = await service();
    expect((await cli("start", "--team", "OPS")).status).toBe(0);
    const before = readFileSync(files.unit, "utf8");
    markRunning();
    expect(await cli("restart")).toMatchObject({ status: 0, stderr: "" });
    expect(readFileSync(files.unit, "utf8")).toBe(before);
  });

  test("status shows the pinned project and Config files, even from elsewhere", async () => {
    const { env, files, cli } = await service();
    expect((await cli("start")).status).toBe(0);
    const result = await startCli({ cwd: tmpdir(), env }, ["status"]).result;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('\nDaemon for "my-app" (project-1)\n');
    expect(result.stdout).toContain(`Global Config: ${files.config}\n`);
    expect(result.stdout).toContain(`  Local Config:  ${files.local}\n`);
  });

  test("status says when no Local Config is pinned", async () => {
    const { files, cli } = await service();
    rmSync(files.local);
    expect((await cli("start", "--team", "ENG")).status).toBe(0);
    expect((await cli("status")).stdout).toContain("  Local Config:  none\n");
  });

  test("the unit never holds the tokens, from the environment or the Credentials", async () => {
    const { env, dir, files } = await service();
    const tokens = { LINEAR_API_KEY: "lin-key", T3_TOKEN: "t3-tok" };
    const { status } = await startCli({ cwd: dir, env: { ...env, ...tokens } }, ["start"]).result;
    expect(status).toBe(0);
    const unit = readFileSync(files.unit, "utf8");
    expect(unit).not.toContain("lin-key");
    expect(unit).not.toContain("t3-tok");
  });

  const ALREADY_RUNNING =
    /T3 project "my-app" \(project-1\) already has a background Daemon running/;

  test.each([["--once"], ["--dry-run"]])(
    "run %s warns when the project's background Daemon is running, then polls as usual",
    async (flag) => {
      const setup = await service();
      expect((await setup.cli("start")).status).toBe(0);
      setup.markRunning();
      const result = await setup.cli("run", flag);
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toMatch(ALREADY_RUNNING);
      expect(result.stdout).toContain("`linear-t3 stop --project project-1`");
      // The warning comes before the first poll.
      expect(result.stdout.search(ALREADY_RUNNING)).toBeLessThan(
        result.stdout.indexOf("watching ENG -> my-app"),
      );
      expect(setup.linearFilters()).toHaveLength(1);
    },
  );

  test("run doesn't warn when the project's Daemon is stopped", async () => {
    const setup = await service();
    expect((await setup.cli("start")).status).toBe(0);
    const result = await setup.cli("run", "--once");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).not.toMatch(ALREADY_RUNNING);
  });

  test("run doesn't warn, or ask the service manager, when the project has no Daemon", async () => {
    const setup = await service();
    const result = await setup.cli("run", "--once");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).not.toMatch(ALREADY_RUNNING);
    expect(setup.calls()).toEqual([]);
  });

  test("run doesn't warn about another project's running Daemon", async () => {
    const setup = await service();
    setup.projects.push({ id: "project-2", title: "other", workspaceRoot: "/work/other" });
    expect((await setup.cli("start", "--project", "other")).status).toBe(0);
    setup.markRunning();
    const result = await setup.cli("run", "--once");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).not.toContain("already has a background Daemon running");
  });

  test("the installed Daemon doesn't warn about itself", async () => {
    const setup = await service();
    expect((await setup.cli("start")).status).toBe(0);
    setup.markRunningAsCaller();
    const result = await runPinned(setup, tmpdir());
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("watching ENG -> my-app");
    expect(result.stdout).not.toMatch(ALREADY_RUNNING);
  });

  test.each([
    ["stop"],
    ["restart"],
    ["logs"],
    ["uninstall"],
    ["stop", "--all"],
    ["uninstall", "--all"],
  ])("%s %s when the service isn't installed says so and exits non-zero", async (...command) => {
    const { cli, calls } = await service();
    const result = await cli(...command);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The Daemon isn't installed as a background service; run `linear-t3 start`",
    );
    expect(calls()).toEqual([]);
  });

  // Each test runs the CLI several times, against T3.
  describe("with a Daemon per T3 project", { timeout: 30_000 }, () => {
    /** `service()` plus a second repository, for T3 project `project-2` titled `other`. */
    async function twoRepositories() {
      const setup = await service();
      const other = repoDir({ project: undefined });
      setup.projects.push({ id: "project-2", title: "other", workspaceRoot: other });
      const cliIn = (cwd: string, ...args: string[]) =>
        startCli({ cwd, env: setup.env }, args).result;
      /** The calls that name a Daemon, each by the project it names. */
      const named = () =>
        setup
          .calls()
          .flatMap((call) =>
            ["project-1", "project-2"].filter((project) => call.includes(setup.unitName(project))),
          );
      return { ...setup, other, cliIn, named };
    }

    /** Both repositories' Daemons started and running, with the calls reset. */
    async function twoDaemons() {
      const setup = await twoRepositories();
      expect((await setup.cli("start")).status).toBe(0);
      expect((await setup.cliIn(setup.other, "start")).status).toBe(0);
      setup.markRunning();
      setup.resetCalls();
      return setup;
    }

    test("start in a second repository adds its Daemon and leaves the first one alone", async () => {
      const setup = await twoRepositories();
      expect((await setup.cli("start")).status).toBe(0);
      const first = readFileSync(setup.files.unit, "utf8");
      setup.markRunning();
      setup.resetCalls();
      const result = await setup.cliIn(setup.other, "start");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(setup.unitOf("project-2"));
      expect(result.stdout).toContain('Pinned to T3 project "other" (project-2)');
      expect(readFileSync(setup.files.unit, "utf8")).toBe(first);
      expect(setup.named()).toContain("project-2");
      expect(setup.named()).not.toContain("project-1");
    });

    test("start again in a repository replaces only its own Daemon", async () => {
      const setup = await twoDaemons();
      const second = readFileSync(setup.unitOf("project-2"), "utf8");
      expect((await setup.cli("start", "--team", "OPS")).status).toBe(0);
      expect(setup.pinned().args).toContain("--team=OPS");
      expect(readFileSync(setup.unitOf("project-2"), "utf8")).toBe(second);
      expect(setup.named()).not.toContain("project-2");
    });

    test.each(["stop", "restart", "uninstall"])(
      "%s in a repository acts on its project's Daemon only",
      async (command) => {
        const setup = await twoDaemons();
        const result = await setup.cliIn(setup.other, command);
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(result.stdout).toContain('"other" (project-2)');
        expect(setup.named()).toContain("project-2");
        expect(setup.named()).not.toContain("project-1");
        expect(existsSync(setup.files.unit)).toBe(true);
        expect(existsSync(setup.unitOf("project-2"))).toBe(command !== "uninstall");
      },
    );

    test.each([
      ["stop", "other"],
      ["restart", "project-2"],
      ["uninstall", "other"],
    ])(
      "%s --project %s acts on that project's Daemon from any directory",
      async (command, project) => {
        const setup = await twoDaemons();
        const result = await setup.cliIn(tmpdir(), command, "--project", project);
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(setup.named()).toContain("project-2");
        expect(setup.named()).not.toContain("project-1");
      },
    );

    test.each(["stop", "restart", "uninstall"])(
      "%s with no project resolving here uses the only installed Daemon",
      async (command) => {
        const setup = await twoRepositories();
        expect((await setup.cliIn(setup.other, "start")).status).toBe(0);
        setup.markRunning();
        setup.resetCalls();
        const result = await setup.cliIn(tmpdir(), command);
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(setup.named()).toContain("project-2");
      },
    );

    test.each(["stop", "restart", "logs", "uninstall"])(
      "%s with several Daemons and no project resolving here fails and lists them",
      async (command) => {
        const setup = await twoDaemons();
        const result = await setup.cliIn(tmpdir(), command);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Several background Daemons are installed");
        expect(result.stderr).toContain(`"my-app" (project-1), Local Config ${setup.files.local}`);
        expect(result.stderr).toContain(
          `"other" (project-2), Local Config ${join(setup.other, LOCAL)}`,
        );
        expect(setup.calls()).toEqual([]);
      },
    );

    test("a repository whose T3 project has no Daemon fails, naming it and the installed ones", async () => {
      const setup = await twoRepositories();
      expect((await setup.cli("start")).status).toBe(0);
      setup.resetCalls();
      const result = await setup.cliIn(setup.other, "stop");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('T3 project "other" (project-2) has no background Daemon');
      expect(result.stderr).toContain('"my-app" (project-1)');
      expect(setup.calls()).toEqual([]);
    });

    test("status lists every Daemon, running or stopped, from any directory, with the shared paths once", async () => {
      const setup = await twoDaemons();
      setup.markDaemon("project-1", true);
      setup.markDaemon("project-2", false);
      const result = await setup.cliIn(tmpdir(), "status");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      const blocks = result.stdout.trimEnd().split("\n\n");
      expect(blocks[0]!.split("\n")).toEqual([
        `Global Config: ${setup.files.config}`,
        `Credentials:   ${setup.files.credentials}`,
        `State:         ${setup.files.state}`,
      ]);
      const [first, second] = [blocks[1]!.split("\n"), blocks[2]!.split("\n")];
      expect(first[0]).toBe('Daemon for "my-app" (project-1)');
      expect(first[1]).toMatch(
        new RegExp(`^  Status:        running \\(pid ${process.pid}, up [\\d:-]+\\)$`),
      );
      expect(first.slice(2)).toContain(`  Local Config:  ${setup.files.local}`);
      expect(first.slice(2)).toContain(`  Unit:          ${setup.files.unit}`);
      expect(second.slice(0, 3)).toEqual([
        'Daemon for "other" (project-2)',
        "  Status:        stopped",
        `  Local Config:  ${join(setup.other, LOCAL)}`,
      ]);
      expect(second).toContain(`  Unit:          ${setup.unitOf("project-2")}`);
      for (const shared of ["Global Config:", "Credentials:", "State:"]) {
        expect(result.stdout.split(shared)).toHaveLength(2);
      }
    });

    test("status shows the ids alone when T3 can't say the titles", async () => {
      const setup = await twoDaemons();
      const config = JSON.parse(readFileSync(setup.files.config, "utf8")) as object;
      writeFile(setup.files.config, JSON.stringify({ ...config, t3Url: "http://127.0.0.1:1" }));
      const result = await setup.cliIn(tmpdir(), "status");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\nDaemon for project-1\n");
      expect(result.stdout).toContain("\nDaemon for project-2\n");
    });

    test("status warns about a missing node for the Daemon that runs it", async () => {
      const setup = await twoDaemons();
      const gone = join(tmpdir(), "linear-t3-gone", "node");
      const unit = setup.unitOf("project-2");
      writeFileSync(unit, readFileSync(unit, "utf8").replace(process.execPath, gone));
      const result = await setup.cliIn(tmpdir(), "status");
      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe(
        `The Daemon for "other" (project-2) runs ${gone}, which no longer exists; run \`linear-t3 start\` again to use this node`,
      );
    });

    test.each(["stop", "restart", "uninstall"])(
      "%s --all acts on every Daemon, from any directory, and names each",
      async (command) => {
        const setup = await twoDaemons();
        const result = await setup.cliIn(tmpdir(), command, "--all");
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(result.stdout).toContain('"my-app" (project-1)');
        expect(result.stdout).toContain('"other" (project-2)');
        expect(result.stdout.trimEnd().split("\n")).toHaveLength(2);
        expect(setup.named()).toContain("project-1");
        expect(setup.named()).toContain("project-2");
      },
    );

    test("uninstall --all removes every unit and keeps the Config, Credentials, State and logs", async () => {
      const setup = await twoDaemons();
      writeFile(setup.files.state, "{}");
      const logs = ["project-1", "project-2"].flatMap((project) => {
        const log = setup.logOf?.(project);
        if (log) writeFile(log, "old output\n");
        return log ? [log] : [];
      });
      expect((await setup.cliIn(tmpdir(), "uninstall", "--all")).status).toBe(0);
      expect(existsSync(setup.files.unit)).toBe(false);
      expect(existsSync(setup.unitOf("project-2"))).toBe(false);
      for (const kept of [
        setup.files.config,
        setup.files.credentials,
        setup.files.state,
        ...logs,
      ]) {
        expect(existsSync(kept)).toBe(true);
      }
      const after = await setup.cliIn(tmpdir(), "status");
      expect(after.stdout).toContain("No background Daemons are installed");
    });

    test("--all with --project is refused before touching any Daemon", async () => {
      const setup = await twoDaemons();
      const result = await setup.cliIn(tmpdir(), "stop", "--all", "--project", "other");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("--all");
      expect(setup.calls()).toEqual([]);
    });
  });

  // Each test runs the CLI several times, against T3.
  describe("migrating the old single background service", { timeout: 30_000 }, () => {
    /** `service()` with only the old single service installed, pinned unless `pinned` is false. */
    async function legacy(options: { pinned?: boolean; running?: boolean } = {}) {
      const setup = await service();
      expect((await setup.cli("start")).status).toBe(0);
      const before = setup.pinned();
      setup.makeLegacy(options.pinned ?? true);
      const old = readFileSync(setup.legacyUnit, "utf8");
      if (options.running ?? true) setup.markRunning();
      setup.resetCalls();
      return { ...setup, old, before };
    }

    /** What's in the unit directory, so a leftover or a duplicate unit shows. */
    const units = (setup: ServiceSetup) =>
      readdirSync(dirname(setup.legacyUnit)).filter((file) => file.startsWith("linear-t3"));

    test.each(["status", "start"])(
      "%s moves a running old unit to the project's Daemon and keeps it running",
      async (command) => {
        const setup = await legacy();
        const result = await setup.cli(command);
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(result.stdout).toContain(`Moved the old background service (${setup.legacyUnit})`);
        expect(existsSync(setup.legacyUnit)).toBe(false);
        expect(units(setup)).toEqual([basename(setup.files.unit)]);
        expect(setup.pinned()).toEqual(setup.before);
        expect(setup.started("project-1")).toBe(true);
      },
    );

    test("status moves a stopped old unit to the project's Daemon without starting it", async () => {
      const setup = await legacy({ running: false });
      const result = await setup.cli("status");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(existsSync(setup.legacyUnit)).toBe(false);
      expect(units(setup)).toEqual([basename(setup.files.unit)]);
      expect(setup.started("project-1")).toBe(false);
      expect(result.stdout).toContain("  Status:        stopped\n");
    });

    test("status removes an old unit pinned to no project and says to run start again", async () => {
      const setup = await legacy({ pinned: false });
      const result = await setup.cli("status");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Removed the old background service (${setup.legacyUnit})`);
      expect(result.stdout).toContain("run `linear-t3 start` in the repository it should watch");
      expect(units(setup)).toEqual([]);
      expect(setup.started("project-1")).toBe(false);
    });

    test("an old unit whose project already has a Daemon is just removed", async () => {
      const setup = await legacy();
      expect((await setup.cli("start", "--team", "OPS")).status).toBe(0);
      // `start` migrated the old unit first; put it back next to the new one.
      writeFile(setup.legacyUnit, setup.old);
      const current = readFileSync(setup.files.unit, "utf8");
      setup.resetCalls();
      const result = await setup.cli("status");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(units(setup)).toEqual([basename(setup.files.unit)]);
      expect(readFileSync(setup.files.unit, "utf8")).toBe(current);
      expect(setup.started("project-1")).toBe(false);
    });

    test.each(["status", "start"])(
      "%s again after migrating moves nothing more",
      async (command) => {
        const setup = await legacy();
        expect((await setup.cli(command)).status).toBe(0);
        const migrated = readFileSync(setup.files.unit, "utf8");
        setup.resetCalls();
        const result = await setup.cli("status");
        expect(result).toMatchObject({ status: 0, stderr: "" });
        expect(result.stdout).not.toContain("old background service");
        expect(units(setup)).toEqual([basename(setup.files.unit)]);
        expect(readFileSync(setup.files.unit, "utf8")).toBe(migrated);
        expect(setup.started("project-1")).toBe(false);
      },
    );

    test("start in the old unit's project ends with exactly one Daemon, with the new flags", async () => {
      const setup = await legacy();
      const result = await setup.cli("start", "--team", "OPS");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain('Pinned to T3 project "my-app" (project-1)');
      expect(units(setup)).toEqual([basename(setup.files.unit)]);
      expect(setup.pinned().args).toContain("--team=OPS");
    });

    test("start after removing an unpinned old unit installs the Daemon it was asked for", async () => {
      const setup = await legacy({ pinned: false });
      const result = await setup.cli("start");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Removed the old background service");
      expect(units(setup)).toEqual([basename(setup.files.unit)]);
      expect(setup.started("project-1")).toBe(true);
    });
  });
}

// launchd only exists on macOS; CI runs this suite on a macOS runner.
describe.runIf(process.platform === "darwin")("cli background service on macOS", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  const uid = process.getuid!();
  const target = `gui/${uid}/linear-t3.project-1`;

  /**
   * A fresh home with a valid Config and Credentials, fake T3 and Linear servers that accept only
   * those tokens, and a stand-in `launchctl` on `PATH` that records each call. `launchctl print`
   * shows `printed` once it is set, else fails the way it does for an agent that isn't loaded.
   */
  async function service(labels: string[] = []) {
    const linear = await fakeLinear([], { apiKey: "lin-key", teams: ["ENG", "OPS"], labels });
    const dir = repoDir();
    const projects = [{ id: "project-1", title: "my-app", workspaceRoot: dir }];
    const t3 = await fakeT3({ projects, token: "t3-tok" });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = {
      ...locations(home),
      log: join(home.XDG_STATE_HOME, "linear-t3", "daemon-project-1.log"),
      unit: join(home.HOME, "Library", "LaunchAgents", "linear-t3.project-1.plist"),
      local: join(dir, LOCAL),
    };
    writeFile(files.config, JSON.stringify({ t3Url: t3.url }));
    writeFile(files.credentials, "LINEAR_API_KEY=lin-key\nT3_TOKEN=t3-tok\n");
    const bin = mkdtempSync(join(tmpdir(), "linear-t3-bin-"));
    const calls = join(bin, "calls");
    const printedFile = join(bin, "printed");
    writeFileSync(
      join(bin, "launchctl"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${calls}"`,
        'if [ "$1" = print ]; then',
        `  one="${printedFile}.$(basename "$2")"`,
        '  if [ -f "$one" ]; then sed "s/@CALLER@/$PPID/" "$one"; exit 0; fi',
        `  if [ -f "${printedFile}" ]; then sed "s/@CALLER@/$PPID/" "${printedFile}"; exit 0; fi`,
        `  echo "Could not find service \\"linear-t3\\" in domain for user gui: ${uid}" >&2`,
        "  exit 113",
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = { ...home, LINEAR_API_URL: linear.url, PATH: `${bin}:${process.env.PATH}` };
    const recorded = () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
    return {
      env,
      dir,
      files,
      cli: (...args: string[]) => startCli({ cwd: dir, env }, args).result,
      calls: recorded,
      pinned: () => launchdPinned(readFileSync(files.unit, "utf8")),
      projects,
      linearFilters: () => linear.filters,
      markRunning: () => writeFileSync(printedFile, runningPrint()),
      markRunningAsCaller: () => writeFileSync(printedFile, callerPrint()),
      markDaemon: (project: string, running: boolean) =>
        writeFileSync(
          `${printedFile}.linear-t3.${project}`,
          printed(running ? `state = running\n\tpid = ${process.pid}` : "state = not running"),
        ),
      print: (output: string) => writeFileSync(printedFile, output),
      resetCalls: () => writeFileSync(calls, ""),
      unitOf: (project: string) =>
        join(home.HOME, "Library", "LaunchAgents", `linear-t3.${project}.plist`),
      unitName: (project: string) => `linear-t3.${project}`,
      logOf: (project: string) => join(home.XDG_STATE_HOME, "linear-t3", `daemon-${project}.log`),
      legacyUnit: join(home.HOME, "Library", "LaunchAgents", "linear-t3.plist"),
      makeLegacy(pinned: boolean) {
        const agent = readFileSync(files.unit, "utf8")
          .replace("<string>linear-t3.project-1</string>", "<string>linear-t3</string>")
          .replaceAll(files.log, join(home.XDG_STATE_HOME, "linear-t3", "daemon.log"))
          .replace(pinned ? "" : "\t\t<string>--project=project-1</string>\n", "");
        rmSync(files.unit);
        writeFile(join(home.HOME, "Library", "LaunchAgents", "linear-t3.plist"), agent);
      },
      started: (project: string) =>
        recorded().includes(
          `bootstrap gui/${uid} ${join(home.HOME, "Library", "LaunchAgents", `linear-t3.${project}.plist`)}`,
        ),
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
    `${target} = {\n\tactive count = 1\n\tpath = /x/linear-t3.project-1.plist\n\t${details}\n}\n`;
  const runningPrint = () => printed(`state = running\n\tpid = ${process.pid}`);
  // The stand-in `launchctl` puts the pid of whoever called it in place of `@CALLER@`.
  const callerPrint = () => printed("state = running\n\tpid = @CALLER@");

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
\t<string>linear-t3.project-1</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${process.execPath}</string>
\t\t<string>${cliPath}</string>
\t\t<string>run</string>
\t\t<string>--project=project-1</string>
\t\t<string>--config=${files.local}</string>
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
        LINEAR_T3_CONFIG: files.config,
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

  test("the agent gets T3CODE_HOME when set", async () => {
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

  /** The lines `status` prints: the shared paths, then the Daemon's block, its status `daemon`. */
  const statusLines = (files: Record<string, string>, daemon?: string) => [
    `Global Config: ${files.config}`,
    `Credentials:   ${files.credentials}`,
    `State:         ${files.state}`,
    "",
    ...(daemon === undefined
      ? ["No background Daemons are installed; run `linear-t3 start` in a repository"]
      : [
          'Daemon for "my-app" (project-1)',
          `  Status:        ${daemon}`,
          `  Local Config:  ${files.local}`,
          `  Log:           ${files.log}`,
          `  Unit:          ${files.unit}`,
        ]),
  ];

  test("status shows a running Daemon's pid and uptime, and where everything lives", async () => {
    const { files, cli } = await installed("running");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[5]).toMatch(
      new RegExp(`^  Status:        running \\(pid ${process.pid}, up [\\d:-]+\\)$`),
    );
    expect(lines).toEqual(statusLines(files, lines[5]!.slice(17)));
  });

  test.each(["stopped", "unloaded"] as const)(
    "status shows an agent that is %s as stopped",
    async (state) => {
      const { files, cli } = await installed(state);
      const result = await cli("status");
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout.trimEnd().split("\n")).toEqual(statusLines(files, "stopped"));
    },
  );

  test("status without the service says it isn't installed", async () => {
    const { files, cli, calls } = await service();
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual(statusLines(files));
    expect(calls()).toEqual([]);
  });

  test("status shows the State path the Config sets", async () => {
    const { files, cli } = await installed("running");
    const config = JSON.parse(readFileSync(files.config, "utf8"));
    writeFile(files.config, JSON.stringify({ ...config, stateFile: "data/state.json" }));
    const result = await cli("status");
    expect(result.stdout).toContain(
      `State:         ${join(dirname(files.config), "data", "state.json")}\n`,
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
      `The Daemon for "my-app" (project-1) runs ${gone}, which no longer exists; run \`linear-t3 start\` again to use this node`,
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

  test("each Daemon logs to its own file, and logs shows only that one", async () => {
    const setup = await service();
    const other = repoDir({ project: undefined });
    setup.projects.push({ id: "project-2", title: "other", workspaceRoot: other });
    expect((await setup.cli("start")).status).toBe(0);
    expect((await startCli({ cwd: other, env: setup.env }, ["start"]).result).status).toBe(0);
    const log = (unit: string) => launchdLog(readFileSync(unit, "utf8"));
    expect(log(setup.files.unit)).toBe(setup.files.log);
    expect(log(setup.unitOf("project-2"))).toBe(setup.logOf("project-2"));
    writeFile(setup.files.log, "first project\n");
    writeFile(setup.logOf("project-2"), "second project\n");
    const result = await startCli({ cwd: other, env: setup.env }, ["logs"]).result;
    expect(result).toEqual({ status: 0, stdout: "second project\n", stderr: "" });
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
  async function service(labels: string[] = []) {
    const linear = await fakeLinear([], { apiKey: "lin-key", teams: ["ENG", "OPS"], labels });
    const dir = repoDir();
    const projects = [{ id: "project-1", title: "my-app", workspaceRoot: dir }];
    const t3 = await fakeT3({ projects, token: "t3-tok" });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    const files = {
      ...locations(home),
      unit: join(home.XDG_CONFIG_HOME, "systemd", "user", "linear-t3-project-1.service"),
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
      // `failOn` makes every call that names a unit fail.
      `if [ -f "${bin}/fail.$3" ] || [ -f "${bin}/fail.$4" ]; then echo "unit is broken" >&2; exit 1; fi`,
      'if [ "$2" = show ]; then',
      `  if [ -f "${shown}.$3" ]; then sed "s/@CALLER@/$PPID/" "${shown}.$3"; exit 0; fi`,
      `  if [ -f "${shown}" ]; then sed "s/@CALLER@/$PPID/" "${shown}"; exit 0; fi`,
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
      calls: () =>
        existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
      pinned: () => systemdPinned(readFileSync(files.unit, "utf8")),
      projects,
      linearFilters: () => linear.filters,
      markRunning: () =>
        writeFileSync(shown, `MainPID=${process.pid}\nActiveState=active\nSubState=running\n`),
      markRunningAsCaller: () =>
        writeFileSync(shown, "MainPID=@CALLER@\nActiveState=active\nSubState=running\n"),
      markDaemon: (project: string, running: boolean) =>
        writeFileSync(
          `${shown}.linear-t3-${project}.service`,
          running
            ? `MainPID=${process.pid}\nActiveState=active\nSubState=running\n`
            : "MainPID=0\nActiveState=inactive\nSubState=dead\n",
        ),
      show: (output: string) => writeFileSync(shown, output),
      enableLinger: () => writeFileSync(linger, ""),
      failOn: (project: string) =>
        writeFileSync(join(bin, `fail.linear-t3-${project}.service`), ""),
      resetCalls: () => writeFileSync(calls, ""),
      unitOf: (project: string) =>
        join(home.XDG_CONFIG_HOME, "systemd", "user", `linear-t3-${project}.service`),
      unitName: (project: string) => `linear-t3-${project}.service`,
      legacyUnit: join(home.XDG_CONFIG_HOME, "systemd", "user", "linear-t3.service"),
      makeLegacy(pinned: boolean) {
        const unit = readFileSync(files.unit, "utf8")
          .replace(
            "Description=linear-t3 Daemon for T3 project project-1",
            "Description=linear-t3 Daemon",
          )
          .replace(pinned ? "" : '"--project=project-1" ', "");
        rmSync(files.unit);
        writeFile(join(home.XDG_CONFIG_HOME, "systemd", "user", "linear-t3.service"), unit);
      },
      started: (project: string) =>
        existsSync(calls) &&
        readFileSync(calls, "utf8").includes(
          `systemctl --user restart linear-t3-${project}.service`,
        ),
    };
  }

  /** The unit `start` should write for `files`, with `env` as its environment. */
  function expectedUnit(files: { local: string }, env: Record<string, string>) {
    const variables = Object.entries(env)
      .map(([key, value]) => `Environment="${key}=${value}"\n`)
      .join("");
    return `[Unit]
Description=linear-t3 Daemon for T3 project project-1

[Service]
ExecStart="${process.execPath}" "${cliPath}" "run" "--project=project-1" "--config=${files.local}"
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
        LINEAR_T3_CONFIG: files.config,
        XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: env.XDG_STATE_HOME,
      }),
    );
    expect(calls()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable linear-t3-project-1.service",
      "systemctl --user restart linear-t3-project-1.service",
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
    expect(readFileSync(files.unit, "utf8")).toContain('"run" "--project=project-1"');
    expect(calls()).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable linear-t3-project-1.service",
      "systemctl --user restart linear-t3-project-1.service",
    ]);
  });

  test("the unit gets T3CODE_HOME when set, and never the tokens", async () => {
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

  test("without XDG variables the unit goes in ~/.config and gets only the Global Config", async () => {
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
      readFileSync(
        join(env.HOME, ".config", "systemd", "user", "linear-t3-project-1.service"),
        "utf8",
      ),
    ).toBe(expectedUnit(files, { LINEAR_T3_CONFIG: config }));
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
      `"--config=${dir}/my \\"100%%\\" $$HOME\\\\x/c.json"\n`,
    );
  });

  test("stop stops the Daemon and disables it so it doesn't start at login", async () => {
    const { cli, calls } = await installed();
    expect(await cli("stop")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual(["systemctl --user disable --now linear-t3-project-1.service"]);
  });

  test("restart enables the unit again and restarts the Daemon", async () => {
    const { cli, calls } = await installed("stopped");
    expect(await cli("restart")).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([
      "systemctl --user enable linear-t3-project-1.service",
      "systemctl --user restart linear-t3-project-1.service",
    ]);
  });

  test("uninstall stops, disables and removes the unit, reloads systemd, and keeps the user's files", async () => {
    const { files, cli, calls } = await installed();
    writeFile(files.state, "{}");
    const result = await cli("uninstall");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(calls()).toEqual([
      "systemctl --user disable --now linear-t3-project-1.service",
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

  /** The lines `status` prints: the shared paths, then the Daemon's block, its status `daemon`. */
  const statusLines = (files: Record<string, string>, daemon?: string) => [
    `Global Config: ${files.config}`,
    `Credentials:   ${files.credentials}`,
    `State:         ${files.state}`,
    "",
    ...(daemon === undefined
      ? ["No background Daemons are installed; run `linear-t3 start` in a repository"]
      : [
          'Daemon for "my-app" (project-1)',
          `  Status:        ${daemon}`,
          `  Local Config:  ${files.local}`,
          "  Log:           journalctl --user -u linear-t3-project-1",
          `  Unit:          ${files.unit}`,
        ]),
  ];

  test("status shows a running Daemon's pid and uptime, where everything lives, and the linger hint", async () => {
    const { files, cli, calls } = await installed("running");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[5]).toMatch(
      new RegExp(`^  Status:        running \\(pid ${process.pid}, up [\\d:-]+\\)$`),
    );
    expect(lines).toEqual([...statusLines(files, lines[5]!.slice(17)), "", lingerHint]);
    expect(calls()).toEqual([
      "systemctl --user show linear-t3-project-1.service --property=ActiveState,SubState,MainPID",
      `loginctl show-user ${uid} --property=Linger --value`,
    ]);
  });

  test("status shows a stopped Daemon as stopped", async () => {
    const { files, cli } = await installed("stopped");
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      ...statusLines(files, "stopped"),
      "",
      lingerHint,
    ]);
  });

  test("status leaves out the linger hint when lingering is on, and never turns it on", async () => {
    const { files, cli, calls, enableLinger } = await installed("running");
    enableLinger();
    const result = await cli("status");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toEqual(statusLines(files, lines[5]!.slice(17)));
    expect(calls().filter((call) => call.startsWith("loginctl"))).toEqual([
      `loginctl show-user ${uid} --property=Linger --value`,
    ]);
  });

  test("status without the service says it isn't installed", async () => {
    const { files, cli, calls } = await service();
    const result = await cli("status");
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual(statusLines(files));
    expect(calls()).toEqual([]);
  });

  test("status with several Daemons shows the linger hint once, at the end", async () => {
    const setup = await service();
    const other = repoDir({ project: undefined });
    setup.projects.push({ id: "project-2", title: "other", workspaceRoot: other });
    expect((await setup.cli("start")).status).toBe(0);
    expect((await startCli({ cwd: other, env: setup.env }, ["start"]).result).status).toBe(0);
    const { stdout } = await startCli({ cwd: tmpdir(), env: setup.env }, ["status"]).result;
    expect(stdout.split(lingerHint)).toHaveLength(2);
    expect(stdout.trimEnd().endsWith(`\n\n${lingerHint}`)).toBe(true);
  });

  test("stop --all keeps going past a Daemon that fails, names it, and exits 1", async () => {
    const setup = await service();
    const other = repoDir({ project: undefined });
    setup.projects.push({ id: "project-2", title: "other", workspaceRoot: other });
    expect((await setup.cli("start")).status).toBe(0);
    expect((await startCli({ cwd: other, env: setup.env }, ["start"]).result).status).toBe(0);
    setup.failOn("project-1");
    setup.resetCalls();
    const result = await startCli({ cwd: tmpdir(), env: setup.env }, ["stop", "--all"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The Daemon for "my-app" (project-1) failed:');
    expect(result.stdout).toContain('Stopped the Daemon for "other" (project-2)');
    expect(setup.calls()).toContain("systemctl --user disable --now linear-t3-project-2.service");
  });

  test("status reads the Local Config a unit passes as `--config <path>`, as before projects were pinned", async () => {
    const { files, cli } = await installed("stopped");
    writeFileSync(
      files.unit,
      readFileSync(files.unit, "utf8").replace(
        `"--project=project-1" "--config=${files.local}"`,
        `"--config" "${files.local}"`,
      ),
    );
    const { stdout } = await cli("status");
    expect(stdout).toContain('\nDaemon for "my-app" (project-1)\n');
    expect(stdout).toContain(`  Local Config:  ${files.local}\n`);
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
      `The Daemon for "my-app" (project-1) runs ${gone}, which no longer exists; run \`linear-t3 start\` again to use this node`,
    );
  });

  test("logs shows the Daemon's journal", async () => {
    const { cli, calls } = await installed();
    expect(await cli("logs")).toEqual({ status: 0, stdout: "journal line\n", stderr: "" });
    expect(calls()).toEqual(["journalctl --user -u linear-t3-project-1 -n 100 --no-pager"]);
  });

  test("logs -f follows the journal until interrupted", async () => {
    const { env, calls } = await installed();
    const cli = startCli({ cwd: tmpdir(), env }, ["logs", "-f"]);
    await new Promise<void>((resolve) => cli.child.stdout!.once("data", () => resolve()));
    cli.child.kill("SIGINT");
    expect(await cli.result).toMatchObject({ status: 0, stdout: "journal line\n" });
    expect(calls()).toEqual(["journalctl --user -u linear-t3-project-1 -n 100 --no-pager -f"]);
  });

  test("logs shows only the journal of the working directory's project's Daemon", async () => {
    const setup = await service();
    const other = repoDir({ project: undefined });
    setup.projects.push({ id: "project-2", title: "other", workspaceRoot: other });
    expect((await setup.cli("start")).status).toBe(0);
    expect((await startCli({ cwd: other, env: setup.env }, ["start"]).result).status).toBe(0);
    setup.resetCalls();
    expect((await startCli({ cwd: other, env: setup.env }, ["logs"]).result).status).toBe(0);
    expect(setup.calls()).toEqual(["journalctl --user -u linear-t3-project-2 -n 100 --no-pager"]);
  });
});

describe("README", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  /** A Markdown table row's cells, with `\|` read back as `|`. */
  const cells = (row: string) =>
    row
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("\\|", "|"));

  /** The rows of the first table after `heading`, without its header and separator. */
  function table(heading: string) {
    const at = readme.indexOf(`${heading}\n`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const section = readme.slice(at);
    const lines = section.split("\n");
    const start = lines.findIndex((line) => line.startsWith("|"));
    const end = lines.findIndex((line, i) => i > start && !line.startsWith("|"));
    return lines.slice(start + 2, end).map(cells);
  }

  /** The code blocks marked `<!-- readme-example: name -->`. */
  const examples = (name: string) =>
    [...readme.matchAll(/<!-- readme-example: (\S+) -->\s*```\w*\n([^]*?)```/g)]
      .filter(([, marker]) => marker === name)
      .map(([, , code]) => code!);

  const unquote = (cell: string) => cell.replace(/^`(.*)`$/, "$1");

  const runHelp = () => runCli("run", "--help").stdout;
  /** The flags in `help`: each option's first line is two spaces, the flag and its placeholder. */
  const helpFlags = (help: string) =>
    [...help.matchAll(/^ {2}(?:-\w, )?(--[\w-]+(?: [<[]\S+)?)/gm)].map(([, flag]) => flag!);
  const runOnly = ["--once", "--dry-run", "--config <path>", "--no-config", "--help"];

  test("the Config keys table lists every flag in run --help with its default and scope", () => {
    const help = runHelp();
    const rows = table("### Config keys");
    const flagged = rows.filter(([, flag]) => flag !== "—");
    expect(flagged.map(([, flag]) => unquote(flag!)).sort()).toEqual(
      helpFlags(help)
        .filter((flag) => !runOnly.includes(flag))
        .sort(),
    );

    const oneLine = help.replace(/\s+/g, " ");
    for (const [key, flag, scope, unset] of flagged) {
      const after = oneLine.slice(oneLine.indexOf(`${unquote(flag!)} `));
      const expected = unset === "required" ? unset : `default: ${unset}`;
      // The flag's own help ends with its default and scope.
      const own = after.slice(0, after.indexOf(")", after.indexOf("; scope: ")) + 1);
      expect(own.endsWith(`(${expected}; scope: ${scope})`), `${key}: ${own}`).toBe(true);
    }
    // Keys without a flag are the machine settings, which only the Global Config holds.
    for (const [key, , scope] of rows.filter(([, flag]) => flag === "—")) {
      expect(scope, key).toBe("global");
    }
  });

  test("the run flags table lists run's own flags", () => {
    const flags = runOnly.filter((flag) => flag !== "--help");
    expect(helpFlags(runHelp())).toEqual(expect.arrayContaining(flags));
    expect(table("### `run`").map(([flag]) => unquote(flag!))).toEqual(flags);
  });

  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((close) => close()));

  /**
   * Fake servers for team FIT and a repository T3 has as project `my-app`, whose default model is
   * Opus, as the README's examples assume. `global` is the Global Config, pointed at the fake T3.
   */
  async function setup(global: string, local?: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "linear-t3-repo-")));
    mkdirSync(join(dir, ".git"));
    if (local !== undefined) writeFileSync(join(dir, LOCAL), local);
    const linear = await fakeLinear([], { teams: ["FIT"], labels: ["agent"] });
    const defaultModelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    const t3 = await fakeT3({
      projects: [{ id: "project-1", title: "my-app", workspaceRoot: dir, defaultModelSelection }],
    });
    cleanup.push(linear.close, t3.close);
    const home = homeDir();
    writeFile(locations(home).config, JSON.stringify({ ...JSON.parse(global), t3Url: t3.url }));
    const env = { ...home, LINEAR_API_URL: linear.url, LINEAR_API_KEY: "lin-key", T3_TOKEN: "t" };
    return { dir, env };
  }

  test("every run command in the examples is accepted against the fakes", async () => {
    const commands = examples("cli")
      .flatMap((code) => code.split("\n"))
      .filter((line) => /^(npx )?linear-t3 run\b/.test(line))
      .map((line) => line.replace(/#.*/, "").trim());
    expect(commands.length).toBeGreaterThan(0);
    const { dir, env } = await setup(examples("global")[0]!);
    for (const command of commands) {
      expect(command).not.toMatch(/["']/);
      const args = command.replace(/^(npx )?linear-t3 /, "").split(/\s+/);
      // A plain run polls until stopped, so check it with a dry run instead.
      if (!args.includes("--once") && !args.includes("--dry-run")) args.push("--dry-run");
      const result = await startCli({ cwd: dir, env }, args).result;
      expect(result, command).toMatchObject({ status: 0, stderr: "" });
    }
  });

  test.each(["", "migrated-"])(
    "the %sGlobal and Local Config examples are accepted",
    async (prefix) => {
      const [global] = examples(`${prefix}global`);
      const [local] = examples(`${prefix}local`);
      const { dir, env } = await setup(global!, local!);
      const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain("watching FIT -> my-app");
    },
  );

  test("the old Config example is rejected with the migration hint", async () => {
    const { dir, env } = await setup(examples("old")[0]!);
    const result = await startCli({ cwd: dir, env }, ["run", "--dry-run"]).result;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the old Config shape");
  });
});
