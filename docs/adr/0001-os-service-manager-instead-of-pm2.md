# Run the daemon under the OS service manager instead of pm2

To ship linear-t3 as an npm package, we dropped pm2. `linear-t3 start` now installs and loads a launchd agent on macOS or a systemd user unit on Linux, and `stop`, `restart` and `status` hand off to `launchctl` and `systemctl --user`. We considered having the CLI supervise itself: fork a detached child and track it with a pidfile. That would have meant building restart-on-crash, start-on-boot and log handling ourselves, which is a small pm2. The OS already does all three reliably, so we use it.

## Consequences

- Only macOS and Linux are supported. Windows has neither launchd nor systemd.
- The unit file stores absolute paths to `node` and the installed CLI. Those paths change when Node or the package is reinstalled somewhere else, so `start` rewrites the unit every time.
