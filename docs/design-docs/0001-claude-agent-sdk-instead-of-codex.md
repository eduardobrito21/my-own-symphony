# 0001 — Use the Claude Agent SDK in place of Codex's app-server

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The Symphony specification is built around Codex's `app-server` mode:
the orchestrator launches `codex app-server` as a subprocess in the
per-issue workspace, speaks a JSON-RPC-style protocol over stdio, manages
threads and turns, and forwards events to its observability layer.

This implementation has different goals. It is a personal learning project,
the operator prefers Anthropic tooling end-to-end, and TypeScript-first
ergonomics matter more than fidelity to Codex's wire protocol.

## Decision

Replace Codex with the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`). The SDK is the closest functional
equivalent of `codex app-server` in the Anthropic ecosystem and is a typed
Node SDK rather than an external subprocess.

A thin **agent abstraction layer** lives in `packages/daemon/src/agent/`.
Everything outside that directory talks to an `AgentRunner` interface.
The SDK lives behind that interface, so swapping back to Codex (or to
another agent) later means writing a second implementation, not rewriting
the orchestrator.

## Alternatives considered

1. **Use Codex's `app-server` faithfully** — would maximize spec fidelity
   but contradicts the operator's tooling preference and adds the cost of
   hand-implementing the stdio protocol. Rejected.
2. **Drive the Claude Code CLI as a subprocess and parse `stream-json`** —
   would mirror the Codex pattern more closely but trades a typed SDK for
   a stdio parser. The SDK is strictly better for a TS learning project.
   Rejected.
3. **Use Anthropic's raw Messages API directly** — would force us to
   reimplement the agent loop (tool calls, multi-turn dialogues, tool
   result handling). The SDK already does that work. Rejected.

## Consequences

**Easier:**

- Typed events, no protocol parser, no stdio framing.
- Custom tools (e.g. `linear_graphql`) plug in via the SDK's tool API
  rather than via a separate transport layer.
- The agent loop, retry semantics inside a turn, and tool-use parsing are
  the SDK's responsibility, not ours.

**Harder:**

- The SDK runs in our Node process by default; we inherit its execution
  context. If we ever want strong sandboxing per turn (Codex's
  `turn_sandbox_policy`), we must add an OS-level layer ourselves.
- Spec sections that prescribe Codex-specific names (`thread_id`,
  `turn_id`, `approval_policy`, `sandbox_mode`, etc.) must be translated
  to SDK equivalents through our abstraction. Translation is mechanical
  but must be documented in the agent layer.

**Constrained:**

- We cannot claim full conformance with the Symphony spec's §10 (Agent
  Runner Protocol). Our deviations are tracked in
  [`docs/product-specs/deviations.md`](../product-specs/deviations.md).

## Implementation notes

- The agent abstraction interface lives in `packages/daemon/src/agent/runner.ts`
  (created in Phase 7).
- The SDK adapter lives in `packages/daemon/src/agent/claude/`.
- A `MockAgent` implementation lives in `packages/daemon/src/agent/mock/` and
  is used through Phase 6 so the orchestrator can be tested without consuming
  real API credits.
