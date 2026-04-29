// zod schemas for the Linear GraphQL response shapes we consume.
//
// Per ADR 0006: every value crossing a boundary is parsed before
// entering the typed core. The Linear API is a particularly volatile
// boundary (their GraphQL schema evolves; they may return null in
// fields we expected populated), so each query has its own typed
// shape and we explicitly handle nullability.
//
// Two issue shapes:
//   - `FullIssueSchema`     — all fields used by `fetchCandidateIssues`
//                             and `fetchIssuesByStates`. Drives the
//                             dispatch / cleanup decision paths.
//   - `MinimalIssueSchema`  — id + identifier + state for
//                             `fetchIssueStatesByIds`. Reconciliation
//                             only needs to know "is this still
//                             Active / Done / Paused?"

import { z } from 'zod';

// ---- common pieces --------------------------------------------------

const StateRefSchema = z.object({
  name: z.string(),
});

const LabelNodeSchema = z.object({
  name: z.string(),
});

/**
 * One node in `Issue.inverseRelations.nodes`. On an issue's
 * `inverseRelations`, the `issue` field points at the OTHER side of
 * the relation — the source. See SPEC §11.3.
 *
 * Linear's schema does NOT allow filtering this connection by `type`,
 * so we fetch the `type` string here and narrow to "blocks"
 * client-side in `normalizeFullIssue`. Common types include `blocks`,
 * `duplicate`, `related`.
 */
const InverseRelationNodeSchema = z.object({
  type: z.string(),
  issue: z
    .object({
      id: z.string().min(1),
      identifier: z.string().min(1),
      state: StateRefSchema.nullable(),
    })
    .nullable(),
});

const PageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

// ---- minimal issue (for reconciliation + terminal cleanup) ----------

export const MinimalIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  state: StateRefSchema,
});

export type MinimalIssue = z.infer<typeof MinimalIssueSchema>;

export const MinimalIssueConnectionSchema = z.object({
  nodes: z.array(MinimalIssueSchema),
  pageInfo: PageInfoSchema,
});

// ---- full issue (for dispatch) --------------------------------------

export const FullIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  /** Linear priority is a number 0..4 (0 = no priority, 1 = urgent). */
  priority: z.number().int().nullable(),
  state: StateRefSchema,
  branchName: z.string().nullable(),
  url: z.string().url().nullable(),
  labels: z.object({
    nodes: z.array(LabelNodeSchema),
  }),
  inverseRelations: z.object({
    nodes: z.array(InverseRelationNodeSchema),
  }),
  /** ISO-8601 timestamps. Both nullable for safety. */
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type FullIssue = z.infer<typeof FullIssueSchema>;

export const FullIssueConnectionSchema = z.object({
  nodes: z.array(FullIssueSchema),
  pageInfo: PageInfoSchema,
});

// ---- top-level query data shapes ------------------------------------

export const CandidateIssuesDataSchema = z.object({
  issues: FullIssueConnectionSchema,
});

export const IssuesByStatesDataSchema = z.object({
  issues: FullIssueConnectionSchema,
});

export const IssueStatesByIdsDataSchema = z.object({
  issues: z.object({
    nodes: z.array(MinimalIssueSchema),
  }),
});
