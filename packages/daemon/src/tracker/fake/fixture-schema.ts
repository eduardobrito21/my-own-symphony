// zod schema for FakeTracker fixture files (YAML or JSON).
//
// Per ADR 0006, every value crossing a process boundary is parsed
// before entering the typed core. Fixture files are a boundary even
// though they're "ours" — typos in a hand-written YAML file can
// silently change tracker behavior, and we'd rather catch them at
// load time than at the first failing test.
//
// The schema mirrors `Issue` (SPEC §4.1.1) but accepts plain strings
// for IDs (rather than branded types) and parses ISO-8601 timestamps.
// The fixture-loader (`fixture-loader.ts`) converts validated data
// into branded `Issue` values.

import { z } from 'zod';

const BlockerRefSchema = z
  .object({
    id: z.string().min(1).nullable().default(null),
    identifier: z.string().min(1).nullable().default(null),
    state: z.string().nullable().default(null),
  })
  .strict();

const RawIssueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().default(null),
    priority: z.number().int().nullable().default(null),
    state: z.string().min(1),
    branch_name: z.string().nullable().default(null),
    url: z.string().url().nullable().default(null),
    labels: z.array(z.string()).default([]),
    blocked_by: z.array(BlockerRefSchema).default([]),
    created_at: z.string().datetime().nullable().default(null),
    updated_at: z.string().datetime().nullable().default(null),
  })
  .strict();

export const FixtureSchema = z
  .object({
    issues: z.array(RawIssueSchema).default([]),
  })
  .strict();

export type RawIssue = z.infer<typeof RawIssueSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
