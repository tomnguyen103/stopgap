import type { OpenMonitoringCase } from "@stopgap/db";

/**
 * Feed-resolution auto-detect (PHASE6 §6.6). The poll knows which shortage keys a feed still
 * lists as `current`, which it explicitly marked `resolved`, and which have simply dropped
 * off. This module owns the decision — reset / bump / resolve — as a PURE function so the
 * counting semantics (a single miss is a flap, N in a row is a resolution) are unit-testable
 * without a database, a Temporal client, or a live feed.
 */

/** Evidence recorded in the `case.feed_resolved` audit entry. */
export interface ResolutionEvidence {
  caseId: string;
  /** The case row's stored Temporal id — what the resolution signal is addressed to. */
  workflowId: string;
  key: string;
  /** `feed-resolved`: the feed said so explicitly. `feed-absent`: N polls with no listing. */
  reason: "feed-resolved" | "feed-absent";
  source: string;
  lastSeenSourceId: string;
  /** How many consecutive polls missed the key (0 for an explicit resolution). */
  consecutiveMisses: number;
  /**
   * Poll timestamps that count as evidence. Only the poll that crossed the threshold is
   * retained — the case row persists a COUNT, not a per-poll history, so this honestly
   * carries the final poll rather than fabricating timestamps we never stored.
   */
  missPollTimestamps: string[];
}

export interface FeedResolutionDiff {
  /** Cases to signal resolved, with the evidence to audit. */
  toResolve: ResolutionEvidence[];
  /** Case ids whose key reappeared as current — reset their miss counter to 0. */
  toReset: string[];
  /** Cases still missing but below threshold — bump their counter by one. */
  toBump: string[];
}

/** What the current poll observed about shortage keys. */
export interface FeedSnapshotKeys {
  /** Keys a feed still lists as an active (`current`) shortage. */
  currentKeys: Set<string>;
  /** Keys a feed explicitly marked `resolved` this poll. */
  resolvedKeys: Set<string>;
}

/**
 * Decide, for each open monitoring case, whether to reset, bump, or resolve it.
 *
 * - Key listed `current`     → present again; reset the counter (only when it was non-zero).
 * - Key explicitly `resolved`→ resolve immediately (miss-counting is only for silent absence).
 * - Key absent (or `unknown`)→ one more miss; resolve once the count reaches `threshold`,
 *   otherwise bump. A single miss never resolves — that is the flap protection §6.6 requires.
 */
export function diffResolutions(
  openCases: readonly OpenMonitoringCase[],
  snapshot: FeedSnapshotKeys,
  threshold: number,
  pollTimestamp: string,
): FeedResolutionDiff {
  const diff: FeedResolutionDiff = { toResolve: [], toReset: [], toBump: [] };
  for (const c of openCases) {
    if (snapshot.currentKeys.has(c.key)) {
      // Present again — reset, but only write when there is something to clear.
      if (c.feedMissCount > 0) diff.toReset.push(c.caseId);
      continue;
    }
    if (snapshot.resolvedKeys.has(c.key)) {
      diff.toResolve.push({
        caseId: c.caseId,
        workflowId: c.workflowId,
        key: c.key,
        reason: "feed-resolved",
        source: c.source,
        lastSeenSourceId: c.sourceId,
        consecutiveMisses: 0,
        missPollTimestamps: [],
      });
      continue;
    }
    // Absent this poll — one more consecutive miss.
    const misses = c.feedMissCount + 1;
    if (misses >= threshold) {
      diff.toResolve.push({
        caseId: c.caseId,
        workflowId: c.workflowId,
        key: c.key,
        reason: "feed-absent",
        source: c.source,
        lastSeenSourceId: c.sourceId,
        consecutiveMisses: misses,
        missPollTimestamps: [pollTimestamp],
      });
    } else {
      diff.toBump.push(c.caseId);
    }
  }
  return diff;
}
