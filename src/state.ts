import { readFile, rename, writeFile } from "node:fs/promises";

export interface PendingActions {
  comment?: boolean;
  moveToState?: string;
}

export interface LaunchRecord {
  identifier: string;
  threadId: string;
  launchedAt: string;
  // Linear updates still to be done for this issue; retried every poll until they succeed.
  pendingActions?: PendingActions;
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
    // Fail at startup rather than after launching a thread we then can't record.
    await this.save();
  }

  has(issueId: string): boolean {
    return issueId in this.launched;
  }

  withPendingActions(): [string, LaunchRecord][] {
    return Object.entries(this.launched).filter(([, r]) => r.pendingActions);
  }

  async record(issueId: string, record: LaunchRecord): Promise<void> {
    if (record.pendingActions && Object.keys(record.pendingActions).length === 0)
      delete record.pendingActions;
    this.launched[issueId] = record;
    await this.save();
  }

  private async save(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ launched: this.launched }, null, 2));
    await rename(tmp, this.path);
  }
}
