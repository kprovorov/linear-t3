import type { LinearDocument } from "./linear.ts";

// Overlap with the previous scan to cover clock skew and updates in flight during it.
const OVERLAP_MS = 5 * 60_000;

/**
 * Keeps each project's Linear query bounded. The first scan reads every matching issue. Later
 * scans only read issues updated since the previous scan (an issue starts matching through an
 * update, e.g. a label or state change), plus issues carried over because they matched but
 * weren't launched (capped, failed, or backing off).
 */
export class ScanTracker {
  private readonly scans = new Map<string, { since: number; carry: Set<string> }>();

  filter(projectRef: string, base: LinearDocument.IssueFilter[]): LinearDocument.IssueFilter {
    const previous = this.scans.get(projectRef);
    if (!previous) return { and: base };
    const recent: LinearDocument.IssueFilter[] = [
      { updatedAt: { gt: new Date(previous.since - OVERLAP_MS).toISOString() } },
    ];
    if (previous.carry.size > 0) recent.push({ id: { in: [...previous.carry] } });
    return { and: [...base, { or: recent }] };
  }

  /** Records a completed scan; `unlaunched` are the matching issues still without a thread. */
  complete(projectRef: string, startedAt: number, unlaunched: string[]): void {
    this.scans.set(projectRef, { since: startedAt, carry: new Set(unlaunched) });
  }
}
