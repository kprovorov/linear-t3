import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Paths } from "./paths.ts";
import {
  type ServicePlatform,
  ServiceError,
  type Unit,
  type UnitManager,
  checkUnitId,
  elapsed,
  listUnits,
  runAttached,
  runCommand,
} from "./service.ts";

/** Each Daemon's label is this, a dot and its T3 project's id. */
const LABEL_PREFIX = "linear-t3.";
/** The label of the single agent from before each T3 project had its own Daemon. */
const LEGACY_LABEL = "linear-t3";
const AGENT_FILE = /^linear-t3\.(.+)\.plist$/;
// Seconds launchd waits before restarting a crashed Daemon, and after SIGTERM before SIGKILL.
const RESTART_DELAY = 10;
const STOP_TIMEOUT = 30;
const BOOTSTRAP_ATTEMPTS = 5;

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const string = (text: string) => `<string>${escapeXml(text)}</string>`;

function plist(label: string, unit: Unit, log: string): string {
  const env = Object.entries(unit.env)
    .map(([key, value]) => `\t\t<key>${key}</key>\n\t\t${string(value)}\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${string(label)}
\t<key>ProgramArguments</key>
\t<array>
${unit.program.map((arg) => `\t\t${string(arg)}\n`).join("")}\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>${RESTART_DELAY}</integer>
\t<key>ExitTimeOut</key>
\t<integer>${STOP_TIMEOUT}</integer>
\t<key>StandardOutPath</key>
\t${string(log)}
\t<key>StandardErrorPath</key>
\t${string(log)}
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => runCommand("launchctl", args);

/** Runs `launchctl`, throwing with its output if it fails. */
async function mustLaunchctl(...args: string[]): Promise<string> {
  const { ok, output } = await launchctl(...args);
  if (!ok) throw new ServiceError(`\`launchctl ${args.join(" ")}\` failed: ${output}`);
  return output;
}

/** Prints the end of `log` and, with `follow`, what gets added to it until interrupted. */
function tail(log: string, follow: boolean): Promise<number> {
  if (!existsSync(log)) {
    console.log(`No logs yet at ${log}`);
    if (!follow) return Promise.resolve(0);
  }
  // -F rather than -f, so tail waits for a log that doesn't exist yet.
  return runAttached("tail", ["-n", "100", ...(follow ? ["-F"] : []), log]);
}

/** What the agent at `path` runs, read back from it. */
function readAgent(path: string): Unit {
  const agent = readFileSync(path, "utf8");
  const strings = (xml = "") =>
    [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescapeXml(match[1]!));
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(agent);
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(agent)?.[1];
  const pairs = (env ?? "").matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g);
  return {
    program: strings(program?.[1]),
    env: Object.fromEntries(
      [...pairs].map(([, key, value]) => [unescapeXml(key!), unescapeXml(value!)]),
    ),
  };
}

/** Each Daemon as a launchd agent in `~/Library/LaunchAgents`, labeled by its T3 project's id. */
export function launchd(paths: Paths): ServicePlatform {
  const agentPath = (project: string) =>
    join(paths.launchAgents, `${LABEL_PREFIX}${project}.plist`);
  return {
    daemon(project) {
      checkUnitId(project);
      // Each Daemon writes its own log, so `logs` shows one project's output.
      const log = join(paths.logs, `daemon-${project}.log`);
      return { project, ...agent(`${LABEL_PREFIX}${project}`, agentPath(project), log) };
    },
    list: () => listUnits(paths.launchAgents, AGENT_FILE, readAgent),
    legacy: () =>
      agent(
        LEGACY_LABEL,
        join(paths.launchAgents, `${LEGACY_LABEL}.plist`),
        join(paths.logs, "daemon.log"),
      ),
  };
}

/** The launchd agent labeled `label` at `agentPath`, logging to `log`. */
function agent(label: string, agentPath: string, log: string): UnitManager {
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${label}`;
  const loaded = async () => (await launchctl("print", target)).ok;
  const unload = async () => {
    if (await loaded()) await mustLaunchctl("bootout", target);
  };
  const load = async () => {
    // `stop` disables the agent, and launchd won't load a disabled one.
    await mustLaunchctl("enable", target);
    // RunAtLoad starts the Daemon as soon as it's loaded. Right after a bootout launchd may still
    // be tearing the old job down and refuse, so give it a few tries.
    for (let attempt = 1; attempt < BOOTSTRAP_ATTEMPTS; attempt++) {
      if ((await launchctl("bootstrap", domain, agentPath)).ok) return;
      await setTimeout(1000);
    }
    await mustLaunchctl("bootstrap", domain, agentPath);
  };

  return {
    kind: "launchd agent",
    unitPath: agentPath,
    logLocation: log,
    installed: () => existsSync(agentPath),
    pinned: () => (existsSync(agentPath) ? readAgent(agentPath) : undefined),

    async install(unit, start = true) {
      // launchd only rereads the agent when it loads it, so unload the old one first.
      await unload();
      mkdirSync(dirname(agentPath), { recursive: true });
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(agentPath, plist(label, unit, log));
      // Disabled and unloaded, the way `stop` leaves it.
      if (start) await load();
      else await mustLaunchctl("disable", target);
    },
    async stop() {
      await unload();
      // A disabled agent stays unloaded at the next login, even though its file is still there.
      await mustLaunchctl("disable", target);
    },
    async restart() {
      if (await loaded()) await mustLaunchctl("kickstart", "-k", target);
      else await load();
    },
    async status() {
      // `print` fails for an agent that isn't loaded, which is as stopped as it gets. Only the
      // top-level fields count, not those of nested blocks, which are indented further.
      const { ok, output } = await launchctl("print", target);
      const running = ok && /^\tstate = running$/m.test(output);
      const pid = /^\tpid = (\d+)$/m.exec(output)?.[1];
      if (!running || !pid) return { running: false };
      return { running, pid: Number(pid), uptime: await elapsed(Number(pid)) };
    },
    logs: (follow) => tail(log, follow),
    async uninstall() {
      await unload();
      rmSync(agentPath, { force: true });
    },
  };
}
