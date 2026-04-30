# 0011 — Agent runs inside the per-task pod; ExecutionBackend is the seam

- **Status:** Accepted
- **Date:** 2026-04-30

## Context

Plans 1–8 ran the agent as a child of the daemon process: the
`ClaudeAgent` class calls the Claude Agent SDK's `query()` directly,
the SDK runs inside the daemon's Node process, and the agent's
tool surface (today: `linear_graphql` only) is a JS function in the
same address space. Workspaces are bare directories on the host;
no container is involved.

That works for the "post a Linear comment + transition state" demo
the smoke run validated. It does not work the moment the agent
needs to edit code: as soon as `Bash`, `Read`, `Edit`, `Write`,
and friends enter the tool surface, the agent can read and write
arbitrary host files and run arbitrary host commands. For a
production-grade target — and especially for the bank context — the
agent needs an isolation boundary that is mechanical, not
"the prompt told it not to."

The prior Plan 09 draft addressed this with what we'll call the
**PATH-wrapper approach**: keep the agent process on the host, but
intercept its `Bash` tool calls by writing wrapper scripts at
`<workspace>/.symphony/bin/<tool>` that `exec docker exec -i
<container> <tool> "$@"`, then constrain the SDK's `PATH` env to
that bin dir. Reads and edits stay direct (workspace is bind-mounted
to the host); only shell calls hop into the container.

Walking through the model end-to-end during the 2026-04-30 design
review surfaced four problems with the PATH-wrapper approach:

1. **Mental model is unusual.** "Where does the agent run?" has a
   compound answer: "the daemon process, but its shell tool calls
   happen elsewhere via PATH magic." Every future reader has to
   understand the trick before they can reason about isolation.

2. **Isolation is not by construction.** The container is a
   sandbox the agent is _encouraged_ to use via PATH manipulation,
   not one it lives in. An agent that hardcodes `/usr/local/bin/git`
   bypasses the wrapper. Plan 09's draft acknowledged this and added
   a `PreToolUse` hook to reject Bash args containing absolute paths
   to known binaries — patching the design to compensate for the
   architecture rather than fixing the architecture.

3. **Backend portability is blocked.** The PATH-wrapper trick only
   makes sense for local Docker. E2B, ECS, Fargate, and k8s Jobs
   all expect "the agent process runs inside the unit of execution
   you provisioned." Adopting any of those backends later would
   require unwinding the wrapper design, not just swapping an impl.

4. **State recovery is murky.** When the daemon restarts mid-run,
   the agent process dies with it; the container keeps running but
   has no agent inside. Resume requires the daemon to re-construct
   a Claude SDK conversation from `session.json`, which is the
   exact bug-prone code in `agent.ts:182-356` that Plan 07's smoke
   surfaced four separate failure modes for. If the agent lives in
   the pod, daemon restart is handled by reattaching the event
   stream — the pod's agent never died.

The framing that crystallized the right shape was "**Symphony is
Prefect for coding agents.**" Prefect, Argo Workflows, k8s Jobs,
GitHub Actions runners, AWS AgentCore, E2B — every comparable
platform uses the same pattern: a control plane orchestrates
ephemeral pods; one pod = one unit of work; the worker process
runs inside the pod. This is a 15+ year-old pattern in workflow
orchestration and the universally accepted shape in the agent
platforms shipping in 2026.

The PATH-wrapper approach was a clever local optimum that fights
the standard pattern. We're choosing the standard pattern instead.

## Decision

Two coupled decisions, recorded in one ADR because neither is
useful without the other.

### Decision A — Agent process runs inside the per-task pod

For each issue the daemon dispatches:

1. The daemon ensures the workspace directory on the host.
2. The daemon resolves the agent image (per ADR 0009 and Plan 09's
   image resolution order: explicit override → `.symphony/agent.dockerfile`
   → `.devcontainer/Dockerfile` → base image).
3. The daemon starts a container from that image. The container's
   `ENTRYPOINT` is the **agent-runtime entrypoint**, not
   `sleep infinity`. The entrypoint:
   - Reads its **dispatch envelope** from
     `/etc/symphony/dispatch.json` (mounted read-only by the daemon
     at start time). The envelope carries the daemon's _dispatch
     decisions_ (which issue, which repo, what caps) — **not** the
     issue body or rendered prompt.
   - Fetches the issue from the tracker (Linear) using the project
     slug in the envelope. If the issue is gone or no longer in
     an active state, exits "no longer eligible" without doing
     work.
   - Clones the target repo into `/workspace`, checking out (or
     creating) the per-issue branch.
   - Reads `<workspace>/<envelope.repo.workflowPath>` — the
     repo-owned `workflow.md`. Renders the prompt template against
     the freshly-fetched issue. Reads the repo-side `model` /
     `allowedTools` / budget caps; combines with operator-side
     caps from the envelope (effective = `min(operator, repo)`
     for budgets; repo-side wins for `model` / `allowedTools`).
   - Constructs the Claude Agent SDK call with the resolved
     prompt + tools + model + caps.
   - Streams `AgentEvent`s as JSON lines to a Unix domain socket
     at `/var/run/symphony/events.sock` (mounted from the host so
     the daemon can read it).
   - Persists session state to `/workspace/.symphony/`
     (bind-mounted to the host workspace dir).
   - Exits with code 0 on terminal event, non-zero on crash.
4. The daemon reads events from the socket, accumulates them into
   `OrchestratorState`, and stops the pod when the terminal event
   arrives or when the abort signal fires.

The daemon never runs `docker exec` for individual commands, and
the daemon never opens the cloned repo or renders a prompt
template. The pod is responsible for everything inside the work
boundary; the daemon's responsibility ends at "spawn pod with
correct envelope."

### Why the pod re-fetches from Linear (and renders its own prompt)

The first draft of this ADR had the daemon serialize the issue
body and rendered prompt into `task.json`, with the pod just
reading and running. Walking through the multi-project flow
(ADR 0009) surfaced two problems with that shape:

1. **The daemon cannot render the prompt.** The per-repo
   `workflow.md` template lives **inside the cloned repo** at
   `<repo>/.symphony/workflow.md`. The repo is cloned **in the
   pod**, at startup. So the daemon literally does not have
   `workflow.md` available when it starts the pod. Either the
   daemon would have to do its own speculative clone (defeating
   the point of pod isolation), or the pod has to do the render.
   The pod doing the render is the only consistent model.

2. **Linear state is the natural dispatch handshake.** When the
   pod re-fetches and transitions the issue to `In Progress` as
   its first act, that transition is visible to the next daemon
   poll. The daemon's in-memory `running` set becomes a _cache_
   of what Linear says, not the authoritative state. This makes
   daemon-restart-mid-run trivially safe: the new daemon polls,
   sees `In Progress` issues, knows they are claimed by their
   pods, leaves them alone. No socket reattach logic, no SDK
   conversation reconstruction. The four resume bugs from the
   Plan 07 smoke run cannot occur in this shape — they were all
   artifacts of the daemon owning the conversation across a
   restart.

The pod re-fetch costs one extra Linear round trip per dispatch
(~50–200ms). The agent is going to be calling Linear constantly
anyway (`linear_graphql` for comments and state transitions); one
more call before the run starts is not a meaningful cost.

The dispatch envelope is therefore intentionally narrow: it
carries only what the pod cannot derive on its own (which issue,
which repo, operator-decided execution caps, retry context). It
is **not** a snapshot of upstream state. The pod fetches its
own snapshot when it starts.

### Decision B — `ExecutionBackend` is the pluggable interface

The "start a pod, observe its events, stop it" contract is the
narrowest one we can extract that future backends will implement
identically. Define it now, even though v1 only ships one impl:

```ts
interface ExecutionBackend {
  // Pre-flight image resolution + availability check. Errors
  // surface to the orchestrator and are recorded against the
  // issue (not silently retried).
  ensureImage(spec: ImageSpec): Promise<ImageRef>;

  // Start a pod with the agent already running inside it.
  // MUST be idempotent on (projectKey, issueId): if a pod for
  // that key already exists, attach to it rather than spawning
  // a duplicate. This is what makes daemon-restart-mid-run safe.
  start(input: PodStartInput): Promise<PodHandle>;

  // Stop and clean up. Idempotent. Safe on a pod that's already
  // gone (e.g. crashed and self-removed).
  stop(handle: PodHandle): Promise<void>;
}

interface PodHandle {
  readonly podId: string; // backend-specific identifier
  readonly events: AsyncIterable<AgentEvent>;
  readonly logsTail: () => Promise<string>; // for diagnostics
}
```

`PodStartInput` carries the workspace path, the resolved image,
the **dispatch envelope** (operator-side dispatch decisions —
issue id, project key, repo coordinates, operator-side caps,
retry context), and runtime env (secrets like `LINEAR_API_KEY`,
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`). Notably absent: the issue
body, the rendered prompt, the `allowedTools` list. Those are
the pod's job to derive after fetching from Linear and reading
the per-repo `workflow.md`.

V1 ships exactly one implementation: `LocalDockerBackend`, which
shells out to the `docker` CLI (preserving the no-SDK-dependency
choice from the existing `WorkspaceContainer`). Future backends
(`E2BBackend`, `EcsBackend`, `KubernetesJobBackend`) implement the
same interface and are selected via the `execution.backend` field
in the deployment YAML. Building those backends is explicitly out
of scope for this ADR and Plan 09.

A `FakeBackend` ships alongside `LocalDockerBackend` for tests, in
the same pattern as ADR 0007's `FakeTracker`. Orchestrator tests
do not need real docker.

### Decision B — `ExecutionBackend` is the pluggable interface

The "start a pod, observe its events, stop it" contract is the
narrowest one we can extract that future backends will implement
identically. Define it now, even though v1 only ships one impl:

```ts
interface ExecutionBackend {
  // Pre-flight image resolution + availability check. Errors
  // surface to the orchestrator and are recorded against the
  // issue (not silently retried).
  ensureImage(spec: ImageSpec): Promise<ImageRef>;

  // Start a pod with the agent already running inside it.
  // MUST be idempotent on (projectKey, issueId): if a pod for
  // that key already exists, attach to it rather than spawning
  // a duplicate. This is what makes daemon-restart-mid-run safe.
  start(input: PodStartInput): Promise<PodHandle>;

  // Stop and clean up. Idempotent. Safe on a pod that's already
  // gone (e.g. crashed and self-removed).
  stop(handle: PodHandle): Promise<void>;
}

interface PodHandle {
  readonly podId: string; // backend-specific identifier
  readonly events: AsyncIterable<AgentEvent>;
  readonly logsTail: () => Promise<string>; // for diagnostics
}
```

V1 ships exactly one implementation: `LocalDockerBackend`, which
shells out to the `docker` CLI (preserving the no-SDK-dependency
choice from the existing `WorkspaceContainer`). Future backends
(`E2BBackend`, `EcsBackend`, `KubernetesJobBackend`) implement the
same interface and are selected via the `execution.backend` field
in the deployment YAML. Building those backends is explicitly out
of scope for this ADR and Plan 09.

A `FakeBackend` ships alongside `LocalDockerBackend` for tests, in
the same pattern as ADR 0007's `FakeTracker`. Orchestrator tests
do not need real docker.

## Alternatives considered

**(a) Agent on host with PATH-wrapper trick.** The prior Plan 09
draft. Rejected for the four reasons in Context: unusual mental
model, isolation by encouragement rather than construction, blocks
backend portability, awkward state recovery. The cleverness ratio
is high but it's clever in service of a design that fights the
standard pattern.

**(b) Agent on host with per-command `docker exec`.** No PATH
trick — the `Bash` tool implementation literally calls
`docker exec <pod> <args>` internally. Cleaner than (a) but pays
200–500ms cold start per shell call. A typical turn makes 20–50
shell calls; 10–25 seconds of pure overhead per turn is not
acceptable. Rejected.

**(c) Container per command (`docker run --rm` per `Bash`).**
Same cold-start problem as (b) plus no warm caches between calls
(npm cache, git object cache, build artifacts all evaporate).
Rejected.

**(d) Agent in pod, but with E2B from day one (skip local).** E2B
would give us the model immediately and is the closest commercial
match for what we want. Rejected for v1 because: it adds a cloud
dependency to a "runs on a developer's laptop" experience; it
creates a billing surface we don't need yet; and the `ExecutionBackend`
abstraction we're defining means adopting E2B later is a backend
swap, not a redesign. Adopting E2B in a later plan is on the table.

**(e) Agent in pod, daemon talks to it over HTTP/gRPC instead of
Unix sockets.** HTTP would be necessary for a remote backend (E2B,
ECS) but is overkill for local docker — sockets are faster, don't
need port allocation, and don't open network surface. The
`ExecutionBackend` interface is event-stream-shaped (`AsyncIterable<AgentEvent>`),
so the underlying transport is each backend's choice. Local docker:
sockets. Cloud backends: whatever they expose.

**(f) Run the SDK in a worker thread inside the daemon, isolated
via VM/`vm2`.** Tempting because it skips Docker entirely, but `vm2`
is deprecated/insecure, Node's built-in `vm` is not a security
boundary (well-documented escape paths), and the agent needs to
spawn child processes (git, pnpm, gh) that VM isolation cannot
contain. Rejected.

## Consequences

**Easier:**

- Mental model is one-line: pod = one issue's complete world. The
  agent is in the pod; the workspace is in the pod; tools the
  agent uses are in the pod. No PATH games.
- Isolation is structural. An agent that hardcodes
  `/usr/local/bin/git` finds the container's `/usr/local/bin/git`
  (or doesn't, and errors loudly). There is no host to leak to.
- Backend portability. Adding `E2BBackend` later means implementing
  one interface, not unwinding a host-side trick. The seam is the
  `ExecutionBackend` interface itself — the orchestrator never
  knows which backend is in use.
- **Daemon restart is trivially safe**, not "survivable with care".
  The Linear state-machine acts as the dispatch lock: the pod
  transitions the issue to `In Progress` as its first act; the
  restarted daemon polls, sees `In Progress`, knows the issue is
  claimed by an existing pod, and leaves it alone. No socket
  reattach logic. No SDK conversation reconstruction. No race on
  the daemon's in-memory `running` set. The four resume bugs from
  Plan 07's smoke run cannot occur in this shape — they were all
  artifacts of the daemon owning the conversation across restarts.
- The agent-runtime image is self-contained: anyone can run
  `docker run -v <workspace>:/workspace symphony/agent-base` to
  reproduce a turn manually for debugging.
- Daemon code shrinks. It no longer renders prompts, no longer
  serializes Linear payloads into a snapshot, no longer needs to
  decide "is the workflow.md rendered correctly for this issue."
  The daemon's job collapses to "decide which issues to dispatch
  with what envelope, then start a pod and watch its events."

**Harder:**

- A daemon ↔ pod RPC has to exist. ~100 lines: socket server in
  the agent-runtime entrypoint, socket client in the daemon, the
  same JSON-line `AgentEvent` shape we already serialize for the
  HTTP wire. Not free, but small.
- Image build pipeline gains complexity. The base image now bundles
  the agent-runtime + Claude SDK + Node deps, not just system
  tools. Per-repo Dockerfiles must extend the base (can't be
  totally arbitrary). Documented in Plan 09's image-resolution
  contract.
- Tests that currently exercise `ClaudeAgent` directly still work
  (the class survives, runs in the pod), but new orchestrator-level
  tests need `FakeBackend`. One more fake to maintain.
- The pod must hold tracker credentials (`LINEAR_API_KEY`) directly
  — these can no longer stay in the daemon-only domain. Mitigation:
  the same env var the daemon already uses; documented in
  `SECURITY.md`. A future per-project credential mode (later plan)
  could narrow this.
- The pod takes one extra Linear round trip on startup vs the
  serialize-into-task.json design (~50–200ms). Negligible relative
  to a typical multi-minute agent turn; called out for completeness.
- Workspace path mirroring becomes a real concern in Plan 10: when
  the daemon-in-container spawns sibling pods, the `-v` flag must
  use HOST paths, not in-container paths. Surfaced as an open
  question in Plan 10.

**Constrained:**

- The agent-runtime contract (entrypoint location, mounted
  dispatch envelope path, event socket path, env var names) is a
  stable interface. Breaking it requires a base-image major
  version bump and rebuilds across every onboarded repo.
- The Linear state machine is now load-bearing for dispatch
  coordination. Trackers that don't expose state transitions to
  the daemon's poller (or trackers without an "In Progress"
  equivalent) cannot use this dispatch model unchanged. For now,
  Linear is the only tracker; this is acceptable. Re-examine when
  adding GitHub Issues or other backends.
- Per-repo Dockerfiles must `FROM symphony/agent-base:<major>`.
  Repos that need a totally different base (e.g. an embedded agent
  runtime in a non-Node language) are not supported. We don't
  expect this case in the Symphony target population.
- The Claude Agent SDK runs in the pod, which means the pod needs
  outbound network access to api.anthropic.com. Air-gapped
  deployments are out of scope; documented in `SECURITY.md`.

## Implementation notes

**Interface location.** New package directory at
`packages/daemon/src/execution/`. Replaces the existing
`packages/daemon/src/workspace/container.ts` over the course of
Plan 09 stages 09c–09d (the existing module is the "container
lifecycle" piece; the new layer wraps it inside the
`LocalDockerBackend` impl and adds the agent-runtime dispatch).

**Event protocol.** JSON lines over a per-pod Unix domain socket.
Each line is one `AgentEvent` (the existing discriminated union
in `packages/daemon/src/agent/runner.ts`). The agent-runtime's
end of the socket is a writer; the daemon's end is a reader that
yields events into an `AsyncIterable`. Backpressure: trivial — the
agent emits events at human-debugging speeds (low tens per
second, peak), well under socket buffer sizes.

**Idempotency contract.** `start({ projectKey, issueId, ... })`
must resolve to the same `PodHandle` for the same key whether the
pod was just created or already existed. Implementation: docker
container name is `symphony-<sanitizedProject>-<sanitizedIssue>`;
`docker inspect <name>` decides start-vs-attach. Same pattern as
`WorkspaceContainer.ensureRunning` today.

**FakeBackend shape.** Implements `ExecutionBackend` with an
in-memory pod registry. Tests inject a scripted event sequence per
pod. Used in orchestrator + multi-project tests so neither needs
docker. The `LocalDockerBackend`'s tests use the existing mocked
`DockerRunner` from `workspace/container.ts` (carried forward).

**Telemetry.** `logsTail()` returns the last N bytes of the pod's
stdout/stderr. The daemon includes it in failure diagnostics
("agent pod exited non-zero, last 4KB of logs follows"). Not used
on the hot path.

**Migration.** The existing `ClaudeAgent` class moves to a new
package `packages/agent-runtime/`, which builds into the agent
image. The class itself is almost unchanged; what's new is the
entrypoint shim that fetches the issue, clones the repo, reads
the per-repo `workflow.md`, renders the prompt, and constructs
the SDK call — then writes events to the socket. The daemon
stops constructing `ClaudeAgent` directly — it constructs
`ExecutionBackend.start(...)` instead.

**Dispatch envelope shape.** The `DispatchEnvelope` mounted at
`/etc/symphony/dispatch.json` is intentionally narrow:

```ts
interface DispatchEnvelope {
  // What pod is working on (so it can fetch + clone)
  readonly issueId: IssueId;
  readonly issueIdentifier: IssueIdentifier; // for logs
  readonly projectKey: string;

  // Where to fetch the issue from
  readonly tracker: { readonly kind: 'linear'; readonly projectSlug: string };

  // Where to find the work + workflow definition
  readonly repo: {
    readonly url: string;
    readonly defaultBranch: string;
    readonly workflowPath: string; // default: .symphony/workflow.md
    readonly branchPrefix: string; // default: symphony/
  };

  // Operator-decided execution caps. Pod takes min(this, repo_cap)
  // for budgets; repo-side wins for model and allowedTools.
  readonly operatorCaps: {
    readonly model?: string;
    readonly maxTurns?: number;
    readonly maxBudgetUsd?: number;
  };

  // Retry + resume context (daemon-decided)
  readonly attempt: number | null;
  readonly resumeSessionId?: string;
}
```

Notably absent: `prompt`, `description`, `state`, `allowedTools`,
the issue body. The pod derives all of these by re-fetching from
Linear and reading `workflow.md` from the cloned repo. Secrets
(`LINEAR_API_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) flow as
env vars on the pod, not in the envelope.

## Schedule

This decision is implemented in
[Plan 09](../exec-plans/active/09-multi-project-and-agent-runtime.md),
specifically stages 09c (interface + LocalDockerBackend) and 09d
(agent-runtime entrypoint + base image).

ADR 0009 (multi-project) and this ADR are independent decisions
that ship together in Plan 09. They sit on orthogonal axes:
ADR 0009 is about **config ownership** (who edits what file);
this ADR is about **runtime placement** (where the agent process
lives). Either could be implemented without the other, but Plan
09's "real PR loop end-to-end on N projects" outcome needs both.
