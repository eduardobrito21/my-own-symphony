# `agent/` — coding-agent integration

Wraps the Claude Agent SDK behind a stable interface, renders prompts
from workflow templates, and exposes custom tools (notably
`linear_graphql`) to the agent session.

## Files (planned)

- `runner.ts` — the `AgentRunner` interface and `AgentEvent` union.
- `prompt.ts` — Liquid-strict prompt rendering.
- `events.ts` — SDK event → domain `AgentEvent` translation.
- `mock/` — `MockAgent` implementation for tests and dev.
- `claude/` — `ClaudeAgent` SDK adapter (Plan 07).
- `tools/linear-graphql.ts` — custom client-side tool (Plan 07).

## Allowed dependencies

- `types/`, `config/`, `workspace/` — yes.
- `tracker/` — **no**, even though `linear_graphql` calls Linear. The
  tool reaches Linear via the same low-level client the tracker uses,
  but that code is in `tracker/linear/client.ts` and is imported only
  by the tool's implementation file. The `agent/` layer as a whole is
  not dependent on `tracker/`.
- `orchestrator/` — **no**. Agents emit events; the orchestrator
  consumes them, not the reverse.

## Why this rule

The agent layer is the second-most-volatile layer in the daemon (after
the tracker, which depends on a remote API). Keeping it isolated means
when the SDK ships breaking changes, the blast radius is contained
here.

Per ADR 0001, this layer abstracts away whether we're using Claude,
Codex, or any other backend. The orchestrator should never know.
