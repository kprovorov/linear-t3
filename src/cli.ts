import { existsSync, readFileSync } from "node:fs";
import { sep } from "node:path";
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
import { loadConfig } from "./config.ts";
import { resolvePaths, resolveStateFile } from "./paths.ts";
import { preflight } from "./preflight.ts";
import { ServiceError, daemonUnit, serviceManager } from "./service.ts";
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

const paths = () => resolvePaths(program.opts<{ config?: string }>().config);

/** Every integration `connect` knows about, in the order plain `connect` runs them. */
const integrations = {
  t3: async () => t3Integration({ baseUrl: await t3BaseUrl(paths().config) }),
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

async function runDaemonCommand({ once = false, dryRun = false }): Promise<void> {
  try {
    // A dry run only lists issues, so polling again would just list them again.
    await runDaemon({
      paths: paths(),
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

async function start(): Promise<void> {
  const where = paths();
  const manager = serviceManager(where);
  // npm can clean the npx cache at any time, which would leave the service pointing at nothing.
  if ([process.argv[1], cliPath].some((path) => path?.split(sep).includes("_npx"))) {
    throw new ServiceError(
      "linear-t3 is running from the npx cache, which npm may clean up. Install it first with `npm i -g linear-t3`, then run `linear-t3 start`",
    );
  }
  const problems = await preflight(where);
  if (problems.length > 0) {
    throw new ServiceError(
      ["The Daemon would not start, so it wasn't installed:", ...problems].join("\n"),
    );
  }
  await manager.install(daemonUnit(where, cliPath));
  console.log(`Started the Daemon (launchd agent ${manager.unitPath})`);
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
  if (manager.installed()) {
    const { running, pid, uptime } = await manager.status();
    daemon = running ? `running (pid ${pid}${uptime ? `, up ${uptime}` : ""})` : "stopped";
    const node = manager.pinnedNode();
    if (node && !existsSync(node)) {
      console.error(
        `The Daemon runs ${node}, which no longer exists; run \`linear-t3 start\` again to use this node`,
      );
    }
  }
  // An unreadable Config can't say where State is, so show where it would be by default.
  const state = await loadConfig(where.config).then(
    (config) => resolveStateFile(where, config.stateFile),
    () => where.defaultState,
  );
  console.log(
    [
      `Daemon:      ${daemon}`,
      `Config:      ${where.config}`,
      `Credentials: ${where.credentials}`,
      `State:       ${state}`,
      `Log:         ${where.log}`,
      `Unit:        ${manager.unitPath}`,
    ].join("\n"),
  );
}

async function logs({ follow = false }): Promise<void> {
  process.exitCode = await installedService().logs(follow);
}

const program = new Command("linear-t3")
  .version(pkg.version)
  .option(
    "--config <path>",
    "the Config file (default: $LINEAR_T3_CONFIG or $XDG_CONFIG_HOME/linear-t3/config.json)",
  )
  // Subcommand help lists --config too; set before adding commands so they inherit it.
  .configureHelp({ showGlobalOptions: true })
  .action(() => program.help());

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

program
  .command("run")
  .description("run the Daemon in the foreground: poll Linear and launch T3 threads")
  .option("--once", "do one poll, then exit")
  .option("--dry-run", "list the issues it would launch without starting threads, then exit")
  .action(runDaemonCommand);

program
  .command("start")
  .description("install and start the Daemon as a background service; safe to run again")
  .action(() => exitOnServiceError(start));

program
  .command("stop")
  .description("stop the Daemon and keep it from starting at login")
  .action(() => exitOnServiceError(stop));

program
  .command("restart")
  .description("restart the Daemon, e.g. to pick up Config changes")
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
