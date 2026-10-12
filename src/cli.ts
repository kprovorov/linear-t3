import { readFileSync } from "node:fs";
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
import { EnvFile } from "./env-file.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** The config file the daemon would use: `CONFIG_PATH` from the environment or `.env`. */
const configPath = (env: EnvFile) =>
  resolve(process.env.CONFIG_PATH ?? env.get("CONFIG_PATH") ?? "config.json");

/** Every service `connect` knows about, in the order plain `connect` runs them. */
const services = {
  t3: async (env) => t3Service({ baseUrl: await t3BaseUrl(configPath(env)) }),
  linear: async () => ({ name: "Linear" }),
} satisfies Record<string, (env: EnvFile) => Promise<Service | PendingService>>;

type ServiceName = keyof typeof services;
const serviceNames = Object.keys(services) as ServiceName[];

const clackUi: Ui = {
  async confirm(message) {
    const answer = await clack.confirm({ message, initialValue: false });
    if (clack.isCancel(answer)) throw new CancelledError();
    return answer;
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
  warn: (message) => clack.log.warn(message),
};

function summary(outcome: Outcome): string {
  const who = outcome.identity ? ` (${outcome.identity})` : "";
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

const program = new Command("linear-t3").version(pkg.version).action(() => program.help());

program
  .command("connect")
  .description("check and save the T3 and Linear tokens in ./.env")
  .addArgument(
    new Argument("[service]", "connect only this service (default: all, in order)").choices(
      serviceNames,
    ),
  )
  .action(runConnect);

await program.parseAsync();
