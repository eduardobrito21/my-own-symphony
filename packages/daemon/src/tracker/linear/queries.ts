// GraphQL queries against the Linear API.
//
// We keep them as plain string constants (not a generated client)
// because they're small, stable, and easy to inspect. Each query is
// paired with its variables type so the call site is type-safe.
//
// SPEC §11.2 specifics:
//   - candidate filter uses `project: { slugId: { eq: $slug } }`
//   - state-refresh by IDs uses GraphQL ID type `[ID!]!`
//   - pagination required for candidate fetch
//   - default page size 50

export const PAGE_SIZE = 50;

/**
 * Common issue field set used by candidate-issues + issues-by-states.
 * SPEC §11.3 dictates which fields we read; this fragment-equivalent
 * keeps them in one place.
 */
const FULL_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name parent { name } } }
  inverseRelations {
    # NOTE: Linear schema does not allow a filter argument on this
    # field. We fetch the relation type string and narrow to "blocks"
    # client-side in normalizeFullIssue.
    nodes {
      type
      issue {
        id
        identifier
        state { name }
      }
    }
  }
`;

// ---- candidate issues -----------------------------------------------

export interface CandidateIssuesVariables {
  readonly projectSlug: string;
  readonly activeStates: readonly string[];
  readonly first: number;
  readonly after: string | null;
}

export const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues(
    $projectSlug: String!
    $activeStates: [String!]!
    $first: Int!
    $after: String
  ) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
      first: $first
      after: $after
    ) {
      nodes { ${FULL_ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---- issues by states (terminal cleanup) ----------------------------

export interface IssuesByStatesVariables {
  readonly projectSlug: string;
  readonly states: readonly string[];
  readonly first: number;
  readonly after: string | null;
}

export const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates(
    $projectSlug: String!
    $states: [String!]!
    $first: Int!
    $after: String
  ) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: $first
      after: $after
    ) {
      nodes { ${FULL_ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---- issue states by IDs (reconciliation) ---------------------------

export interface IssueStatesByIdsVariables {
  /**
   * GraphQL ID type. SPEC §11.2 explicitly says `[ID!]` (not String);
   * Linear distinguishes the two and a wrong type causes a 422.
   */
  readonly ids: readonly string[];
}

export const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        state { name }
      }
    }
  }
`;

// ---- transition issue state (Plan 23) -------------------------------

export interface IssueWorkflowStatesVariables {
  /** GraphQL ID type. Linear's schema is picky about ID vs String. */
  readonly issueId: string;
}

/**
 * Fetch the workflow states available on the team that owns this
 * issue, plus the issue's current state name. One round-trip lets
 * the adapter resolve `targetStateName` → `stateId` AND short-
 * circuit when the issue is already in the target state — no extra
 * API call needed for the idempotent path.
 */
export const ISSUE_WORKFLOW_STATES_QUERY = `
  query IssueWorkflowStates($issueId: String!) {
    issue(id: $issueId) {
      id
      state { name }
      team {
        states(first: 100) {
          nodes { id name }
        }
      }
    }
  }
`;

export interface IssueUpdateStateVariables {
  readonly issueId: string;
  readonly stateId: string;
}

/**
 * Move one issue to a workflow state. We only care about the
 * `success` boolean and the new state name (for logging); a richer
 * payload would mean more schema to maintain for no caller benefit.
 */
export const ISSUE_UPDATE_STATE_MUTATION = `
  mutation IssueUpdateState($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue {
        id
        state { name }
      }
    }
  }
`;
