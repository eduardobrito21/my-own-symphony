# Plan 07 — Claude Agent SDK integration

- **Status:** Not started
- **Spec sections:** §10 (Agent Runner Protocol — substituted per
  ADR 0001)
- **Layers touched:** `agent/`, plus the `linear_graphql` tool which
  reuses `tracker/linear/client.ts`.

## Goal

Replace `MockAgent` with a real `ClaudeAgent` backed by
`@anthropic-ai/claude-agent-sdk`. After this plan, the daemon
dispatches actual agent runs against Anthropic's API, exposes the
`linear_graphql` tool, surfaces structured token / rate-limit
telemetry, and respects turn / stall timeouts.

## Out of scope

- Web dashboard. Plan 08.
- Docker / deployment. Plan 09.
- Sandboxing beyond what the SDK provides. Documented as a known
  limitation in `SECURITY.md`.

## Steps

1. **SDK research spike**:
   - Read the Claude Agent SDK reference (use `claude-code-guide`
     subagent if needed).
   - Identify the SDK functions for: starting a session, running a
     turn, registering custom tools, reading typed events, surfacing
     token usage.
   - Capture findings as comments in
     `packages/daemon/src/agent/claude/notes.md`.
2. **Event normalization** in
   `packages/daemon/src/agent/events.ts`:
   - Define the discriminated `AgentEvent` union shared between
     mock and real adapters.
   - Adapter functions translate SDK events → our union.
3. **`ClaudeAgent` adapter** in
   `packages/daemon/src/agent/claude/`:
   - Implements `AgentRunner`.
   - Builds the SDK input (prompt, allowed tools, MCP-equivalents).
   - Iterates SDK output and yields `AgentEvent`s.
   - Enforces `codex.turn_timeout_ms` via `AbortController`.
   - Surfaces rate-limit headers / fields via `AgentEvent`.
4. **`linear_graphql` tool** in
   `packages/daemon/src/agent/tools/linear-graphql.ts`:
   - Input schema (zod): `{ query: string, variables?: object }`.
   - Validate that `query` parses as GraphQL via `graphql.parse`.
   - Reject if more than one operation; reject empty queries.
   - Execute via the same `linearClient` used by the tracker layer.
   - Return: `{ success, data, errors, http_status }` per spec §10.5.
5. **Linear skill markdown** in `commands/linear.md`:
   - Concise reference of Linear's GraphQL types and the small set of
     queries / mutations the agent will actually run.
   - Loaded into agent context via the SDK's skill loading mechanism.
6. **Token / runtime accounting** in
   `packages/daemon/src/observability/token-accounting.ts`:
   - Implement spec §13.5 token rules: prefer absolute thread totals,
     ignore deltas, accumulate via diff to last reported.
7. **Integration tests** (gated by `ANTHROPIC_API_KEY`):
   - Run a one-turn agent that calls `linear_graphql` against a stub
     project, assert tool result shape.
   - Run an agent that exceeds `turn_timeout_ms`, assert clean failure.

## Definition of done

- A live run against a real Linear issue and a real Claude session
  produces a comment on the issue (or whatever the workflow prompt
  asks for).
- Stall and turn timeouts fire correctly under simulated SDK delays.
- Token totals in the orchestrator snapshot match the cumulative
  numbers the SDK reports across turns.
- `pnpm deps:check` passes.
- Docs updated: `docs/design-docs/0008-...` if any non-trivial choice
  surfaces during implementation.

## Open questions

- **SDK API stability.** Verify with the `claude-code-guide` agent /
  current docs at the start of this plan; flag any breaking changes
  vs assumptions baked into earlier exec plans.
- **Tool advertisement format.** The SDK has its own tool spec
  format; `linear_graphql` must be packaged accordingly. Resolve in
  the spike step.

## Decision log

(empty)
