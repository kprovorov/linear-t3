#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { Argument, Command, Option } from "commander";
import {
  CancelledError,
  ConnectError,
  type Outcome,
  type Integration,
  type PendingIntegration,
  type Ui,
  connect,
} from "./connect.ts";
import { t3BaseUrl, t3Integration } from "./connect-t3.ts";
import { runDaemon } from "./daemon.ts";
import { EnvFile } from "./env-file.ts";
import { LOCAL_CONFIG_NAME, loadGlobalConfig } from "./config.ts";
import { configFlags, configOptions } from "./flags.ts";
import { resolvePaths } from "./paths.ts";
import { preflight } from "./preflight.ts";
import {
  type ServiceManager,
  type ServicePlatform,
  ServiceError,
  daemonUnit,
  migrateLegacy,
  pinnedTo,
  servicePlatform,
} from "./service.ts";
import {
  type TargetOptions,
  allDaemons,
  describeProject,
  pickDaemon,
  projectTitles,
} from "./target.ts";
import { checkLinear } from "./token-check.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const linear: Integration = {
  name: "Linear",
  envKey: "LINEAR_API_KEY",
  obtain: (ui) =>
    ui.password(
      "Linear API key (create one in Linear → Settings → Security & access → Personal API keys)",
    ),
  check: checkLinear,
  // A saved key that can't be checked may still be fine, so don't ask to replace it. A new key
  // that fails is most likely a typo, so keep asking until one passes or the user cancels.
  onFailure: (step, result) =>
    step === "existing" && result.status === "unreachable" ? "abort" : "obtain",
};

const paths = () => resolvePaths();

/** Every integration `connect` knows about, in the order plain `connect` runs them. */
const integrations = {
  t3: async () => t3Integration({ baseUrl: await t3BaseUrl(paths().globalConfig) }),
  linear: async () => linear,
} satisfies Record<string, () => Promise<Integration | PendingIntegration>>;

type IntegrationName = keyof typeof integrations;
const integrationNames = Object.keys(integrations) as IntegrationName[];

const clackUi: Ui = {
  async confirm(message) {
    const answer = await clack.confirm({ message, initialValue: false });
    if (clack.isCancel(answer)) throw new CancelledError();
    return answer;
  },
  async password(message) {
    const answer = await clack.password({
      message,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    if (clack.isCancel(answer)) throw new CancelledError();
    return answer.trim();
  },
  async spin(message, work) {
    const spinner = clack.spinner({ onCancel: () => process.exit(1) });
    spinner.start(message);
    try {
      const result = await work();
      spinner.stop(message);
      return result;
    } catch (error) {
      spinner.error(message);
      throw error;
    }
  },
  success: (message) => clack.log.success(message),
  warn: (message) => clack.log.warn(message),
};

function summary(outcome: Outcome): string {
  const who = outcome.identity ? `, authenticated as ${outcome.identity}` : "";
  return `${outcome.integration}: ${outcome.action === "saved" ? "token saved" : "kept existing token"}${who}`;
}

async function runConnect(integration: IntegrationName | undefined): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("connect is interactive, run it in a terminal");
    process.exit(1);
  }
  const credentials = new EnvFile(paths().credentials);
  const selected = await Promise.all(
    (integration ? [integration] : integrationNames).map((name) => integrations[name]()),
  );

  clack.intro("linear-t3 connect");
  try {
    const outcomes = await connect(selected, credentials, clackUi);
    const saved = outcomes.some((outcome) => outcome.action === "saved");
    const where = saved ? `Saved to ${credentials.path}` : `${credentials.path} unchanged`;
    clack.outro([...outcomes.map(summary), where].join("\n"));
  } catch (error) {
    if (error instanceof CancelledError) {
      clack.cancel("Cancelled");
    } else if (error instanceof ConnectError) {
      clack.cancel(error.message);
    } else {
      throw error;
    }
    process.exit(1);
  }
}

// Resolved from this module, so it's found both from `src/` and from the bundle in `dist/`.
const configTemplate = new URL("../config.template.json", import.meta.url);

function runSetup(): void {
  const { globalConfig: config } = paths();
  mkdirSync(dirname(config), { recursive: true });
  try {
    // `wx` fails if the file exists, so an existing Config is never touched.
    writeFileSync(config, readFileSync(configTemplate), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    console.error(`A Config already exists at ${config}, leaving it unchanged`);
    process.exit(1);
  }
  console.log(
    [
      `Wrote a starter Global Config to ${config}`,
      "",
      "Next steps:",
      `  1. Add a ${LOCAL_CONFIG_NAME} to your repository, with the T3 project and Linear team:`,
      '     { "project": "/path/to/repo", "team": "ENG" }',
      "  2. Run `linear-t3 connect` to save the T3 and Linear tokens",
      "  3. Run `linear-t3 run` in the repository, or `linear-t3 start` to run it in the background",
    ].join("\n"),
  );
}

async function runDaemonCommand(
  options: {
    once?: boolean;
    dryRun?: boolean;
    config?: string | false;
  } & Record<string, unknown>,
): Promise<void> {
  const { once = false, dryRun = false, config } = options;
  try {
    // A dry run only reports, so polling again would just report the same again.
    await runDaemon({
      paths: paths(),
      localConfig: config,
      flags: configFlags(options),
      once: once || dryRun,
      dryRun,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/** Runs a background service command, printing a `ServiceError` and exiting 1 on failure. */
async function exitOnServiceError(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

const cliPath = fileURLToPath(import.meta.url);

/** Moves the old single background service to its project's Daemon, saying what it did. */
async function migrate(platform: ServicePlatform): Promise<void> {
  const done = await migrateLegacy(platform);
  if (done) console.log(done);
}

async function start(
  options: { config?: string | false } & Record<string, unknown>,
): Promise<void> {
  const where = paths();
  const platform = servicePlatform(where);
  // npm can clean the npx cache at any time, which would leave the service pointing at nothing.
  if ([process.argv[1], cliPath].some((path) => path?.split(sep).includes("_npx"))) {
    throw new ServiceError(
      "linear-t3 is running from the npx cache, which npm may clean up. Install it first with `npm i -g linear-t3`, then run `linear-t3 start`",
    );
  }
  await migrate(platform);
  const flags = configFlags(options);
  const { problems, localConfig, project } = await preflight(where, {
    localConfig: options.config,
    flags,
  });
  if (problems.length > 0 || !project) {
    throw new ServiceError(
      ["The Daemon would not start, so it wasn't installed:", ...problems].join("\n"),
    );
  }
  // Each T3 project has its own Daemon, so this replaces only this project's.
  const manager = platform.daemon(project.id);
  await manager.install(
    daemonUnit(cliPath, {
      project: project.id,
      localConfig,
      globalConfig: where.globalConfig,
      flags,
    }),
  );
  console.log(
    [
      `Started the Daemon (${manager.kind} ${manager.unitPath})`,
      `Pinned to T3 project ${describeProject(project.id, project.title)}`,
    ].join("\n"),
  );
}

/** The installed Daemon the command's flags and working directory pick. */
const target = (options: TargetOptions) => pickDaemon(servicePlatform(paths()), paths(), options);

/** The Daemons a command acts on: every installed one with `--all`, else the one `target` picks. */
const targets = async ({ all, ...options }: TargetOptions & { all?: boolean }) =>
  all ? allDaemons(servicePlatform(paths()), paths()) : [await target(options)];

type AllOptions = TargetOptions & { all?: boolean };

/**
 * Runs `act` on each Daemon the command targets, printing `done` for each. With `--all`, one
 * Daemon failing doesn't stop the rest; each failure is named, and the command exits 1 at the end.
 */
async function eachTarget(
  options: AllOptions,
  act: (manager: ServiceManager) => Promise<void>,
  done: (manager: ServiceManager, project: string) => string,
): Promise<void> {
  let failed = false;
  for (const { manager, title } of await targets(options)) {
    const project = describeProject(manager.project, title);
    try {
      await act(manager);
    } catch (error) {
      if (!options.all || !(error instanceof ServiceError)) throw error;
      console.error(`The Daemon for ${project} failed: ${error.message}`);
      failed = true;
      continue;
    }
    console.log(done(manager, project));
  }
  if (failed) process.exitCode = 1;
}

const stop = (options: AllOptions) =>
  eachTarget(
    options,
    (manager) => manager.stop(),
    (_, project) =>
      `Stopped the Daemon for ${project}; it won't start at login until \`linear-t3 start\``,
  );

const restart = (options: AllOptions) =>
  eachTarget(
    options,
    (manager) => manager.restart(),
    (_, project) => `Restarted the Daemon for ${project}`,
  );

const uninstall = (options: AllOptions) =>
  eachTarget(
    options,
    (manager) => manager.uninstall(),
    (manager, project) =>
      `Removed the Daemon for ${project} (${manager.unitPath}); the Config, Credentials, State and log are kept`,
  );

/** `label: value` lines, with the values lined up. */
const rows = (lines: [string, string | undefined][], indent = "") =>
  lines.flatMap(([label, value]) =>
    value === undefined ? [] : [`${indent}${`${label}:`.padEnd(15)}${value}`],
  );

/** Where the Global Config at `path` keeps State. An unreadable one can't say, so the default. */
const statePath = (path: string, fallback: string) =>
  loadGlobalConfig(path).then(
    (config) => config.stateFile ?? fallback,
    () => fallback,
  );

/** Every installed Daemon, wherever it's run from, after the files they share. */
async function status(): Promise<void> {
  const where = paths();
  const platform = servicePlatform(where);
  await migrate(platform);
  const installed = platform.list();
  const [state, titles] = await Promise.all([
    statePath(where.globalConfig, where.defaultState),
    installed.length > 0 ? projectTitles(where) : new Map<string, string>(),
  ]);
  const daemons = await Promise.all(
    installed.map(async ({ project, unit }) => {
      const manager = platform.daemon(project);
      const pinned = pinnedTo(unit);
      // Only when `start` ran with another Global Config than this command found.
      const ownConfig =
        pinned.globalConfig === undefined || pinned.globalConfig === where.globalConfig
          ? undefined
          : pinned.globalConfig;
      const [service, ownState] = await Promise.all([
        manager.status(),
        ownConfig && statePath(ownConfig, where.defaultState),
      ]);
      return { manager, unit, pinned, service, ownConfig, ownState, project };
    }),
  );
  // Each Daemon's service manager may say the same thing, like the linger hint; say it once.
  const hints = new Set<string>();
  const blocks = daemons.map(({ manager, unit, pinned, service, ownConfig, ownState, project }) => {
    const name = describeProject(project, titles.get(project));
    const { running, pid, uptime, hint } = service;
    if (hint) hints.add(hint);
    const node = unit.program[0];
    if (node && !existsSync(node)) {
      console.error(
        `The Daemon for ${name} runs ${node}, which no longer exists; run \`linear-t3 start\` again to use this node`,
      );
    }
    return [
      `Daemon for ${name}`,
      ...rows(
        [
          ["Status", running ? `running (pid ${pid}${uptime ? `, up ${uptime}` : ""})` : "stopped"],
          ["Local Config", pinned.localConfig ?? "none"],
          ["Global Config", ownConfig],
          ["State", ownState === state ? undefined : ownState],
          ["Log", manager.logLocation],
          ["Unit", manager.unitPath],
        ],
        "  ",
      ),
    ];
  });
  const shared = rows([
    ["Global Config", where.globalConfig],
    ["Credentials", where.credentials],
    ["State", state],
  ]);
  const none = ["No background Daemons are installed; run `linear-t3 start` in a repository"];
  console.log(
    [shared, ...(blocks.length > 0 ? blocks : [none]), ...(hints.size > 0 ? [[...hints]] : [])]
      .map((block) => block.join("\n"))
      .join("\n\n"),
  );
}

async function logs({ follow = false, ...options }: TargetOptions & { follow?: boolean }) {
  const { manager } = await target(options);
  process.exitCode = await manager.logs(follow);
}

const program = new Command("linear-t3").version(pkg.version).action(() => program.help());

const CONFIG_OPTION = [
  "--config <path>",
  `the Local Config to use instead of the nearest ${LOCAL_CONFIG_NAME} up to the Git root. The Global Config is $LINEAR_T3_CONFIG or $XDG_CONFIG_HOME/linear-t3/config.json`,
] as const;
const NO_CONFIG_OPTION = [
  "--no-config",
  "use no Local Config, even if the repository has one",
] as const;

program
  .command("setup")
  .description(
    "write a starter Global Config to edit (refuses if the Global Config already exists)",
  )
  .action(runSetup);

program
  .command("connect")
  .description(
    "check and save the T3 and Linear tokens in the Credentials file ($XDG_CONFIG_HOME/linear-t3/credentials)",
  )
  .addArgument(
    new Argument("[integration]", "connect only this integration (default: all, in order)").choices(
      integrationNames,
    ),
  )
  .action(runConnect);

const run = program
  .command("run")
  .description("run the Daemon in the foreground: poll Linear and launch T3 threads")
  .option("--once", "do one poll, then exit")
  .option(
    "--dry-run",
    "show which issues would start now and which would wait on a cap, without starting threads, then exit",
  )
  .option(...CONFIG_OPTION)
  .option(...NO_CONFIG_OPTION)
  .action(runDaemonCommand);
for (const option of configOptions()) run.addOption(option);

const startCommand = program
  .command("start")
  .description(
    "install and start the Daemon as a background service, pinned to the T3 project, these flags and the Config files; run it again to change them",
  )
  .option(...CONFIG_OPTION)
  .option(...NO_CONFIG_OPTION)
  .action((options: { config?: string | false } & Record<string, unknown>) =>
    exitOnServiceError(() => start(options)),
  );
for (const option of configOptions()) startCommand.addOption(option);

const PROJECT_OPTION = [
  "--project <project>",
  "the T3 project whose Daemon to act on: its id, unique title or folder path (default: the Local Config's project, else the repository's, else the only installed Daemon)",
] as const;

/** A command that acts on one installed Daemon, picked the way `start` picks the project. */
function daemonCommand(name: string, description: string) {
  return program
    .command(name)
    .description(description)
    .option(...PROJECT_OPTION)
    .option(...CONFIG_OPTION)
    .option(...NO_CONFIG_OPTION);
}

const ALL_OPTION = ["--all", "act on every installed Daemon, wherever this runs from"] as const;

/** A command that acts on one installed Daemon, or with `--all` on every one. */
const allCommand = (name: string, description: string) =>
  daemonCommand(name, description).addOption(
    new Option(...ALL_OPTION).conflicts(["project", "config"]),
  );

allCommand("stop", "stop the Daemon and keep it from starting at login").action(
  (options: AllOptions) => exitOnServiceError(() => stop(options)),
);

allCommand(
  "restart",
  "restart the Daemon with what `start` pinned, e.g. to pick up Config file changes; the project and flags stay pinned until `start` again",
).action((options: AllOptions) => exitOnServiceError(() => restart(options)));

program
  .command("status")
  .description(
    "show every installed Daemon, whether it's running and where its files are, wherever this runs from",
  )
  .action(() => exitOnServiceError(status));

daemonCommand("logs", "show the Daemon's recent output")
  .option("-f, --follow", "keep printing new output")
  .action((options: TargetOptions & { follow?: boolean }) =>
    exitOnServiceError(() => logs(options)),
  );

allCommand(
  "uninstall",
  "stop the Daemon and remove its background service; keeps the Config, Credentials, State and log",
).action((options: AllOptions) => exitOnServiceError(() => uninstall(options)));

await program.parseAsync();
