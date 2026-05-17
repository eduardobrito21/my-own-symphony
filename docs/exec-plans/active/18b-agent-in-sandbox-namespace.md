# Plan 18b — Sub-agents run inside the Namespace sandbox

- **Status:** Not started
- **Implements:** ADR 0015 ("sub-agents run in the sandbox they
  operate on") for the `namespace-devbox` backend. After this plan
  ships, a `sandbox:namespace`-labelled dispatch executes
  `@planner`, `@coder`, and `@ci` _inside_ the microVM via the
  `claude` CLI, not in the daemon process. `@sandbox` itself
  stays in the daemon (the bootstrap that creates the VM cannot
  run inside the very VM it provisions).
- **Comes AFTER:** Plan 17a (multi-backend `@sandbox` dispatcher),
  Plan 18a (SDK native sub-agents — the in-daemon pattern this
  plan extends, not replaces), Plan 20 first cut (`@planner`).
  Plan 17b (private repo creds) is _adjacent_: this plan adds a
  second secret (`ANTHROPIC_API_KEY`) that uses the same
  injection pattern Plan 17b establishes for `GITHUB_TOKEN`. If
  17b hasn't shipped, this plan ships the pattern; 17b later
  adopts it.
- **Comes BEFORE:** Plan 18 (real `@coder` + `@tester`) — bigger
  iteration loops are dangerous without sandbox isolation. The
  decision to deprecate `local-*` backends (informally agreed
  2026-05-17) is a follow-up plan, not part of 18b.
- **Spec sections:** none directly. ADR 0015 is the load-bearing
  context.
- **Layers touched:**
  - `packages/daemon/src/skills/sandbox/scripts/namespace-create.sh`
    (install `claude` CLI in the VM during provisioning; pin a
    version range; verify after install; `nsc instance upload` the daemon's
    skills directory + the in-VM wrapper into `/opt/symphony/`
    per Decision 12)
  - `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
    (new file — the in-VM wrapper script the parent agent
    invokes via `nsc ssh`; reads SKILL.md from the bundle,
    invokes `claude -p`, streams NDJSON back. See Decision 12.)
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts`
    (kind-aware dispatch instructions in the orchestration
    prompt: after `@sandbox` returns, branch on `kind` for the
    remaining stages)
  - `packages/daemon/src/agent/pipeline/runner.ts` (event mapping
    for `claude --print --output-format=stream-json` stdout
    coming back from `nsc ssh`)
  - `packages/daemon/src/agent/claude/event-mapping.ts` (extend
    the existing SDKMessage → AgentEvent table to also cover
    `claude` CLI NDJSON events; same shape, different transport)
  - `SECURITY.md` (document `ANTHROPIC_API_KEY` reaching the
    sandbox; tighten the trust posture section for remote-VM
    secret handling)
  - `symphony.yaml` example (operator note: namespace backend
    now needs `ANTHROPIC_API_KEY` in `.env` to be forwarded)
- **ADRs referenced:** ADR 0015 (this plan's decision document),
  ADR 0014 (sub-agent pipeline — Plan 18b preserves the parent-
  in-daemon part), ADR 0006 (zod at every boundary — sub-agent
  return values still validate), ADR 0011 (agent-in-pod —
  explicitly NOT what this plan does; comparison drawn in ADR
  0015).

## Goal

Make `sandbox:namespace`-labelled dispatches produce real PRs by
relocating `@planner`/`@coder`/`@ci` execution into the microVM
they're operating on. After this plan ships:

- A Linear issue with the `namespace` (or `sandbox:namespace`)
  label dispatches through the full pipeline.
- The microVM is provisioned with `claude` CLI pre-installed (by
  `@sandbox`'s namespace-create script).
- The parent agent (still in the daemon) invokes `@planner`,
  `@coder`, `@ci` by shelling out to the in-VM wrapper:
  `nsc ssh <id> -T -- /opt/symphony/dispatch.sh <name> '<inputs-json>'`.
  Credentials (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) reach the
  sandbox via an uploaded env file the wrapper sources
  (Decision 4) — `nsc ssh` does not support env-var flags.
- Sub-agent file edits stay inside the microVM. The daemon's
  host filesystem is structurally unreachable to those sub-
  agents — the EDU-18 class of "agent writes to source repo"
  bug becomes impossible by construction, not by SKILL.md
  discipline.
- `@ci`'s `git push` and `gh pr create` run from inside the
  microVM, using `GITHUB_TOKEN` injected the same way (extending
  Plan 17b's pattern).

`local-*` dispatches keep Plan 18a's in-daemon behavior
verbatim. No behavior change for local; namespace becomes
end-to-end functional.

## Why

Three motivations, in priority order:

1. **Structural elimination of host-fs contamination.** The
   EDU-18 smoke caught `@planner` writing the exec plan to the
   daemon's source repo (relative path resolved against
   `process.cwd()`). SKILL.md tightening reduced the leak but
   relies on the agent reading and obeying the instruction. With
   the agent running inside the microVM, the daemon's filesystem
   isn't on the agent's PATH at all — the bug cannot occur.
2. **Environment parity.** Today's `local-shell` backend runs the
   agent on the daemon host's Node/libc/locale. Cross-platform
   inconsistencies (operator runs macOS; production runs Linux)
   mean the agent could pass its work on one and fail on another.
   The microVM environment matches what production builds + tests
   would see.
3. **Sandbox-only is the roadmap.** Informal call on
   2026-05-17: `local-*` will be deprecated in favor of namespace
   as the default backend. Every hour invested in remote-aware
   pipeline behavior pays off; every hour in local-only paths
   doesn't.

The cost story (Anthropic SDK tokens, not infra) is mixed but
acceptable. The cache boundary moves:

- **Within each sub-agent's `claude -p` invocation** inside the
  sandbox, Anthropic's prompt cache still applies — the system
  prompt (SKILL.md) and any multi-turn context get cached for
  that session's turns. Sub-agents that take multiple turns
  (`@coder` especially) still benefit.
- **Across the daemon ↔ sandbox boundary**, the cache is lost.
  The parent agent (in daemon) and each sub-agent (in sandbox)
  open separate Anthropic sessions; the parent's cached prompt
  doesn't help sub-agents inside the sandbox. Plan 18a's
  intra-process cross-stage caching (single SDK process,
  shared cache for parent + sub-agents) goes away here.

Net effect: per-dispatch token cost goes up modestly because
the cross-stage cache is lost, but each sub-agent's internal
caching still works. Plan 18b measures the delta against the
local-backend baseline (target: ≤ 25% increase for the
EDU-15-class issue); Plan 18b doesn't try to tune it further.
Per-sub-agent model selection (use Haiku for `@planner` which
is mostly judgement; Sonnet for `@coder`'s editing) is a
follow-up optimization once the architecture lands.

## Out of scope

- **Local-backend deprecation.** The decision is informal but
  unscheduled. `local-shell` and `local-docker` paths continue to
  work unchanged in this plan. Removing them is its own follow-up
  with a migration window for operators.
- **Plan 18 (real `@coder` + `@tester`).** Plan 18b moves the
  EXECUTION LOCATION of existing sub-agents. It does not change
  any sub-agent's behavior. The MVP `@coder` keeps its 3-file
  cap; the MVP `@ci` keeps its single-commit semantics. Plan 18
  (a separate effort) introduces `@tester` with bounded
  iteration.
- **AWS / E2B / other remote backends.** Each new remote provider
  needs the same shape (install `claude` CLI in the image,
  expose a command-streaming API with stdin/stdout, support env
  injection). Plan 18b lands the pattern for Namespace; future
  backends adopt it without architectural change but each is its
  own plan.
- **Sandbox pause / resume across dispatches.** Namespace
  supports `--duration` extensions and (eventually) snapshots;
  E2B has `pause`/`connect`. Plan 18b creates and tears down a
  fresh microVM per dispatch — no cross-dispatch session
  persistence, no warm pool. Reuse is a cost optimization for
  a follow-up plan once we have real dispatch volume.
- **Custom `claude` CLI flags / extensions.** We use the standard
  `claude -p --output-format=stream-json` flow. If we need
  features the CLI doesn't expose, we negotiate with Anthropic
  rather than fork. (Cost: CLI compatibility is a foreign API;
  we accept that risk explicitly — see Decision 7.)
- **Anthropic-managed agents.** ADR 0015 option 6. Different
  product decision; not addressed here.
- **Operator UI for remote dispatches.** The dashboard's event
  stream and run-history views continue to work on the same
  `AgentEvent` types after this plan — that's a load-bearing
  design constraint, not a feature.
- **Cross-VM sub-agent invocation (sub-agents calling other
  sub-agents).** Each sub-agent gets one Anthropic session in
  one microVM. If a sub-agent needs to dispatch a peer, that's
  Plan 18's concern (real `@coder` calling `@tester` is the
  motivating case; bounded loop inside one sub-agent or split
  into separate parent-orchestrated stages — TBD in Plan 18).

## Design decisions

### Decision 1 — Parent stays in the daemon (ADR 0015 reaffirmed)

The parent agent (today: the SDK query started by the
`PipelineAgentRunner`) keeps running in the daemon process. It
does no filesystem work, no shell execution. Its job is to
dispatch sub-agents (in-daemon for local kinds; ssh-out for
remote kinds) and to close out via `linear_graphql` at the end.

Reason recap from ADR 0015: relocating the parent into the
microVM would mean every Linear API call has to either reach
back to the daemon (adds a round-trip) or run from the VM
(needs `LINEAR_API_KEY` in the VM — wider secret surface for
no architectural gain). The parent's tools (`linear_graphql`)
operate on remote state already; running the parent next to
that state is fine. Sub-agents operate on the worktree, which
lives in the VM, so they go there.

### Decision 2 — Per-stage dispatch routing by `SandboxHandle.kind`

`@sandbox` runs as today (Plan 18a, in-daemon via SDK `Agent`
tool). It MUST run first; it creates the sandbox the rest of
the pipeline operates on. Until `@sandbox` returns, the kind is
unknown.

After `@sandbox` returns, the parent inspects
`SandboxHandle.kind`:

- **`local-*`** (e.g. `local-shell`, `local-docker`): rest of
  pipeline dispatched via the SDK's built-in `Agent` tool.
  Identical to Plan 18a. No code path divergence.
- **Remote** (`namespace-devbox` today; future
  `e2b-microvm` etc.): rest of pipeline dispatched by the
  parent shelling out via its `Bash` tool to the in-VM
  wrapper:

      nsc ssh "$sandbox_id" -T -- \
          /opt/symphony/dispatch.sh <subagent-name> '<inputs-json>'

  The wrapper sources `/opt/symphony/env` (uploaded at
  `@sandbox` time — Decision 4) to get `ANTHROPIC_API_KEY` and
  `GITHUB_TOKEN` into its environment, then invokes
  `claude -p --output-format=stream-json …`. The parent observes
  the sub-agent via the ssh stdout stream.

The routing logic lives in the **parent prompt** — i.e., the
parent agent itself decides which dispatch mode to use based on
the kind it received from `@sandbox`. The daemon's parent-prompt
builder includes both modes' instructions; the parent picks
based on observation. This avoids a special "remote-mode
parent" build path and keeps the parent in charge of orchestration.

### Decision 3 — `@sandbox`'s `namespace-create.sh` installs `claude` CLI AND copies the daemon's Symphony bundle into the VM

Today's `namespace-create.sh` creates a bare microVM and clones
the repo. Plan 18b extends it to do three things after the clone:

1.  **Install the `claude` CLI** inside the microVM (one-time
    `curl ... | sh`, version-range checked):

        nsc ssh "$id" -T -- bash -c '
          set -euo pipefail
          curl -fsSL https://claude.ai/install.sh | bash
          claude --version | grep -E "^claude (1\.|2\.)" \
            || { echo "[namespace-create] ERROR: unsupported claude CLI" >&2; exit 1; }
        '

2.  **Copy the daemon's current `packages/daemon/src/skills/`
    directory** into the VM at `/opt/symphony/skills/`. The
    skills the agent operates by are whichever ones the
    _running daemon_ shipped with — NOT whichever ones the
    target repo happens to contain. This separation is
    load-bearing for dogfood mode (target repo IS Symphony):
    the daemon's running contract is what governs the dispatch;
    the worktree's in-flight edits to skills are the artifact
    being produced, not the artifact running.

    `nsc instance upload` only handles single files (no `-r`
    flag exists). To upload the skills tree atomically we tar
    it on the daemon, upload the archive, and extract in the
    VM:

        SKILLS_TAR=$(mktemp -t symphony-skills.XXXXXX.tar.gz)
        tar -czf "$SKILLS_TAR" -C <daemon-side parent of skills/> skills
        nsc instance upload "$id" "$SKILLS_TAR" \
            /opt/symphony/skills.tar.gz --mkdir
        rm -f "$SKILLS_TAR"
        nsc ssh "$id" -T -- bash -c '
          set -e
          tar -xzf /opt/symphony/skills.tar.gz -C /opt/symphony/
          rm -f /opt/symphony/skills.tar.gz
        '

3.  **Copy the in-VM wrapper script** (new file added by this
    plan; see Decision 12) to `/opt/symphony/dispatch.sh` and
    make it executable. Single-file upload, no archive needed:

        nsc instance upload "$id" <daemon-side wrapper path> \
            /opt/symphony/dispatch.sh --mkdir
        nsc ssh "$id" -T -- chmod +x /opt/symphony/dispatch.sh

Cost: ~30s for `claude` install + a few hundred ms for the two
`nsc instance upload` operations. One-time per dispatch. Acceptable given
the dispatch already takes 60-90s end-to-end and infra cost
isn't the binding constraint.

The version range guard on `claude` catches "Anthropic shipped a
breaking CLI change and we missed the news" before the dispatch
produces a broken handle. Range is widened over time as releases
prove compatible; tightened on a known break.

### Decision 4 — Credentials reach the sandbox via an uploaded env file

`nsc ssh` does NOT support a `-e KEY=VAL` env-injection flag
(verified against `nsc ssh --help` at plan-write time — only
`-T`, `--container_name`, `--ssh_agent`, `--unique_tag`). The
options narrow to two practical paths:

1. **Pass env on the command line** — `nsc ssh <id> -T -- env
ANTHROPIC_API_KEY=… claude -p …`. Argv-visible: `ps` inside
   the VM, daemon logs of the shell command, anywhere the
   command is echoed. Bad for secrets.
2. **Upload an env file to the VM** — at `@sandbox` provisioning
   time, write secrets to a temp file on the daemon, then
   `nsc instance upload <id> <tmp> /opt/symphony/env`, then
   `chmod 600` and remove the daemon-side temp. The wrapper
   sources `/opt/symphony/env` before invoking `claude`. The
   secrets live on the VM's filesystem only for the dispatch
   lifetime; the VM is ephemeral (destroyed by teardown).

We pick option 2. The argv-leak risk on option 1 is real and
unavoidable without rewriting the shell layer; the VM-lifetime-
bounded file leak on option 2 is manageable given microVMs are
single-dispatch and destroyed at teardown.

Concretely, `namespace-create.sh` does, after the VM is up:

    {
      umask 077
      cat > "$ENV_TMP" <<EOF
    ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
    GITHUB_TOKEN=$GITHUB_TOKEN
    EOF
    }
    nsc instance upload "$id" "$ENV_TMP" /opt/symphony/env --mkdir
    rm -f "$ENV_TMP"
    nsc ssh "$id" -T -- chmod 600 /opt/symphony/env

The wrapper at `/opt/symphony/dispatch.sh` starts with:

    set -a
    . /opt/symphony/env
    set +a

So `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are in the env
the `claude` CLI inherits, without being on its argv.

Hygiene: the daemon must NOT write the env values to any
persistent log (the daemon's standard log scrubbing applies);
the temp file on the daemon is `mktemp`-created with `umask
077` and `rm`'d immediately after the upload returns.

If Plan 17b ships before Plan 18b, it adopts this same pattern
for `GITHUB_TOKEN`. If 18b ships first, 17b inherits.

### Decision 5 — Sub-agent SKILL.md is invocation-mode-agnostic

The same SKILL.md works whether the sub-agent runs in-process
via SDK or in-sandbox via `claude` CLI. This is already true for
Plan 18a — SKILL.md is plain Markdown, no SDK-specific syntax.
Plan 18b keeps that invariant.

What does change: the SKILL.md's tool references must work in
both modes. Today the SDK's `Agent` tool surfaces a fixed tool
allowlist per sub-agent (`AgentDefinition.tools`). The `claude`
CLI version surfaces a different (broader by default) tool set.
We constrain via `--allowed-tools` on the CLI side to mirror
the SDK's per-sub-agent allowlist:

    claude -p "$prompt" --append-system-prompt "$skill_body" \
                        --allowed-tools "Read,Write,Edit,Glob,Grep,Bash"

The allowlist string per sub-agent comes from the same map
`sub-agents.ts` already maintains for `AgentDefinition.tools`.
No duplication.

### Decision 6 — Event mapping reuses Plan 18a's table with NDJSON wrapping

`claude --output-format=stream-json` emits one JSON object per
line on stdout. The shape is the SDK's `SDKMessage` shape
(Anthropic uses the same internal types in the CLI's streaming
output). Plan 18a's `event-mapping.ts::mapSdkMessage` already
handles `SDKMessage` → `AgentEvent`. We add a thin wrapper that
reads stdout line-by-line from the `nsc ssh` Bash result, parses
each line as JSON, and feeds it to `mapSdkMessage`. Same output
type, same downstream behavior.

Unknown event types: dropped (forward-compatible — `claude` may
add events we haven't seen yet; let them through without
mapping). Malformed lines: logged at warn level, dropped, do
not fail the dispatch. EOF without a `result` message: classify
as `turn_failed reason="claude CLI exited without result"`.

### Decision 7 — `claude` CLI version is a pinned dependency

The CLI is a third-party (Anthropic) binary whose flag/output
contract can shift. We pin a **supported version range** in
`namespace-create.sh` (see Decision 3) and assert at provision
time. The range is conservative (start with the major version we
test against; widen on observed compat; tighten on observed
break).

A `claude` version outside the range causes the dispatch to fail
fast at provision time with an actionable error
(`UNSUPPORTED_CLAUDE_VERSION`), not silently mis-parse output
later. Ops then either pins the install URL to a known-good
version or updates the daemon's range.

This is the same "boring third-party tool, accept its update
cadence" stance ADR 0014 takes for `git` and `gh`. The
difference is that `claude` is on a faster release cycle, so
the range expression matters more.

### Decision 8 — `@sandbox` stays in the daemon (always)

`@sandbox` provisions the sandbox the rest of the pipeline
operates on. Running it _inside_ the very sandbox it creates is
circular. ADR 0015 anticipates this; Plan 18b makes it
concrete: regardless of the eventual sandbox kind, `@sandbox`
itself runs via Plan 18a's in-daemon SDK path.

A consequence: the EDU-18 class of "agent writes to host
filesystem" risk for the rest of the pipeline is eliminated, but
`@sandbox` itself still has filesystem access on the daemon
host. `@sandbox`'s SKILL.md restricts it to running scripts in
`packages/daemon/src/skills/sandbox/scripts/` — it doesn't edit
files. Defense-in-depth: also lock `@sandbox`'s tool set to
`Bash` + `Read` only (already the case in Plan 18a).

### Decision 9 — Local backends keep Plan 18a unchanged

No behavior change for `local-shell` or `local-docker` kinds in
this plan. The parent's kind-aware dispatch (Decision 2) falls
through to the SDK `Agent` tool path for those kinds, which is
exactly what Plan 18a does. Tests for local-backend dispatches
should pass before and after this plan with the same assertions.

This isolation is deliberate: Plan 18b ships a new code path
alongside the existing one, doesn't replace anything. A bug in
the remote path can't break local dispatches.

### Decision 10 — Two execution paths, ONE event-mapping table

The daemon's runner ends up with two ways to drive a sub-agent
(SDK in-process, CLI over ssh) but **one** `AgentEvent` shape
the rest of the system consumes (orchestrator, dashboard,
session store, retry logic). The split is deliberately narrow:
how-we-invoke vs. what-events-look-like.

Per ADR 0015's "harder" consequences: this means two code paths
for invocation, error handling, and budget enforcement. Plan
18b owns reconciling them behind a single
`dispatchSubAgent(name, kind, args)` function on the daemon
side. Direct CLI invocations from the parent's Bash tool are
still allowed (it's the same dispatcher with the args already
constructed) — the function exists for daemon-side callers like
the runner's setup logic.

### Decision 11 — Cost discipline: per-sub-agent model is exposed but not tuned in this plan

`AgentDefinition` already supports `model`. The `claude` CLI
supports `--model`. Plan 18b adds plumbing for per-sub-agent
model selection in `sub-agents.ts` but leaves all sub-agents on
the operator-default model. Tuning (e.g. Haiku for `@planner`,
Sonnet for `@coder`) is a separate follow-up plan — likely a
"cost-discipline pass" that also pins iteration caps and
verifies cache-hit dominance.

The reason to expose-but-not-tune: a wrong tuning decision (e.g.
Haiku for `@coder`) breaks the dispatch in ways that confound
the Plan 18b smoke. Ship the architecture; tune separately with
a controlled measurement.

### Decision 12 — In-VM Symphony bundle at `/opt/symphony/`; wrapper is a source-versioned script

The sandbox is provisioned with a small Symphony "bundle" at
`/opt/symphony/`:

    /opt/symphony/
      skills/                    # copy of daemon's packages/daemon/src/skills/
        sandbox/
        planner/
        coder/
        ci/
      dispatch.sh                # the in-VM wrapper (Decision 12)

The wrapper is a new source file at
`packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`.
It runs inside the VM (signaled by the `in-vm/` sub-directory)
and is `nsc instance upload`'d into the sandbox by `namespace-create.sh` at
provision time. Its contract:

    /opt/symphony/dispatch.sh <subagent-name> <inputs-json>
    # exits 0 on success, !=0 on error
    # stdout: claude's --output-format=stream-json NDJSON, line-buffered

The wrapper:

1. Reads `/opt/symphony/skills/<subagent-name>/SKILL.md` from
   disk (no transport via argv → no escaping problems, no
   length limit).
2. Renders the per-sub-agent input block from the JSON
   argument into a small prompt header.
3. Invokes `claude -p "<prompt>" --append-system-prompt "$(cat
SKILL.md)" --allowed-tools "<per-subagent allowlist>"
--output-format=stream-json`.
4. Streams stdout unchanged to its caller (the parent agent
   reading via `nsc ssh -T`).
5. Maps `claude` CLI's exit code to a final stdout line so the
   daemon can disambiguate "ssh failed" from "claude exited
   with error" (resolves the open question that Plan 17a left
   for `nsc ssh` exit-code propagation).

Why this design wins over the alternatives:

- **vs. inlining the wrapper in the parent prompt** (Plan
  18b's pre-revision option A): no argv-length hazard, no
  shell-quoting-markdown-through-ssh problem, no need to make
  the model construct ssh invocations. The parent prompt
  becomes trivial: "run `nsc ssh "$id" -T --
/opt/symphony/dispatch.sh planner '<json>'`" (credentials
  come from the env file the wrapper sources, per Decision 4).
- **vs. baking the wrapper into a custom base image**
  (pre-revision option B): wrapper updates ship with the
  daemon (source-versioned), no image rebuild required for
  iteration, no version-drift footgun where the daemon
  expects a feature the VM's image doesn't have.
- **vs. baking the skills into the image**: same — skills
  evolve with the daemon, not with the image. Operators don't
  need to rebuild anything to pick up a SKILL.md change.

The `/opt/symphony/skills/` copy is the **daemon's current
version of the skills**, not the target repo's. In dogfood
mode (target repo is Symphony itself) the worktree's
`packages/daemon/src/skills/` is what the dispatch is
producing edits to; `/opt/symphony/skills/` is what's running
the dispatch. They must stay separate or the dispatch eats
its own contract.

**Always copy, even in dogfood mode.** No "if target repo is
Symphony, skip the copy" special-case. The cost of always
copying is trivial (skills are tens of KB); the cost of a
conditional code path is conceptual complexity plus the bug
surface where the condition is misread and the dispatch
operates against the wrong skill version. Uniform behavior
beats local optimization here.

**Only the skills directory + the wrapper get copied.** Not
the rest of `packages/daemon/src/`, not `dist/`, not
`node_modules/`, not `.env`, not anything else from the
daemon's source tree. Two reasons:

1. **Minimize what crosses the sandbox boundary.** The
   daemon's wider source contains code the agent doesn't need
   to operate (orchestrator internals, Linear adapter, secret-
   handling, etc.). Anything we copy into the sandbox is
   readable by the agent inside it — including by a future
   `@coder` working on an arbitrary target repo. Even though
   Symphony is open source, "the agent has access to read all
   of Symphony's internals while editing some unrelated repo"
   is leakage by surface, not by intent. Keep the surface
   minimum.
2. **Skills ARE the contract.** Anything not in `skills/` is
   internal to the daemon and irrelevant to sub-agent behavior.
   If a sub-agent needs to reference something outside
   `skills/` we have a missing abstraction — fix that by
   moving the abstraction into a skill, not by widening the
   copy.

Versioning: when the wrapper script's contract grows beyond
"name + json arg" we add a `--protocol-version` flag the
daemon checks. Today's contract is small enough that ad-hoc
compatibility is fine.

## Steps

### Stage 18b-1 — `@sandbox` provisions claude CLI + Symphony bundle in the VM

1. Add the in-VM wrapper script at
   `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
   per Decision 12. Initial cut: reads SKILL.md from
   `/opt/symphony/skills/<name>/SKILL.md`, invokes `claude -p`
   with `--append-system-prompt` from that file and the
   per-sub-agent allowed-tools list passed in as argv.
2. Update `namespace-create.sh` to do, after the repo clone:
   - Install `claude` CLI inside the VM (curl-pipe-bash; pin
     `^1.0.0 || ^2.0.0` initially; document policy inline).
   - `nsc instance upload -r` the daemon's `packages/daemon/src/skills/`
     into `/opt/symphony/skills/` in the VM.
   - `nsc instance upload` the wrapper script from
     `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
     to `/opt/symphony/dispatch.sh` in the VM; `chmod +x` it.
3. Update `@sandbox`'s SKILL.md (the namespace branch) so
   operators reading the docs know what's installed and why
   (`/opt/symphony/` layout + `claude` version range).
4. Manual smoke: `pnpm symphony` against a `sandbox:namespace`
   dispatch; verify post-`@sandbox` that
   `nsc ssh <id> -- ls /opt/symphony/` shows `skills/` and
   `dispatch.sh`, and that `nsc ssh <id> -- claude --version`
   reports a version in range.

### Stage 18b-2 — Daemon-side `dispatchSubAgent` function with kind-aware routing

5. Add `packages/daemon/src/agent/pipeline/dispatch-subagent.ts`
   exposing `dispatchSubAgent({ name, sandboxHandle, prompt, allowedTools, env }): AsyncIterable<AgentEvent>`.
   Note: no longer takes `skillBody` — the wrapper reads it from
   `/opt/symphony/skills/` inside the VM (Decision 12). Local
   path still uses the in-memory skill from the daemon's loader,
   identical to Plan 18a's existing flow.
6. For `kind.startsWith('local-')`: delegate to Plan 18a's
   existing SDK `Agent` flow. The function exists primarily to
   give one entry point; the local path is just a passthrough.
7. For remote `kind`: spawn `nsc ssh "$id" -T --
/opt/symphony/dispatch.sh <name> '<inputs-json>'` as a child
   process with stdout piped. Credentials reach the VM via the
   uploaded env file (Decision 4); they are NOT on the daemon's
   argv. Read NDJSON lines from stdout, parse each as
   `SDKMessage`, feed to `mapSdkMessage`. Yield AgentEvents as
   they arrive.
8. Handle: child exit, stdout EOF, malformed JSON lines, abort
   signal (operator cancel), `nsc ssh` connection drop. Each
   has a defined `turn_failed` reason. Use the wrapper's final
   exit-code-mapping stdout line (Decision 12) to disambiguate
   "ssh broke" from "claude failed".

### Stage 18b-3 — Parent prompt: kind-aware dispatch instructions

9. Update `parent-prompt.ts` to include a "post-@sandbox routing"
   block. After Stage 1 (`@sandbox`), the prompt instructs the
   parent: "Inspect the `kind` field of the returned
   `SandboxHandle`. If it starts with `local-`, use the
   `Agent` tool for Stages 2-4. Otherwise, use the `Bash` tool
   to invoke `nsc ssh ...` per the template below."
10. Provide the exact Bash command template inline in the
    prompt — model behavior is more reliable with the shape
    spelled out than with a free-form "invoke via ssh"
    instruction.
11. Test: `parent-prompt.test.ts` gains assertions on the
    kind-aware routing language; a new test confirms both
    dispatch branches are mentioned in order.

### Stage 18b-4 — Event-mapping coverage for NDJSON over Bash

12. `event-mapping.ts`: confirm `mapSdkMessage` handles every
    shape `claude --output-format=stream-json` emits. Likely
    already true since the CLI's stream-json output is the SDK's
    internal `SDKMessage` shape, but verify against the
    CLI's documented schema and add fixtures.
13. Add a helper `parseNdjsonLines(buf: string): SDKMessage[]`
    in `event-mapping.ts` that's used by `dispatchSubAgent`'s
    remote path. Handles partial lines at the buffer boundary.
14. Test: feed a captured `claude --print --output-format=stream-json`
    transcript into the parser; assert event sequence matches
    expectations.

### Stage 18b-5 — Credential plumbing: `ANTHROPIC_API_KEY` to the VM via uploaded env file

15. Confirm the daemon already has `ANTHROPIC_API_KEY` in its
    process env (it does — the SDK requires it).
16. Extend `namespace-create.sh` to write the env file:
    `mktemp` a daemon-side temp with `umask 077`; write
    `ANTHROPIC_API_KEY=...` and `GITHUB_TOKEN=...` lines;
    `nsc instance upload "$id" "$tmp" /opt/symphony/env --mkdir`;
    `rm -f "$tmp"`; then `nsc ssh "$id" -T -- chmod 600
/opt/symphony/env`. Per Decision 4.
17. The in-VM wrapper (`/opt/symphony/dispatch.sh`) starts with
    `set -a; . /opt/symphony/env; set +a` so the secrets reach
    `claude` via environment, not argv.
18. `SECURITY.md`: add an "Anthropic key reaches remote
    sandboxes via uploaded env file" subsection. Match Plan 17b's
    `GITHUB_TOKEN` discussion style; cross-link to Decision 4.
19. Verify post-provision: `nsc ssh "$id" -- ls -l
/opt/symphony/env` shows mode `600`; `nsc ssh "$id" --
cat /opt/symphony/env` shows the expected key names (NOT
    in a log capture); but the daemon's own logs do NOT
    contain the key values. Grep audit on a recent run's log;
    add a log scrubber test if anything leaks.

### Stage 18b-6 — End-to-end smoke against a real namespace dispatch

19. Create an EDU-NN Linear issue with `sandbox:namespace` label
    (or use the equivalent operator-side issue from dogfood
    mode).
20. Run `pnpm symphony`. Expected event sequence:
    - `@sandbox` provisions microVM, installs `claude`,
      returns handle with `kind: "namespace-devbox"`.
    - Parent observes the kind, switches to ssh-dispatch for
      remaining stages.
    - `@planner` (inside VM) reads issue, decides plan or skip,
      writes file in VM (NOT on daemon host), commits inside
      VM.
    - `@coder` (inside VM) edits files inside VM.
    - `@ci` (inside VM) `git push` and `gh pr create` from
      inside VM.
    - Parent (in daemon) close-out via `linear_graphql`.
21. Verify:
    - Source repo on daemon host is completely untouched
      (`git status --porcelain` empty).
    - PR opened in the test repo with expected content.
    - Linear issue transitions to Done.
    - Daemon logs show ssh-dispatch path was used (the new
      `dispatch_subagent_remote` log lines fire, not the
      `dispatch_subagent_local` ones).
22. Capture before/after token-cost metrics in this plan's
    decision log: parent input/output, each sub-agent's
    input/output, total dispatch cost in USD. Compare against
    EDU-15 / EDU-16 (local-backend baselines).

### Stage 18b-7 — Docs + tech-debt updates

23. Update `AGENTS.md` to describe the dispatch routing model:
    "for namespace backends, sub-agents run inside the
    microVM via `claude` CLI". Link to ADR 0015 for design
    rationale.
24. Update `docs/exec-plans/tech-debt-tracker.md`: mark the
    EDU-18-class "agent writes to source repo" risk as
    "Resolved by Plan 18b for remote backends; still relevant
    for local until local is deprecated."
25. Move this plan to `completed/` with the final accounting
    table.

## Definition of done

- A `sandbox:namespace` dispatch end-to-end:
  - Provisions a microVM with `claude` CLI installed.
  - Runs `@planner`, `@coder`, `@ci` _inside the microVM_ via
    `nsc ssh -T -- claude -p ...`.
  - Closes out via the parent's `linear_graphql` from the
    daemon.
  - Opens a real PR.
  - Linear issue → Done.
- Daemon's source repo `git status --porcelain` is empty
  before and after the dispatch — proves no host-fs leak.
- `local-shell` dispatches continue to pass their existing
  smoke (Plan 17a / 18a parity preserved).
- `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` reach the sandbox via
  the uploaded `/opt/symphony/env` file (Decision 4) with mode
  `600`. Neither appears on `nsc ssh` argv, in any daemon log,
  or in any `.git/config` after the dispatch. The file inside
  the microVM dies with the VM at teardown.
- A captured token-cost report shows the namespace dispatch
  within 25% of the local-backend baseline for an
  EDU-15-class issue. If outside, this plan documents the
  delta and identifies which sub-agent's prompt-cache loss
  drove it; doesn't try to fix it in this plan.
- `claude --version` outside the supported range causes
  `@sandbox` to fail at provision time with a clear
  `UNSUPPORTED_CLAUDE_VERSION` error. (Falsifiable: install
  an out-of-range version manually, dispatch, observe
  failure.)
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check && pnpm build`
  green.

## Open questions

- **Does the parent's `Bash` tool need additional output buffering?**
  Default Bash tool output captures may have a size limit or
  buffer-flushing behavior incompatible with long-running
  `nsc ssh` streams. May need a streaming mode or per-call
  tuning. Verify during Stage 18b-2.
- **What's the right behavior when a sub-agent inside the VM
  fails partway through?** Today's `@coder` failures return
  `changed_files: []` and the parent skips `@ci`. For remote
  failures (e.g. `nsc ssh` drops mid-execution), the daemon
  doesn't know if the sub-agent partially completed work in the
  VM. Options: (a) retry inside the same VM, (b) destroy the VM
  and start fresh, (c) leave the half-state and let the
  operator inspect. Initial cut: (b), since the VM is cheap.
  Refine after observing real failure modes.
- **How does `claude` CLI surface budget caps?** The SDK's
  `maxBudgetUsd` is enforced inside the SDK loop. The CLI
  equivalent (if any) is operator-set via `--max-budget` or
  similar. Need to confirm the CLI flag exists and matches the
  semantic. If not, per-sub-agent budget enforcement becomes
  a daemon-side timeout instead of an Anthropic-side budget.
- **MicroVM teardown timing.** The current namespace-create
  script sets `--duration 30m`. With sub-agents running inside,
  the VM is alive while sub-agents work. If a sub-agent takes
  ~10s and we have 4 sub-agents per dispatch, 30m is fine. If
  `@coder` ↔ `@tester` (future Plan 18) loops 3x, that grows.
  Worth tuning the duration knob OR accepting that the VM
  outlives the dispatch and we reap it later.
- **Multi-sandbox dispatches (e.g. a single dispatch spawning
  two VMs for different sub-tasks).** Not a Plan 18b concern
  (the pipeline is fixed at one sandbox per dispatch today),
  but flagging in case Plan 18's `@tester` needs an isolated
  test VM. If so, that's its own design pass.
- **Prompt-cache behavior across `claude` CLI invocations.** Each
  `nsc ssh -T -- claude -p ...` is a separate process and
  almost certainly a separate Anthropic session. Cache hits
  across sub-agent dispatches are unlikely. Worth capturing
  measured `cache_creation` vs `cache_read` tokens in the
  smoke and confirming the assumption — if cache actually
  works across CLI invocations (via the SDK's per-user state
  dir), great; if not, that's the cost story we accept.
- **`nsc ssh` flakiness.** Plan 17a's probe showed `nsc ssh`
  exit codes don't propagate cleanly (tech-debt entry).
  Affects this plan: how does the daemon distinguish "ssh
  failed to connect" from "claude exited with error"? Both
  produce non-zero exit codes from the daemon's perspective.
  May need a stderr inspection pass to separate them — or the
  daemon could parse the `claude --print` output's terminal
  event independently of the ssh exit code.
- **Local-backend deprecation timing.** Informal call: local
  is going away. But Plan 18b explicitly keeps it working. At
  what dispatch volume / signal do we cut it? Probably "first
  full week of dogfood mode runs cleanly against namespace,
  with no operator-side complaints about local being missing"
  — but that's a soft criterion. Likely its own plan.

## Decision log

(Empty until execution begins.)
