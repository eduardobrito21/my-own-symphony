# Plan 14 — Namespace ExecutionBackend

- **Status:** 📝 Drafted
- **New plan.** Created 2026-04-30 after the design discussion
  that produced ADR 0012 (Namespace as the v1 production
  ExecutionBackend).
- **Spec sections:** none directly (this is an additional
  backend behind ADR 0011's seam).
- **Layers touched:** new
  `packages/daemon/src/execution/namespace/` directory (the
  backend impl + tests),
  `packages/daemon/src/config/deployment.ts` (enum gains
  `namespace`),
  `packages/daemon/src/index.ts` (composition root branches on
  the new value),
  `packages/agent-runtime/src/entrypoint.ts` (envelope reads
  from `SYMPHONY_DISPATCH_ENVELOPE` env var as a fallback to
  the file mount),
  `packages/agent-runtime/` build (tarball artifact for VM
  upload),
  `examples/deployment/symphony.yaml` (a `backend: namespace`
  example).
- **ADRs referenced:** 0011 (agent-in-pod + ExecutionBackend
  seam — the abstraction this plan slots into), 0012 (Namespace
  as production target — the decision this plan implements).
- **Comes AFTER:** Plan 10 (the agent-runtime entrypoint must
  exist; we're swapping the transport, not the runtime).
- **Comes BEFORE:** Plan 11-slim (idempotent side effects —
  scoped down post-Namespace, since ephemeral VMs eliminate
  some prior concerns), Plan 12 (end-to-end PR demo —
  reshaped to run against `NamespaceBackend`).

## Goal

`execution.backend: namespace` works end-to-end. A Linear
issue triggers a dispatch that:

1. Creates a Namespace instance via `@namespacelabs/sdk`.
2. Uploads + extracts the agent-runtime tarball into the VM.
3. Clones the target repo into the VM.
4. Brings the team's docker compose stack up if a
   `docker-compose.yml` is present at the repo root (or
   `compose.yaml`, or `.symphony/compose.yaml` — first
   match wins).
5. Runs the existing agent-runtime entrypoint as a node
   process directly on the VM (not inside a container).
6. Streams the agent's stdout AgentEvents back via the
   server-streaming `RunCommand` response.
7. Tears the instance down on terminal event, abort signal,
   or daemon shutdown.

LocalDockerBackend keeps working unchanged.

## Outcome shape (preview)

```
operator: pnpm symphony symphony.yaml   # backend: namespace
daemon: poll Linear → eligible issue EDU-N
        → namespaceBackend.ensureImage(spec)   (fast: no-op for
                                                stock VM image)
        → namespaceBackend.start({ envelope, ... })
            → client.compute.createInstance({ shape, deadline,
                containers: [{ imageRef: <stock VM image>, env }],
              })
            → upload agent-runtime tarball; runCommand to extract
            → runCommand: git clone + checkout per-issue branch
            → runCommand: docker compose up -d --wait (if compose
                          file exists; skipped otherwise)
            → runCommand (streaming):
                node /opt/symphony/agent-runtime/dist/entrypoint.js
                env: SYMPHONY_DISPATCH_ENVELOPE=<json>,
                     LINEAR_API_KEY, ANTHROPIC_API_KEY, GH_TOKEN
            → yield AgentEvents parsed from stdout JSON lines
        → on terminal event:
            → namespaceBackend.stop(handle)
              → client.compute.destroyInstance({ instanceId })
```

The ~5-step shape mirrors the original LocalDockerBackend flow
but with the SDK in place of `docker run`/`docker exec`/the TCP
loopback socket. The dispatch envelope schema, the
`AgentEvent` wire format, and the orchestrator above the
backend are all unchanged.

## Out of scope (deliberately)

- **Snapshot-based warm starts.** Namespace supports
  snapshotting an instance after setup so subsequent dispatches
  start from the post-install state in <1s. Useful for repos
  with expensive compose-up time. Defer to a follow-up plan
  once we have a real workload to measure.
- **Per-project credential scoping.** Operator-wide env vars
  flow to every dispatch in v1.
- **Multi-region.** Default region only.
- **Cost dashboard.** Out of scope; left to operator-side
  observation via Namespace's own usage UI.
- **Replacing the tarball with a published npm package
  (`@symphony/agent-runtime`).** Tarball-upload-on-start ships
  v1; publishing is a follow-up that simplifies the start path.
- **`.symphony/compose.yaml` as a Symphony-specific manifest.**
  We use the team's existing compose file in v1, not a
  Symphony-specific overlay. Per ADR 0012's "agent runs on the
  VM" decision, we don't need to inject an `agent` service into
  the team's compose graph — the agent runs alongside compose,
  not inside it.

## Steps

### Stage 14a — Dependency + scaffolding

1. **Add `@namespacelabs/sdk` + transitive deps to
   `packages/daemon/package.json`.** Per the SDK README:
   `@connectrpc/connect`, `@connectrpc/connect-node`,
   `@bufbuild/protobuf`. `pnpm install` from the workspace root.

2. **New directory `packages/daemon/src/execution/namespace/`**
   mirroring `local-docker/`. Initial files:
   - `backend.ts` — `NamespaceBackend implements ExecutionBackend`.
   - `instance-runner.ts` — thin wrapper around the SDK's
     `createInstance` + `runCommand` + `destroyInstance` for
     test seam-ability (mirrors `docker-runner.ts` in
     `local-docker/`).
   - `event-stream.ts` — parses AgentEvent JSON lines out of
     the streaming `runCommand` stdout chunks (replaces
     `socket-server.ts`).
   - `tarball.ts` — locates the prebuilt agent-runtime tarball
     in `dist/` and uploads it to the instance.
   - `backend.test.ts` — mocked-runner unit tests, mirroring
     `local-docker/backend.test.ts`.
   - `index.ts` — re-exports.

3. **Update `packages/daemon/src/execution/index.ts`** to
   re-export the new backend.

### Stage 14b — Envelope-via-env-var in entrypoint

4. **Modify `packages/agent-runtime/src/entrypoint.ts`**
   `loadEnvelope()` to read `SYMPHONY_DISPATCH_ENVELOPE` env
   var first; fall through to `/etc/symphony/dispatch.json`
   when the env var is absent. Backward-compatible.

5. **Same change for `SYMPHONY_EVENT_HOST`:** when running on
   Namespace, the entrypoint writes events to `stdout` instead
   of dialing a TCP socket. Detect via the absence of
   `SYMPHONY_EVENT_HOST`. When stdout-mode, JSON-line write
   each event to `process.stdout`. The daemon-side event-stream
   parser reads from the streamed runCommand chunks.

   This is a small refactor of the existing
   `socket-writer.ts` shape into a `socket-or-stdout` writer.
   Keep the same `EventSocketWriter`-like interface so the
   rest of `entrypoint.ts` is unchanged.

### Stage 14c — Backend implementation

6. **`NamespaceBackend.ensureImage(spec)`** — for v1, the
   "image" is a stock Namespace VM base image (configurable
   via `execution.namespace.base_vm_image` in symphony.yaml,
   defaulting to a pinned ubuntu-with-docker image identifier
   that Namespace publishes — TBD which exact one based on
   docs read in stage 14a). Return the configured tag with
   `source: 'base'`. No build, no inspection — Namespace's
   side handles availability.

7. **`NamespaceBackend.start(input)`** — the 5-step flow above.
   Implementation notes:
   - Idempotency: derive an instance label from
     `podNameFor(projectKey, issueId)`. Before creating, list
     instances filtered by that label; if one exists in a
     non-terminal state, attach to it (return a handle whose
     events stream resumes from a fresh `runCommand` against
     the same agent process, OR — more pragmatically for v1
     — return an error if a previous attempt is still running,
     and let the orchestrator's existing dispatch logic
     decide). Choose the simpler path; revisit if real reuse
     is needed.
   - Deadline: `Date.now() + (operatorCaps.maxTurnTimeoutMs
?? default)`. Hard ceiling so leaks are bounded.
   - The dispatch envelope is JSON-stringified and passed as
     the `SYMPHONY_DISPATCH_ENVELOPE` env var on the runCommand
     that runs the agent.
   - The compose-up step is skipped silently if no compose
     file is found in the cloned workspace. Logged.

8. **`NamespaceBackend.stop(handle)`** —
   `destroyInstance({ instanceId, reason })`. Idempotent: if
   the instance is already gone (404 / not-found from the
   SDK), return ok.

9. **Tarball build hook:** add a `pnpm` script
   (`pnpm --filter @symphony/agent-runtime build:tarball`)
   that produces `packages/agent-runtime/dist/agent-runtime.tar.gz`
   containing the built `dist/` plus `package.json` plus a
   pruned `node_modules`. Reuse the same `pnpm deploy --legacy`
   pattern from the existing `agent-base.Dockerfile`.

### Stage 14d — Composition root + config wiring

10. **Update `packages/daemon/src/config/deployment.ts`** to
    add `'namespace'` to the `execution.backend` enum and add
    an optional `execution.namespace` section
    (`base_vm_image`, optional `region`, optional `vcpu` /
    `memory_mb` for shape).

11. **Update `packages/daemon/src/index.ts` composition root**
    to branch on `execution.backend === 'namespace'`,
    constructing `NamespaceBackend` with the auth token loaded
    via the SDK's `loadDefaults()` (so it reads `NSC_TOKEN_FILE`
    or the user's local config). Wire it through
    `BackendAgentRunner` exactly like `LocalDockerBackend`
    today.

12. **Add an example `examples/deployment/symphony.yaml.namespace`**
    showing the new shape. Keep `examples/deployment/symphony.yaml`
    pointing at `local-docker` for first-time-user smoothness.

### Stage 14e — Smoke verification

13. **Operator step:** sign up at namespace.so, run
    `nsc auth login` (or set `NSC_TOKEN_FILE`), `pnpm install`.
14. **Smoke run:** symphony.yaml configured with `backend:
namespace`, the EDU-N test issue in Linear's "Smoke Test"
    project. Verify: - Instance created within ~2s. - Tarball uploaded + extracted. - Repo cloned. - (If repo has a compose file) compose stack starts. - Agent runs, streams events, transitions Linear, posts
    comment, exits 0. - Instance destroyed. - Linear issue ends in target state, comment posted, no
    duplicates.

### Stage 14f — Tests

15. **Unit tests for `NamespaceBackend`** with a mocked
    `instance-runner.ts`, mirroring the
    `local-docker/backend.test.ts` shape:
    - `start` calls createInstance with the right shape +
      deadline + env.
    - Envelope JSON is set on the agent runCommand.
    - Tarball-upload step is invoked.
    - `stop` calls destroyInstance with the right id; ok on 404.
    - `start` returns `pod_start_failed` when the SDK errors;
      no leaked instance (cleanup path runs).
    - The event-stream parser yields parsed AgentEvents from
      the streamed stdout chunks; terminates on terminal event.

16. **Integration test (skipped by default, opt-in via env
    var)** that uses a real Namespace token to do the full
    dance against a tiny test instance. CI-skip; useful
    locally to catch SDK breakage.

## Definition of done

- `execution.backend: namespace` works end-to-end against
  real Namespace + real Linear (smoke verified, manually).
- LocalDockerBackend smoke (the EDU-9 path from Plan 10) still
  passes — no regression.
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean across the workspace.
- ADR 0012 is Accepted (flipped from Proposed once the smoke
  verifies the assumptions hold).
- README + examples reference the new backend choice.

## Open questions

- **Which Namespace stock VM base image?** TBD until the SDK
  docs / examples are read in Stage 14a. We need one with node
  20+, git, and docker pre-installed. Namespace publishes
  several "Devbox"-shaped images; pick the leanest one that
  satisfies these.
- **Streaming stdout vs. polling logs.** The SDK exposes
  `runCommand` as server-streaming. If for any reason the
  streaming has buffering issues with line-oriented output,
  fall back to a polling loop on `command.runCommandSync` for
  short-lived commands and a polling fetch on the
  ObservabilityService for the long-lived agent process.
  Decide after Stage 14b.
- **Instance reuse across dispatches.** Skipped in v1 (every
  dispatch is a fresh instance). Future: if the team's compose
  stack takes 2 minutes to seed, a snapshot-and-reuse path
  would matter. Plan-15 territory.
- **Where does the GH token come from?** Same env-var path as
  today (`GH_TOKEN`). The agent-runtime entrypoint already
  knows how to use it for `gh` CLI calls. No new wiring.

## Decision log

(empty — populated as the plan executes)
