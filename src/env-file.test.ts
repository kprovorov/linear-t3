import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { EnvFile, upsertEnv } from "./env-file.ts";

describe("upsertEnv", () => {
  test("replaces an existing key in place", () => {
    const before = "A=1\nT3_TOKEN=old\nB=2\n";
    expect(upsertEnv(before, { T3_TOKEN: "new" })).toBe("A=1\nT3_TOKEN=new\nB=2\n");
  });

  test.each([
    { before: "A=1\n", after: "A=1\nT3_TOKEN=new\n" },
    { before: "A=1", after: "A=1\nT3_TOKEN=new\n" },
    { before: "", after: "T3_TOKEN=new\n" },
  ])("appends a missing key to $before", ({ before, after }) => {
    expect(upsertEnv(before, { T3_TOKEN: "new" })).toBe(after);
  });

  test("keeps comments, blank lines, other keys and their order", () => {
    const before = "# header\n\nB=2\n# note\nT3_TOKEN=old\n\nA=1\n";
    expect(upsertEnv(before, { T3_TOKEN: "new", LINEAR_API_KEY: "lin" })).toBe(
      "# header\n\nB=2\n# note\nT3_TOKEN=new\n\nA=1\nLINEAR_API_KEY=lin\n",
    );
  });

  test("leaves commented-out keys untouched", () => {
    const before = "# CONFIG_PATH=./config.json\n#T3_TOKEN=old\n";
    expect(upsertEnv(before, { CONFIG_PATH: "./other.json", T3_TOKEN: "new" })).toBe(
      "# CONFIG_PATH=./config.json\n#T3_TOKEN=old\nCONFIG_PATH=./other.json\nT3_TOKEN=new\n",
    );
  });

  test("fills in .env.example contents", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(upsertEnv(example, { T3_TOKEN: "t3tok", LINEAR_API_KEY: "lin_api_real" })).toBe(
      [
        "# Linear personal API key: Linear -> Settings -> Security & access -> Personal API keys",
        "LINEAR_API_KEY=lin_api_real",
        "# T3 Code bearer token: t3 auth session issue --label linear-t3 --ttl 365d --token-only",
        "T3_TOKEN=t3tok",
        "# CONFIG_PATH=./config.json",
        "",
      ].join("\n"),
    );
  });

  test("gives the same result when run twice with the same input", () => {
    const before = "# c\nA=1\n\nT3_TOKEN=old\n";
    const updates = { T3_TOKEN: "new", LINEAR_API_KEY: "lin" };
    const once = upsertEnv(before, updates);
    expect(upsertEnv(before, updates)).toBe(once);
    expect(upsertEnv(once, updates)).toBe(once);
  });
});

describe("EnvFile", () => {
  let dir: string;
  let path: string;
  let examplePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-file-"));
    path = join(dir, ".env");
    examplePath = join(dir, ".env.example");
  });

  const mode = (file: string) => statSync(file).mode & 0o777;

  test("creates .env from .env.example with mode 0600", () => {
    writeFileSync(examplePath, "# comment\nT3_TOKEN=\n", { mode: 0o644 });
    new EnvFile(path, examplePath).set({ T3_TOKEN: "tok" });
    expect(readFileSync(path, "utf8")).toBe("# comment\nT3_TOKEN=tok\n");
    expect(mode(path)).toBe(0o600);
  });

  test("creates .env from scratch when there is no .env.example", () => {
    new EnvFile(path, examplePath).set({ T3_TOKEN: "tok" });
    expect(readFileSync(path, "utf8")).toBe("T3_TOKEN=tok\n");
    expect(mode(path)).toBe(0o600);
  });

  test("updates an existing .env and tightens its mode to 0600", () => {
    writeFileSync(path, "A=1\nT3_TOKEN=old\n");
    chmodSync(path, 0o644);
    writeFileSync(examplePath, "IGNORED=1\n");
    new EnvFile(path, examplePath).set({ T3_TOKEN: "new" });
    expect(readFileSync(path, "utf8")).toBe("A=1\nT3_TOKEN=new\n");
    expect(mode(path)).toBe(0o600);
  });

  test("reads a key's current value from .env only", () => {
    writeFileSync(examplePath, "LINEAR_API_KEY=lin_api_xxx\n");
    const env = new EnvFile(path, examplePath);
    expect(env.get("LINEAR_API_KEY")).toBeUndefined();
    writeFileSync(path, "# T3_TOKEN=commented\nT3_TOKEN=\nLINEAR_API_KEY=lin_real\n");
    expect(env.get("T3_TOKEN")).toBeUndefined();
    expect(env.get("LINEAR_API_KEY")).toBe("lin_real");
  });
});
