# Deviations from the Symphony spec

This document enumerates every place where this implementation
intentionally diverges from
[`symphony-spec.md`](symphony-spec.md). For each deviation, we cite
the spec section, describe what we do differently, and link to the
ADR or exec plan that captures the reasoning.

The expectation is that this document is **complete**: if the
implementation diverges from the spec for any reason, the divergence is
recorded here. Undocumented divergence is a bug.

## Categories

| Severity        | Meaning                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Substituted** | We do the same job a different way (e.g. Claude SDK instead of Codex). Spec intent preserved; mechanism differs. |
| **Restricted**  | We implement a strict subset (e.g. Linear only, no SSH worker pool).                                             |
| **Deferred**    | We will implement this; not yet shipped. Tracked in an exec plan.                                                |
| **Skipped**     | We have decided not to implement this. Will not change without an ADR.                                           |

## Deviations

### §10 — Agent Runner Protocol — **Substituted**

**Spec:** prescribes Codex `app-server` as the agent backend, with
specific protocol concepts (`thread_id`, `turn_id`, `approval_policy`,
`thread_sandbox`, `turn_sandbox_policy`).

**Here:** the agent backend is the **Claude Agent SDK**. A thin
abstraction layer in `packages/daemon/src/agent/` translates between
Symphony's orchestration concepts and the SDK's primitives. Codex-
specific protocol fields have no direct equivalent and are not honored
literally.

**Reasoning:** [ADR 0001](../design-docs/0001-claude-agent-sdk-instead-of-codex.md)

**Implication:** This implementation is **not** conformant with the
spec's §10.1–§10.6 as written. Sections that describe orchestration
behavior (workspace cwd, prompt construction, continuation turns,
event emission to the orchestrator) are honored.

---

### §10.5 — `linear_graphql` client-side tool — **Implemented (recommended path)**

**Spec:** standardizes a `linear_graphql` tool the daemon may expose to
the agent. Optional under the spec.

**Here:** **implemented**, and chosen over alternatives like Linear's
hosted MCP server.

**Reasoning:** [ADR 0002](../design-docs/0002-no-linear-mcp.md)

---

### §11 — Issue tracker integration — **Restricted**

**Spec:** describes Linear as the v1 supported tracker, with a
forward-looking note about pluggable adapters.

**Here:** Linear is the only real adapter. We additionally ship a
`FakeTracker` for development and testing.

**Reasoning:** [ADR 0007](../design-docs/0007-fake-tracker-before-linear.md)
plus the project's scope as a personal learning effort.

**Implication:** Other trackers (Jira, GitHub Projects, ClickUp) are
out of scope for this implementation. The interface in
`packages/daemon/src/tracker/tracker.ts` is shaped to allow them, but
we won't add one until a concrete need arises.

---

### §13.7 — Optional HTTP server — **Substituted**

**Spec:** describes an optional HTTP server with `/`,
`/api/v1/state`, `/api/v1/<id>`, `/api/v1/refresh`. Implementations
may serve HTML or a client-side app.

**Here:** the daemon exposes `/api/v1/health` and `/api/v1/state`
(JSON-only, built-in `node:http`, not Fastify). The UI is a
separate Next.js process consuming the API. `/api/v1/<id>` and
`/api/v1/refresh` from the spec are **deferred** (not currently
needed; would require a daemon-side event buffer).

**Reasoning:** [ADR 0003](../design-docs/0003-two-process-architecture.md);
[ADR 0010](../design-docs/0010-co-located-http-is-provisional.md)
documents the provisional in-process arrangement and the planned
split in Plan 10.

**Status:** Shipped as of Plan 08. See
[`docs/exec-plans/completed/08-http-api-and-dashboard.md`](../exec-plans/completed/08-http-api-and-dashboard.md).

---

### §5 / §11.2 — Single-project workflow file — **Substituted (multi-project)**

**Spec:** SPEC §5 describes a single `WORKFLOW.md` file that pairs
one tracker (one `tracker.project_slug` per §11.2) with one prompt
template, one set of hooks, and one set of agent settings. The
implicit deployment shape is "one daemon, one project."

**Here:** the daemon takes a deployment YAML
(`symphony.yaml`) listing N projects. Each project entry binds a
Linear project slug to a git repo URL. The repo's per-project
agent workflow lives **inside the target repo** at
`<repo>/.symphony/workflow.md`, version-controlled with the code.
The daemon clones the repo, reads its workflow, and dispatches.

The legacy single-`WORKFLOW.md` invocation (`pnpm symphony
path/to/WORKFLOW.md`) is preserved as a single-project
compatibility mode — wraps an implicit one-project deployment.

**Reasoning:** [ADR 0009](../design-docs/0009-multi-project-orchestration.md).
The four-layer config split (operator deployment / project
binding / per-repo workflow / ephemeral state) is the core idea;
ownership boundaries follow.

**Implication:** This implementation is **not conformant** with
SPEC §5's single-file model when running in multi-project mode.
Single-project mode preserves the spec's `WORKFLOW.md` shape.

**Status:** **Shipped (foundation)** as of Plan 09 stage 09c.
The orchestrator is multi-project end-to-end with `FakeBackend`
in tests; `Issue` carries a `projectKey`; workspaces are
namespaced by project (`<root>/<projectKey>/<id>/`); the
snapshot wire format includes a per-project `projects[]`
breakdown the dashboard renders. The `symphony.yaml` schema is
implemented and parsed (Plan 09 stage 09b). The composition
root still runs in single-project compat mode at runtime;
multi-project YAML wiring at startup happens alongside the pod
runtime in [Plan 10](../exec-plans/active/10-agent-in-pod-runtime.md).
Per-repo `<repo>/.symphony/workflow.md` is loaded **by the pod**
after the clone (Plan 10) — the daemon never reads it directly.

---

### §9.3 — Workspace population — **Substituted (containerized)**

**Spec:** says workspace population beyond directory creation is
"implementation-defined" and typically handled via hooks.

**Here:** workspace population is implemented via a per-workspace
Docker container. The `before_run` hook clones the repo and
installs deps **inside the container**, not on the host. The
agent's shell tool (Bash) routes through wrapper scripts in
`<workspace>/.symphony/bin/` that `docker exec` into the
container. The host's `PATH` is constrained to those wrappers
plus a minimal allowlist, so the agent cannot accidentally use a
host-installed `git`/`pnpm`/`gh` that would not exist in
production.

**Reasoning:** see Plan 09 decision log. Spec §9.3 explicitly
permits implementation-defined population, so this is a
**substitution** (different mechanism) rather than a deviation
(different intent).

**Implication:** the host Symphony runs on must have Docker
Desktop (or a compatible Docker engine) running. If `docker` is
not available on `PATH`, multi-project mode fails at startup;
single-project compatibility mode without containers continues
to work.

---

### §14.3 — Partial state recovery — **Conformant**

**Spec:** scheduler state is intentionally in-memory; restart recovery
is tracker-driven.

**Here:** identical. Documented in [`RELIABILITY.md`](../../RELIABILITY.md).

---

### §18.2 — SSH worker extension — **Skipped**

**Spec:** describes an optional extension where the orchestrator
dispatches workers to remote hosts over SSH.

**Here:** **skipped.** A single-host daemon meets the project's needs.
We will not add SSH worker support without an ADR demonstrating a
concrete use case.

---

### §18.2 — Persisted retry queue / session metadata — **Skipped**

**Spec:** notes a TODO for persisting retry queue and session
metadata across restarts.

**Here:** **skipped.** Stateless across restarts is the documented
posture (see [`RELIABILITY.md`](../../RELIABILITY.md)).

---

### §18.2 — First-class tracker write APIs in the orchestrator — **Skipped**

**Spec:** notes a TODO for moving tracker writes into the orchestrator
rather than only via agent tools.

**Here:** **skipped.** Tracker writes happen exclusively via the
agent's `linear_graphql` tool. The orchestrator is a reader.

---

### `codex.*` front-matter section — **Restructured**

**Spec:** SPEC §5.3.6 defines a `codex` section with `command`,
`approval_policy`, `thread_sandbox`, `turn_sandbox_policy`,
`turn_timeout_ms`, `read_timeout_ms`, and `stall_timeout_ms`.

**Here:** the Codex-specific fields (`command`, the three policy
fields) are dropped — the Claude Agent SDK has no equivalents. The
generic timeout fields (`turn_timeout_ms`, `read_timeout_ms`,
`stall_timeout_ms`) are folded into `agent.*` since they describe
agent runtime behavior regardless of backend.

**Reasoning:** [ADR 0008](../design-docs/0008-fold-codex-section-into-agent.md)

**Migration:** an upstream `WORKFLOW.md` containing `codex.*` still
parses (top-level `.passthrough()` carries the section through), but
the values are ignored. To migrate, move the timeouts to `agent.*` and
delete the rest.

---

## Things we explicitly preserve

To make our conformance posture clear: aside from the deviations above,
we treat the spec as binding. Specifically the following are honored as
written:

- §4 Domain model (Issue / Workspace / RunAttempt / Session /
  RetryEntry / OrchestratorState fields, with Codex-specific fields
  reinterpreted via the agent abstraction).
- §5 Workflow file format (YAML front matter + Markdown body).
- §6 Configuration resolution pipeline including `$VAR` and `~`
  expansion.
- §7 Orchestration state machine (Unclaimed / Claimed / Running /
  RetryQueued / Released).
- §8 Polling, scheduling, reconciliation, and retry semantics.
- §9 Workspace management invariants (sanitization, root containment,
  agent cwd checks).
- §11.3 Tracker normalization rules (when implementing Linear).
- §12 Prompt rendering with strict variables / filters (we use
  [LiquidJS](https://liquidjs.com/) — Liquid-compatible, as the spec
  permits).
- §13 Logging and observability fields (`issue_id`, `issue_identifier`,
  `session_id`).
- §14 Failure model and recovery strategy.
- §15 Filesystem safety and secret-handling requirements.
