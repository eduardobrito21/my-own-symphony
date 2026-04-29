// `LinearTracker` — the production `Tracker` implementation.
//
// Implements SPEC §11.1's three required operations against Linear's
// GraphQL API. Each method:
//   1. Calls the relevant query (paginating where required).
//   2. Validates the response shape with zod.
//   3. Normalizes Linear-shaped data into our domain `Issue` type.
//
// Errors flow as typed `TrackerError`s — never thrown — so the
// orchestrator's reconciliation logic can pattern-match on `.code`
// (transport vs status vs GraphQL errors vs payload).

import type { Issue, IssueId } from '../../types/index.js';
import type {
  FetchByIdsArgs,
  FetchByStatesArgs,
  FetchCandidatesArgs,
  Tracker,
  TrackerResult,
} from '../tracker.js';

import type { LinearClient } from './client.js';
import { normalizeFullIssue, normalizeMinimalIssue } from './normalize.js';
import { paginate } from './paginate.js';
import {
  CANDIDATE_ISSUES_QUERY,
  ISSUES_BY_STATES_QUERY,
  ISSUE_STATES_BY_IDS_QUERY,
  PAGE_SIZE,
  type CandidateIssuesVariables,
  type IssuesByStatesVariables,
  type IssueStatesByIdsVariables,
} from './queries.js';
import {
  CandidateIssuesDataSchema,
  IssueStatesByIdsDataSchema,
  IssuesByStatesDataSchema,
} from './responses.js';
import type { LinearUnknownPayload } from '../tracker.js';

export interface LinearTrackerArgs {
  readonly client: LinearClient;
  /** Linear project's `slugId` (the part of the URL after `/project/`). */
  readonly projectSlug: string;
}

export class LinearTracker implements Tracker {
  private readonly client: LinearClient;
  private readonly projectSlug: string;

  constructor(args: LinearTrackerArgs) {
    this.client = args.client;
    this.projectSlug = args.projectSlug;
  }

  // ---- candidate issues ------------------------------------------------

  async fetchCandidateIssues(args: FetchCandidatesArgs): Promise<TrackerResult<readonly Issue[]>> {
    const result = await paginate({
      fetchPage: async (after) => {
        const variables: CandidateIssuesVariables = {
          projectSlug: this.projectSlug,
          activeStates: args.activeStates,
          first: PAGE_SIZE,
          after,
        };
        const response = await this.client.execute({
          query: CANDIDATE_ISSUES_QUERY,
          variables,
        });
        if (!response.ok) return response;
        const parsed = CandidateIssuesDataSchema.safeParse(response.value);
        if (!parsed.success) {
          const error: LinearUnknownPayload = {
            code: 'linear_unknown_payload',
            message: `CandidateIssues response did not match schema: ${parsed.error.message}`,
          };
          return { ok: false, error };
        }
        return {
          ok: true,
          value: {
            nodes: parsed.data.issues.nodes,
            pageInfo: parsed.data.issues.pageInfo,
          },
        };
      },
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value.map(normalizeFullIssue) };
  }

  // ---- issues by states (terminal cleanup) ----------------------------

  async fetchIssuesByStates(args: FetchByStatesArgs): Promise<TrackerResult<readonly Issue[]>> {
    if (args.states.length === 0) {
      // SPEC §17.3: empty input returns empty without an API call.
      return { ok: true, value: [] };
    }
    const result = await paginate({
      fetchPage: async (after) => {
        const variables: IssuesByStatesVariables = {
          projectSlug: this.projectSlug,
          states: args.states,
          first: PAGE_SIZE,
          after,
        };
        const response = await this.client.execute({
          query: ISSUES_BY_STATES_QUERY,
          variables,
        });
        if (!response.ok) return response;
        const parsed = IssuesByStatesDataSchema.safeParse(response.value);
        if (!parsed.success) {
          const error: LinearUnknownPayload = {
            code: 'linear_unknown_payload',
            message: `IssuesByStates response did not match schema: ${parsed.error.message}`,
          };
          return { ok: false, error };
        }
        return {
          ok: true,
          value: {
            nodes: parsed.data.issues.nodes,
            pageInfo: parsed.data.issues.pageInfo,
          },
        };
      },
    });
    if (!result.ok) return result;
    return { ok: true, value: result.value.map(normalizeFullIssue) };
  }

  // ---- issue states by IDs (reconciliation) ---------------------------

  async fetchIssueStatesByIds(args: FetchByIdsArgs): Promise<TrackerResult<readonly Issue[]>> {
    if (args.ids.length === 0) return { ok: true, value: [] };

    const variables: IssueStatesByIdsVariables = {
      // The branded IssueId is a string at runtime; cast to plain
      // string for the GraphQL variables.
      ids: args.ids.map((id) => id as string),
    };
    const response = await this.client.execute({
      query: ISSUE_STATES_BY_IDS_QUERY,
      variables,
    });
    if (!response.ok) return response;

    const parsed = IssueStatesByIdsDataSchema.safeParse(response.value);
    if (!parsed.success) {
      const error: LinearUnknownPayload = {
        code: 'linear_unknown_payload',
        message: `IssueStatesByIds response did not match schema: ${parsed.error.message}`,
      };
      return { ok: false, error };
    }

    return {
      ok: true,
      value: parsed.data.issues.nodes.map(normalizeMinimalIssue),
    };
  }
}

export type { IssueId };
