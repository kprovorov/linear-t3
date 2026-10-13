import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type { Paths } from "./paths.ts";
import { type ServiceManager, ServiceError, type Unit, elapsed, runAttached } from "./service.ts";

const LABEL = "linear-t3";
// Seconds launchd waits before restarting a crashed Daemon, and after SIGTERM before SIGKILL.
const RESTART_DELAY = 10;
const STOP_TIMEOUT = 30;
const BOOTSTRAP_ATTEMPTS = 5;

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const string = (text: string) => `<string>${escapeXml(text)}</string>`;

function plist(unit: Unit, log: string): string {
  const env = Object.entries(unit.env)
    .map(([key, value]) => `\t\t<key>${key}</key>\n\t\t${string(value)}\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${string(LABEL)}
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

async function launchctl(...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await promisify(execFile)("launchctl", args, { encoding: "utf8" });
    return { ok: true, output: stdout };
  } catch (error) {
    const { code, stdout, stderr } = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    if (code === "ENOENT") throw new ServiceError("Could not run `launchctl`");
    return { ok: false, output: `${stdout ?? ""}${stderr ?? ""}`.trim() };
  }
}

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

/** The Daemon as a launchd agent in `~/Library/LaunchAgents`. */
export function launchd(paths: Paths): ServiceManager {
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${LABEL}`;
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
      if ((await launchctl("bootstrap", domain, paths.launchAgent)).ok) return;
      await setTimeout(1000);
    }
    await mustLaunchctl("bootstrap", domain, paths.launchAgent);
  };

  return {
    kind: "launchd agent",
    unitPath: paths.launchAgent,
    logLocation: paths.log,
    installed: () => existsSync(paths.launchAgent),
    pinnedNode() {
      if (!existsSync(paths.launchAgent)) return undefined;
      const agent = readFileSync(paths.launchAgent, "utf8");
      const node = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(agent);
      return node ? unescapeXml(node[1]!) : undefined;
    },

    async install(unit) {
      // launchd only rereads the agent when it loads it, so unload the old one first.
      await unload();
      mkdirSync(dirname(paths.launchAgent), { recursive: true });
      mkdirSync(dirname(paths.log), { recursive: true });
      writeFileSync(paths.launchAgent, plist(unit, paths.log));
      await load();
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
    logs: (follow) => tail(paths.log, follow),
    async uninstall() {
      await unload();
      rmSync(paths.launchAgent, { force: true });
    },
  };
}
