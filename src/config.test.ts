import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { loadConfig } from "./config.ts";

function writeConfig(config: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "config-")), "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("loadConfig", () => {
  test("still loads configs with the removed fullScanIntervalMinutes key", async () => {
    const path = writeConfig({
      fullScanIntervalMinutes: 60,
      projects: { app: { linear: { team: "ENG" } } },
    });
    const config = await loadConfig(path);
    expect(config).not.toHaveProperty("fullScanIntervalMinutes");
    expect(config.projects.app?.linear.team).toBe("ENG");
  });

  test.each([-1, 1.5, "2"])("rejects maxRunningThreads %j", async (value) => {
    const path = writeConfig({
      maxRunningThreads: value,
      projects: { app: { linear: { team: "ENG" } } },
    });
    await expect(loadConfig(path)).rejects.toThrow(/maxRunningThreads/);
  });

  test.each([0, 3, undefined])("accepts maxRunningThreads %j", async (value) => {
    const path = writeConfig({
      maxRunningThreads: value,
      projects: { app: { linear: { team: "ENG" } } },
    });
    expect((await loadConfig(path)).maxRunningThreads).toBe(value);
  });
});
