// `DispatchEnvelope` — wire format for `/etc/symphony/dispatch.json`.
//
// The host-side `LocalDockerBackend` writes this file at pod start; the
// in-pod entrypoint reads it on boot to figure out which issue + repo
// it's responsible for. Per ADR 0011 + Plan 10, the envelope is
// intentionally narrow: it carries the daemon's _dispatch decisions_
// (which issue, which repo, what caps, retry context) — NOT the issue
// body or rendered prompt. The pod re-fetches from Linear and renders
// the prompt itself, after the clone, against the per-repo
// `workflow.md`.
//
// We define the canonical shape as a zod schema so both sides validate
// against the same source of truth (per ADR 0006). The TS shape is
// inferred from the schema; the daemon imports it via the
// `@symphony/daemon` `execution` subpath (the daemon also needs the
// shape to *write* the envelope) and the pod imports it from this
// package to *read* it.

import { z } from 'zod';

export const DispatchEnvelopeSchema = z
  .object({
    issueId: z.string().min(1),
    issueIdentifier: z.string().min(1),
    projectKey: z.string().min(1),

    tracker: z
      .object({
        kind: z.literal('linear'),
        projectSlug: z.string().min(1),
      })
      .strict(),

    repo: z
      .object({
        url: z.string().min(1),
        defaultBranch: z.string().min(1),
        workflowPath: z.string().min(1),
        branchPrefix: z.string().min(1),
      })
      .strict(),

    operatorCaps: z
      .object({
        model: z.string().min(1).optional(),
        maxTurns: z.number().int().positive().optional(),
        maxBudgetUsd: z.number().positive().optional(),
      })
      .strict(),

    attempt: z.number().int().nonnegative().nullable(),
    resumeSessionId: z.string().min(1).optional(),
  })
  .strict();

export type DispatchEnvelope = z.infer<typeof DispatchEnvelopeSchema>;
