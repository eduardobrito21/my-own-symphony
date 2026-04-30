# Plan 10 — Deployable services + v1 polish

- **Status:** 📝 Drafted
- **Replaces:** the original Plan 09 (Docker + polish), reshaped
  to follow Plan 09's pivot to the agent-in-pod model. With the
  agent runtime now containerized AND the agent-process inside
  the pod (Plan 09 stages 09c–09d), what's left here is the
  **service tier**: packaging the daemon + dashboard + API
  themselves so a fresh machine with only Docker can run
  Symphony.
- **Spec sections:** none directly (deployment is out of spec
  scope).
- **Layers touched:** new top-level `Dockerfile.daemon` /
  `Dockerfile.api` / `Dockerfile.dashboard` (or
  `packages/*/Dockerfile`), `docker-compose.yml` at repo root,
  `.env.example`, README, every doc that references the dev-only
  path.
- **ADRs referenced:** 0003 (two-process architecture),
  0009 (multi-project), 0010 (HTTP provisional — resolved by
  this plan), 0011 (agent-in-pod + ExecutionBackend).
- **Comes AFTER:** Plan 09. Reason: containerizing the daemon is
  pointless if the daemon doesn't yet do the multi-project +
  agent-in-pod work that's the whole point. The docker-socket
  mount that lets the daemon spawn pods (this plan) is
  meaningless until the daemon knows how to spawn pods (Plan 09).

## Goal

After Plan 10, a fresh machine with ONLY `docker` and `docker
compose` installed can:

1. `git clone <symphony-repo> && cd <symphony-repo>`
2. Copy `.env.example` → `.env`, fill in three keys
   (`LINEAR_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`),
   point `SYMPHONY_CONFIG` at a `symphony.yaml` they bring.
3. `docker compose up`
4. Open `http://localhost:3001` and see Symphony watching their
   Linear projects, with per-issue agent pods spawning as
   siblings to the daemon container.

Plus the v1-done polish pass: docs are consistent, every plan is
in `completed/` or has an explicit reason for staying `active/`,
no lint debt, no dead exec plan steps.

## Outcome shape (preview)

```
docker-compose up
   ├── service: daemon       (image: symphony/daemon:v1)
   │     ├── volumes:
   │     │     - ./symphony.yaml:/etc/symphony/symphony.yaml:ro
   │     │     - ./workspaces:/var/lib/symphony/workspaces
   │     │     - /var/run/docker.sock:/var/run/docker.sock
   │     │       ↑ so the daemon's LocalDockerBackend can spawn
   │     │         per-issue agent pods as siblings on the host's
   │     │         docker daemon (not docker-in-docker).
   │     ├── env:
   │     │     LINEAR_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN
   │     │     SYMPHONY_CONFIG=/etc/symphony/symphony.yaml
   │     │     SYMPHONY_STATE_SOCKET=/var/run/symphony/state.sock
   │     └── exposes: nothing on the network. Talks to api over
   │                  unix domain socket on a shared volume.
   │
   ├── service: api          (image: symphony/api:v1)
   │     ├── volumes:
   │     │     - daemon-socket:/var/run/symphony   (shared with daemon)
   │     ├── ports:
   │     │     - 127.0.0.1:3000:3000
   │     └── connects to:    daemon over /var/run/symphony/state.sock
   │
   └── service: dashboard    (image: symphony/dashboard:v1)
         ├── env: SYMPHONY_API_URL=http://api:3000
         └── ports:
               - 127.0.0.1:3001:3001

(per-issue agent pods are spawned by the daemon as host-level
 sibling containers — they don't appear in this compose file. Pod
 lifecycle is owned by the daemon's LocalDockerBackend, not by
 docker-compose.)
```

Three services because Plan 10 also resolves ADR 0010 (split the
HTTP server out of the daemon). The split is cheap to do at the
container boundary.

## Why "sibling containers" (not docker-in-docker)

Three options, ranked from least to most painful:

- **Sibling containers via host docker socket mount.** Daemon
  runs in a container with `/var/run/docker.sock` mounted; when
  it calls `docker run`, the new container is a *sibling* on the
  host's docker daemon, not a child of the daemon container.
  Standard pattern (GitLab Runner, Jenkins, Drone all use this).
  Trade-off: the daemon container has effective root on the host
  (it can `docker run --privileged anything`). Acceptable because
  the daemon is the only thing holding the socket and we control
  what the daemon spawns. Documented in `SECURITY.md`.
- **Rootless BuildKit / sysbox / podman.** Solves the
  privilege-escape concern. Adds setup complexity, host-tool
  variance. Out of scope for v1; revisit if/when Symphony is
  deployed somewhere other than a developer laptop.
- **True docker-in-docker (DinD).** Privileged container running
  its own dockerd. Slowest, biggest security hole, most
  operational pain. Skip.

Going with sibling containers.

## Out of scope

- **Production hardening** (managed secrets, network policies,
  autoscaling, HA). This is a personal/learning project; not a
  SaaS.
- **CI publishing of images.** Local `docker build` + `docker
  compose build` is enough for v1.
- **Telemetry export to a remote backend.** Logs go to stdout;
  whoever runs Symphony pipes them wherever.
- **Multi-arch images.** Build for the host's arch only.
- **Auto-update of the agent runtime image** (`symphony/agent-base`).
  The deployment includes a `pnpm docker:build:agent-base`
  script the operator runs manually. Per-repo image rebuilds
  are also manual (Plan 09 step 14).
- **TLS / reverse proxy.** Loopback-bound by default. If the
  user exposes externally, they bring the TLS layer.
- **Alternative ExecutionBackends** (E2B, ECS, k8s Jobs). The
  interface is in place from Plan 09; new impls are Plan 11+.

## Steps

### Stage 10a — HTTP-server process split (resolve ADR 0010)

1. **Daemon emits state over a Unix domain socket** instead of
   serving HTTP directly:
   - `packages/daemon/src/state-socket/server.ts` — listens on
     `process.env.SYMPHONY_STATE_SOCKET ?? /var/run/symphony/state.sock`.
   - On connection, writes the JSON snapshot and closes. Same
     wire format as today's `/api/v1/state`.
   - Remove the daemon's `http/` server (Plan 08's implementation
     moves to the new api package — see step 2).

2. **New `packages/api/` package** (small Node service):
   - Binds HTTP on `:3000` (or `SYMPHONY_HTTP_PORT`).
   - Per request to `/api/v1/state`, opens a connection to the
     daemon's state socket, reads the snapshot, returns it.
   - Adds `/api/v1/health` that pings the socket.
   - CORS headers so the dashboard (different port) can read.
   - Inherits the existing tests (which run against the wire
     shape, not the transport).

3. **Dashboard config**: `SYMPHONY_DAEMON_URL` → renamed to
   `SYMPHONY_API_URL`. The dashboard talks to the API process,
   not the daemon. Internal/behavioral change only.

4. **`pnpm symphony` and dev scripts**:
   - Default dev mode (no `SYMPHONY_CONFIG`, single workflow
     path) keeps everything in one process — no socket, no api
     subprocess. Single-developer friction matters.
   - Multi-project mode (with `SYMPHONY_CONFIG`) uses the
     three-process arrangement. Dev mode for that uses
     `concurrently` via a new `pnpm dev` script.

5. **Tests**:
   - Boot the daemon's socket server on a random ephemeral path,
     hit it from the api process, assert the response.
   - Backward-compat: dashboard's existing tests against the
     wire shape pass unchanged.

### Stage 10b — Daemon Dockerfile

6. **`packages/daemon/Dockerfile`**:
   - Multi-stage. Builder runs `pnpm install --frozen-lockfile`
     and `pnpm build`. Runtime copies `dist/` plus production
     `node_modules`.
   - Includes the **`docker` CLI** (statically linked or apt-get)
     so the daemon can shell out via `LocalDockerBackend`. Does
     NOT include a docker daemon (we use the host's via socket).
   - Non-root user (uid 1001 — distinct from the agent
     container's `agent:1000`). Member of the `docker` group so
     the mounted socket is usable.
   - PID 1 is `tini`.
   - Healthcheck: `--health-check` flag in `index.ts` that
     connects to its own state socket and exits 0 if a response
     comes back.

7. **Volume contract** (documented in compose file):
   - `/etc/symphony/symphony.yaml` (read-only) — operator
     deployment config.
   - `/var/lib/symphony/workspaces` — per-issue workspaces.
     Read-write. Bind to host so per-issue pods (siblings) and
     daemon see the same files. **Critical:** the host path
     for this bind must be the same path the daemon passes to
     `docker run -v ...` for sibling pods. We document this as
     the "workspace path mirror" requirement and make the
     daemon assert it at startup.
   - `/var/run/docker.sock` (read-write) — sibling pod spawning.
     Documented as a security trade-off in `SECURITY.md`.
   - `/var/run/symphony/` — shared volume for state-socket and
     pod event sockets.

### Stage 10c — Dashboard Dockerfile

8. **`packages/dashboard/Dockerfile`**:
   - Multi-stage Next.js build with `output: standalone` in
     `next.config.mjs`.
   - Runtime image is the standalone server only — not full
     `node_modules`.
   - Non-root user.
   - Healthcheck: `curl -f http://localhost:3001/`.

### Stage 10d — API process Dockerfile

9. **`packages/api/Dockerfile`**:
   - Tiny Node image. Same multi-stage pattern as the daemon.
   - Mounts the daemon's state socket via the shared volume.
   - Healthcheck hits its own `/api/v1/health`.

### Stage 10e — docker-compose.yml at repo root

10. **`docker-compose.yml`**:
    - Three services: `daemon`, `api`, `dashboard`.
    - Shared `daemon-socket` volume between daemon and api.
    - `daemon` mounts `./workspaces` and `/var/run/docker.sock`.
    - `api` exposes `127.0.0.1:3000`. `dashboard` exposes
      `127.0.0.1:3001`.
    - Restart policy: `unless-stopped`.
    - Healthchecks gate `dashboard` on `api`, `api` on `daemon`.

11. **`.env.example`**:
    - `LINEAR_API_KEY`
    - `ANTHROPIC_API_KEY`
    - `GITHUB_TOKEN`
    - `SYMPHONY_CONFIG=./symphony.yaml`
    - `SYMPHONY_HTTP_PORT=3000` (defaults to 3000 if unset)
    - `SYMPHONY_WORKSPACE_HOST_PATH=./workspaces` (the host
      path for the workspace bind — must match what the daemon
      passes to sibling pods).
    - Comment block explaining where each is used.

12. **Operator quickstart** in README:
    - Prerequisites: Docker Desktop running.
    - Three-step bringup (clone, fill env, compose up).
    - One-time: `pnpm docker:build:agent-base` to build the
      agent runtime image (Plan 09 step 12). This builds on
      the host and makes the image available to sibling pods
      via the shared docker daemon.
    - Where to look first when something breaks (logs, state
      socket, port conflicts, missing agent-base image).

### Stage 10f — v1-done polish

13. **Doc consistency sweep**:
    - Read every file in `docs/`, fix stale references to
      Codex / Fastify / single-project / single-process / `pnpm
      symphony WORKFLOW.md`-only.
    - Read every file in `docs/exec-plans/active/` — anything
      complete moves to `completed/`. Anything still in flight
      gets an explicit one-line reason.
    - Read every ADR; verify status is correct (especially
      0010 → "Resolved by Plan 10").

14. **Tech-debt sweep**:
    - `pnpm deps:check` clean.
    - `pnpm lint` clean.
    - `pnpm test` and `pnpm build` from a clean checkout.
    - Grep for `TODO`/`FIXME`/`XXX` — file each in
      `docs/exec-plans/tech-debt-tracker.md`.

15. **README polish**:
    - "What works / what doesn't" section listing spec
      sections we conform to and the deviations.
    - Screenshots of the dashboard (single + multi-project).
    - Architecture diagram (text-art is fine — renders in the
      terminal too).
    - "Honest demo" section: how to verify the agent ran in
      the pod, not on the host.

16. **Definition-of-v1-done checklist** as a short doc at
    `docs/v1-done.md`. Each item is a one-liner the reader can
    verify by running a command. Becomes the script for any
    future "is this still working?" review.

## Definition of done

- `docker compose up` on a clean machine (only Docker installed,
  no local Node, no local pnpm) brings daemon + api + dashboard
  to healthy state.
- Dashboard at `http://localhost:3001` reflects orchestrator
  state from a real `symphony.yaml` with 1+ projects.
- The daemon does not bind any TCP port directly; it talks to the
  api over a Unix domain socket. (Verify: `lsof -i -P` against
  the daemon's process shows nothing.)
- A real Linear issue triggers a sibling agent pod on the host's
  docker daemon, runs end-to-end, opens a PR, and the pod is
  cleaned up after.
- Killing the dashboard or the api process does NOT disrupt
  in-flight agent work in the daemon (or in the running pods).
- Killing the daemon container and `docker compose up` again
  re-attaches to any still-running pods (verifies Plan 09's
  reattach guarantee survives the daemon being containerized).
- ADR 0010 status updates from "Accepted (provisional)" to
  "Accepted (resolved by Plan 10)".
- All exec plans are either in `completed/` or have an explicit
  status reason for remaining `active/`.
- The repo passes `pnpm typecheck && pnpm lint && pnpm test &&
  pnpm deps:check && pnpm build` cleanly from a fresh checkout.
- A first-time reader following only `README.md` → `AGENTS.md` →
  `ARCHITECTURE.md` can boot the system within an hour.

## Open questions

- **Docker socket exposure to the daemon.** Mounting
  `/var/run/docker.sock` into the daemon gives it effective root
  on the host. Acceptable for personal/local use; not acceptable
  for a hosted multi-tenant deployment. We document the risk in
  `SECURITY.md` and call out that production deployments need a
  different ExecutionBackend (rootless docker, k8s Job per
  workspace, E2B). Not Plan 10's job to solve; Plan 10's job is
  to flag it.
- **Workspace path mirror requirement.** The daemon container
  mounts the host's workspace dir at
  `/var/lib/symphony/workspaces`, but when it spawns a sibling
  pod, the `-v` flag uses HOST paths (the docker daemon
  resolving the bind doesn't see inside the daemon container).
  Daemon must resolve "host equivalent" of its in-container
  workspace path. Plan: take an explicit
  `SYMPHONY_WORKSPACE_HOST_PATH` env var, assert at startup
  that it bind-mounts to `/var/lib/symphony/workspaces`, fail
  loudly otherwise. Better than guessing.
- **Symphony API as a third service or as a sidecar inside the
  daemon container?** Sidecar (two processes in one container)
  would be simpler operationally but defeats ADR 0010's split.
  Going with three services.
- **Which package owns the state-socket protocol?** Tentative:
  `packages/types/` — both daemon (writer) and api (reader)
  consume it, neither should depend on the other. Confirm
  during implementation.
- **Auto-build the agent-base image as part of `docker compose up`?**
  No, too magical. The operator runs `pnpm docker:build:agent-base`
  once. We document this in the quickstart and surface a clear
  error if the image is missing on first dispatch.

## Decision log

(empty — populated as the plan executes)
