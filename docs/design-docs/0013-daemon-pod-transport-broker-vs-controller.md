# 0013 — Daemon ↔ pod transport: pull-from-broker vs push-from-daemon

- **Status:** Proposed
- **Date:** 2026-05-03
- **Relates to:** Supersedes parts of ADR 0011 (the per-pod
  reverse-TCP socket and file-mounted dispatch envelope) and
  reshapes parts of ADR 0012 (the choice between Namespace's
  `Compute.Instance` and `DevBoxService` as the underlying
  primitive). Reshapes Plan 14.

## Context

ADR 0011 wired daemon ↔ pod communication two ways:

1. **Daemon → pod:** the dispatch envelope is written to a
   host-side JSON file and bind-mounted into the pod at
   `/etc/symphony/dispatch.json`. The pod reads it on startup.
2. **Pod → daemon:** the daemon binds a per-pod TCP listener
   on `127.0.0.1:<random>`. The pod connects out to
   `host.docker.internal:<port>` and streams `AgentEvent`s as
   JSON lines.

This was the right shape for Plan 10's smoke target (a single
laptop running both daemon and pod). It has three known limits
that have surfaced as we extended the system:

- **Daemon-restart loses the event stream.** The TCP listener
  is in-memory. ADR 0011 explicitly accepts this ("we cannot
  reattach the events stream"). The pod keeps running; the
  daemon recovers its existence but not its progress.
- **Push-only dispatch.** The envelope is set at pod-create
  time and immutable. There is no path for the daemon to send
  later commands ("abort," "extend budget," "dump state") to
  a running pod.
- **Tight network coupling.** The pod must be able to reach
  the daemon's host. On `LocalDockerBackend` this is
  `host.docker.internal`; on `NamespaceBackend` (Plan 14) this
  works because the daemon also runs as a process the VM can
  reach via outbound TCP — but only because the VM has
  unrestricted egress and the daemon happens to have a
  reachable address.

The trigger for revisiting this: the DevBox vs Instance
question on Namespace. `DevBoxService` does not expose a
streaming `RunCommand` of its own and does not expose a
`deadline` field for auto-expiry. `Compute.Instance` has both,
but lacks DevBox's persistent-volume / SSH affordances. Either
choice has gaps **as long as the daemon needs a live streaming
exec channel into the pod**. Removing that requirement —
having the pod talk to a stable broker instead — collapses the
DevBox vs Instance question and dissolves several other open
items at the same time.

Two patterns emerged in design discussion. Both replace the
push-envelope + reverse-socket model with a pull-and-publish
model. They differ in **what plays the role of broker**.

## Decision

Two coupled sub-decisions, recorded together. The decision
between Pattern A and Pattern B is the substance of this ADR;
the details below describe each so the choice can be made
explicitly rather than by drift.

Both patterns share the same agent-runtime contract change:

- The pod boots from a generic image with an outbound network
  reach to a known broker address.
- On startup, the pod authenticates to the broker, identifies
  itself by a `runner_id` baked into its boot env, and **pulls**
  its dispatch envelope from the broker.
- During execution, the pod **publishes** `AgentEvent`s to the
  broker. The daemon consumes them.
- The pod **subscribes** to a control channel for the broker so
  the daemon can push later commands (`abort`, `extend_budget`,
  `dump_state`).
- On terminal event or abort, the pod cleans up and exits.

What changes between the patterns is which process plays
broker.

### Pattern A — daemon-as-controller (HTTP)

The daemon exposes an HTTP control-plane API. Pods are HTTP
clients of the daemon.

Endpoints (sketch):

- `POST /api/runners/<runnerId>/poll` → returns the dispatch
  envelope when one is assigned to this runner; 204 otherwise.
- `POST /api/runners/<runnerId>/events` → pod posts batched
  agent events.
- `GET /api/runners/<runnerId>/commands` → pod long-polls for
  daemon-issued commands.

Auth: per-runner bearer token, generated at dispatch time,
baked into the pod's boot env. Symphony issues + rotates the
tokens.

Network shape: **the daemon is publicly addressable** — pods
on Namespace VMs hit a daemon URL over the public internet.
This is the load-bearing constraint of this pattern.

State location: in-daemon memory (the orchestrator state
already exists). No new persistent store.

Process count to deploy: **1** (daemon). The dashboard is
unchanged.

### Pattern B — Redis broker (hosted)

A hosted Redis instance (Upstash, Redis Cloud, Aiven, or
self-hosted on the operator's infra) sits between daemon and
pods. Both are clients.

Channels (sketch):

- **Jobs:** Redis Stream `jobs:<runnerId>`. Daemon `XADD`s
  the dispatch envelope; pod `XREAD GROUP`s it.
- **Events:** Redis Stream `events:<runnerId>`. Pod `XADD`s
  agent events; daemon consumes via consumer group, acks
  per-event so a daemon restart resumes from the last ack.
- **Commands:** Redis pub/sub channel `commands:<runnerId>`.
  Daemon `PUBLISH`es; pod's subscriber callback fires.

Auth: Redis ACL + password + TLS, terminated by the hosted
provider. No custom token system in Symphony.

Network shape: **neither daemon nor pods need to be reachable.**
Both are outbound-only clients of the broker. The broker is the
only thing with a public surface, and that surface is operated
by the Redis vendor.

State location: Redis. Streams are durable; the daemon's
in-memory orchestrator state becomes a cache reconcilable
from Redis on restart.

Process count to deploy: **3** — daemon, dashboard, hosted
Redis. The third is SaaS, so its operational surface for the
Symphony operator is "create an Upstash project, paste the
URL into `symphony.yaml`."

### Comparison

| Concern                         | ADR 0011 (today)            | Pattern A (daemon HTTP) | Pattern B (Redis broker)         |
| ------------------------------- | --------------------------- | ----------------------- | -------------------------------- |
| Daemon must be publicly reachable | No                          | **Yes** (regression)    | No                               |
| Pod → broker direction          | Pod connects to daemon TCP  | Pod HTTPs daemon URL    | Pod TCPs Redis URL               |
| Auth mechanism                  | Loopback only               | Custom bearer tokens    | Redis ACL                        |
| Bidirectional commands          | Not supported               | Long-poll endpoint      | Pub/sub native                   |
| Daemon-restart resilience       | Event stream lost           | Pod retries poll        | Resume from stream by ack offset |
| Process count to deploy        | 2 (daemon, dashboard)        | 2 (unchanged)           | 3 (one is SaaS)                  |
| New runtime dependency          | None                        | None                    | Hosted Redis                     |
| DevBox vs Instance              | Open (Plan 14 unresolved)   | Settled — Instance      | Settled — Instance               |
| Devbox / instance leak guard    | Compute `deadline` field    | Compute `deadline`      | Compute `deadline` + Redis state reconcile |
| State location                  | In-daemon memory            | In-daemon memory        | Redis (durable)                  |

Both patterns settle the DevBox vs Instance question in favor
of `Compute.Instance`: once the daemon no longer needs a
streaming exec channel into the pod, Instance's first-class
`deadline` field is sufficient and DevBox's persistent-volume
/ SSH affordances aren't needed for v1's "fresh env per
dispatch" model.

### What this ADR does NOT decide

This ADR captures the two patterns as serious candidates and
the tradeoffs between them. **The choice between A and B is
deferred** to a follow-up review. Once chosen, the
implementation lands in a new plan (Plan 15) that reshapes
Plan 14 and supersedes ADR 0011's transport sections.

Both patterns are mutually exclusive — adopting one rules out
the other. Both supersede the same parts of ADR 0011. The
work is shaped enough that a single review can pick.

## Alternatives considered

### Stay on ADR 0011's transport; pick DevBox or Instance and live with gaps

Continue with the push-envelope + reverse-socket model. Pick
one of DevBox or Instance for Namespace and accept its gaps:

- DevBox: leak risk on daemon crash (no `deadline`); streaming
  exec uncertain.
- Instance: no persistent volumes, no SSH, no blueprint reuse.

Rejected because the underlying transport's three limits
(restart-loses-events, no bidirectional commands, network
coupling) keep producing follow-on design pressure. Solving
them once at the transport layer is cheaper than working
around them at every backend.

### Daemon embeds an MQTT / NATS broker in-process

Run a broker library (Aedes, NATS-server-as-library) inside
the daemon. Daemon is still publicly reachable (back to
Pattern A's network shape) but the protocol is pub/sub
natively. Rejected: pulls in a sizeable dependency, daemon
becomes a network service to operate, and the wins over
Pattern A (HTTP long-poll) don't justify the new surface.

### Use Namespace's instance metadata or storage as the broker

Stash the dispatch envelope in Namespace's per-instance
metadata or in their object storage; pod reads from there.
Rejected: couples the transport to one platform, gives up
bidirectional commands, and reintroduces the DevBox-vs-Instance
question (only one of them surfaces this metadata cleanly).

### Postgres LISTEN/NOTIFY as the broker (instead of Redis)

Same shape as Pattern B, different storage. Rejected as the
*default* but kept as a fallback: an operator who already
runs a Postgres they trust may prefer it. The implementation
plan should keep the broker behind an interface so both can
be supported without code branching at every call site.

## Consequences

The consequences below are written for the *adoption of either
pattern over today's ADR 0011 transport*. Pattern-specific
consequences are called out where they differ.

**Easier:**

- DevBox vs Instance dissolves: `Compute.Instance` is the
  answer for both patterns.
- Daemon-restart mid-dispatch becomes survivable. Pattern A:
  pod retries the poll. Pattern B: daemon resumes from the
  Redis stream's last-acked offset.
- Bidirectional commands (`abort`, `extend_budget`,
  `dump_state`) become trivial — they were impossible under
  ADR 0011.
- The pod image becomes generic. No envelope file mount, no
  proto-shim, no per-backend coupling. Same image for every
  project; per-repo customization stays in the repo's compose
  file and `.symphony/workflow.md`.
- The `ExecutionBackend` interface simplifies. `start()`
  becomes "create a VM, hand it a runner token + broker URL,
  walk away." `stop()` becomes "kill the VM." No
  `events: AsyncIterable<AgentEvent>` on the pod handle —
  events flow daemon-inward via the broker. `LocalDockerBackend`
  loses its socket-server entirely.
- (Pattern B only) Multiple consumers (dashboard, future HA
  daemon, future analytics) can read from the broker without
  the daemon mediating each.
- (Pattern B only) Daemon stays inbound-traffic-free; can run
  on a laptop, in a private VPC, behind any NAT. No public
  TLS endpoint to defend.

**Harder:**

- Agent-runtime entrypoint changes meaningfully. It now needs
  a broker client + auth flow. `SYMPHONY_DISPATCH_ENVELOPE`
  / `/etc/symphony/dispatch.json` are removed; envelope comes
  over the wire on the first poll.
- (Pattern A only) Daemon must be publicly addressable. New
  ops surface: TLS termination, DNS, rate limiting, a custom
  bearer-token issuance + rotation system. This is the
  pattern's load-bearing cost.
- (Pattern B only) Hosted Redis is a new runtime dependency
  + recurring vendor cost (~free at the v1 scale named in
  ADR 0012; small at any scale Symphony plausibly hits).
  Daemon correctness depends on Redis being reachable; the
  hosted SLA is typically better than the daemon's own SLA,
  so this is plausibly an availability gain — but it is
  another vendor on the diagram.
- The transport contract becomes a stable interface across
  every backend. Breaking it requires both `LocalDockerBackend`
  and `NamespaceBackend` to adapt simultaneously.

**Constrained:**

- ADR 0003's "two-process architecture" framing tightens.
  Pattern A keeps it (1 daemon + 1 dashboard, both run by the
  operator). Pattern B inflates the count to 3 if you count
  the broker, but the broker is operated by the vendor — for
  the operator it's "a URL in the config."
- ADR 0011's transport sections (file-mount envelope, reverse
  TCP socket, `bindEventSocket`, `host.docker.internal`
  trick) become superseded text. The ADR itself stays — the
  agent-in-pod model, the `ExecutionBackend` seam, and the
  idempotency contract are all still load-bearing. Only the
  transport sections move.
- Plan 14's step-by-step shape changes: no streaming
  `RunCommand`, no per-instance event TCP, no envelope upload.
  Replaced by "boot Instance, agent-runtime polls broker."

## Out of scope (deliberately deferred)

- Multi-tenant Symphony (multiple operators sharing one
  daemon / broker). Both patterns enable it; v1 doesn't need
  it.
- HA daemon (multiple daemon replicas). Pattern B makes this
  possible (state in Redis); Pattern A makes it harder. Either
  way, not v1.
- Replacing the agent-runtime tarball distribution
  (LocalDocker bakes it into the image; Namespace stages it
  via git clone). Orthogonal to transport.
- Allowlisted egress / network policy on pods (CrabTrap-style).
  Configured at the platform layer (Docker network, Namespace
  network policy), not at the broker layer.
- Per-project credential isolation. Same status as ADR 0012
  — operator-wide env vars today; per-project later.

## Schedule

Implementation lands in Plan 15 (to be drafted once the
A-vs-B choice is made). Plan 14 (NamespaceBackend with
streaming `RunCommand` + envelope upload) is paused pending
that choice — its `Compute.Instance` plumbing is reusable
under either pattern, but the transport-layer code (
`event-stream.ts`, the streaming `runCommand` plumbing in
`sdk-runner.ts`) is throwaway under both.

`LocalDockerBackend` stays unchanged in this transition. The
new transport is wired in alongside the existing one; once
the agent-runtime supports both, individual backends switch
over and the old transport is removed in a follow-up.
