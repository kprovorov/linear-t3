import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Paths } from "./paths.ts";
import {
  type ServiceManager,
  ServiceError,
  type Unit,
  elapsed,
  runAttached,
  runCommand,
} from "./service.ts";

const NAME = "linear-t3";
const UNIT = `${NAME}.service`;
// Seconds systemd waits before restarting a crashed Daemon, and after SIGTERM before SIGKILL.
const RESTART_DELAY = 10;
const STOP_TIMEOUT = 30;

/** `text` as one quoted word of a unit file, with `%` doubled so it isn't read as a specifier. */
const quoteWord = (text: string) => `"${text.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
/** `arg` as a word of `ExecStart`, which also expands `$`, so that's doubled too. */
const quoteArg = (arg: string) => quoteWord(arg).replace(/\$/g, "$$$$");
const unquote = (word: string) =>
  word.replace(/\$\$/g, "$").replace(/%%/g, "%").replace(/\\(.)/g, "$1");

function unitFile(unit: Unit): string {
  const env = Object.entries(unit.env)
    .map(([key, value]) => `Environment=${quoteWord(`${key}=${value}`)}\n`)
    .join("");
  return `[Unit]
Description=linear-t3 Daemon

[Service]
ExecStart=${unit.program.map(quoteArg).join(" ")}
${env}Restart=on-failure
RestartSec=${RESTART_DELAY}
TimeoutStopSec=${STOP_TIMEOUT}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

/** Runs `systemctl --user`, throwing with its output if it fails. */
async function systemctl(...args: string[]): Promise<string> {
  const { ok, output } = await runCommand("systemctl", ["--user", ...args]);
  if (!ok) throw new ServiceError(`\`systemctl --user ${args.join(" ")}\` failed: ${output}`);
  return output;
}

/** Whether systemd keeps this user's services running after they log out. */
async function lingering(): Promise<boolean> {
  const { ok, output } = await runCommand("loginctl", [
    "show-user",
    String(process.getuid!()),
    "--property=Linger",
    "--value",
  ]).catch(() => ({ ok: false, output: "" }));
  return ok && output.trim() === "yes";
}

/** The Daemon as a systemd user unit in `$XDG_CONFIG_HOME/systemd/user`. */
export function systemd(paths: Paths): ServiceManager {
  const unitPath = paths.systemdUnit;
  // `stop` disables the unit, so enable it again before starting it.
  const enableAndStart = async () => {
    await systemctl("enable", UNIT);
    // restart rather than start, so a running Daemon picks up a rewritten unit.
    await systemctl("restart", UNIT);
  };

  return {
    kind: "systemd user unit",
    unitPath,
    logLocation: `journalctl --user -u ${NAME}`,
    installed: () => existsSync(unitPath),
    pinnedNode() {
      if (!existsSync(unitPath)) return undefined;
      const node = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(readFileSync(unitPath, "utf8"));
      return node ? unquote(node[1]!) : undefined;
    },

    async install(unit) {
      mkdirSync(dirname(unitPath), { recursive: true });
      writeFileSync(unitPath, unitFile(unit));
      await systemctl("daemon-reload");
      await enableAndStart();
    },
    async stop() {
      await systemctl("disable", "--now", UNIT);
    },
    restart: enableAndStart,
    async status() {
      const output = await systemctl("show", UNIT, "--property=ActiveState,SubState,MainPID");
      const property = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(output)?.[1];
      const pid = Number(property("MainPID"));
      const hint = (await lingering())
        ? undefined
        : "The Daemon only runs while you're logged in. To keep it running after you log out, run `loginctl enable-linger`";
      if (property("ActiveState") !== "active" || !pid) return { running: false, hint };
      return { running: true, pid, uptime: await elapsed(pid), hint };
    },
    logs: (follow) =>
      runAttached("journalctl", [
        "--user",
        "-u",
        NAME,
        "-n",
        "100",
        "--no-pager",
        ...(follow ? ["-f"] : []),
      ]),
    async uninstall() {
      await systemctl("disable", "--now", UNIT);
      rmSync(unitPath, { force: true });
      await systemctl("daemon-reload");
    },
  };
}
