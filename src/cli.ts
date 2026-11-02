#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { Argument, Command } from "commander";
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
import { ServiceError, daemonUnit, pinnedTo, serviceManager } from "./service.ts";
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

async function start(
  options: { config?: string | false } & Record<string, unknown>,
): Promise<void> {
  const where = paths();
  const manager = serviceManager(where);
  // npm can clean the npx cache at any time, which would leave the service pointing at nothing.
  if ([process.argv[1], cliPath].some((path) => path?.split(sep).includes("_npx"))) {
    throw new ServiceError(
      "linear-t3 is running from the npx cache, which npm may clean up. Install it first with `npm i -g linear-t3`, then run `linear-t3 start`",
    );
  }
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
      `Pinned to T3 project "${project.title}" (${project.id})`,
    ].join("\n"),
  );
}

/** The service manager, once `start` has installed the Daemon. */
function installedService() {
  const manager = serviceManager(paths());
  if (!manager.installed()) {
    throw new ServiceError(
      "The Daemon isn't installed as a background service; run `linear-t3 start`",
    );
  }
  return manager;
}

async function stop(): Promise<void> {
  await installedService().stop();
  console.log("Stopped the Daemon; it won't start at login until `linear-t3 start`");
}

async function restart(): Promise<void> {
  await installedService().restart();
  console.log("Restarted the Daemon");
}

async function uninstall(): Promise<void> {
  const manager = installedService();
  await manager.uninstall();
  console.log(`Removed ${manager.unitPath}; the Config, Credentials and State are kept`);
}

async function status(): Promise<void> {
  const where = paths();
  const manager = serviceManager(where);
  let daemon = "not installed, run `linear-t3 start`";
  let hint: string | undefined;
  let pinned: ReturnType<typeof pinnedTo> | undefined;
  const unit = manager.installed() ? manager.pinned() : undefined;
  if (unit) {
    const service = await manager.status();
    const { running, pid, uptime } = service;
    hint = service.hint;
    daemon = running ? `running (pid ${pid}${uptime ? `, up ${uptime}` : ""})` : "stopped";
    const node = unit.program[0];
    if (node && !existsSync(node)) {
      console.error(
        `The Daemon runs ${node}, which no longer exists; run \`linear-t3 start\` again to use this node`,
      );
    }
    pinned = pinnedTo(unit);
  }
  const globalConfig = pinned?.globalConfig ?? where.globalConfig;
  // An unreadable Config can't say where State is, so show where it would be by default.
  const state = await loadGlobalConfig(globalConfig).then(
    (config) => config.stateFile ?? where.defaultState,
    () => where.defaultState,
  );
  // The pinned rows only exist once installed. Units from before projects were pinned have none.
  const project = pinned && (pinned.project ?? "not pinned, run `linear-t3 start` again");
  const localConfig = pinned && (pinned.localConfig ?? "none");
  const lines: [string, string | undefined][] = [
    ["Daemon", daemon],
    ["Project", project],
    ["Global Config", globalConfig],
    ["Local Config", localConfig],
    ["Credentials", where.credentials],
    ["State", state],
    ["Log", manager.logLocation],
    ["Unit", manager.unitPath],
  ];
  console.log(
    [
      ...lines.flatMap(([label, value]) =>
        value === undefined ? [] : [`${`${label}:`.padEnd(15)}${value}`],
      ),
      ...(hint ? ["", hint] : []),
    ].join("\n"),
  );
}

async function logs({ follow = false }): Promise<void> {
  process.exitCode = await installedService().logs(follow);
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

program
  .command("stop")
  .description("stop the Daemon and keep it from starting at login")
  .action(() => exitOnServiceError(stop));

program
  .command("restart")
  .description(
    "restart the Daemon with what `start` pinned, e.g. to pick up Config file changes; the project and flags stay pinned until `start` again",
  )
  .action(() => exitOnServiceError(restart));

program
  .command("status")
  .description("show whether the Daemon is running and where its files are")
  .action(() => exitOnServiceError(status));

program
  .command("logs")
  .description("show the Daemon's recent output")
  .option("-f, --follow", "keep printing new output")
  .action((options: { follow?: boolean }) => exitOnServiceError(() => logs(options)));

program
  .command("uninstall")
  .description(
    "stop the Daemon and remove the background service; keeps Config, Credentials and State",
  )
  .action(() => exitOnServiceError(uninstall));

await program.parseAsync();
