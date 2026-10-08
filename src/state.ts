import { readFile, rename, writeFile } from "node:fs/promises";

export interface LaunchRecord {
  identifier: string;
  threadId: string;
  launchedAt: string;
}

/** Remembers which Linear issues already have a T3 thread, so restarts never relaunch them. */
export class StateStore {
  private readonly path: string;
  private launched: Record<string, LaunchRecord> = {};

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      this.launched = JSON.parse(await readFile(this.path, "utf8")).launched ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  has(issueId: string): boolean {
    return issueId in this.launched;
  }

  async record(issueId: string, record: LaunchRecord): Promise<void> {
    this.launched[issueId] = record;
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ launched: this.launched }, null, 2));
    await rename(tmp, this.path);
  }
}
