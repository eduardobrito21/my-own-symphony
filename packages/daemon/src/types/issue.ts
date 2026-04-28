// The `Issue` domain entity, mirrored verbatim from SPEC §4.1.1.
//
// This is the normalized issue record used everywhere in the daemon.
// The Linear adapter (Plan 06) and the FakeTracker (Plan 02) both
// produce values of this shape; the orchestrator and HTTP layers
// consume it.
//
// Field semantics deliberately match the spec — including the
// distinction between `id` (opaque tracker-internal) and `identifier`
// (human-readable). See `ids.ts` for why these are branded.

import type { IssueId, IssueIdentifier } from './ids.js';

/**
 * A reference to another issue that blocks this one. Per SPEC §11.3,
 * blockers are derived from inverse relations of type `blocks` on
 * Linear; the FakeTracker constructs them directly.
 *
 * Any of the fields may be null when the upstream tracker doesn't
 * surface them (e.g. a deleted blocker reference).
 */
export interface BlockerRef {
  readonly id: IssueId | null;
  readonly identifier: IssueIdentifier | null;
  readonly state: string | null;
}

/**
 * The normalized issue. SPEC §4.1.1.
 *
 * `state` is intentionally a plain string rather than an enum: tracker
 * state names are user-defined per workspace (and per workflow). The
 * spec normalizes only by lowercase comparison (§4.2), not by an
 * enumerated set.
 */
export interface Issue {
  readonly id: IssueId;
  readonly identifier: IssueIdentifier;
  readonly title: string;
  readonly description: string | null;
  /** Lower numbers are higher priority (1..4). `null` if unprioritized. */
  readonly priority: number | null;
  readonly state: string;
  readonly branchName: string | null;
  readonly url: string | null;
  /** Lowercased per SPEC §11.3. */
  readonly labels: readonly string[];
  readonly blockedBy: readonly BlockerRef[];
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}
