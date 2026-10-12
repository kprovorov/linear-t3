import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vite-plus/test";

const cliPath = new URL("./cli.ts", import.meta.url).pathname;

function runCli(...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
  return { status, stdout, stderr };
}

describe("cli", () => {
  test.each(["--version", "-V"])("%s prints the package version and exits 0", (flag) => {
    const result = runCli(flag);
    expect(result).toEqual({ status: 0, stdout: "0.1.0\n", stderr: "" });
  });

  test.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }])(
    "$args prints help and exits 0",
    ({ args }) => {
      const result = runCli(...args);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^Usage: linear-t3 /);
      expect(result.stdout).toContain("-V, --version");
      expect(result.stdout).toContain("-h, --help");
    },
  );

  test("an unknown flag prints an error and exits non-zero", () => {
    const result = runCli("--bogus");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown option '--bogus'");
  });
});
