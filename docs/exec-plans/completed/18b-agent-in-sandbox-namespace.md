---
status: completed
linear_issue: null
github_pr: null
created: 2026-05-17
updated: 2026-05-17
closed: 2026-05-17
---

# Plan 18b — Sub-agents run inside the Namespace sandbox

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
  Plan 17b (private repo creds) is _subsumed for the namespace
  backend_: this plan threads `GITHUB_TOKEN` through the
  workspace vault rather than as an env var inherited from the
  daemon. 17b's host-side credential pattern stays relevant
  only for `local-*` dispatches.
- **Comes BEFORE:** Plan 18 (real `@coder` + `@tester`) — bigger
  iteration loops are dangerous without sandbox isolation. The
  decision to deprecate `local-*` backends (informally agreed
  2026-05-17) is a follow-up plan, not part of 18b.
- **Spec sections:** none directly. ADR 0015 is the load-bearing
  context.
- **Layers touched:**
  - `packages/daemon/src/skills/sandbox/scripts/namespace-create.sh`
    (full rewrite — POST to `ComputeService/CreateInstance` with
    container + `envVars[].fromSecretId`, clone repo inside the
    agent container, upload skills + wrapper into
    `/opt/symphony/` per Decision 12)
  - `docker/symphony-agent.Dockerfile` (new — operator-built
    image carrying `claude` + `git` + `gh`; see Decision 13)
  - `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
    (new file — the in-VM wrapper script the parent agent
    invokes via `nsc ssh`; reads SKILL.md from the bundle,
    invokes `claude -p` in default text mode, emits the
    agent's final assistant reply on stdout. See Decision 12.)
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts`
    (kind-aware dispatch instructions in the orchestration
    prompt: after `@sandbox` returns, branch on `kind` for the
    remaining stages)
  - `packages/daemon/src/agent/pipeline/parent-prompt.test.ts`
    (new tests pinning the kind-aware routing language for
    stages 2-4; prompt-length ceiling bumped 6.5k → 8.5k)
  - `SECURITY.md` (document the vault flow for namespace
    backends: secrets reach the agent container via
    `envVars[].fromSecretId`, never touch disk)
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
- `namespace-create.sh` calls the Namespace API directly,
  spinning up an instance + one `agent` container from the
  operator's pre-built `symphony-agent` image (carries `claude`
  CLI + `git` + `gh`).
- The parent agent (still in the daemon) invokes `@planner`,
  `@coder`, `@ci` by shelling out to the in-VM wrapper:
  `nsc ssh <id> --container_name agent -T -- /opt/symphony/dispatch.sh <name> '<inputs-json>'`.
  Credentials (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) reach the
  agent container via Namespace vault `envVars[].fromSecretId`
  injection at container start (Decision 4) — no env file, no
  on-disk secret window.
- Sub-agent file edits stay inside the microVM. The daemon's
  host filesystem is structurally unreachable to those sub-
  agents — the EDU-18 class of "agent writes to source repo"
  bug becomes impossible by construction, not by SKILL.md
  discipline.
- `@ci`'s `git push` and `gh pr create` run from inside the
  agent container, using the vault-injected `GITHUB_TOKEN`.
  This subsumes Plan 17b's host-side credential threading for
  the namespace backend (17b stays relevant only for `local-*`
  backends).

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
- **Custom `claude` CLI flags / extensions.** We use the
  standard `claude -p` flow in default text output mode. If we
  ever need features the CLI doesn't expose, we negotiate with
  Anthropic rather than fork. (Cost: CLI compatibility is a
  foreign API; we accept that risk explicitly — see Decision 7.)
- **Streaming intermediate events from sub-agents to the daemon
  (NDJSON via `--output-format=stream-json`).** Wrapper uses
  default text mode in v1 — the daemon sees only the
  sub-agent's final assistant reply (which contains the
  structured JSON fence). Richer dashboard observability for
  remote dispatches lands when we have a real reason to invest
  in NDJSON parsing in the daemon.
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

  Credentials reach the wrapper's process via the container's
  vault-injected env vars (Decision 4) — `ANTHROPIC_API_KEY`
  and `GITHUB_TOKEN` are already in `env` when `dispatch.sh`
  starts. The wrapper invokes `claude -p` in default text mode;
  its stdout is the sub-agent's final assistant reply (which
  contains the structured JSON fence). The parent reads that
  reply via its `Bash` tool.

The routing logic lives in the **parent prompt** — i.e., the
parent agent itself decides which dispatch mode to use based on
the kind it received from `@sandbox`. The daemon's parent-prompt
builder includes both modes' instructions; the parent picks
based on observation. This avoids a special "remote-mode
parent" build path and keeps the parent in charge of orchestration.

### Decision 3 — `namespace-create.sh` calls the Namespace API directly to provision instance + agent container

The `nsc create` CLI doesn't expose `containers[].envVars[].fromSecretId`,
which is the only mechanism for getting vault secrets into a
container's env without writing them to disk. So Plan 18b
replaces the `nsc create --bare` call with a direct
`POST /namespace.cloud.compute.v1beta.ComputeService/CreateInstance`
to the Namespace API. The bearer token comes from
`nsc auth generate-dev-token --output_to <tmpfile>` per dispatch
(no keychain hunting, no long-lived tokens).

The request declares one container — `agent` — referencing the
operator's pre-built image and pulling both creds from the vault:

    POST $NAMESPACE_API_URL/namespace.cloud.compute.v1beta.ComputeService/CreateInstance
    Authorization: Bearer <generated dev token>
    Content-Type: application/json

    {
      "duration": "30m",
      "bare": true,
      "uniqueTag": "symphony-<issue-identifier>",
      "containers": [{
        "name": "agent",
        "imageRef": "nscr.io/<workspace>/symphony-agent:latest",
        "envVars": [
          {"name": "ANTHROPIC_API_KEY", "fromSecretId": "sec_..."},
          {"name": "GITHUB_TOKEN",      "fromSecretId": "sec_..."}
        ]
      }]
    }

**Critical wire-format detail caught during the smoke probe**:
the field name is `imageRef` (camelCase, with the `Ref` suffix),
NOT `image`. The API silently drops `image` and the container
starts with no declared image → containerd then reports "invalid
reference format" downstream with no clue why. Costed an hour
during the probe; pinned by this decision.

After the API returns the `instanceId`, `namespace-create.sh`:

1. Polls `nsc ssh <id> --container_name agent -T -- /bin/true`
   until reachable (image pull + container start; bounded at
   120s).
2. Clones the target repo INSIDE the agent container at
   `/workspace` via `nsc ssh --container_name agent`. The
   `GITHUB_TOKEN` is already in the container's env from vault
   injection — clone authentication works without us threading
   the token ourselves.
3. Tars the daemon's `packages/daemon/src/skills/` and uploads
   to `/opt/symphony/skills.tar.gz`, then extracts. `nsc
instance upload --container_name agent` targets the
   container's filesystem (not the host's).
4. Uploads the in-VM wrapper to `/opt/symphony/dispatch.sh` and
   `chmod +x` it.

No `claude` CLI install at provision time — it's baked into the
image (Decision 13). No env file write or upload — vault env
vars reach the container directly (Decision 4). Per-dispatch
provisioning time roughly matches the Plan 17a baseline
(60–90s end-to-end) with no on-disk-secret window.

The skills + wrapper still upload per dispatch (not baked into
the image) so SKILL.md edits ship with the daemon rather than
needing an image rebuild — same rationale as Decision 12.

Why API-direct over the `nsc create` CLI: the CLI lacks
`containers[].envVars[].fromSecretId`, which is the only
vault-native injection path. An uploaded env file is the
fallback, but it puts secrets on the VM's filesystem (even if
only for the VM lifetime). API-direct is one curl per dispatch
(small operational cost) and eliminates the on-disk-secret
window entirely.

### Decision 4 — Credentials reach the agent container via vault `envVars[].fromSecretId`

Namespace's vault → container plumbing injects env vars into a
container's process at start time when the `CreateInstance`
ContainerRequest declares `envVars[].fromSecretId` referencing a
`sec_...` object id from the workspace vault. Confirmed working
during the Plan 18b smoke (2026-05-17):

- `nscr.io/<workspace>/symphony-agent:latest` pulled clean
- `nsc ssh <id> --container_name agent -- env` shows
  `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` populated by the
  platform
- `claude --version` runs inside the container
- No filesystem writes, no argv exposure, no daemon-side log
  exposure

Operator stores both secrets in the Namespace vault UI:

| Container env var   | Source                       |
| ------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY` | Namespace vault `sec_...` ID |
| `GITHUB_TOKEN`      | Namespace vault `sec_...` ID |

The vault secret ids are operator-specific and hardcoded as
constants at the top of `namespace-create.sh`
(`NAMESPACE_SECRET_ANTHROPIC_API_KEY`,
`NAMESPACE_SECRET_GITHUB_TOKEN`). For v1 dogfood (one operator)
this is fine. A follow-up plan can lift them to
`symphony.yaml` config when there's a second operator.

Critical wire-format quirks discovered during the smoke (worth
pinning here so the next traveler doesn't re-discover them):

- The field is **`imageRef`** not `image`. `image` is silently
  dropped; container then fails with "invalid reference format".
- Field naming is **camelCase** (`envVars`, `fromSecretId`,
  `uniqueTag`), even though the proto definitions use
  snake_case internally — Connect-RPC's JSON binding flips
  them.
- The container's working dir is `/workspace` (the
  Dockerfile's `WORKDIR`). The repo gets cloned there by
  `namespace-create.sh`'s `nsc ssh --container_name agent`
  step.

Subsumes Plan 17b's `GITHUB_TOKEN` story for namespace
backends. 17b's host-side credential threading remains relevant
only for `local-*` backends (which keep the daemon-env-var
pattern).

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

### Decision 6 — Wrapper output is plain text; daemon's existing post-hoc validators apply

The in-VM wrapper invokes `claude -p` in default text output
mode. Its stdout is the sub-agent's final assistant reply —
the same shape the local-kind sub-agents produce. That reply
contains the structured JSON fence the daemon's post-hoc
validators (`findSandboxHandleInText`,
`safeParseCoderResult`, etc.) already scrape for. No new
daemon-side parser is needed.

Why not `--output-format=stream-json`:

- The parent agent reads the wrapper's stdout via its `Bash`
  tool. Text mode hands the parent the agent's natural reply
  directly; the LLM trivially extracts the JSON fence.
- Streaming intermediate events (tool calls, thinking blocks)
  back to the daemon would be a richer dashboard story for
  remote dispatches. It's a real follow-up, not a v1 need —
  documented in Out of scope.
- Avoiding NDJSON parsing in the daemon keeps the code path
  for namespace dispatches surprisingly small. No new
  `dispatchSubAgent` helper, no buffer-boundary handling, no
  parser tests. The whole remote path is one prompt-level
  instruction + one Bash invocation.

Sub-agent failure handling: the wrapper's exit code mirrors
`claude`'s. Non-zero propagates through `nsc ssh` to the
parent's Bash tool; the parent's prompt instructs it to treat
non-zero as a stage failure and skip downstream stages.

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
    # exits 0 on success (claude finished), !=0 on claude failure
    # stdout: the agent's final assistant reply (default text mode);
    #         contains the structured JSON fence the daemon's
    #         post-hoc validators scrape for.

The wrapper:

1. Reads `/opt/symphony/skills/<subagent-name>/SKILL.md` from
   disk (no transport via argv → no escaping problems, no
   length limit).
2. Renders the per-sub-agent input block from the JSON
   argument into a small prompt header.
3. Invokes `claude --print --append-system-prompt "$(cat
SKILL.md)" --allowed-tools "<per-subagent allowlist>"
--bare --dangerously-skip-permissions "<user-prompt>"`.
   Default text output mode — the agent's final reply is the
   only thing that lands on stdout.
4. Exit code mirrors `claude`'s. Non-zero propagates through
   `nsc ssh` to the daemon's Bash tool, where the parent
   prompt treats it as a stage failure and skips downstream
   stages.

Why this design wins over the alternatives:

- **vs. inlining the wrapper in the parent prompt** (Plan
  18b's pre-revision option A): no argv-length hazard, no
  shell-quoting-markdown-through-ssh problem, no need to make
  the model construct ssh invocations. The parent prompt
  becomes trivial: "run `nsc ssh "$id" --container_name agent
-T -- /opt/symphony/dispatch.sh planner '<json>'`"
  (credentials come from vault-injected container env vars,
  per Decision 4).
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

### Decision 13 — Pre-built `symphony-agent` image carries `claude` + `git` + `gh`

The container `imageRef` (Decision 3) points at an
operator-built image in the workspace's `nscr.io` registry:
`nscr.io/<workspace>/symphony-agent:latest`. The Dockerfile
lives at `docker/symphony-agent.Dockerfile` in the Symphony
repo. Contents:

- Debian Bookworm slim base (glibc — `claude` install binaries
  target glibc, so musl/alpine is riskier)
- `bash`, `curl`, `git`, `gnupg`, `jq`, `openssh-client`
- `gh` via the GitHub-recommended apt-keyring path
- `claude` CLI via `curl -fsSL https://claude.ai/install.sh |
bash` with a symlink to `/usr/local/bin/claude` so PATH
  doesn't matter
- `WORKDIR /workspace`; `CMD ["sleep", "infinity"]` so the
  container stays up for `nsc ssh --container_name agent`

Why baked-in tools rather than installed at provision time:

- Provision-time install (the original Plan 18b draft)
  required ~30s of `curl | bash` for `claude` alone per
  dispatch. The image approach moves that work to the
  operator's one-time image build.
- Provision-time install also needed to run inside the VM,
  which meant our `namespace-create.sh` had to ssh in and
  bootstrap each tool — fragile when network conditions are
  off. The image bakes them in once, tested at build time.
- `claude` version pinning becomes "rebuild the image with a
  new install" instead of "edit a grep regex in
  namespace-create.sh". Cleaner ops loop.

Why skills + wrapper are NOT baked into the image (still
uploaded per dispatch per Decision 12): they evolve with the
daemon's source. Baking them in would mean rebuilding the
image on every SKILL.md change. Tools (`claude`, `git`, `gh`)
evolve on Anthropic/GitHub's release cadence — slow enough
that an image rebuild is fine.

Operator workflow:

1. `nsc build docker -f symphony-agent.Dockerfile --name symphony-agent --push`
2. Note the registry path (auto-prefixed to
   `nscr.io/<workspace>/symphony-agent:latest`)
3. Paste into `namespace-create.sh`'s `NAMESPACE_IMAGE_REF`
   constant

Rebuild when:

- A new `claude` major version requires a refreshed install
- We add a new tool to the agent's expected toolset (e.g.
  `bun`, a language runtime, etc — Plan 18's @coder may want
  some of these)

## Steps

### Stage 18b-1 — Image build + `namespace-create.sh` rewrite

1.  Author `docker/symphony-agent.Dockerfile` per Decision 13.
    Operator-side one-time build + push:

        nsc build docker -f symphony-agent.Dockerfile \
                  --name symphony-agent --push

    The image lands at `nscr.io/<workspace>/symphony-agent:latest`.

2.  Operator stores the two secrets in the Namespace vault UI
    (ANTHROPIC*API_KEY, GITHUB_TOKEN). Capture the `sec*...` ids.
3.  Hardcode the image ref + secret ids as constants at the top
    of `namespace-create.sh` (`NAMESPACE_IMAGE_REF`,
    `NAMESPACE_SECRET_ANTHROPIC_API_KEY`,
    `NAMESPACE_SECRET_GITHUB_TOKEN`).
4.  Rewrite `namespace-create.sh` (full replace of the Plan 17a
    nsc-create-based flow): - Pre-flight: `nsc`, `curl`, `jq` on PATH; `nsc auth
check-login`. - `nsc auth generate-dev-token --output_to <tmpfile>` for
    a per-dispatch bearer token. - POST `ComputeService/CreateInstance` with the body shape
    from Decision 3 (one container `agent`, `imageRef`,
    `envVars[].fromSecretId`). - Parse `instanceId` from response. - Poll `nsc ssh <id> --container_name agent -T -- /bin/true`
    for reachability (bounded 120s). - Clone the target repo inside the container via
    `nsc ssh --container_name agent -- bash -c 'git clone…'`,
    using the vault-injected GITHUB_TOKEN inline. - Tar `packages/daemon/src/skills/` and upload via
    `nsc instance upload --container_name agent ...
/opt/symphony/skills.tar.gz`; extract in-container. - Upload the wrapper to `/opt/symphony/dispatch.sh`; chmod +x. - Emit SandboxHandle with `kind: "namespace-devbox"`,
    `worktree_path: "/workspace"`,
    `exec.template: "nsc ssh <id> --container_name agent -T -- {cmd}"`.
5.  Add the in-VM wrapper script at
    `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
    per Decision 12. Initial cut: reads SKILL.md from
    `/opt/symphony/skills/<name>/SKILL.md`, invokes `claude -p`
    with `--append-system-prompt` from that file plus the
    per-sub-agent allowed-tools list. No env-file sourcing —
    the container's process inherits ANTHROPIC_API_KEY and
    GITHUB_TOKEN directly from the platform's vault injection.
6.  Update `@sandbox`'s SKILL.md (namespace branch) to describe
    the new `/opt/symphony/` layout (skills + dispatch.sh — NO
    env file).
7.  Manual smoke: `pnpm symphony` against a `sandbox:namespace`
    dispatch; verify post-`@sandbox` that
    `nsc ssh <id> --container_name agent -- ls /opt/symphony/`
    shows `skills/` and `dispatch.sh`, and that
    `nsc ssh <id> --container_name agent -- env` shows
    `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`.

### Stage 18b-2 — Parent prompt: kind-aware dispatch instructions

The parent agent already has `Bash` in its tool allowlist
(per Plan 18a's pre-existing parent tool set), so no new
daemon-side dispatcher function is needed — the parent
shells out directly via `Bash` for the namespace path.

5.  Update `parent-prompt.ts` to include a "Dispatch routing
    for Stages 2-4" block after Stage 1. The prompt instructs
    the parent to inspect `SandboxHandle.kind` and pick the
    dispatch mode:
    - `local-*` → SDK `Agent` tool (Plan 18a path, unchanged)
    - `namespace-devbox` → Bash with the in-VM wrapper
      template
6.  In each of Stages 2-4 (`@planner`, `@coder`, `@ci`), add
    a "For `local-*` kinds" / "For `namespace-devbox` kinds"
    pair documenting both dispatch modes. The local docs stay
    identical to Plan 18a/20; the namespace docs reference the
    Bash template.
7.  The exact Bash command template, spelled out inline (model
    behavior is more reliable when the shape is concrete):

        nsc ssh <INSTANCE_ID> --container_name agent -T -- \
          /opt/symphony/dispatch.sh <NAME> '<INPUTS_JSON>'

8.  Test: `parent-prompt.test.ts` gains
    `includes kind-aware dispatch routing for namespace backends`
    and `per-stage docs cover BOTH dispatch modes for stages 2-4`,
    plus the prompt-length ceiling bumps from 6.5k → 8.5k chars.

### Stage 18b-3 — In-VM wrapper output format

The wrapper at `/opt/symphony/dispatch.sh` uses `claude -p` in
default text output mode (not `--output-format=stream-json`):

- The parent reads the wrapper's stdout via its `Bash` tool.
  Plain text mode gives the parent the agent's natural reply
  directly — no NDJSON parsing downstream.
- The reply contains the structured JSON fence the daemon's
  existing post-hoc validators (findSandboxHandleInText,
  CoderResult/CIResult/PlannerResult) scrape for. Same code
  path as the local-kind dispatches.
- Streaming intermediate events to the daemon for richer
  dashboard observability is a future win, not a v1 need.

9. Wrapper invokes `claude --print --append-system-prompt
"$(cat $SKILL_MD)" --allowed-tools "$ALLOWED_TOOLS" --bare
--dangerously-skip-permissions "$USER_PROMPT"`.
10. Wrapper's exit code mirrors claude's; non-zero propagates
    through `nsc ssh` to the parent's Bash tool, which surfaces
    the failure to the parent for downstream-skip handling.

### Stage 18b-4 — Vault-injection verification + SECURITY.md note

Credentials reach the agent container via vault
`envVars[].fromSecretId` (Decision 4); no daemon-side
credential plumbing is needed beyond the operator pasting two
`sec_...` ids into the constants in `namespace-create.sh`.
This stage is verification + documentation, not implementation.

11. Smoke probe before wiring the daemon dispatcher (cheap;
    one curl + one ssh): create a throwaway instance via the
    API with the real image + real secret ids; ssh into the
    `agent` container and run
    `env | grep -E "^(ANTHROPIC_API_KEY|GITHUB_TOKEN)="`. Both
    must show up. Destroy the instance. Done during Plan 18b
    drafting on 2026-05-17 — recorded in the decision log.
12. `SECURITY.md`: add a "Namespace vault → agent container"
    subsection covering: (a) where the secrets live (workspace
    vault), (b) how they reach the container (platform-level
    injection at container start, not via daemon), (c) what is
    NOT exposed (argv, daemon process env, daemon logs, on-VM
    filesystem). Cross-link to Decision 4.
13. Verify the daemon's logs do NOT contain the secret values
    on a real dispatch. Standard daemon log scrubber suffices;
    no special handling per Plan 18b.

### Stage 18b-5 — End-to-end smoke against a real namespace dispatch

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

### Stage 18b-6 — Docs + tech-debt updates

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
- `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` reach the agent
  container via Namespace vault `envVars[].fromSecretId`
  injection (Decision 4) — never written to the daemon
  filesystem, never on `nsc` argv, never in daemon logs, never
  in any file inside the microVM. The values are inherited
  directly into the container's process env at start time.
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

### 2026-05-17 — Vault-native pivot during Stage 18b-1 drafting

Plan 18b initially drafted around an uploaded env file
approach (write `ANTHROPIC_API_KEY` to a daemon-side tempfile,
`nsc instance upload` to `/opt/symphony/env`, wrapper sources
it). Worked, but put secrets on the VM's disk for the
dispatch lifetime. User pushed back: "i dont like the idea of
sending a env file" — wanted to use Namespace's vault primitive.

Vault probing revealed:

- `nsc vault list/add/set/delete` exist for managing secrets,
  but the CLI has NO flag for attaching them to instances.
- Per the docs, `ContainerRequest.envVars[].fromSecretId` is
  the only injection mechanism. Available only via the gRPC
  API (`/namespace.cloud.compute.v1beta.ComputeService/CreateInstance`),
  not surfaced anywhere on the CLI.
- The dispatch instance and the devbox interactive instance
  (both via `nsc create`) both have `/run/secrets/by_id/`
  mount points, but those stay empty unless `envVars` were
  declared at create time. The VM's own `nsc` token also
  lacks vault read permissions, so there's no runtime-fetch
  fallback.

Decision: use API-direct with vault attachment. Operator-side
artifacts:

1. `docker/symphony-agent.Dockerfile` — Debian slim + claude +
   git + gh. Built and pushed via `nsc build docker -f symphony-agent.Dockerfile
--name symphony-agent --push`.
2. Two secrets created in the workspace vault UI:
   `ANTHROPIC_API_KEY` (sec_u93fk4ekq8) and `GITHUB_TOKEN`
   (sec_5bukm4tp80) — IDs hardcoded in `namespace-create.sh`
   for v1.

### 2026-05-17 — Wire-format gotchas caught during the smoke

Two field-naming traps that cost real probe iterations:

- The container's image field is **`imageRef`**, not `image`.
  The API silently drops `image` (server-side returns 200,
  container declaration accepted), then containerd later
  reports "invalid reference format" because the container
  has no declared image. Caught after grepping the `nsc`
  binary for proto JSON tags. Pinned in Decision 4.
- The platform image isn't on docker.io; it must be pre-built
  in the operator's workspace registry at
  `nscr.io/<workspace>/...`. Trying `alpine:latest` or
  `docker.io/library/alpine:latest` both failed with "invalid
  reference format" — the platform's image-pull layer is
  scoped to the workspace's nscr.io plus a curated allowlist.

Successful smoke result (instance `fgb1r0h5tjmum`):

    ANTHROPIC_API_KEY=***SET***  (from sec_u93fk4ekq8)
    GITHUB_TOKEN=***SET***       (from sec_5bukm4tp80)
    claude --version → 2.1.143 (Claude Code)

Instance destroyed after verification. End-to-end vault-native
path confirmed working; the namespace-create.sh rewrite + the
in-VM wrapper update follow the smoke shape verbatim.

### 2026-05-17 — Plan close-out

Shipped via PR #30 (implementation) + PR #31 (post-merge sweep
to scrub bug-archaeology comments). End-to-end smoke EDU-25 ran
the full `@sandbox → @planner → @coder → @ci` pipeline inside a
Namespace microVM with vault-injected credentials; PR opened in
the target repo, instance destroyed cleanly, ~2m08s
end-to-end.

What landed:

- `docker/symphony-agent.Dockerfile` — Debian slim + claude CLI
  - git + gh + non-root `symphony` user (uid 1000, required
    because `claude --dangerously-skip-permissions` refuses uid 0).
- `namespace-create.sh` rewrite — API-direct CreateInstance
  with vault `envVars[].fromSecretId` injection. No secret
  ever touches the daemon's filesystem or argv.
- `clone-and-checkout.sh` + `dispatch.sh` — in-VM helpers
  uploaded per-dispatch alongside the daemon's current skills
  tree. SKILL.md updates ship with the daemon, not with the
  image.
- Parent-prompt kind-aware routing for `namespace-devbox`
  (Bash dispatch via `nsc ssh --container_name agent -T -- bash
/opt/symphony/dispatch.sh <name> '<inputs>'`).
- Hardcoded constants for v1 (image ref, secret IDs); operator-
  side prerequisites documented in `namespace-create.sh`'s
  header. Migrate to `symphony.yaml` when there's a second
  operator.

What was deferred (tracked elsewhere or accepted as v1 scope):

- `nsc ssh` exit-code propagation — tech-debt-tracker entry
  exists from Plan 17a; still binary pass/fail in v1.
- Stream-json output mode for the in-VM `claude -p` invocation —
  text mode keeps the parent's Bash-tool path simple; revisit
  if dashboard observability becomes a need.
