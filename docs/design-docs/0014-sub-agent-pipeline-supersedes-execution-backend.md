# 0014 — Sub-agent pipeline + skill-driven provisioning supersedes ExecutionBackend, agent-in-pod, and broker transport

- **Status:** Proposed
- **Date:** 2026-05-17
- **Supersedes:** ADR 0011 (agent-in-pod + ExecutionBackend seam) in
  full; ADR 0012 (Namespace as production ExecutionBackend) in full;
  ADR 0013 (daemon ↔ pod transport: broker vs controller) in full.
  The decisions those ADRs recorded all assumed the architecture
  this ADR replaces. None survive intact.

## Context

Symphony's current architecture (after ADRs 0009–0013) is:

- A daemon polls Linear, picks eligible issues, dispatches each to
  an `ExecutionBackend`.
- The backend creates a pod (Docker container today; Namespace
  microVM in the WIP Plan 14 branch).
- An `agent-runtime` package runs **inside the pod**, reads a
  dispatch envelope mounted as a file (or passed via env var),
  fetches the issue, clones the repo, renders a `workflow.md`,
  and drives the Claude Agent SDK.
- Events flow back from the pod to the daemon over a TCP socket
  (LocalDocker) or streaming `RunCommand` (Namespace WIP) — ADR
  0013 was a half-written attempt to replace this with a broker.

That architecture grew incrementally and codified at each step
that Symphony itself owns:

- **Which platform to use** (`LocalDockerBackend` vs
  `NamespaceBackend` vs future `Ec2Backend`).
- **Which image to run** (per-repo Dockerfile resolution order, the
  per-project image tag, the agent-base image, devcontainer
  fallback).
- **How services come up** (the WIP Plan 14 had a "docker compose
  up if a compose file exists" step baked into the backend).
- **How the agent reaches its issue** (mounted file, env var, env
  TCP, eventually broker).
- **How events flow back** (per-pod sockets, then maybe Redis,
  then maybe HTTP poll).

Each of those is a decision the **agent itself** is more
qualified to make — given a Linear issue body, a `workflow.md`,
and a set of skills, an agent can pick the right sandbox kind,
provision it, start the right services, do the work, run tests,
push the PR. Encoding those decisions in TypeScript code that
ships with the daemon was a 2025-era pattern.

The 2026 pattern, recognized in conversation 2026-05-17, is:

> **Symphony's daemon is a dispatcher. The agent is a pipeline of
> specialist sub-agents, each with one skill. The "infrastructure"
> a dispatch needs is provisioned by the agent itself via skills,
> not by Symphony code.**

This collapses three open questions at once:

1. **ExecutionBackend abstraction** (ADR 0011) → there isn't one.
   An `@infra` sub-agent with a "spin up a sandbox" skill does
   what `LocalDockerBackend.start()` did, with a tenth of the code
   and full agent observability.
2. **Which production backend** (ADR 0012, "Namespace") → not
   Symphony's call. The `@infra` agent's skill picks per dispatch.
   Namespace, devbox, E2B, local docker — same skill interface,
   different implementations.
3. **Daemon ↔ pod transport** (ADR 0013) → no transport. The
   parent agent runs **in the daemon's process** via the Claude
   Agent SDK. Sub-agents are SDK sub-agents (in-process). The
   things that _do_ run remotely (sandboxes, services) are
   addressed by the @infra skill's remote-exec tools.

## Decision

Two coupled sub-decisions.

### Decision A — Symphony shrinks to a dispatcher

The daemon's responsibilities reduce to:

- Poll the tracker (Linear) for eligible issues.
- Maintain orchestrator state (in-flight dispatches, retries,
  concurrency caps).
- For each eligible issue, **spawn an initial agent in-process**
  via `@anthropic-ai/claude-agent-sdk`'s `query()`.
- Forward agent events to observability + dashboard.
- Persist enough state to survive restarts (idempotent re-dispatch
  per Plan 11).

What it stops doing:

- ❌ No `ExecutionBackend` interface. Deleted.
- ❌ No `LocalDockerBackend`. Deleted.
- ❌ No `NamespaceBackend` (WIP). Deleted on `plan14-namespace-backend`
  branch; that branch becomes reference-only.
- ❌ No `agent-runtime` package. The agent runs in the daemon
  process; there is no separate in-pod runtime to ship.
- ❌ No per-pod Docker image, no `agent-base.Dockerfile`, no
  image-resolution order, no `docker:build:*` scripts.
- ❌ No per-pod transport (sockets, streaming `RunCommand`, broker).

### Decision B — The agent is a pipeline of specialist sub-agents

The initial agent (the one the daemon spawns per dispatch) reads
the issue + the repo's `workflow.md` and orchestrates a fixed
pipeline of sub-agents:

```
Initial agent (per dispatch, in daemon process)
   ↓
   ├─ @infra        spin up a sandbox the rest of the pipeline runs against
   │                  (skill: "how to provision sandboxes")
   │                  returns: { sandbox_handle, exec_tool }
   │
   ├─ @app          bring up the team's services in that sandbox
   │                  (skill: "how to spin up this app",
   │                   reads repo's compose/manifest)
   │                  returns: { services_ready }
   │
   ├─ @coder        do the actual code change
   │                  (skill: "coding agent", uses Bash/Read/Edit
   │                   routed into the sandbox via @infra's exec_tool)
   │     ├─ @tester  (sub-sub-agent) run tests, report
   │
   ├─ @ci           commit, push, open PR
   │                  (skill: "CI agent")
   │
   └─ back to initial: transition Linear, close out
```

Each sub-agent has:

- One skill bundle (markdown + scripts) describing what it does
  and how.
- An explicit success criterion (its `RETURN`).
- A structured output handed to the next stage.

The skills are the **executable knowledge** the agent uses. They
live in the repo (e.g. `.symphony/skills/`) so they version with
the project, are reviewable by humans, and are swappable per
project (a bank repo can override `@infra` with its
internal-sandbox skill).

Isolation property (the original ADR 0011 concern): the
**parent agent has no host Bash**. Its `Bash` tool routes through
@infra's `exec_tool`, which targets the sandbox. The agent can't
damage the daemon host because it doesn't have a tool that reaches
it.

## Alternatives considered

### Stay on the ExecutionBackend + agent-in-pod model and ship ADR 0013's broker

What the conversation produced through 2026-05-03. Rejected
because the entire stack of `ExecutionBackend` implementations,
the agent-runtime package, the broker transport, and the per-pod
image story all exist to solve problems that **don't exist if the
agent provisions its own environment via skills**. We were
designing a controller for a thing that doesn't need to be
controlled by us.

### Keep ExecutionBackend; let it return a sandbox the @infra skill operates on

Hybrid: Symphony still picks "container or VM or microVM," but
the _inside_ of the sandbox is configured by skills. Rejected:
the platform choice is just as much a per-repo / per-issue
decision as the inside is. Bank repos may need a Namespace
sandbox; toy repos may want local docker. The @infra skill is
the right place for both.

### Symphony becomes a thin TS wrapper around `nsc devbox` (or equivalent CLI)

Skip the SDK + sub-agent pattern entirely and have the daemon
shell out to `nsc devbox create`, then drop a Codex/Claude CLI
into it via SSH. Rejected: this is the symphony-ts shape (which
we surveyed 2026-05-17). It works but gives up the sub-agent
pipeline that's the whole point of this ADR — the auditable,
gateable, swappable pipeline is what makes the BTG context
viable.

### `symphony-ts` as the new base

Throw away `my-own-symphony` and adopt the OasAIStudio/symphony-ts
codebase as the starting point. Rejected (2026-05-17): smaller
seed, but missing all the orchestration work (multi-project,
retries, reconcile, tracker normalizer, Claude SDK integration,
ADR/plan discipline) that ports forward into this architecture.
Less code to subtract from `my-own-symphony` than to rebuild on
top of `symphony-ts`.

## Consequences

**Easier:**

- Symphony's surface area drops by an estimated 40–50% (Plan 15
  itemizes). The entire `execution/` subtree (~1,000+ LOC) goes.
  The `agent-runtime` package (~5 files, plus its docker base
  image) goes. The `docker/` directory goes.
- Multi-service environments (Postgres + Redis + Kafka): the
  @app skill does this. Symphony stops caring.
- Platform choice (LocalDocker, Namespace, E2B, BTG-internal):
  the @infra skill picks. Symphony stops caring.
- Daemon-restart resilience: idempotent re-dispatch of the
  initial agent (already addressed by Plan 11) is the entire
  story. No broker, no socket reattach, no streaming RPC
  reconnect.
- The pipeline is **auditable** at each handoff. Each sub-agent's
  tool calls + output are first-class events. "What did @infra
  do?" → read its events. "Why did @app pick this Postgres
  version?" → read the @app skill + its tool calls.
- The pipeline is **gateable**. @ci can be the policy
  enforcement point ("no PR without passing tests + scan +
  signed envelope"). That's a skill, not buried logic.
- BTG-style review surface: skills are markdown + scripts that
  a security team can read. They can't easily review a
  TypeScript `LocalDockerBackend`.
- Skills are **swappable per project**. A repo can ship its own
  `@infra` override. Symphony doesn't need a config knob; it's
  files in the repo.
- Local development becomes trivial: invoke the initial agent
  manually with a fake issue, same code path. No docker
  required to run the daemon.

**Harder:**

- The Claude Agent SDK becomes a runtime dependency of the
  daemon, not just of the (now-deleted) agent-runtime package.
  Daemon process now hosts SDK queries directly.
- Skills need to be designed, written, versioned. They're the
  new code. Five skills minimum (@infra, @app, @coder, @tester,
  @ci) + the orchestration prompt that wires them. Each is small
  but together they're the project's behavioral surface.
- Sub-agent handoffs cost tokens. Five-stage pipeline with
  context handoffs at each boundary is meaningfully more tokens
  per dispatch than today's single-agent. Real cost — needs
  pricing at a representative workload.
- Observability model is restructured. Today: agent events from
  a pod. Tomorrow: nested events from a sub-agent tree. Dashboard
  rendering changes meaningfully.
- The "where does the agent reach the sandbox" question moves
  into the @infra skill. The skill needs a stable contract
  (`sandbox_handle` + `exec_tool`) that the rest of the pipeline
  consumes. That contract is new.
- All the work in `plan14-namespace-backend` branch becomes
  reference code. Real loss of completed-ish work. Mitigation:
  the `Compute.Instance` SDK plumbing in `sdk-runner.ts` can be
  ported into the `@infra` skill (as a shell script that calls
  `nsc` or the SDK), so it's not zero-recovery.

**Constrained:**

- The skill contract becomes the load-bearing interface. Breaking
  it touches every sub-agent. ADR 0006-style zod boundaries
  apply.
- The pipeline shape (initial → infra → app → coder → tester →
  ci → close) is the v1 contract. Variations per repo go through
  the @infra/app/etc skill overrides, not through a different
  pipeline shape.
- The daemon's HTTP API surface stays small; the dashboard reads
  nested sub-agent events, which means the event schema gains a
  parent/child relationship.

## Out of scope (deliberately deferred)

- Skill marketplace / discovery. Skills are local files in v1.
- Multiple agent runtimes (e.g. Codex sub-agent). v1 is Claude
  Agent SDK only.
- Skill execution sandboxing (running a skill's scripts in an
  isolated context). Skills are trusted operator-side artifacts;
  malicious-skill defense is a v2 concern.
- Inter-dispatch caching (the @app skill probably wants to reuse
  warm sandboxes across dispatches; not v1).
- Per-sub-agent budget caps. Today operator-wide cap; per-stage
  caps are nice but not v1.
- Replacing the daemon's HTTP API with anything else (it stays).

## Schedule

Subtraction lands in Plan 15 (drafted alongside this ADR). Plan
15 itemizes the files to delete, the files to re-role, and the
files that survive untouched. After Plan 15, the surviving
codebase is the seed for a future Plan 16 ("Skill bundles + sub-
agent pipeline") that adds the new architecture's actual code.

Plans 13 and 14 are superseded by Plan 15. Plan 12 is partially
superseded — the "end-to-end PR demo" goal survives but every
verification scenario tied to pod lifecycle gets rewritten in
Plan 15's wake. Plan 11 (idempotency) survives intact; the
properties it protects matter in any architecture.
