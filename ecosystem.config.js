// pm2 start (pm2 picks up ecosystem.config.js from the current directory)
// pm2 loads this with require(), which only sees named exports of an ES module.
export const apps = [
  {
    name: "linear-t3",
    script: "src/main.ts",
    cwd: import.meta.dirname,
    // Node loads .env itself and strips TypeScript types natively; no build step.
    node_args: "--env-file=.env",
    autorestart: true,
    restart_delay: 10_000,
    // main.ts finishes the current launch and exits cleanly on SIGINT.
    kill_timeout: 30_000,
  },
];
