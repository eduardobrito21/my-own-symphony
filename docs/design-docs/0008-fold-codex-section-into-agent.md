# 0008 — Fold the `codex.*` section into `agent.*`

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The Symphony spec's `WORKFLOW.md` schema (SPEC §5.3.6) defines a
`codex.*` front-matter section that holds the agent backend's
configuration:

- `codex.command` — shell command to launch the agent
- `codex.approval_policy`, `codex.thread_sandbox`,
  `codex.turn_sandbox_policy` — Codex-specific approval / sandbox
  policy values
- `codex.turn_timeout_ms`, `codex.read_timeout_ms`,
  `codex.stall_timeout_ms` — per-turn / per-read / stall timeouts

Plan 01 implemented this section verbatim. The schema header comment
described it as "preserved for spec compatibility": a `WORKFLOW.md`
authored for upstream Symphony would parse identically.

In practice this introduced a misleading name throughout the codebase —
schemas, types, tests, docs, future code — for a compatibility benefit
that this implementation will never use:

- [ADR 0001](0001-claude-agent-sdk-instead-of-codex.md) commits us to
  the Claude Agent SDK. There is no Codex command to launch.
- The Claude Agent SDK has no equivalent of `approval_policy`,
  `thread_sandbox`, or `turn_sandbox_policy`. They are pass-through
  unknowns in our typed schema.
- The timeouts (`turn`, `read`, `stall`) are generic concepts — any
  agent backend has them — and they describe orchestrator behavior
  (turn timeout, read timeout, stall detection) more than backend
  identity.

## Decision

**Drop the `codex.*` section from the typed schema. Fold the timeouts
into `agent.*`. Drop the Codex-only policy fields entirely.**

After this change, the typed schema has:

```yaml
agent:
  # orchestrator-level (existing)
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300_000
  max_concurrent_agents_by_state: {}
  # per-turn runtime (lifted from codex.*)
  turn_timeout_ms: 3_600_000
  read_timeout_ms: 5_000
  stall_timeout_ms: 300_000
```

A `WORKFLOW.md` that still includes a `codex.*` section is **not** an
error: top-level `.passthrough()` carries the section through
unvalidated, and our agent layer ignores it. Operators migrating from
upstream Symphony can move `turn_timeout_ms` / `read_timeout_ms` /
`stall_timeout_ms` from `codex.*` to `agent.*` and delete the rest.

## Alternatives considered

1. **Keep `codex.*` as-is.** The path of least change. Costs:
   misleading name throughout the codebase, every reader of `schema.ts`
   asks "wait, didn't we change to Anthropic?", documentation has to
   keep apologizing. Rejected.
2. **Keep `codex.*` and rename the SDK adapter to `codex` too.** Lying
   harder to make the names line up. Rejected.
3. **Rename `codex.*` to `runtime.*` (a third top-level section).**
   Cleaner separation between "orchestrator agent policy" (`agent.*`)
   and "agent backend runtime" (`runtime.*`), but introduces a new term
   and arbitrarily splits two concepts that map to the same SDK call
   site. Rejected for now; revisit if the agent layer grows enough that
   the split becomes load-bearing.
4. **Drop the section entirely; use SDK defaults for timeouts.**
   Loses operator control over turn / stall timeouts. Rejected.

## Consequences

**Easier:**

- Naming is honest. `agent.turn_timeout_ms` says exactly what it is.
- New readers don't need to consult an ADR to understand why a section
  named `codex` exists in a Claude-only project.
- Fewer concepts in `WORKFLOW.md`: one section per concern, not two.

**Harder:**

- A literal upstream `WORKFLOW.md` will silently lose its
  `codex.command`, `codex.approval_policy`, etc. — they pass through
  the schema unchecked but no code consumes them. Migration is a
  manual `codex.<timeout> -> agent.<timeout>` rename. We don't expect
  to migrate any real upstream files; flagged here for completeness.

**Constrained:**

- We cannot claim conformance with SPEC §5.3.6 as written. This was
  already the case via [ADR 0001](0001-claude-agent-sdk-instead-of-codex.md);
  this ADR makes the deviation explicit at the schema level rather than
  at the implementation level.

## Implementation notes

- Schema changes live in `packages/daemon/src/config/schema.ts`. The
  `CodexConfigSchema` and the `CodexConfig` type are gone. The
  `AgentConfigSchema` absorbs the three timeout fields.
- Test file `schema.test.ts` updates assertions to read from `agent.*`
  and adds one new test confirming legacy `codex.*` sections still
  parse without errors (forward-compat).
- The vendored upstream SPEC at `docs/product-specs/symphony-spec.md`
  is unchanged. The deviations summary at
  `docs/product-specs/deviations.md` records this rename.
- Future plans (especially Plan 05 for stall detection and Plan 07 for
  the Claude SDK integration) consume the new field names directly.
