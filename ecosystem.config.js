// pm2 start (pm2 picks up ecosystem.config.js from the current directory)
// pm2 loads this with require(), which only sees named exports of an ES module.
export const apps = [
  {
    name: "linear-t3",
    script: "src/cli.ts",
    args: "run",
    cwd: import.meta.dirname,
    // `run` loads .env itself and Node strips TypeScript types natively; no build step.
    // pm2 runs .ts scripts with Bun when it's installed, so pin Node.
    interpreter: "node",
    autorestart: true,
    restart_delay: 10_000,
    // `run` finishes the current launch and exits cleanly on SIGINT.
    kill_timeout: 30_000,
  },
];
