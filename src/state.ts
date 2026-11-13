import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

export interface PendingActions {
  comment?: boolean;
  moveToState?: string;
}

export interface LaunchRecord {
  identifier: string;
  threadId: string;
  launchedAt: string;
  // The T3 project the thread launched into. Only Daemons for that project retry its pending
  // actions; records from before it was kept have none, and any Daemon retries those.
  projectId?: string;
  // Linear updates still to be done for this issue; retried every poll until they succeed.
  pendingActions?: PendingActions;
}

// A write holds the lock for milliseconds, so a lock this old was left by a Daemon that died.
const STALE_LOCK_MS = 30_000;
// Longer than STALE_LOCK_MS, so a stale lock is always taken over before a writer gives up.
const LOCK_WAIT_MS = 45_000;
const LOCK_RETRY_MS = 25;

/**
 * Remembers which Linear issues already have a T3 thread, so restarts never relaunch them.
 * Several Daemons share the file: each write takes a lock next to it, rereads it, merges in one
 * issue's record and saves it atomically, so no Daemon erases another's records.
 */
export class StateStore {
  private readonly path: string;
  private readonly lockPath: string;
  private launched: Record<string, LaunchRecord> = {};

  constructor(path: string) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  /**
   * Reads the State, with what every Daemon has recorded so far. `checkWritable` saves it straight
   * back, under the lock, to prove it can be saved.
   */
  async load({ checkWritable = false } = {}): Promise<void> {
    // Fail at startup rather than after launching a thread we then can't record.
    if (checkWritable) await this.update(() => {});
    else this.launched = await this.read();
  }

  has(issueId: string): boolean {
    return issueId in this.launched;
  }

  /** Records with Linear updates still to do that a Daemon for `projectId` should retry. */
  withPendingActions(projectId: string): [string, LaunchRecord][] {
    return Object.entries(this.launched).filter(
      ([, r]) => r.pendingActions && (r.projectId === undefined || r.projectId === projectId),
    );
  }

  /**
   * Saves `record` for `issueId`. With `ifAbsent`, keeps a record another Daemon saved since this
   * one last read the State, and returns false.
   */
  async record(issueId: string, record: LaunchRecord, { ifAbsent = false } = {}): Promise<boolean> {
    if (record.pendingActions && Object.keys(record.pendingActions).length === 0)
      delete record.pendingActions;
    let recorded = false;
    await this.update((launched) => {
      if (ifAbsent && issueId in launched) return;
      launched[issueId] = record;
      recorded = true;
    });
    return recorded;
  }

  private async read(): Promise<Record<string, LaunchRecord>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")).launched ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  /** Rereads the file under the lock, applies `change`, and saves the result atomically. */
  private async update(change: (launched: Record<string, LaunchRecord>) => void): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const token = await this.lock();
    try {
      const launched = await this.read();
      change(launched);
      // Unique per process, in case a writer whose lock was taken over as stale is still writing.
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ launched }, null, 2));
      await rename(tmp, this.path);
      this.launched = launched;
    } finally {
      await this.unlock(token);
    }
  }

  /** Takes the lock, returning the token written into it, which proves it's still ours. */
  private async lock(): Promise<string> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    const token = `${process.pid} ${randomUUID()}`;
    for (;;) {
      let handle;
      try {
        handle = await open(this.lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (handle) {
        try {
          await handle.writeFile(token);
        } catch (error) {
          await unlink(this.lockPath).catch(() => {});
          throw error;
        } finally {
          await handle.close();
        }
        return token;
      }
      if (await this.removeIfStale()) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.lockPath} has been locked for over ${LOCK_WAIT_MS / 1000}s by another Daemon`,
        );
      }
      await setTimeout(LOCK_RETRY_MS);
    }
  }

  /** Removes the lock unless another Daemon took it over as stale. */
  private async unlock(token: string): Promise<void> {
    const holder = await readFile(this.lockPath, "utf8").catch(() => undefined);
    if (holder === token) await unlink(this.lockPath).catch(() => {});
  }

  /**
   * Removes the lock if a Daemon that died left it behind. Several Daemons may find the same stale
   * lock, so removal happens under a second lock, and the lock is checked again under it: one that
   * another Daemon just replaced is fresh, and stays.
   */
  private async removeIfStale(): Promise<boolean> {
    if (!(await this.isStale(this.lockPath))) return false;
    const breakPath = `${this.lockPath}.break`;
    try {
      await (await open(breakPath, "wx")).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A Daemon that died while removing a stale lock left this behind.
      if (await this.isStale(breakPath)) await unlink(breakPath).catch(() => {});
      return false;
    }
    try {
      if (await this.isStale(this.lockPath)) await unlink(this.lockPath).catch(() => {});
      return true;
    } finally {
      await unlink(breakPath).catch(() => {});
    }
  }

  /** Whether the file at `path` is older than a live lock can be; a missing one counts. */
  private async isStale(path: string): Promise<boolean> {
    try {
      return Date.now() - (await stat(path)).mtimeMs >= STALE_LOCK_MS;
    } catch (error) {
      // Released between our attempt and now: try again straight away.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
}
