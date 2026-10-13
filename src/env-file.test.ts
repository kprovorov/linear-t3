import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    const before = "# OTHER_KEY=old\n#T3_TOKEN=old\n";
    expect(upsertEnv(before, { OTHER_KEY: "new", T3_TOKEN: "new" })).toBe(
      "# OTHER_KEY=old\n#T3_TOKEN=old\nOTHER_KEY=new\nT3_TOKEN=new\n",
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-file-"));
    path = join(dir, "linear-t3", "credentials");
  });

  const mode = (file: string) => statSync(file).mode & 0o777;

  test("creates the file and its directory, with mode 0600", () => {
    new EnvFile(path).set({ T3_TOKEN: "tok" });
    expect(readFileSync(path, "utf8")).toBe("T3_TOKEN=tok\n");
    expect(mode(path)).toBe(0o600);
  });

  test("updates an existing file and tightens its mode to 0600", () => {
    mkdirSync(dirname(path));
    writeFileSync(path, "A=1\nT3_TOKEN=old\n");
    chmodSync(path, 0o644);
    new EnvFile(path).set({ T3_TOKEN: "new" });
    expect(readFileSync(path, "utf8")).toBe("A=1\nT3_TOKEN=new\n");
    expect(mode(path)).toBe(0o600);
  });

  test("reads a key's current value", () => {
    const env = new EnvFile(path);
    expect(env.get("LINEAR_API_KEY")).toBeUndefined();
    mkdirSync(dirname(path));
    writeFileSync(path, "# T3_TOKEN=commented\nT3_TOKEN=\nLINEAR_API_KEY=lin_real\n");
    expect(env.get("T3_TOKEN")).toBeUndefined();
    expect(env.get("LINEAR_API_KEY")).toBe("lin_real");
  });
});
