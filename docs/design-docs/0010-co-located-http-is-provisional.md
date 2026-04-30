# 0010 — Co-located HTTP server is provisional

- **Status:** Accepted
- **Date:** 2026-04-29

## Context

Plan 08 added an HTTP server inside the daemon process to expose
the read-only `/api/v1/state` endpoint the dashboard polls. The
implementation is straightforward (`http.createServer`, two route
handlers, ~150 lines), and the dashboard already lives in a separate
package and a separate process — so the externally observable
architecture matches ADR 0003 (daemon and dashboard are separate
processes).

But internally, the daemon process now does **two unrelated jobs**:

1. **Execution plane** — polls the tracker, owns workspaces,
   dispatches agents, holds source-of-truth state. Must be a
   singleton (one writer, no split-brain).
2. **Observability plane** — serves a JSON snapshot over HTTP.
   Read-only, inherently safe to scale, restart, replace.

These have very different operational profiles:

|                  | Execution plane               | Observability plane       |
| ---------------- | ----------------------------- | ------------------------- |
| Process count    | exactly 1                     | 1..N (any number)         |
| Restart impact   | aborts in-flight agent work   | dashboard blank for ~2s   |
| Deploys          | rare, careful                 | iterate fast              |
| Trust level      | holds API keys + GitHub token | read-only network surface |
| Bug blast radius | leaks lose agent work         | leaks show stale data     |

Mixing them into one process means a misbehaving HTTP handler
(slow render, memory leak, crash) can take down the orchestrator.
The user identified this directly during Plan 08 review:
"why is the daemon also a server?"

## Decision

The current single-process arrangement is **correct for v1** but
**provisional**. We accept it knowingly; we do not pretend the
coupling is desired long-term.

- Plan 08 ships co-located. Documented in this ADR so the trade-off
  is on the record.
- **Plan 10 (Deployable services + v1 polish)** is the next natural
  cut point: when the daemon and dashboard ship as separate Docker
  containers, the HTTP server moves into a third process. The
  dashboard polls that third process; the third process talks to
  the daemon over a Unix domain socket (or a small read-only
  state file the daemon writes periodically — implementation TBD
  in Plan 10).
- Until then, `packages/dashboard` deliberately **does not import
  from `packages/daemon`**. The wire format
  (`packages/daemon/src/http/serialize.ts`'s
  `StateSnapshotWire`) is hand-mirrored in
  `packages/dashboard/app/api-types.ts`. This makes the future
  process split a server-only refactor — the dashboard does not
  change.

## Alternatives considered

**(a) Stay co-located forever.** Reject because the trade-offs
above only get worse as the daemon adds responsibilities (event
buffer, tool-call audit log, etc.) — the HTTP server's surface
grows, and so does the blast-radius coupling.

**(b) Split immediately (in Plan 08).** Reject because the dashboard
itself was the user's first-pass priority for "see what the agent
is doing." Splitting would have meant designing an IPC story
before validating that the dashboard solves a real problem. We'd
rather pay the refactor later than block the user value now.

**(c) Use a message bus (NATS / Redis / Kafka).** Overkill for a
single-host hobby system. Reconsider if Symphony ever runs N
daemons that share one observability surface.

## Consequences

**Easier:**

- v1 ships in one process with one `pnpm symphony` invocation.
- No IPC layer to design, no protocol to maintain.
- The dashboard's poll latency is direct in-memory access; no
  serialization-deserialization between two processes.

**Harder:**

- Plan 10 carries the cost of the split. Estimated ~300 lines:
  a Unix-socket server in the daemon, an HTTP server that
  proxies it, and configuration plumbing.
- The wire format is now load-bearing for two consumers. Breaking
  changes need to land on both sides simultaneously.

**Constrained:**

- The daemon's HTTP server is **bound to loopback only**. It is
  never the right answer to expose it externally; the
  dashboard-or-its-successor process is what handles external
  traffic in Plan 10+.
- The dashboard package must not develop a hard dependency on the
  daemon's runtime. Hand-mirrored types in
  `app/api-types.ts` are a feature, not a workaround.

## Implementation notes

The split criteria for "when do we actually do this":

1. **Trigger:** when Plan 10 starts the deployment-tier
   containerization. Splitting at the container boundary is
   cheap; splitting later ("retroactively bolt on a second
   process") is much more work.
2. **Required fields in the new IPC** (whatever shape it takes —
   Unix socket, file watch, etc.):
   - the same `OrchestratorState` snapshot the HTTP server reads
     today,
   - a small heartbeat / health field so the HTTP-tier process
     can distinguish "daemon paused mid-tick" from "daemon
     dead",
   - cheap enough to call at 1 Hz (the dashboard's polling rate).
3. **Not included** in the split: the dashboard. The dashboard
   stays as it is; only the daemon's external HTTP face moves.

## Schedule

This decision is paired with
[Plan 10](../exec-plans/active/10-deployable-services-and-v1-polish.md),
which is where the split actually happens.
