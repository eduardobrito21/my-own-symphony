# 0015 — Sub-agents run in the sandbox they operate on; the parent stays in the daemon

- **Status:** Proposed (2026-05-17 — pending Plan 18a / 18b
  implementation)
- **Date:** 2026-05-17
- **Amends:** ADR 0014. The "parent agent runs in the daemon
  process" decision stands. The implicit corollary that ADR 0014
  invited — "and so do all sub-agents" — is replaced by a per-
  stage rule: sub-agents run where their work runs. For local
  sandbox kinds (`local-shell`, `local-docker`) that's still the
  daemon process. For remote kinds (`namespace-devbox`, future
  `e2b-microvm`, etc.) it's inside the sandbox itself, using the
  Claude Code CLI as the runtime.
- **Does NOT supersede ADR 0011.** ADR 0011's "agent-in-pod"
  model put the entire agent — including orchestration and
  Linear interaction — inside the pod, and required a custom
  `agent-runtime` package, custom image, custom transport, and a
  dispatch-envelope contract. This ADR keeps the daemon as the
  orchestration host and only relocates per-stage sub-agents
  when the sandbox they operate on is remote. The runtime is
  Anthropic's `claude` CLI (third-party, maintained by them);
  the transport is the sandbox provider's existing command-
  streaming API; the image is whatever the sandbox provider
  already ships plus a one-line install of `claude`. None of
  ADR 0011's hard costs apply.

## Context

Plan 17a shipped the multi-backend `@sandbox` skill on
2026-05-17 and a real end-to-end smoke went through:
local-cloned repo → README edit → commit → push → PR opened →
Linear comment with PR URL → Done, all in ~62 seconds. The MVP
`@coder` and `@ci` skills shipped alongside.

The smoke worked because the dispatched sandbox was
`local-shell` — the worktree lives at a path on the daemon
host's filesystem. The agent's built-in `Read`/`Edit`/`Write`
tools target the daemon process's filesystem (via Node's `fs`),
so reading and editing `/Users/.../workspaces/.../EDU-15/README.md`
just worked.

For `namespace-devbox` sandboxes the worktree lives inside the
microVM, at `/workspace`. That path doesn't exist on the daemon
host. The agent's `Read`/`Edit`/`Write` tools fail or operate
on the wrong filesystem. Only `Bash` is sandbox-aware, and only
by convention: the agent has to manually wrap each command in
the `SandboxHandle.exec.template` substitution. If it forgets,
the command runs on the daemon host instead of the VM.

The MVP `@coder` SKILL.md took a shortcut: "if `kind` is not
`local-*`, return `changed_files: []` and bail." This made the
Plan 17a smoke work end-to-end on local but means
`sandbox:namespace` labels can't produce a PR today. The MVP
`@ci` script has the same limitation — it runs `git` and `gh`
on the daemon host against `worktree_path`, which only resolves
for local kinds.

We surveyed five paths through this constraint:

1. **Bash-only on remote.** Tell the agent to use only `Bash`
   with manual `exec.template` substitution for remote sandboxes.
   Works for trivial edits, gets brittle for in-place
   modifications and binary files.
2. **Agent-in-sandbox via `claude` CLI.** Install the Claude
   Code CLI inside the sandbox at `@sandbox` time, then invoke
   sub-agents via `nsc ssh <id> -T -- claude -p '<prompt>'` (or
   the equivalent for other providers).
3. **SSHFS / NFS mount.** Mount the remote sandbox's filesystem
   on the daemon host. Filesystem tools transparently work.
   Operator dependency (macFUSE on macOS), latency-sensitive,
   semantic awkwardness around atomic writes and locking.
4. **Hybrid: code lives locally, sandbox is just for execution.**
   Daemon's working copy stays local; `exec.template` only used
   for test runs / service execution. Closer to the Plan 14
   model (which we abandoned).
5. **Sandbox-as-MCP.** Daemon hosts a per-dispatch MCP server
   exposing `sandbox_read` / `sandbox_edit` / `sandbox_write` /
   `sandbox_bash` tools that route through `exec.template`.
   Sub-agents have these tools instead of (or in addition to)
   the built-ins.

(2) and (5) were the serious contenders. We were initially
attracted to (5) — it preserves the daemon-resident architecture
ADR 0014 picked, keeps a single Claude session per dispatch, and
makes file ops naturally sandbox-aware via the MCP boundary.

While drafting Plan 18b we surveyed E2B's documentation
(2026-05-17 research) to see how a dedicated sandbox-for-LLM-
agents company shaped the problem. The findings reset the
decision:

- E2B's filesystem and command primitives
  (`sandbox.files.read/write`, `sandbox.commands.run`) are
  exposed as **orchestrator-side SDK methods**, not LLM tools.
  Their position is "the orchestrator drives the sandbox; the
  agent itself doesn't need to know it's in a sandbox."
- The blessed Claude integration is the **Claude Code CLI
  installed inside the sandbox**, invoked as a subprocess from
  the orchestrator. The agent's logic runs in the VM, talking to
  Anthropic's API over the network. `Read`/`Edit`/`Write` /
  `Bash` work natively on the VM's filesystem.
- E2B previously shipped a sandbox-as-MCP server
  ([archived April 2026](https://github.com/e2b-dev/mcp-server)).
  They tried option (5) and walked away from it. Their current
  MCP product is "MCP gateway inside the sandbox" — exposes
  third-party tools to the agent-in-VM, not the other way around.
- E2B's `sandbox.pause()` (~4s/GB RAM) +
  `Sandbox.connect(id)` (~1s resume) with 30-day retention is
  what makes agent-in-sandbox cost-tractable: you don't pay for
  an idle VM between sub-agent dispatches.

The most-invested company in this exact problem space tried
(5) and chose (2). That's a strong negative signal for (5).

## Decision

**Sub-agents run wherever their work runs.** Determined by
`SandboxHandle.kind`:

- **`local-*` kinds** (the daemon host IS the worktree): sub-
  agents run as SDK sub-agents within the daemon's process. The
  parent agent invokes them via the SDK's `Task` tool. This is
  the post-Plan-18a behavior for local sandboxes.
- **Remote kinds** (`namespace-devbox` today, future
  `e2b-microvm` / `aws-ec2` / etc.): sub-agents run inside the
  sandbox as `claude` CLI invocations. The parent agent invokes
  them by shelling out to the sandbox provider's
  command-streaming API — for Namespace, that's
  `nsc ssh <id> -T -- claude -p '<rendered prompt>'`; for E2B it
  would be `sandbox.commands.run('claude -p "..."')`. Output
  streams back as ssh stdout / equivalent and gets mapped onto
  the existing `AgentEvent` shape.

The parent agent stays in the daemon either way. It does no
filesystem work; it orchestrates Linear, the sandbox provider,
and sub-agent dispatches.

`@sandbox` itself stays in the daemon (it's the thing that
creates the sandbox; "run @sandbox in the sandbox" is
circular). `@coder` and `@ci` (and future `@app`, `@tester`)
follow the per-stage rule above.

For remote-kind dispatches, the `@sandbox` skill picks up an
additional responsibility: install the `claude` CLI (and any
other sub-agent prerequisites — `gh`, `git`, etc.) inside the
VM as part of provisioning. This is one shell line in
`namespace-create.sh`. The bootstrap cost (~30s for a typical
`curl ... | sh` install) is paid once per dispatch.

`SandboxHandle.exec.template` continues to be the load-bearing
contract for "how to run a command inside this sandbox." This
ADR doesn't change the schema; it changes what the parent agent
does with `exec.template` for the sub-agent dispatching case
specifically.

## Alternatives considered

### Option 1 — Bash-only on remote

Have `@coder` use only the `Bash` tool, wrapping every command
in `exec.template`. Functional for "append a literal string to
README." Brittle for sed-style in-place edits over ssh
(quoting, escaping, multi-line content). The agent has to
remember to wrap every command; we re-introduce the implicit
substitution discipline that ADR 0014's `exec.template` field
was supposed to abstract over. Rejected as the long-term answer
but accepted as a near-term ergonomic fallback for trivial
edits if the per-sandbox `claude` install fails.

### Option 3 — SSHFS / NFS mount

Mount `/workspace` from the VM on the daemon host. The agent's
`Read`/`Edit`/`Write` tools transparently target the mount.
Rejected:

- Operator dependency on macFUSE (macOS) / kernel-module support
  (Linux). Adds a host-side install gate to the "just run the
  daemon" flow.
- Latency on every file op is at least one ssh round-trip.
  Plenty of `Read` calls per `@coder` dispatch would compound.
- Atomic-write semantics over SSHFS are not consistent across
  implementations. `Edit`'s in-place replacement could yield
  corrupted files under concurrent access.
- Worst-case failure mode is silent: a stale or broken mount
  reads stale data without erroring, so an `@coder` run might
  "succeed" against the wrong filesystem snapshot.

### Option 4 — Code lives locally, sandbox only runs tests

Clone in the daemon's per-issue workspace; do file edits there
(Plan 17a behavior); only use `exec.template` for shell
operations that need the sandbox environment (running tests,
docker compose, etc.). This is essentially Plan 14's model. It
works for "edit, then test" flows but makes the sandbox
optional for the actual code-change step. Rejected because:

- The whole point of provisioning a microVM is that the agent's
  environment matches production. Editing on the daemon host
  defeats this — the agent could be using a different Node
  version, libc, locale, etc. than the sandbox.
- Re-introduces "two copies of the worktree" with no clean way
  to keep them in sync.
- For repos where building requires the sandbox environment
  (compiled languages, language-server-driven edits, etc.),
  this falls over.

### Option 5 — Sandbox-as-MCP server

The path we were drafting Plan 18b around before the E2B
research. Daemon spins up a per-dispatch MCP server with
sandbox-aware tools; sub-agents use these tools in place of the
SDK's built-ins. Rejected after the 2026-05-17 E2B research:

- E2B archived their equivalent project (April 2026). They have
  the strongest possible incentive to make this work and chose
  not to.
- Every file operation becomes an ssh round-trip mediated by the
  MCP server, which then has to substitute into `exec.template`
  and parse the result. Round-trip overhead compounds; large
  file edits / `Write` of binaries / `Glob` over a large tree
  all degrade.
- Custom plumbing surface on our side: a per-dispatch MCP server
  is real code (transport, lifecycle, error handling) that has
  to be maintained as `exec.template` shapes evolve per backend.
- The `Edit` tool's in-place modification semantics are hard to
  implement faithfully over a shell-only routing path. Writing
  half of an `Edit` correctly is worse than not having it.

### Option 6 — Anthropic Managed Agents

Anthropic offers a hosted product where they own the orchestrator,
the tool execution layer, and sandbox provisioning. We'd hand
them the issue and a skill bundle and get back outputs. Rejected
**for this ADR**, not in general:

- It replaces the daemon entirely, which is a different product
  decision than the per-stage location of sub-agents that this
  ADR is about.
- Worth its own future ADR conversation if the operator-side
  ownership story (BTG, etc.) tilts toward "we don't want to
  run our own orchestrator at all."

## Consequences

**Easier:**

- `sandbox:namespace` (and any future remote backend) produces
  PRs end-to-end. The honor-the-label experience the user
  expected is finally honored.
- Each sub-agent's tool surface is naturally where its work is.
  No tool-routing plumbing; no manual `exec.template`
  substitution discipline at the model level.
- Per-stage observability is uniform across local and remote
  via the sandbox provider's existing streaming. The daemon's
  event mapping shim adds the `sub_agent` label and
  forwards.
- We ride Anthropic's `claude` CLI updates for free. Tool
  behavior changes that Anthropic makes propagate without
  Symphony work.
- Sandbox provider primitives (E2B's `pause`/`resume`,
  Namespace's `extend duration`, snapshots if/when added)
  become available to us without architectural change.
- The split scales to as many remote providers as we want: each
  one just needs `exec.template`-shaped command streaming and a
  way to install `claude` at provisioning time. AWS EC2 / GCP
  Cloud Run / Fly / etc. all fit.

**Harder:**

- `ANTHROPIC_API_KEY` has to be present inside remote sandboxes
  for the duration of a sub-agent dispatch. Plan 17b's
  credential-injection design extends from "GitHub token" to
  "Anthropic key" — same shape, second secret. The single-
  tenant remote-VM property of our sandboxes makes the
  threat model manageable but the surface widens.
- Two execution paths for sub-agents (in-process SDK for local,
  ssh-streamed `claude` CLI for remote) means two code paths
  for event mapping, error handling, and budget enforcement.
  Plan 18b owns reconciling them behind a single
  `dispatchSubAgent(name, kind, ...)` entry point.
- Sub-agent invocation tokens are billed via Anthropic
  regardless of the sandbox provider, but a remote sub-agent's
  prompt cache is sandbox-local — no shared cache with the
  parent's session. Net token cost per dispatch goes up
  meaningfully for remote backends compared to local. Plan 18b
  measures this against the Plan 17a baseline and updates
  cost models.
- Bootstrap latency on remote dispatches: `claude` CLI install
  inside the VM adds ~30s to first-time provisioning. Subsequent
  dispatches against a paused/resumed VM amortize this.
- Sub-agent stdout-parsing for events is per-CLI-version
  brittle. `claude --print` output format can change. Plan 18b
  pins the supported CLI version range and tests against it.

**Constrained:**

- The sandbox provider has to support: stable instance ID,
  command streaming with output capture, FS persistence within
  the dispatch lifetime, and (ideally) pause/resume for cost
  efficiency. Namespace and E2B both qualify. AWS EC2 needs
  scaffolding; Fly Machines and Cloud Run are closer.
- Per-sub-agent budget caps become more important. A remote
  `@coder` invocation pays for `claude` CLI tokens _plus_ the
  sandbox provider's compute time. Today's operator-wide
  `max_budget_usd` is too coarse. Plan 18b lifts this into per-
  stage caps configurable in `symphony.yaml`.
- The `claude` CLI's authentication model (env var) is the
  contract we depend on. If Anthropic deprecates env-var auth in
  favor of a keychain / browser-flow, our bootstrap step has
  to adapt.

## Out of scope (deliberately deferred)

- **Cross-provider sandbox capability negotiation.** Each
  provider's `exec.template` differs slightly (Namespace's
  `nsc ssh -T --` vs E2B's `sandbox.commands.run` shell-string
  vs a hypothetical AWS SSM `aws ssm start-session ...`).
  Plan 18b ships one provider integration (Namespace) plus
  documents the contract; future providers are independent plans.
- **Auto-pause/resume orchestration across sub-agent
  dispatches.** E2B's pause primitive lets you save VM cost
  between `@coder` and `@ci` invocations. Worth doing but adds
  state machine complexity around resume failures, instance
  drift, deadline races. Defer until cost data justifies it.
- **Parent agent ever running outside the daemon.** Not in this
  ADR. ADR 0014's "daemon-resident parent" stands.
- **Replacing the `claude` CLI with a custom runtime.** The CLI
  is the chosen substrate. If Anthropic ships a more agent-SDK-
  shaped sub-process API later (or a "remote SDK session"
  primitive), that's a future amendment.
- **Local-sandbox sub-agents going via `claude` CLI for
  uniformity.** Tempting (one code path instead of two) but
  pays per-dispatch latency and token cost for no gain. Local
  stays in-process.

## Schedule

- **Plan 18a** (already drafted, status `Not started`): migrate
  the existing inlined-skill-sections pipeline to SDK native
  sub-agents within the daemon process. Implements per-sub-
  agent tool scoping and structured handoffs. Independent of
  this ADR but a precondition for 18b's clean split.
- **Plan 18b** (TBD): apply this ADR's split. Sub-agents for
  remote sandboxes run inside the sandbox as `claude` CLI
  invocations; local sub-agents use 18a's in-process SDK path.
  `@sandbox` skill scripts learn to install `claude` (and `gh`)
  inside the VM at provisioning time. `SandboxHandle.exec.template`
  contract documented as "the way to invoke a sub-agent in
  this sandbox," not just "the way to run a shell command."
- **Plan 19** (`@ci` real, post-18a/18b): inherits the split
  uniformly. Same code path whether the sandbox is local or
  namespace.

The first end-to-end smoke after 18a + 18b should be a
`sandbox:namespace`-labeled Linear issue that produces a PR
without the MVP "remote bail-out" path firing.
