# 0005 — Apply harness-engineering principles to this project's own development

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

OpenAI's [Harness Engineering](https://openai.com/index/harness-engineering/)
post (Feb 2026) describes how a small team built a million-line product
where every line was written by Codex agents. The thesis: when an agent is
the primary contributor, the engineering work shifts to designing the
_environment_ in which the agent operates. Specifically, the post
describes:

- A short `AGENTS.md` (table of contents, not encyclopedia) plus a
  structured `docs/` tree.
- Layered architecture with mechanically enforced dependency directions.
- Boundary parsing (zod-style) at every system edge.
- Execution plans as first-class versioned artifacts.
- "Boring" composable technology preferred over opaque libraries.
- The repo as the single system of record (anything not in the repo is
  invisible to the agent).

This project's purpose is to (a) reimplement Symphony in TypeScript and
(b) help its operator learn TS _and_ harness engineering before starting
a new role. Since Symphony itself orchestrates agents, building it
without the harness patterns would be architecturally incoherent.

## Decision

**Apply harness-engineering principles to this repository from day one.**
Concretely:

- Top-level `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`,
  `RELIABILITY.md` are written before significant code lands.
- Decisions are captured as ADRs in `docs/design-docs/` as they are
  made. This document is itself an example.
- The implementation plan lives in `docs/exec-plans/`, one document per
  phase, updated as work progresses. It is not a chat artifact.
- Layer boundaries are mechanically enforced by `dependency-cruiser`
  (`pnpm deps:check`) and TypeScript project references.
- Every value crossing a boundary is parsed with `zod`. (See
  [0006](0006-zod-at-every-boundary.md).)
- Validation errors and lint messages are written as remediation hints —
  the message tells the next reader (human or agent) how to fix the
  problem.

We do **not** apply the post's full operational toolkit at this scale.
Specifically deferred or skipped:

- Recurring "doc-gardening" agents (overkill for a single-maintainer
  project; revisit when the repo has > 10k lines).
- A LogQL/PromQL local observability stack queryable by agents
  (skipped; structured `pino` logs + the dashboard are sufficient).
- Quality grades per domain in a `QUALITY_SCORE.md` (deferred until
  the codebase is large enough that domain-by-domain status is useful).
- Worktree-per-task tooling (skipped until we run Symphony on itself).

## Alternatives considered

1. **Build Symphony plain, apply harness to a separate project.** Would
   ship faster but defeats the project's stated dual purpose. The
   operator explicitly chose the harder path.
2. **Apply only `AGENTS.md`.** A common starting point for harness work,
   but skips the load-bearing pieces (layered enforcement, boundary
   parsing, exec-plan discipline). Rejected as too shallow.
3. **Apply every principle from the post.** Would slow Phase 0 by days
   for principles that don't pay off until the repo is much larger.
   Rejected as too expensive at this scale.

## Consequences

**Easier:**

- Every decision is captured. No "why did we do it this way?" amnesia
  in three months.
- Future contributors (including the operator's future self) get a
  legible repo with mechanical guardrails instead of tribal knowledge.
- Once the harness is in place, Phase-by-phase work compounds: each
  phase reuses the same scaffolding rather than rebuilding it.

**Harder:**

- Phase 0 is mostly markdown and config, not executable code. This can
  feel like procrastination; it isn't, but the feeling is real.
- The exec-plan discipline only works if plans are actually maintained.
  Stale plans are worse than no plans (the article warns about this).
  We must update plans when reality diverges, and write ADRs when we
  reverse direction.

**Constrained:**

- We do not lower the bar later. If a tradeoff calls for "skip the ADR,
  just merge it," we write the ADR — even if it's three sentences
  long. The discipline is the value.
