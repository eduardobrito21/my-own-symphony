# Plan 15 — Subtract to the sub-agent pipeline

- **Status:** ✅ Complete (2026-05-17)
- **Implements:** ADR 0014 (sub-agent pipeline + skill-driven
  provisioning supersedes ExecutionBackend, agent-in-pod, and
  broker transport).
- **Supersedes:** Plan 13 (deployable services — collapses to
  "run the daemon as a Node process"), Plan 14 (Namespace
  ExecutionBackend — replaced by the @infra skill).
- **Reshapes:** Plan 12 (end-to-end PR demo — goal survives,
  verification scenarios tied to pod lifecycle get rewritten).
- **Untouched:** Plan 11 (idempotent side effects — properties
  matter under any architecture; marker conventions + branch
  reuse logic port forward into skill behavior).
- **Comes BEFORE:** a future Plan 16 ("Skill bundles + sub-agent
  pipeline") that adds the new architecture's actual code on top
  of the subtracted seed.

## Goal

Subtract every file, package, and script that exists to support
the ExecutionBackend / agent-in-pod / broker-transport
architecture. Leave behind the load-bearing parts that survive
into the sub-agent pipeline architecture (orchestrator, tracker,
HTTP, dashboard, types, docs, idempotency).

This plan does **not** add the new architecture. It clears the
ground for it. After Plan 15, the surviving codebase is the
seed; Plan 16 will plant the new shape on top.

## Outcome shape (preview)

Before Plan 15:

```
my-own-symphony/
├── packages/
│   ├── agent-runtime/        ← deleted (whole package)
│   ├── daemon/
│   │   └── src/
│   │       ├── execution/    ← deleted (whole subtree)
│   │       ├── agent/        ← partially deleted + re-roled
│   │       ├── orchestrator/ ← survives
│   │       ├── tracker/      ← survives
│   │       ├── workspace/    ← re-roled (lighter) OR deleted
│   │       ├── http/         ← survives
│   │       ├── observability/← survives
│   │       ├── config/       ← survives, schema revised
│   │       └── types/        ← survives, revised (drop pod types)
│   ├── dashboard/            ← survives (event-schema impact later)
│   └── types/                ← survives
├── docker/                   ← deleted (whole directory)
├── examples/                 ← partially deleted + re-roled
└── docs/                     ← survives, statuses updated
```

After Plan 15: same tree, the marked items removed or shrunk.
No new code added — that's Plan 16's job.

## What survives (no changes from this plan)

These layers are load-bearing under any architecture and stay
exactly as they are. Listed first so the kill list reads against
a known baseline.

- `packages/daemon/src/orchestrator/` — polling cadence,
  eligibility, retries, reconcile, lock, state. The dispatcher
  core.
- `packages/daemon/src/tracker/` — Linear adapter, normalizer,
  fake tracker, blockers, eligibility. ADR 0007's discipline
  intact.
- `packages/daemon/src/http/` — API server. Dashboard reads
  from it.
- `packages/daemon/src/observability/` — logger, log shapes.
- `packages/daemon/src/agent/claude/` — most of it. The Claude
  Agent SDK wrapper is exactly what the parent agent uses in
  the new model. Specifics: `agent.ts`, `event-mapping.ts`,
  `session-store.ts`, `linear-skill-loader.ts` (already a skill
  loader — gets repurposed, not deleted).
- `packages/daemon/src/agent/mock/` — keep for tests.
- `packages/daemon/src/agent/tools/linear-graphql.ts` — Linear
  writes remain a tool the agent invokes directly.
- `packages/dashboard/` — survives. Event-schema impact comes
  later in Plan 16; not Plan 15's problem.
- `packages/types/` — shared types.
- All ADRs and plans (with status updates per the "doc updates"
  section below).
- `examples/repo-workflow/` — `workflow.md` model survives.
- `examples/fake/` — fake tracker fixtures.

## What gets deleted (the kill list)

### Whole packages

1. **`packages/agent-runtime/`** — the entire package.
   - `src/dispatch-envelope.ts` — file-mounted envelope is gone
     (ADR 0014 replaces it with in-process agent + skills).
   - `src/dispatch-envelope.test.ts`
   - `src/entrypoint.ts` — no in-pod entrypoint; the agent runs
     in the daemon process.
   - `src/linear-helper.ts` — folds into the daemon's tracker
     layer if any logic is needed (likely already duplicated).
   - `src/socket-writer.ts` — no per-pod socket.
   - `package.json`, `tsconfig*.json`
   - Remove from `pnpm-workspace.yaml` if listed explicitly.
   - Remove from `tsconfig.json` references.

### Whole subtrees inside `packages/daemon/`

2. **`packages/daemon/src/execution/`** — the entire subtree.
   - `backend.ts` — the `ExecutionBackend` interface itself.
     Replaced by the agent's @infra skill.
   - `errors.ts` — execution error types.
   - `fake.ts`, `fake.test.ts` — `FakeBackend` for tests.
     Tests that depended on it get reshaped under Plan 16.
   - `index.ts` — re-exports.
   - `local-docker/` (entire subdirectory):
     - `backend.ts`, `backend.test.ts`
     - `docker-runner.ts`
     - `image-resolver.ts`, `image-resolver.test.ts`
     - `socket-server.ts`
     - `index.ts`
   - **Note:** the `plan14-namespace-backend` branch's
     `execution/namespace/` subtree is also dead. That branch
     becomes reference-only. The `Compute.Instance` plumbing
     in `sdk-runner.ts` is portable into the future @infra
     skill as a shell wrapper around `nsc` / the SDK.

3. **`packages/daemon/src/agent/backend/`** — the
   `BackendAgentRunner` that dispatches to ExecutionBackend.
   - `backend-runner.ts`, `backend-runner.test.ts`
   - Replaced by direct SDK `query()` invocation in the
     daemon (Plan 16).

### Whole top-level directories

4. **`docker/`** — the entire directory.
   - `agent-base.Dockerfile` — no in-pod image.
   - `README.md` — its premise is gone.

### Root scripts

5. **`package.json` scripts:**
   - Delete `docker:build:agent-base`.
   - Audit `symphony` script — keep, the daemon still runs as a
     Node process. No change needed.
   - Audit `dashboard` / `dashboard:build` — keep.

### Examples

6. **`examples/deployment/`** — audit and revise.
   - Delete any `agent.dockerfile` examples (per-repo Dockerfile
     resolution is gone).
   - Delete any `symphony.yaml.namespace` / `symphony.yaml.docker`
     variants — collapse to one example (the schema gets simpler
     in step 9).
   - Keep operator-quickstart README; rewrite premise.

7. **`examples/repo-workflow/` `workflow.md` examples** — keep,
   but audit for references to the docker:build cycle, per-repo
   `.symphony/agent.dockerfile`, or "the pod mounts your repo at
   /workspace." Strip those.

## What gets re-roled (lighter / repurposed)

These survive but their role changes.

### Workspace manager

8. **`packages/daemon/src/workspace/`** — re-role or delete
   entirely.
   - Old role: create per-issue host directory, bind-mount into
     pod. The pod is gone, so the bind-mount premise is gone.
   - Candidate new role: scratch space for skill-side artifacts
     (logs, intermediate files the @infra skill produces).
     Possibly slimmed to just `paths.ts` + a tiny manager.
   - **Decision in this plan:** delete `container.ts`,
     `hooks.ts`, `hooks.test.ts` outright (Docker-specific).
     Keep `paths.ts`, `paths.test.ts`, `manager.ts`,
     `manager.test.ts` for the scratch-space role; revise to
     drop pod-related fields.
   - `errors.ts`, `index.ts` — slim per the above.

### Config schema

9. **`packages/daemon/src/config/`** — revise, don't delete.
   - `deployment.ts` — drop the `execution.backend` enum
     (`local-docker` / `namespace`). Drop `execution.base_image`.
     Add a `skills` section (paths to skill bundles) — but defer
     the _shape_ of that section to Plan 16. Plan 15 just
     removes the dead fields.
   - `deployment.test.ts` — update tests.
   - `parse.ts`, `parse.test.ts` — adapt to the new schema.
   - `repo-workflow.ts`, `repo-workflow.test.ts` — survives;
     the per-repo `workflow.md` model still applies.
   - `resolve.ts`, `resolve.test.ts` — survives.
   - `schema.ts`, `schema.test.ts` — survives.
   - `errors.ts`, `deployment-loader.ts` — survives.

### Types

10. **`packages/daemon/src/types/`** — revise lightly.
    - `workspace.ts` — drop pod-related fields; keep the
      issue/branch identity fields.
    - `run-attempt.ts` — keep; the "attempt" concept is
      architecture-agnostic.
    - `ids.ts`, `issue.ts`, `orchestrator-state.ts`,
      `retry-entry.ts`, `sanitize.ts`, `session.ts`,
      `index.ts` — all survive.

### Agent layer

11. **`packages/daemon/src/agent/`** — mixed.
    - `prompt.ts`, `prompt.test.ts` — keep for now; the prompt
      builder's shape changes substantially in Plan 16 but the
      file isn't dead.
    - `runner.ts` — keep; gets rewritten as the in-process
      parent-agent runner in Plan 16.
    - `claude/` — survives entirely:
      - `agent.ts`, `agent.test.ts` — the SDK wrapper. The
        parent agent in the new model uses this directly.
      - `event-mapping.ts`, `event-mapping.test.ts` — survives.
      - `session-store.ts`, `session-store.test.ts` —
        survives. Session resumption still relevant.
      - `linear-skill-loader.ts` — repurpose (already a skill
        loader by name; generalize to multiple skills in Plan
        16).
    - `mock/` — survives for tests.
    - `tools/linear-graphql.ts`, `tools/linear-graphql.test.ts`
      — survives.
    - `backend/` — deleted (see step 3 above).

## Doc updates (status flips + light edits)

12. **ADR 0011** — flip status from
    `Accepted (transport sections superseded by 0013)` to
    `Superseded by ADR 0014`. Add a one-line header note.

13. **ADR 0012** — flip status from
    `Proposed (implementation transport reshaped by 0013)` to
    `Superseded by ADR 0014`. Header note.

14. **ADR 0013** — flip status from `Proposed` to
    `Superseded by ADR 0014`. Header note explaining that the
    broker-vs-controller transport question dissolves because
    there is no transport.

15. **Plan 13** — flip status from
    `🟡 Drafted, reshape pending` to
    `🔴 Superseded by Plan 15`. Header note.

16. **Plan 14** — flip status from
    `🔴 Superseded by ADR 0013; pending Plan 15` to
    `🔴 Superseded by Plan 15 (the kill); replaced by future
Plan 16`. Note that the `plan14-namespace-backend` branch
    stays as reference for Compute.Instance plumbing.

17. **Plan 12** — note that "end-to-end PR demo" survives but
    the daemon-restart-mid-run and host-has-no-pnpm
    verification scenarios get rewritten after Plan 16. Add a
    `🟡 Partial supersede by Plan 15; pipeline-pending-Plan-16`
    status note.

18. **`docs/design-docs/index.md`** — update status cells for
    0011, 0012, 0013; add 0014.

19. **`README.md`, `ARCHITECTURE.md`, `SECURITY.md`,
    `RELIABILITY.md`** — every reference to "agent runs in a
    pod," "per-issue Docker container," "ExecutionBackend,"
    "agent-base image," or "dispatch envelope mounted at
    `/etc/symphony/dispatch.json`" is stale. **In Plan 15:**
    add a banner at the top of each noting "post-ADR 0014
    architecture pivot; sections below describe the pre-pivot
    state and will be rewritten in Plan 16." Don't do the
    rewrite in this plan — that's writing the new architecture,
    which is Plan 16.

## What's NOT in this plan

- ❌ Adding any code for the new architecture. Plan 16's job.
- ❌ Writing skill bundles. Plan 16's job.
- ❌ Wiring `@anthropic-ai/claude-agent-sdk` into the daemon as
  the direct host. Plan 16's job.
- ❌ Designing the skill contract (`sandbox_handle`, `exec_tool`,
  structured handoff shape). Plan 16's job.
- ❌ Rewriting `README.md` / `ARCHITECTURE.md` past the banner
  note. Plan 16's job — the new architecture has to exist before
  the docs describe it.
- ❌ Deleting the `plan14-namespace-backend` branch. Stays as
  reference.

## Steps

### Stage 15a — Doc status updates (do first, cheap, unblocks others)

1. Add the header notes + flip statuses on ADRs 0011, 0012, 0013.
2. Add the header notes + flip statuses on Plans 12, 13, 14.
3. Update `docs/design-docs/index.md`.
4. Add the "post-ADR 0014" banner to `README.md`,
   `ARCHITECTURE.md`, `SECURITY.md`, `RELIABILITY.md`.

### Stage 15b — Delete `agent-runtime` package

5. `rm -r packages/agent-runtime`.
6. Remove from `pnpm-workspace.yaml`.
7. Remove from root `tsconfig.json` references.
8. Remove from `package.json`'s `docker:build:agent-base` (which
   itself gets deleted).
9. `pnpm install` to reconcile lockfile.
10. `pnpm typecheck` to surface dangling imports.

### Stage 15c — Delete `execution/` subtree

11. `rm -r packages/daemon/src/execution`.
12. Remove `packages/daemon/src/agent/backend/`.
13. Update `packages/daemon/src/index.ts` (the composition root)
    to drop everything that constructed an ExecutionBackend.
    The daemon's `main()` will need a temporary placeholder
    where the dispatch invocation used to happen (`// TODO Plan
16: spawn initial agent here`).
14. `pnpm typecheck` — expect a wave of errors as the
    composition root unwinds. Fix mechanically: delete imports,
    delete construction code, comment dispatch site.
15. Test failures: a chunk of orchestrator + agent tests
    depended on `FakeBackend`. Mark those tests `.skip` with a
    `// Plan 16: re-wire against in-process agent runner`
    comment. Don't delete; they're regression coverage that
    re-greens in Plan 16.

### Stage 15d — Delete `docker/`

16. `rm -r docker/`.
17. Remove `docker:build:agent-base` from root `package.json`.
18. Audit `README.md` for `docker build` instructions; banner
    them (Stage 15a covers this) or remove if they're in code
    blocks the banner doesn't shade.

### Stage 15e — Re-role workspace + config + types

19. **Workspace:** delete `container.ts`, `container.test.ts`,
    `hooks.ts`, `hooks.test.ts`. Slim `manager.ts` (and its
    test) + `paths.ts` (and its test) to the scratch-space
    role: drop pod-related fields and methods. Update
    `index.ts` re-exports. Update `errors.ts`.

20. **Config schema:** drop `execution.backend` and
    `execution.base_image` from `deployment.ts`. Update
    `deployment.test.ts`. If `parse.ts` references those keys,
    update. Do **not** add the new `skills` section yet —
    that's Plan 16.

21. **Types:** drop pod-related fields in `workspace.ts`.
    Anything else flagged by `pnpm typecheck` after the
    deletions above gets cleaned here.

### Stage 15f — Examples

22. Delete `examples/deployment/symphony.yaml.namespace` if
    present (it's on the plan14 branch).
23. Audit `examples/deployment/symphony.yaml` for the deleted
    fields; trim.
24. Audit `examples/repo-workflow/` for references to
    `agent.dockerfile`, `docker:build:<projectKey>`, or
    "/workspace mount." Strip.

### Stage 15g — Final sweep

25. `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm
test` should pass (with the `.skip`'d tests). Anything else
    failing means a stray reference; fix.
26. `git status` should show **only deletions** (and the doc
    status updates from Stage 15a, and the placeholder comment
    in the composition root). No new code files.
27. LOC delta: expect 4,000–6,000 lines removed. Final commit
    message reports the diffstat.

## Definition of done

- All items in "what gets deleted" are gone from the working
  tree on `main` (after this plan merges).
- All doc status flips landed; ADRs 0011/0012/0013 and Plans
  13/14 show `Superseded` status.
- `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `RELIABILITY.md`
  carry the post-pivot banner.
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  passes (with the documented `.skip`'d test set).
- `git diff --stat main` against the pre-Plan-15 baseline shows
  ≥ 80% lines removed, ≤ 20% lines added (the additions are
  doc banners + the composition-root placeholder).
- The `plan14-namespace-backend` branch is unchanged
  (reference-only).

## Open questions

- **Workspace manager: re-role or delete entirely?** This plan
  re-roles it to scratch-space. If Plan 16 finds it has zero
  callers, delete then. Defer the call.
- **Should the `BackendAgentRunner` deletion in Stage 15c
  include `packages/daemon/src/agent/prompt.ts` /
  `prompt.test.ts`?** Probably not — the prompt builder has
  reusable logic. But if Plan 16 rewrites it wholesale, this
  plan was wasted work. Lean on keep; cheap to re-delete.
- **The `.skip`'d tests** — are they really regression coverage,
  or are they architectural artifacts that should be deleted
  too? Stage 15c marks them `.skip` rather than deleting so
  we can decide per-test in Plan 16. If most of them get
  deleted in 16 anyway, this was minor friction.
- **Composition root placeholder.** Stage 15c leaves a comment
  where the dispatch invocation was. That comment is the
  "here be Plan 16's work" marker. Acceptable to leave a daemon
  that polls but doesn't dispatch for the duration between
  Plan 15 merging and Plan 16 landing? **Yes** — the daemon
  still loads, the dashboard still renders, the orchestrator
  state still updates. It just no-ops on the "act on an
  eligible issue" step. Document loudly in the commit.

## Decision log

### 2026-05-17 — Plan 15 complete

Commit `7044ddc` executed the full kill list. Net: 5,079 lines removed
across 54 files. Deletions verified:

- `packages/agent-runtime/` — deleted (whole package, 7 files)
- `packages/daemon/src/execution/` — deleted (whole subtree, 11 files)
- `packages/daemon/src/agent/backend/` — deleted (BackendAgentRunner)
- `packages/daemon/src/workspace/container.ts`, `hooks.ts`, `hooks.test.ts` — deleted
- `docker/` — deleted (agent-base.Dockerfile + README)
- `docker:build:agent-base` script — removed from root package.json

Re-roles verified:

- `packages/daemon/src/index.ts` — `NoopAgentRunner` stub in place
- `packages/daemon/src/workspace/manager.ts` — hook subsystem removed
- `packages/daemon/src/config/deployment.ts` — `ExecutionConfig` dropped
- `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, `RELIABILITY.md` — banners added
- ADRs 0011/0012/0013 — status flipped to "Superseded by ADR 0014"

Checks: `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
all clean (313 tests pass, 1 skipped with Plan 16 marker).
