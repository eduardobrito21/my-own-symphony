# Plan 10 — Agent-in-pod runtime + LocalDockerBackend

- **Status:** ✅ Complete — smoke verified end-to-end on 2026-04-30 (one Linear issue, full docker pod path, ~12s + $0.035 / turn).
- **Extracted from:** original Plan 09 stage 09d. Split out as
  its own plan so the pod runtime can be built and verified
  independently from the multi-project foundation (Plan 09 ships
  with `FakeBackend`; this plan ships the real one).
- **Spec sections:** §9 (workspace management — substituted by
  the pod runtime).
- **Layers touched:** new `packages/agent-runtime/` package
  (entrypoint shim that runs INSIDE the pod), new top-level
  `docker/` (base image), `packages/daemon/src/execution/`
  (`LocalDockerBackend` impl alongside the existing
  `FakeBackend`).
- **ADRs referenced:** 0009 (multi-project — image resolution
  is per-project), **0011 (agent-in-pod + ExecutionBackend —
  this plan implements the production backend)**.
- **Comes AFTER:** Plan 09 (multi-project foundation +
  ExecutionBackend interface + FakeBackend must exist before we
  can ship a production impl of the same interface).
- **Comes BEFORE:** Plan 11 (idempotent side effects builds on
  this plan's pod runtime), Plan 12 (live PR demo needs all
  three of 09 + 11 + 12), Plan 13 (deployment containerization
  needs the agent runtime image to exist).

## Goal

A single Linear issue dispatched via real Docker:

1. Operator runs `pnpm docker:build:agent-base` once to build
   `symphony/agent-base:1`.
2. Operator declares one project in `symphony.yaml` (the
   multi-project config from Plan 09 already supports this — we
   just have one entry instead of N).
3. A Linear issue lands in `Todo`.
4. The daemon picks it up and calls
   `LocalDockerBackend.start(...)` with the resolved image and
   dispatch envelope.
5. The pod starts, runs the agent-runtime entrypoint, fetches
   the issue from Linear, clones the repo, reads the per-repo
   `workflow.md`, renders the prompt, runs the Claude Agent SDK
   with `Bash`/`Read`/`Edit`/`Write` tools, and exits cleanly.
6. The daemon stops the pod and the dashboard shows the
   completed run.

What is NOT in scope here (deferred to Plan 11 or 13):

- Idempotent re-dispatch behavior (per-issue branch reuse, PR
  upsert, comment dedup) — Plan 11.
- A real PR opening on a real GitHub repo — Plan 12.
- Symphony self-hosting — Plan 12.

The minimum demo for this plan: the pod runs and posts a
"hello from the pod" comment to the Linear issue. That proves
the runtime works end-to-end without dragging in PR-loop
complexity.

## Outcome shape (preview)

```
Daemon (control plane — from Plan 09)
   │
   │ ExecutionBackend.start({ image, workspace, env, envelope })
   │    ↑ resolved by this plan (no longer FakeBackend)
   │
LocalDockerBackend (this plan)
   │ docker run --rm -d \
   │   --name symphony-<project>-<issue> \
   │   -v <workspace>:/workspace \
   │   -v <events-sock-host>:/var/run/symphony/events.sock \
   │   -v <dispatch-json>:/etc/symphony/dispatch.json:ro \
   │   -e LINEAR_API_KEY=... -e GITHUB_TOKEN=... \
   │   -e ANTHROPIC_API_KEY=... -e SYMPHONY_*=... \
   │   <resolved-image>
   ↓
Pod (one per issue)
   ┌─────────────────────────────────────────────────┐
   │ ENTRYPOINT: tini → node entrypoint.js           │
   │   (from packages/agent-runtime, baked into the  │
   │    base image)                                  │
   │                                                 │
   │ Entrypoint flow:                                │
   │   1. Read /etc/symphony/dispatch.json           │
   │   2. Fetch issue from Linear (eligibility)      │
   │   3. Transition issue to In Progress            │
   │      (handshake — daemon's next poll sees this) │
   │   4. Clone envelope.repo.url, checkout branch   │
   │   5. Read <workspace>/<workflowPath>            │
   │   6. Render prompt template (Liquid)            │
   │   7. Construct ClaudeAgent + run query()        │
   │   8. Stream AgentEvents to events.sock          │
   │   9. Exit 0 on terminal event                   │
   └─────────────────────────────────────────────────┘
```

## Why container-per-task (not container-per-command)

Settled in ADR 0011 + the prior 09 draft; preserving for this
plan's scope:

- `docker run --rm` per shell command costs 200–500ms cold-start
  per call. A typical turn makes 20–50 shell calls; that's
  10–25 seconds of pure docker overhead per turn, plus no warm
  caches.
- One container per task amortizes startup to once per dispatch.

## Why containers in this plan, not in Plan 13's deployment work

Two distinct containerizations:

- **This plan (11):** the **agent's execution environment** is
  a container. Per-issue, ephemeral. Owned by the orchestrator's
  dispatch path.
- **Plan 13:** the **daemon's deployment environment** is a
  container, alongside one for the dashboard and one for the
  API process. Per-deployment, long-lived. Owned by
  docker-compose.

Both are real and both are needed. They don't depend on each
other.

## Out of scope

- **Cloud sandbox backends (E2B / Firecracker / Fargate).** The
  `ExecutionBackend` interface from Plan 09 accepts them later;
  implementing them is not this plan's work.
- **Auto-build of per-repo agent images.** First dispatch errors
  with an actionable message ("run `pnpm docker:build:<key>`"),
  the operator builds manually, retry succeeds. Auto-build is a
  later concern (cache invalidation by Dockerfile + lockfile
  hash, build queue, etc.).
- **Network egress restrictions on the agent pod.** The pod
  needs `git push`, `gh`, npm registry — full network access
  for now. Per-pod network policies are a later concern.
- **Per-tool permission prompts (`PreToolUse` hooks).** We trust
  the agent within its `allowed_tools` list. Real hooks come
  later.
- **Resource caps (CPU/mem/disk) on the agent pod.** Add once
  we have a sense of normal workload sizes.
- **Multi-arch images.** Build for the host's arch only.
- **PR opening / GitHub workflow.** Plan 12.
- **Re-dispatch idempotency.** Plan 11.

## Steps

### Stage 11a — Agent-runtime entrypoint

1. **New `packages/agent-runtime/` workspace package**:
   - `package.json` declares `@symphony/agent-runtime` with the
     Claude Agent SDK + the existing `LinearClient` + the
     existing tracker types as deps.
   - Builds via `tsc` to `dist/`.
   - The build artifact goes into the base image; the package
     is not consumed by other workspace packages.

2. **Entrypoint shim** at
   `packages/agent-runtime/src/entrypoint.ts`. Per ADR 0011's
   pod-fetches model, the entrypoint owns the entire work flow
   inside the pod:
   - Reads the **dispatch envelope** from
     `/etc/symphony/dispatch.json` (mounted by the backend at
     pod start). Carries: issue id + identifier, project key,
     tracker coordinates, repo coordinates, operator-side caps,
     attempt + resume context. Does NOT carry the issue body or
     a rendered prompt.
   - Validates the envelope with a zod schema (per ADR 0006).
   - Fetches the issue from the tracker (Linear) using the
     project slug in the envelope and `LINEAR_API_KEY` from env.
     If the issue is gone or no longer in an active state,
     exits with `turn_failed` reason "no longer eligible" and
     does not transition Linear state (the human/other agent
     that moved it is authoritative).
   - Transitions the issue to "In Progress" as the dispatch
     handshake — this is what the daemon's next poll sees as
     "claimed" (replaces the daemon's in-memory `running` set
     as authoritative dispatch state).
   - Clones `envelope.repo.url` into `/workspace`, checking out
     (or creating) the per-issue branch
     `<branchPrefix><issueIdentifier>`.
   - Reads `<workspace>/<envelope.repo.workflowPath>` for the
     per-repo `workflow.md`. Renders the prompt template
     (Liquid) against the freshly-fetched issue + `attempt`.
   - Resolves effective execution settings: repo-side
     `workflow.md` wins for `model` and `allowedTools`;
     `min(operatorCaps, repoCaps)` for budget fields.
   - Constructs `ClaudeAgent` (today's class, almost unchanged)
     and runs `query()`.
   - Streams `AgentEvent`s as JSON lines to a Unix domain
     socket at `/var/run/symphony/events.sock` (mounted by the
     backend; the daemon end of the socket is what reads them).
   - Writes session.json updates to `/workspace/.symphony/`
     (bind-mounted to host).
   - Exits 0 on terminal event, non-zero on crash.

3. **Migration of `ClaudeAgent`**: the existing class at
   `packages/daemon/src/agent/claude/agent.ts` moves into
   `packages/agent-runtime/src/agent/`. The class itself is
   almost unchanged; what's new is the entrypoint shim that
   constructs it from the dispatch envelope. The daemon stops
   constructing `ClaudeAgent` directly — it constructs
   `ExecutionBackend.start(...)` instead.

### Stage 11b — Base image

4. **`docker/agent-base.Dockerfile`** — the image the pod
   actually runs:
   - `node:20-bookworm-slim` base.
   - Installs: git, openssh-client, gh, pnpm (corepack via
     `corepack enable && corepack prepare pnpm@10.18.2 --activate`),
     tini, jq, ca-certificates, gnupg, curl.
   - Bundles the agent-runtime build artifact at known path
     (`/opt/symphony/agent-runtime/dist/entrypoint.js`).
   - Bundles the Claude Agent SDK + production deps.
   - Non-root `agent` user (uid 1000 — rename from `node`).
   - `WORKDIR /workspace`.
   - `ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/symphony/agent-runtime/dist/entrypoint.js"]`.
   - Tagged `symphony/agent-base:1`. The version tag bumps when
     the contract (entrypoint location, mounted-paths, env vars)
     changes.

5. **Build script** in root `package.json`:
   - `pnpm docker:build:agent-base` →
     `pnpm --filter @symphony/agent-runtime build && \
docker build -f docker/agent-base.Dockerfile -t symphony/agent-base:1 .`.
   - Documented in README + a one-line callout in the operator
     quickstart.

### Stage 11c — LocalDockerBackend

6. **`LocalDockerBackend`** at
   `packages/daemon/src/execution/local-docker/`:
   - `ensureImage`: implements the resolution order in step 7.
     Returns `image_not_found` (with actionable message) if the
     resolved tag isn't present locally — does NOT auto-build.
   - `start`: shells `docker run --rm -d --name <pod-name>
-v <workspace>:/workspace
-v <events-sock-host>:/var/run/symphony/events.sock
-v <dispatch-json>:/etc/symphony/dispatch.json:ro
-e LINEAR_API_KEY=... -e GITHUB_TOKEN=... -e ANTHROPIC_API_KEY=...
-e SYMPHONY_*=...
<resolved-image>`.
     Returns a `PodHandle` wrapping the container id and an
     AsyncIterable that reads the events socket.
   - `stop`: `docker stop -t 5 <pod-name>; docker rm -f <pod-name>`.
     Idempotent (already-gone is `ok`).
   - `logsTail`: `docker logs --tail 200 <pod-name>`.
   - Uses `docker` CLI (no SDK dependency). Tests mock the
     `docker` runner the same way the existing
     `WorkspaceContainer` tests do.

7. **Image resolution order** (documented contract):
   1. Project config sets explicit `agent_image: <tag>` →
      use it. Error if the tag is missing locally.
   2. Workspace contains `.symphony/agent.dockerfile` →
      expected tag is `symphony-agent/<project_key>:latest`.
      Built by `pnpm docker:build:<project_key>`. Error with
      actionable message if missing.
   3. Workspace contains `.devcontainer/Dockerfile` (and not
      (2)) → same expected tag, built from the devcontainer
      file. Free reuse of repos that already have one.
   4. Otherwise → `<execution.base_image>` from deployment
      config (default `symphony/agent-base:1`).

### Stage 11d — Daemon ↔ pod event protocol

8. **Per-pod Unix socket** wiring:
   - The daemon allocates a host-side socket path (e.g.
     `/var/lib/symphony/sockets/<pod-name>.sock`) per dispatch.
   - Bind-mounts it into the pod at
     `/var/run/symphony/events.sock`.
   - The daemon listens on the host side; the agent-runtime
     writes JSON-line `AgentEvent`s to its end.
   - When the pod exits, the daemon closes the socket and
     emits a synthetic terminal event if the pod exited
     without one (defensive — the agent-runtime should always
     emit one).

9. **JSON-line wire format**: each line is one `AgentEvent`
   (the existing discriminated union in
   `packages/daemon/src/agent/runner.ts`). zod schema for
   parsing on the daemon side; same schema is the agent-runtime
   serializer's reference. Per ADR 0006.

### Stage 11e — Smoke verification

10. **Local end-to-end smoke** with one Linear issue. Goal:
    prove the pod runs and exits cleanly. Specifically:
    - Build the base image: `pnpm docker:build:agent-base`.
    - Configure `symphony.yaml` with one project pointing at
      a throwaway test repo. The repo has a minimal
      `.symphony/workflow.md` that says: "Post a comment on
      this issue saying 'hello from the pod', then transition
      to Done."
    - Create a Linear issue in the test project, state Todo.
    - Run `pnpm symphony` (with the deployment YAML).
    - Watch the dashboard:
      - Pod starts (visible in `docker ps` as
        `symphony-<project>-<issue>`).
      - Linear comment lands.
      - Issue transitions Todo → In Progress → Done.
      - Pod is removed.
    - Capture the result in the decision log.

### Stage 11f — Tests + docs

11. **Tests**:
    - `LocalDockerBackend` with mocked `docker` runner
      (start, stop, logsTail, idempotency, ensureImage all
      four resolution branches).
    - Image resolution unit tests covering each branch with
      a fake filesystem.
    - Agent-runtime entrypoint tests:
      - Envelope parsing (valid + invalid).
      - "No longer eligible" exit path.
      - Successful render → SDK invocation (with a stubbed
        SDK).
    - Event-protocol round trip: agent-runtime writes events
      to a socket, daemon reads them back, equality check.

12. **Documentation**:
    - `packages/agent-runtime/README.md` — what the package
      is, how it gets into the image, what env vars it reads.
    - `docker/README.md` — how to build the base image, what
      the version tag means.
    - Update `ARCHITECTURE.md` layer map to include
      `agent-runtime` package and `LocalDockerBackend`.
    - `SECURITY.md` — note that `LINEAR_API_KEY`,
      `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` flow into pods as
      env vars.

## Definition of done

- `pnpm docker:build:agent-base` succeeds and produces
  `symphony/agent-base:1` locally.
- A single Linear issue dispatched through `LocalDockerBackend`
  starts a real Docker pod, the pod runs the agent-runtime
  entrypoint, posts a "hello from the pod" Linear comment,
  transitions the issue to Done, and exits cleanly. Daemon
  removes the pod.
- Removing the host's `git`, `pnpm`, or `gh` does NOT break
  the smoke (the pod is the source of truth for those tools).
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean, with new tests for `LocalDockerBackend`, image
  resolution, entrypoint envelope parsing, and event-protocol
  round trip.
- Image resolution honors all four sources (explicit tag,
  `.symphony/agent.dockerfile`, `.devcontainer/Dockerfile`,
  base image fallback) — verified by tests.
- `ARCHITECTURE.md` updated to reflect the `agent-runtime`
  package and the `execution/local-docker/` subdir.

## Open questions

- **Daemon ↔ pod RPC: per-pod Unix socket vs single shared
  socket with pod-id framing?** Tentative: per-pod socket,
  bind-mounted at a known path. Simpler — no multiplexing.
- **Image build trigger — manual `pnpm docker:build:<key>` or
  daemon auto-builds on first dispatch?** Manual for v1.
  Auto-build needs cache invalidation by Dockerfile + lockfile
  hash, which is its own design problem (later plan).
- **Should the agent-runtime package live in this repo or a
  separate one?** In this repo for v1 (versioning is `npm
version` + image tag bump). Separate repo only if/when third
  parties want to write alternate runtimes.
- **GitHub creds in the pod for non-PR plans.** The smoke
  scope (Linear comment + transition) doesn't strictly need
  `GITHUB_TOKEN`. But the `git clone` does (private repos via
  HTTPS). Token plumbing lands here even though git push
  doesn't happen until Plan 11.

## Decision log

### 2026-04-30 (evening) — Stage 11e smoke run: PASS

End-to-end validation of the full docker pod path. One Linear issue
(EDU-9 in the `Smoke Test` project, slug `a532c6a9e9bb`) dispatched
through `LocalDockerBackend` against
`https://github.com/eduardobrito21/my-own-symphony-test.git` (its
`.symphony/workflow.md`: post a `hello from the pod 👋` comment +
transition to `Done`).

Result: 12 seconds end-to-end, $0.035 (Sonnet 4.6, cache hit on
turn 2). Pod went `Todo → In Progress` (handshake) → `Done` (agent),
comment landed. `worker_exit reason=normal`. Plan 10 satisfied
verbatim: "the pod runs and posts a 'hello from the pod' comment to
the Linear issue."

**Five blockers resolved en route to the green run, all worth
recording:**

1. **`pnpm deploy` errored on pnpm v10**: needed `--legacy` flag.
   pnpm 10 changed `deploy` to demand `inject-workspace-packages=true`
   by default; we don't need injected deps for the runtime image.
2. **`groupadd --gid 1000` clash**: `node:20-bookworm-slim` already
   ships a `node` user at uid 1000. Reused it instead of recreating.
3. **macOS Unix-socket path > 104 chars**: `$TMPDIR` (`/var/folders/...`)
   plus the per-pod subdir + UUID exceeded the kernel limit, surfacing
   as misleading `EADDRINUSE`. Switched to `~/.symphony-pods/<sha256-hash>.sock`
   (host shares `$HOME` with Docker by default; hash gives short stable
   names).
4. **Docker Desktop / VirtioFS doesn't pass live AF_UNIX sockets
   through bind mounts** on macOS. The mounted socket file appears in
   the pod but `connect()` fails with `EACCES`. **Switched the daemon ↔
   pod transport from Unix socket to TCP loopback** on
   `127.0.0.1:<random-port>`; pod connects via `host.docker.internal:<port>`
   (we wire `--add-host=host.docker.internal:host-gateway` for Linux
   parity). This is now the v1 wire format — Unix socket support is
   not coming back.
5. **SDK's libc detection picked musl on glibc bookworm**: the Claude
   Agent SDK's binary resolver tries `*-linux-<arch>-musl` first and
   only falls through to glibc if the musl package isn't installed.
   Both packages were present, so the SDK picked musl, then the
   kernel reported the binary as "not found" because `/lib/ld-musl-*`
   doesn't exist on bookworm. Fix: post-`pnpm deploy` step in the
   Dockerfile deletes the musl variants from the deploy tree, forcing
   fall-through to glibc.

These five are all encoded in code+comments in this PR. None of them
will recur unless the `Dockerfile` regresses — they're now mechanical.

### 2026-04-30 (afternoon) — Legacy `WORKFLOW.md` pipeline removed; `execution.backend: in-process` added

Driven by user feedback during smoke-prep: "before starting, remove the
legacy workflow.md pipeline. From now on, only 1 workflow, locally,
equals symphony.yaml with only one routine, the basic case."

Removed:

- `packages/daemon/src/config/loader.ts` — loaded WORKFLOW.md.
- `packages/daemon/src/config/watch.ts` — watched WORKFLOW.md for
  dynamic reload.
- `packages/daemon/src/config/loader.test.ts`,
  `packages/daemon/src/config/watch.test.ts`.
- `examples/linear/WORKFLOW.md`, `examples/fake/WORKFLOW.md`,
  `examples/linear/README.md` (whole `examples/linear/` dir).
- `Orchestrator.applyWorkflow` method and the
  `WorkflowDefinition` type.
- The `applyWorkflow` describe block in
  `orchestrator-plan05.test.ts` (the `Plan 05 dynamic-reload`
  feature ships nothing user-visible without the watcher).

Added:

- `execution.backend: in-process` as a third option (alongside
  `local-docker` and the still-internal `fake`-via-FakeBackend).
  When selected, the daemon constructs `ClaudeAgent` directly and
  runs it in its own process — no docker. This collapses what was
  the legacy "ClaudeAgent in daemon process" path into the
  `symphony.yaml`-driven composition root.
- The `local-docker` enum value remains the default; the
  user-visible choice now lives in one file (`symphony.yaml`)
  instead of being split between `WORKFLOW.md`'s `agent.kind` and
  `symphony.yaml`'s `execution.backend`.

Net effect: there's exactly one entrypoint shape. `pnpm symphony`
defaults to `./symphony.yaml`; the `argv[2]` extension dispatch
is gone. The `runLegacy()` function and its helpers
(`maybeBuildLinearClient`, `buildTracker`, `buildAgent`,
`buildLinearTracker`, `buildFakeTracker`) are deleted —
`buildAgent()` survives but is now `(deployment, ...) => AgentRunner`,
selecting `ClaudeAgent` (in-process) or `BackendAgentRunner`
(local-docker) per `execution.backend`.

`config/schema.ts` and the `ServiceConfig` type stay — they're now
internal-only, used to feed the orchestrator (which hasn't been
refactored to take `DeploymentConfig` directly). Synthesis happens
in `index.ts`. A future plan can flatten this if it becomes a
genuine pain point.

### 2026-04-30 (morning) — Stage 11a–11d landed; smoke (11e) deferred

What shipped:

- New `packages/agent-runtime/` workspace package — entrypoint shim
  (`src/entrypoint.ts`), dispatch envelope zod schema
  (`src/dispatch-envelope.ts`), JSON-line socket writer
  (`src/socket-writer.ts`), and a small Linear helper for the
  eligibility-check + dispatch-handshake (`src/linear-helper.ts`).
- `docker/agent-base.Dockerfile` (multi-stage build) and
  `pnpm docker:build:agent-base` script in the root `package.json`.
- `LocalDockerBackend` at
  `packages/daemon/src/execution/local-docker/`, with image resolution
  honoring all four sources (explicit tag → `.symphony/agent.dockerfile`
  → `.devcontainer/Dockerfile` → base fallback) and `start` /
  `stop` / `logsTail`.
- Per-pod Unix socket protocol — `bindEventSocket` on the daemon side
  yields `AsyncIterable<AgentEvent>`; the in-pod `EventSocketWriter`
  writes JSON-line events at the other end. Tests cover the round
  trip with a real socket pair (no docker needed).
- `BackendAgentRunner` adapter at `packages/daemon/src/agent/backend/`
  — implements the existing `AgentRunner` interface in terms of an
  `ExecutionBackend`. Lets the orchestrator use the pod runtime
  without rewriting every existing `MockAgent`-based test. The full
  orchestrator → `ExecutionBackend.start(...)` cutover is a Plan 11
  follow-up.
- Tests: image resolver (every branch), LocalDockerBackend (mocked
  `docker` runner + a real Unix socket round trip), dispatch envelope
  schema, backend adapter (using `FakeBackend`).
- ARCHITECTURE.md and SECURITY.md updated to cover the
  `agent-runtime` package, the `execution/local-docker/` subdir,
  and the `GITHUB_TOKEN` plumbing into pods.

What's deferred:

- **Stage 11e smoke run.** Requires a host with docker installed +
  a Linear test project + a test repo; not done in this CI-only
  iteration. The Dockerfile, build script, and runtime contract are
  all in place — an operator can run the smoke when ready and
  capture the result in this log.
- **Migration of `ClaudeAgent` from daemon to agent-runtime.** Plan
  10 step 3 calls for moving the class. We deviated: the class stays
  in `packages/daemon/src/agent/claude/agent.ts` and the
  agent-runtime imports it via the new `@symphony/daemon/agent/claude`
  subpath export. This avoids moving ~1.7k lines of source + tests
  for a code-organization gain that doesn't change behavior. The
  daemon's composition root (`index.ts`) still constructs
  `ClaudeAgent` for legacy in-process mode; that path can be removed
  in Plan 11 once the orchestrator is fully cut over to
  `ExecutionBackend`.
- **Daemon composition root wiring.** The daemon's `index.ts` doesn't
  yet construct `LocalDockerBackend` and `BackendAgentRunner` — the
  pieces are in place but the operator-visible config switch
  (`agent.kind: docker` / `execution.backend: local-docker` selecting
  the new path) is wired in a follow-up patch alongside the smoke
  run. Composition root changes are out of scope here because they
  need the smoke run to validate end-to-end.
