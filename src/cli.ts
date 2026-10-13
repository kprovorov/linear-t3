import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
import { resolvePaths } from "./paths.ts";
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

// Resolved from this module, so it's found both from `src/` and from the bundle in `dist/`.
const configTemplate = new URL("../config.template.json", import.meta.url);

function runSetup(): void {
  const { config } = paths();
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
      `Wrote a starter Config to ${config}`,
      "",
      "Next steps:",
      "  1. Edit its projects: your T3 projects, their Linear teams and filters",
      "  2. Run `linear-t3 connect` to save the T3 and Linear tokens",
      "  3. Run `linear-t3 start` to run the Daemon in the background",
    ].join("\n"),
  );
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
  .command("setup")
  .description("write a starter Config to edit (refuses if the Config already exists)")
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

program
  .command("run")
  .description("run the Daemon in the foreground: poll Linear and launch T3 threads")
  .option("--once", "do one poll, then exit")
  .option("--dry-run", "list the issues it would launch without starting threads, then exit")
  .action(runDaemonCommand);

await program.parseAsync();
