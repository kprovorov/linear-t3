// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "linear-t3",
      script: "src/main.ts",
      cwd: __dirname,
      // Node loads .env itself and strips TypeScript types natively; no build step.
      node_args: "--env-file=.env",
      autorestart: true,
      restart_delay: 10_000,
      // main.ts finishes the current launch and exits cleanly on SIGINT.
      kill_timeout: 30_000,
    },
  ],
};
