// Minimal Linear helper for the in-pod entrypoint.
//
// The pod entrypoint needs three Linear operations the existing
// `LinearTracker` doesn't expose directly:
//
//   1. Fetch a single issue (with its body + state) by `id`.
//   2. Resolve the workflow-state id for a name like "In Progress".
//   3. Transition the issue to that state (the dispatch handshake per
//      ADR 0011).
//
// We intentionally do not extend `LinearTracker` for this. The tracker
// is a daemon-side abstraction shaped for the orchestrator's
// poll-and-reconcile flow; the in-pod handshake is a different,
// narrower concern. Reusing `LinearClient` for transport keeps auth +
// error semantics in one place.

import type { LinearClient } from '@symphony/daemon/tracker/linear';

export interface FetchedIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: { readonly id: string; readonly name: string };
  readonly teamId: string;
  readonly priority: number | null;
  readonly branchName: string | null;
  readonly url: string | null;
}

const FETCH_ISSUE_QUERY = `
  query PodFetchIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      priority
      branchName
      url
      state { id name }
      team { id }
    }
  }
`;

export async function fetchIssueById(
  client: LinearClient,
  id: string,
): Promise<{ ok: true; issue: FetchedIssue } | { ok: false; reason: string }> {
  const response = await client.execute({ query: FETCH_ISSUE_QUERY, variables: { id } });
  if (!response.ok) return { ok: false, reason: response.error.message };
  const data = response.value as {
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
      description?: string | null;
      priority?: number | null;
      branchName?: string | null;
      url?: string | null;
      state?: { id?: string; name?: string };
      team?: { id?: string };
    } | null;
  };
  const raw = data.issue;
  if (
    raw == null ||
    typeof raw.id !== 'string' ||
    typeof raw.identifier !== 'string' ||
    typeof raw.title !== 'string' ||
    raw.state?.id === undefined ||
    raw.state.name === undefined ||
    raw.team?.id === undefined
  ) {
    return { ok: false, reason: `issue ${id} not found or shape unexpected` };
  }
  return {
    ok: true,
    issue: {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description ?? null,
      priority: raw.priority ?? null,
      branchName: raw.branchName ?? null,
      url: raw.url ?? null,
      state: { id: raw.state.id, name: raw.state.name },
      teamId: raw.team.id,
    },
  };
}

// Linear's `team: { id: { eq: $teamId } }` filter expects $teamId as
// `ID!`, not `String!` — the latter returns 400 GRAPHQL_VALIDATION_FAILED.
// (Discovered during the 2026-04-30 docker smoke run.)
const TEAM_STATE_QUERY = `
  query PodTeamStates($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }) {
      nodes { id name }
    }
  }
`;

export async function findStateIdByName(
  client: LinearClient,
  teamId: string,
  stateName: string,
): Promise<{ ok: true; stateId: string } | { ok: false; reason: string }> {
  const response = await client.execute({
    query: TEAM_STATE_QUERY,
    variables: { teamId },
  });
  if (!response.ok) return { ok: false, reason: response.error.message };
  const data = response.value as {
    workflowStates?: { nodes?: readonly { id?: string; name?: string }[] };
  };
  const target = stateName.toLowerCase();
  const node = data.workflowStates?.nodes?.find(
    (n) => typeof n.name === 'string' && n.name.toLowerCase() === target,
  );
  if (node === undefined || typeof node.id !== 'string') {
    return { ok: false, reason: `team ${teamId} has no workflow state named "${stateName}"` };
  }
  return { ok: true, stateId: node.id };
}

const TRANSITION_MUTATION = `
  mutation PodTransition($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
    }
  }
`;

export async function transitionIssue(
  client: LinearClient,
  issueId: string,
  stateId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const response = await client.execute({
    query: TRANSITION_MUTATION,
    variables: { id: issueId, stateId },
  });
  if (!response.ok) return { ok: false, reason: response.error.message };
  const data = response.value as { issueUpdate?: { success?: boolean } };
  if (data.issueUpdate?.success !== true) {
    return { ok: false, reason: 'issueUpdate returned success=false' };
  }
  return { ok: true };
}
