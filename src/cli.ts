import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import { Argument, Command } from "commander";
import {
  CancelledError,
  ConnectError,
  type Outcome,
  type PendingService,
  type Service,
  type Ui,
  connect,
} from "./connect.ts";
import { t3BaseUrl, t3Service } from "./connect-t3.ts";
import { runDaemon } from "./daemon.ts";
import { EnvFile } from "./env-file.ts";
import { checkLinear } from "./token-check.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const linear: Service = {
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

/** The Config file: `--config`, else `CONFIG_PATH` from the environment or `.env`. */
const configPath = (env?: EnvFile) =>
  resolve(
    program.opts<{ config?: string }>().config ??
      process.env.CONFIG_PATH ??
      env?.get("CONFIG_PATH") ??
      "config.json",
  );

/** Every service `connect` knows about, in the order plain `connect` runs them. */
const services = {
  t3: async (env) => t3Service({ baseUrl: await t3BaseUrl(configPath(env)) }),
  linear: async () => linear,
} satisfies Record<string, (env: EnvFile) => Promise<Service | PendingService>>;

type ServiceName = keyof typeof services;
const serviceNames = Object.keys(services) as ServiceName[];

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
  return `${outcome.service}: ${outcome.action === "saved" ? "token saved" : "kept existing token"}${who}`;
}

async function runConnect(service: ServiceName | undefined): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("connect is interactive, run it in a terminal");
    process.exit(1);
  }
  const env = new EnvFile(resolve(".env"), resolve(".env.example"));
  const selected = await Promise.all(
    (service ? [service] : serviceNames).map((name) => services[name](env)),
  );

  clack.intro("linear-t3 connect");
  try {
    const outcomes = await connect(selected, env, clackUi);
    const saved = outcomes.some((outcome) => outcome.action === "saved");
    const where = saved ? `Saved to ${env.path}` : `${env.path} unchanged`;
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
  // Tokens (and CONFIG_PATH) still come from ./.env for now; variables already set win.
  if (existsSync(".env")) process.loadEnvFile(".env");
  try {
    // A dry run only lists issues, so polling again would just list them again.
    await runDaemon({
      configPath: configPath(),
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
  .option("--config <path>", "the Config file (default: $CONFIG_PATH or ./config.json)")
  // Subcommand help lists --config too; set before adding commands so they inherit it.
  .configureHelp({ showGlobalOptions: true })
  .action(() => program.help());

program
  .command("connect")
  .description("check and save the T3 and Linear tokens in ./.env")
  .addArgument(
    new Argument("[service]", "connect only this service (default: all, in order)").choices(
      serviceNames,
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
