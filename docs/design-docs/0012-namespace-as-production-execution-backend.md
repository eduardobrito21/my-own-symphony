# 0012 — Namespace as the v1 production ExecutionBackend

- **Status:** Proposed
- **Date:** 2026-04-30
- **Relates to:** Evolves ADR 0011's "v1 ships exactly one impl
  (`LocalDockerBackend`)" framing. The `ExecutionBackend` seam,
  the agent-in-pod model, and the dispatch envelope all stand
  unchanged — this ADR adds a second backend and renames which
  one is "production."

## Context

ADR 0011 introduced the `ExecutionBackend` seam and shipped
`LocalDockerBackend` as the v1 implementation. Plan 10 made
that real: per-issue Docker pods with the agent runtime
inside them, smoke-verified end-to-end on EDU-9 (2026-04-30,
12s, $0.035 with Sonnet 4.6).

The smoke run also exposed five blocker classes that were
all macOS Docker Desktop / VirtioFS / DinD-adjacent:

1. pnpm v10 deploy needed `--legacy` to skip injected workspaces.
2. `node:20-bookworm-slim` shipped `node` user uid 1000 already.
3. macOS Unix-socket path > 104 chars on transient `/var/folders/`.
4. Docker Desktop / VirtioFS does not pass AF_UNIX through bind
   mounts (forced a TCP refactor of the daemon ↔ pod channel).
5. Claude SDK's libc resolver picked musl on glibc bookworm.

Each was solvable in code, but four of the five were artifacts
of "running Docker on a developer's macOS laptop" — exactly
the deployment shape `LocalDockerBackend` is built for. The
production target was supposed to be a Linux host eventually
(EC2, k8s), but the path to that host has its own ops surface:
AMI maintenance, Terraform state, container registry, secret
distribution, log shipping.

While exploring the next step (multi-service environments per
dispatch, so the agent can edit code against a real Postgres +
Redis + app stack), the design hit a deeper problem: docker
compose inside a Docker container is either nested-Docker
(slow + privileged) or "DOOD" (the agent's container mounts
the host's docker socket, which is a real privilege escalation).
Neither was acceptable for a production target.

The intuition that broke the impasse: **the multi-service
problem disappears if the dispatch unit is a real VM rather
than a container.** Docker compose inside a real Linux VM is
just normal Linux — no nesting, no DOOD. The constraint
that made our design hard was the constraint we had built in
ourselves by choosing "container per dispatch."

[Namespace](https://namespace.so) is a hosted compute platform
designed exactly for this shape:

- **microVM per sandbox** (not container isolation), full root
  inside, ~0.8s end-to-end boot.
- **Standard Dockerfile or stock VM image** as the env spec.
- Native multi-container declaration via the `containers: []`
  field on `createInstance`, OR run docker compose inside the
  VM normally (since it's a real VM with its own kernel + docker
  daemon).
- **Server-streaming `RunCommand`** for executing inside the
  instance and reading stdout/stderr — replaces our TCP loopback
  socket entirely.
- **Built-in `deadline` field** for auto-cleanup → no leaked-pod
  risk on daemon crash.
- **TypeScript SDK** (`@namespacelabs/sdk`) using Connect-RPC,
  fits our stack natively.
- Pricing: ~$0.08 per 10-minute medium-shape dispatch. For a
  3-operator team running ~20-50 dispatches/week, that's
  $80-200/year vs. $600+/year for an always-on Linux EC2.
- SaaS only (runs on Namespace's cloud, not the operator's).

The user verified end-to-end on 2026-04-30: signed up, created
a sandbox via the browser console, SSH'd in, confirmed `docker`
is pre-installed and works inside the instance.

## Decision

Two coupled changes, recorded together.

### Decision A — `NamespaceBackend` becomes the v1 production target

A new `ExecutionBackend` implementation, `NamespaceBackend`,
ships alongside `LocalDockerBackend`. Both implement the same
interface from ADR 0011. The deployment YAML's
`execution.backend` enum gains a `namespace` value. Operator
chooses per-deployment.

`NamespaceBackend` is the **default and recommended** v1
production target. `LocalDockerBackend` stays in the codebase
indefinitely as the **dev/local** option (no SaaS dependency,
no credit card, useful for learning + hacking).

The shape of `NamespaceBackend.start(input)`:

```ts
1. createInstance({
     shape, deadline,
     containers: [{ name: "main", imageRef: "<stock VM image>", env: [...] }],
   })
2. runCommand: install agent-runtime tarball
3. runCommand: git clone <repo.url> /workspace; checkout per-issue branch
4. runCommand: cd /workspace && docker compose up -d --wait  (if compose.yaml exists)
5. runCommand (server-streaming): node /opt/symphony/agent-runtime/dist/entrypoint.js
   - envelope passed via SYMPHONY_DISPATCH_ENVELOPE env var (no file mount)
   - stdout JSON lines parsed into AgentEvents
6. destroyInstance on terminal event or abort
```

The agent runs **directly on the VM** (not inside a container
on the VM). This is the inverse of the LocalDockerBackend model
and is what dissolves the multi-service / DOOD tension —
docker is on the same kernel as the agent, accessed natively.

### Decision B — Dispatch envelope flows via env var, not bind-mount

In LocalDockerBackend, the daemon writes the envelope to
`/etc/symphony/dispatch.json` and bind-mounts it into the
container. With Namespace, there is no host filesystem to
bind-mount from — the daemon is on a different machine than
the VM.

The agent-runtime entrypoint is changed to read the envelope
from the `SYMPHONY_DISPATCH_ENVELOPE` env var, falling through
to the `/etc/symphony/dispatch.json` file when the env var is
absent. This is a backward-compatible change — LocalDockerBackend
keeps using the file mount path; NamespaceBackend uses the env
var.

## Alternatives considered

### Stay LocalDockerBackend-only; build multi-service env on top

What ADR 0011 + a hypothetical ADR 0012 (compose-project as
dispatch unit) would have looked like. Rejected because:

- The multi-service story required either DinD (slow,
  privileged, fragile on macOS) or DOOD (privilege escalation
  via mounted docker socket). Neither acceptable for production.
- The macOS-specific blockers from the Plan 10 smoke (VirtioFS,
  socket path lengths, libc resolver) keep recurring as the
  surface grows. They are platform-shaped friction, not bug-shaped
  friction — fixing one surface a new one.
- Operating a Linux production host (Mac Mini, EC2, k8s) on top
  of LocalDockerBackend reintroduces the ops surface this project
  was meant to skip.

### Self-host an equivalent runtime (Coder, DevPod, k8s Jobs)

Build on top of an OSS dev-environment runtime instead of a
hosted SaaS. Rejected for v1 because:

- The OSS options (DevPod, Coder, Daytona) are built around
  human IDE attach, not headless agent dispatch. Adapting them
  costs more than building NamespaceBackend.
- Self-hosting any of them brings back the operator-side ops
  surface we want to skip.
- The `ExecutionBackend` interface from ADR 0011 is exactly the
  abstraction that lets us swap to a self-hosted backend later.
  Choosing Namespace today does not foreclose self-hosted
  tomorrow — it defers it until we have a reason.

### EC2 + Terraform per dispatch

Provision a fresh EC2 instance per dispatch. Same model as
Namespace conceptually, different vendor. Rejected for v1:

- 30-90s VM boot vs. Namespace's 0.8s. Order-of-magnitude worse
  for "magical" feel.
- Real ops surface: AWS account, IAM, VPC, AMI maintenance,
  Terraform state, leak detection, billing alarms.
- Vendor risk is comparable (AWS dependency vs. Namespace
  dependency); Namespace's product is purpose-built for our
  shape, AWS's isn't.

If/when we have a reason to leave Namespace (cost, compliance,
acquisition), `Ec2Backend` is one more `ExecutionBackend` impl
behind the same seam.

### Keep the agent inside a container on the VM (DOOD on Namespace)

Reuse `symphony/agent-base:1` as the imageRef for the `agent`
container in the Namespace instance, mount the VM's docker
socket into it. Rejected:

- Reintroduces the DOOD privilege-escalation concern that we
  rejected in the LocalDockerBackend exploration.
- The container layer adds nothing — the VM is already the
  isolation boundary.
- Two image artifacts to maintain (the Namespace VM base + our
  Docker image) instead of one.

The agent runs directly on the VM. The VM is the container.

## Consequences

**Easier:**

- Multi-service environments work without any new Symphony
  abstractions: docker compose runs natively on the VM.
- The four+ macOS-specific blockers from Plan 10 are gone — the
  daemon doesn't run pods locally anymore.
- The TCP loopback socket dance is gone — `RunCommand`'s
  server-streaming response IS the event channel.
- Pod leak risk is gone — `deadline` field on `createInstance`
  hard-caps lifetime even on daemon crash.
- The daemon no longer needs Docker on its host. Daemon can
  run on a tiny Fly.io machine, or on the operator's laptop,
  or in any Node-capable environment.
- Plan 13 (deployable services) shrinks from "containerize the
  daemon + dashboard + worry about docker-in-docker socket
  passthrough" to "publish the daemon as an npm package or a
  Fly app." Days of work, not weeks.
- 2026 dev-environment ergonomics: the agent's environment is
  the same Linux + docker + compose the team uses everywhere
  else. No special "Symphony env" to learn.

**Harder:**

- New runtime dependency on Namespace (a single vendor SaaS).
  Mitigation: the `ExecutionBackend` seam from ADR 0011 keeps
  the dependency contained to one file's worth of code; swap
  cost is bounded.
- Code now leaves the operator's machine during dispatch. For
  Symphony's stated v1 scope (3-operator team, fresh systems,
  no legacy bank repos) this is acceptable. The day Symphony
  needs to operate against a repo that cannot leave a perimeter,
  `LocalDockerBackend` (or a future `Ec2Backend` in the
  operator's own VPC) is the answer — same interface, same
  daemon code.
- Recurring vendor cost (~$80-200/yr at our scale). Trivial in
  absolute terms; named here for completeness.
- Agent-runtime distribution shape changes. LocalDockerBackend
  bakes the runtime into a Docker image. NamespaceBackend ships
  it as a tarball uploaded at instance setup (or a published
  npm package later). Two distribution artifacts to maintain
  during the overlap.

**Constrained:**

- The agent-runtime contract (entrypoint location, env-var
  names, stdout-as-event-channel) is now a stable interface
  across two backends. Breaking it requires both backends to
  adapt simultaneously.
- The `SYMPHONY_DISPATCH_ENVELOPE` env var becomes part of the
  contract. Backward-compatible with the file-mount path so
  both can coexist; mentioned because it's the kind of small
  contract that grows accidental coupling.
- Network egress from the Namespace VM is unfiltered by default.
  The day we want CrabTrap-style allowlisting (referenced from
  the design discussion), it gets configured at the Namespace
  network-policy level, not in Symphony.

## Out of scope (deliberately deferred)

- Per-project credential isolation (each project's secrets
  scoped to its own dispatches). Today operator-wide env vars
  pass to all dispatches.
- Self-hosted Namespace alternative for compliance contexts
  (would be a future `Ec2Backend` or `K8sJobBackend`).
- Cost dashboard per project / per operator.
- Snapshot-based warm starts (Namespace supports them; we use
  cold starts in v1 for simplicity).
- Multi-region routing.
- Replacing the agent-runtime tarball with a published npm
  package (`@symphony/agent-runtime`).

## Schedule

This decision is implemented in
[Plan 14](../exec-plans/active/14-namespace-execution-backend.md).
LocalDockerBackend remains in the codebase and remains the
default in `symphony.yaml` examples for "I just want to try it
on my laptop" use cases until Plan 14 ships and the
documentation pivots.
