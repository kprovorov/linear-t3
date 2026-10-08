import type { LinearDocument } from "./linear.ts";

// Overlap with the previous scan to cover clock skew and updates in flight during it.
const OVERLAP_MS = 5 * 60_000;

interface ScanState {
  since: number;
  lastFullScan: number;
  carry: Set<string>;
}

export interface PlannedScan {
  filter: LinearDocument.IssueFilter;
  full: boolean;
}

/**
 * Keeps each project's Linear query bounded. A full scan reads every matching issue. Between
 * full scans, a poll only reads issues updated since the previous scan (an issue usually starts
 * matching through its own update, e.g. a label or state change), plus issues carried over
 * because they matched but weren't launched (capped, failed, or backing off). Full scans repeat
 * every `fullScanIntervalMs` to catch issues that start matching without being updated
 * themselves, e.g. when a label, state or project they reference is renamed.
 */
export class ScanTracker {
  private readonly scans = new Map<string, ScanState>();
  private readonly fullScanIntervalMs: number;

  constructor(fullScanIntervalMs: number) {
    this.fullScanIntervalMs = fullScanIntervalMs;
  }

  plan(projectRef: string, base: LinearDocument.IssueFilter[], now = Date.now()): PlannedScan {
    const previous = this.scans.get(projectRef);
    if (!previous || now - previous.lastFullScan >= this.fullScanIntervalMs) {
      return { filter: { and: base }, full: true };
    }
    const recent: LinearDocument.IssueFilter[] = [
      { updatedAt: { gt: new Date(previous.since - OVERLAP_MS).toISOString() } },
    ];
    if (previous.carry.size > 0) recent.push({ id: { in: [...previous.carry] } });
    return { filter: { and: [...base, { or: recent }] }, full: false };
  }

  /** Records a completed scan; `unlaunched` are the matching issues still without a thread. */
  complete(projectRef: string, scan: { startedAt: number; full: boolean }, unlaunched: string[]): void {
    const lastFullScan = scan.full ? scan.startedAt : (this.scans.get(projectRef)?.lastFullScan ?? scan.startedAt);
    this.scans.set(projectRef, { since: scan.startedAt, lastFullScan, carry: new Set(unlaunched) });
  }
}
