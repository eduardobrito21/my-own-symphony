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
  labels { nodes { name } }
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
