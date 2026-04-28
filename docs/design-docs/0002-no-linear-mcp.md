# 0002 — Do not use Linear's hosted MCP for agent → Linear writes

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

When the agent works on an issue, it needs to write back to Linear:
add comments, transition states, attach pull request links. Three
mechanisms are technically available:

1. Linear's hosted MCP server.
2. A custom client-side tool (e.g. `linear_graphql`) the daemon exposes
   to the agent.
3. A set of narrow operation-specific tools (`linear_comment`,
   `linear_transition_state`, etc.).

The Symphony spec's §10.5 standardizes option (2) and the upstream Elixir
implementation uses it. Independent reports identify operational problems
with option (1) — token bloat in tool responses, response latency, broad
exposed surface, separate auth context.

## Decision

Use **option 2**: expose a single `linear_graphql` tool to the Claude
Agent SDK, and ship a markdown skill that teaches the agent the queries
and mutations it needs.

The tool wrapper:

- Accepts `{ query: string, variables?: object }`.
- Validates that the document parses as GraphQL and contains exactly
  one operation.
- Reuses the daemon's `LINEAR_API_KEY` and configured Linear endpoint —
  the agent never sees the raw token.
- Returns `success=true` only when the transport succeeds **and** the
  GraphQL response has no top-level `errors`.

## Alternatives considered

1. **Linear's hosted MCP server** — fastest to integrate but verbose,
   slow, and broad. Reports of significant context-bloat per call.
   Auth is duplicated (the operator's MCP token is separate from
   `LINEAR_API_KEY`). Rejected for this reason.
2. **Multiple narrow tools** — strongest type safety per operation, but
   any new use case requires new code in the daemon. Less flexible for a
   project still discovering its workflow needs. May revisit if a
   specific operation becomes error-prone enough to deserve a dedicated
   tool layered on top of `linear_graphql`. Deferred.

## Consequences

**Easier:**

- Single auth, single endpoint, narrow tool surface.
- Agent learns Linear's GraphQL schema progressively via the markdown
  skill rather than via a sprawling MCP catalog.
- Tool calls are easy to log structurally and to scope (e.g. reject
  mutations outside the configured project).

**Harder:**

- The agent must know enough GraphQL to compose its own queries. The
  skill markdown is what makes this tractable; if the skill rots, agent
  writes degrade.

**Constrained:**

- We will **not** add Linear MCP later as a fallback. If `linear_graphql`
  proves inadequate, the response is to add narrow operation-specific
  tools layered on top, not to broaden the surface.

## Implementation notes

- The tool implementation lives in `packages/daemon/src/agent/tools/linear-graphql.ts`.
- The markdown skill lives in `commands/linear.md` (vendored into agent
  context via the Agent SDK's skill loading mechanism).
- The tool reuses `tracker/linear/client.ts` so there is one place that
  knows how to authenticate against Linear.
