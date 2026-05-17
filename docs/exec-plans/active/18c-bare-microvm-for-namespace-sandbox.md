# Plan 18c — Bare microVM for `@sandbox` (drop the container layer)

- **Status:** Not started
- **Implements:** A direct simplification of Plan 18b. Same goal
  (sub-agents run in the sandbox they operate on, per ADR 0015) and
  same backend (Namespace), but the per-dispatch environment becomes
  a **bare microVM** instead of a container running inside one.
  Secrets stop riding through Namespace's vault → `envVars[].fromSecretId`
  channel and start riding through `nsc ssh -T --` stdin instead.
- **Comes AFTER:** Plan 18b (the container-based namespace path
  this plan supersedes). Plan 20 (`@planner` + `@curator`) — those
  stages still run inside the sandbox; only the sandbox flavor
  changes.
- **Comes BEFORE:** Plan 21 (the agentic loop with `@env-up` /
  `@verify` / `@code-review`). 21 needs docker inside the sandbox,
  which is structurally impossible in the 18b container (probe
  2026-05-17: `CapEff=0`, no `/var/run/docker.sock`, no
  `containerd`). 18c unblocks 21.
- **Spec sections:** none directly. ADR 0015 stays load-bearing.
- **Layers touched:**
  - `packages/daemon/src/skills/sandbox/scripts/namespace-create.sh`
    (rewrite — bare microVM via API, no `containers` field, install
    claude in bootstrap, create non-root `symphony` user)
  - `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
    (read secrets from stdin; drop the vault-presence check)
  - `packages/daemon/src/skills/sandbox/scripts/in-vm/clone-and-checkout.sh`
    (drop `--container_name` assumptions; same logic otherwise)
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts`
    (namespace-dispatch template gains a stdin heredoc with the
    daemon's env vars; drop `--container_name agent` everywhere)
  - `docker/symphony-agent.Dockerfile` (**deleted**)
  - `SECURITY.md` (Plan 18b's vault subsection replaced with the
    stdin-based delivery model)
  - `packages/daemon/src/skills/sandbox/SKILL.md` (operator
    prerequisites change — no image to build, no vault secrets to
    register)
- **ADRs referenced:** ADR 0015 (sub-agents-in-their-sandbox —
  unchanged), ADR 0014 (sub-agent pipeline — parent-in-daemon split
  preserved), ADR 0006 (zod at every boundary — sub-agent results
  still validate).

## Goal

After this plan ships, a `sandbox:namespace`-labelled dispatch
provisions a **bare Namespace microVM** (Wolfi 6.16, full root, full
capabilities, native docker daemon already running), uploads
Symphony's per-dispatch bundle (skills + scripts), pipes credentials
through `nsc ssh -T`'s stdin, and runs sub-agents via
`claude -p` inside the VM. Every operational property Plan 18b's
container layer cost us comes back:

- Native `docker` daemon (no nested-virt issue; needed by Plan 21
  for `env_up`).
- `root` by default; no `--dangerously-skip-permissions` refusal-as-
  uid-0 dance (we still drop to a non-root `symphony` user before
  invoking `claude`, but for our reasons, not the platform's).
- Full capabilities (`CapEff: 0x000001ffffffffff`); seccomp off.
- `/dev/fuse`, `/dev/kvm`, `/dev/loop*` all present — anything the
  target repo's `env_up` script wants to do is on the table.
- `apk add` works for one-off package installs.

And every operator overhead Plan 18b added gets unwound:

- No `docker/symphony-agent.Dockerfile` to maintain.
- No `nsc build docker … --push` step in the one-time setup.
- No vault secret pre-registration; no `sec_…` IDs hardcoded in
  the script.
- No `--container_name agent` plumbing in every `nsc ssh` and
  `nsc instance upload`.

## Why

Three motivations, in priority order:

1. **Unblocks the agentic loop.** Plan 21 (the next-up plan)
   introduces an iterating sensor loop: `@env-up` → `@verify` →
   `@tests` → `@code-review` → `@curator`, with `@coder` bouncing
   off failures. Most of those sensors expect the target repo's
   stack to be running — `docker compose up`, healthchecks, real
   network ports. Today's container path can't deliver that
   (probe 2026-05-17, see Decision log). Without 18c, 21 either
   degrades to "no env-up support" or routes namespace dispatches
   back to `local-docker`, which defeats Plan 18b's host-fs-
   isolation property.

2. **Secret hygiene improves, not regresses.** Plan 18b's vault
   injection put secrets in the container's env at start time —
   never on disk, never on argv, _and_ the vault UI's audit log
   recorded which dispatch had access to which secret. 18c's
   stdin-pipe delivery keeps the first two properties (never on
   disk; never on argv) AND eliminates the vault UI as a
   coordination point:

   | Property                           | 18b (vault)   | 18c (stdin)   |
   | ---------------------------------- | ------------- | ------------- |
   | Secrets on daemon disk             | no            | no            |
   | Secrets on microVM disk            | no            | no            |
   | Secrets on argv                    | no            | no            |
   | Secrets in vault UI audit          | **yes**       | no            |
   | Operator pre-registers each secret | yes (UI step) | no            |
   | Secret rotation surface            | vault         | daemon `.env` |

   For a single-operator v1, the audit log isn't load-bearing.
   The operator's daemon already has `ANTHROPIC_API_KEY` and
   `GITHUB_TOKEN` in its own env (`.env` file or process env).
   18c forwards those over stdin per-dispatch — same scope, fewer
   ceremony.

3. **Smaller and more boring.** The 18b architecture has three
   moving parts that 18c collapses: (a) a custom image we build
   and push, (b) vault secrets we register via the UI, (c) a
   container declaration with `envVars[].fromSecretId`. 18c
   replaces all three with: spin up a bare microVM and pipe
   inputs in. New operators onboarding hit zero steps that aren't
   "have an Anthropic key in `.env`" — same as the local
   backends.

## Out of scope

- **The agentic loop itself (Plan 21).** 18c is purely the sandbox
  flavor change. The pipeline shape and existing sub-agent
  behavior do not change.
- **`local-*` backend deprecation.** Still informal. `local-shell`
  and `local-docker` keep working unchanged.
- **Custom microVM image (claude + repo dependencies pre-baked).**
  Cold-start time on the new path will include `curl claude.ai/install.sh | bash`
  per first dispatch (~10–15s observed in the probe environment).
  If that becomes a measurable bottleneck, follow up with a baked
  Wolfi-based image. Until then, the install step lives in the
  VM-bootstrap branch of `namespace-create.sh` and is idempotent
  on re-dispatch (same `uniqueTag` reuses the VM).
- **Migrating other backends to stdin-pipe secrets.** `local-shell`
  inherits the daemon's env directly; `local-docker` mounts an env
  file via compose. They stay as they are.

## Stages

### Stage 18c-1 — Probe + commit to the path

Already done as part of this plan's authoring (2026-05-17). See
the Decision log entry "Probe results". No code work.

### Stage 18c-2 — Rewrite `namespace-create.sh`

1. Drop the `containers` array from the `CreateInstance` POST
   body. `bare: true` stays. The response no longer has a
   `containers[]`; the instance is reachable via `nsc ssh <id>`
   directly (no `--container_name`).

2. Remove the four hardcoded operator constants:
   - `NAMESPACE_IMAGE_REF`
   - `NAMESPACE_SECRET_ANTHROPIC_API_KEY`
   - `NAMESPACE_SECRET_GITHUB_TOKEN`
   - The `envVars[].fromSecretId` declarations they fed
     The remaining operator-specific constant is `NAMESPACE_API_URL`
     (regional endpoint) — keep, document, plan to externalize when
     we have two operators.

3. After the VM is reachable, run a **bootstrap script** in the
   VM. Idempotent: skip steps whose artifacts already exist.
   Steps:
   - Create a non-root `symphony` user (uid 1000) with bash
     shell and home dir. `claude --dangerously-skip-permissions`
     still refuses uid 0; this is the only reason we keep the
     two-user dance.
   - `chown symphony:symphony /workspace /opt/symphony`
   - Install claude as the `symphony` user:
     `su symphony -c 'curl -fsSL https://claude.ai/install.sh | bash'`
   - Verify: `su symphony -c 'claude --version'` exits 0.

   Implementation note: the bootstrap is its own script
   (`scripts/in-vm/bootstrap.sh`) uploaded once per dispatch and
   invoked via `nsc ssh <id> -T -- bash /root/bootstrap.sh`.
   Same upload-and-invoke-by-path pattern Plan 18b established
   (the bash-c-with-multi-line-script-doesn't-work-via-nsc-ssh
   constraint still holds — that's about `nsc ssh`, not about
   containers).

4. The skills tarball upload + the dispatch.sh upload happen
   exactly as today, just without `--container_name agent`.
   `/opt/symphony/skills/` and `/opt/symphony/dispatch.sh` land
   in the VM's filesystem. Bash invocation by absolute path
   (no chmod-by-non-root constraint anymore, since we're root
   during bootstrap and only drop privileges at claude
   invocation time).

5. Emit the same `SandboxHandle` JSON shape, with one field
   change: `exec.template` becomes
   `nsc ssh $INSTANCE_ID -T -- {cmd}` (no `--container_name agent`).
   The `kind` stays `namespace-devbox`. Downstream consumers see
   no schema change.

### Stage 18c-3 — Update `dispatch.sh` for stdin secrets

1. Drop the `[ -n "${ANTHROPIC_API_KEY:-}" ] || die "…vault attachment…"`
   check (vault is gone).

2. Read the first N lines of stdin as `KEY=value` pairs and
   export them. Stop at EOF. The contract is: caller pipes
   one secret per line, no quoting needed (we're inside a
   single-tenant microVM, the values pass straight from
   `nsc ssh` stdin into our shell variable space):

   ```bash
   while IFS= read -r line; do
     [ -z "$line" ] && continue
     case "$line" in
       *=*) export "$line" ;;
       *) die "stdin line not in KEY=value form: $line" ;;
     esac
   done < /dev/stdin
   ```

3. The rest of `dispatch.sh` is unchanged — invoke
   `su symphony -c "claude --print …"` with the same flags. The
   `su` is new (we're now root at dispatch time; claude still
   needs non-root). The `--allowed-tools` allowlist + the
   per-subagent SKILL.md loading are identical.

4. The case-statement validation (`planner|coder|curator|ci`)
   stays.

### Stage 18c-4 — Update the parent prompt's namespace template

In `parent-prompt.ts`, the namespace-dispatch Bash template
gains a heredoc with the env vars the dispatcher needs. Today:

    nsc ssh <INSTANCE_ID> --container_name agent -T -- \
      bash /opt/symphony/dispatch.sh <NAME> '<INPUTS_JSON>'

Becomes:

    nsc ssh <INSTANCE_ID> -T -- \
      bash /opt/symphony/dispatch.sh <NAME> '<INPUTS_JSON>' <<EOF
    ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
    GITHUB_TOKEN=$GITHUB_TOKEN
    EOF

Three changes:

- Drop `--container_name agent`.
- Append a heredoc with the daemon's `$ANTHROPIC_API_KEY` and
  `$GITHUB_TOKEN` interpolated (the parent agent reads its own
  daemon-process env to fill these in — same way the daemon's
  Bash tool has always seen the operator's env vars).
- Note in the prompt that secret values must NOT appear in the
  parent's narrative output or in any logged message; they are
  ONLY embedded in the heredoc, which is passed to `Bash` tool
  invocation and never echoed back.

### Stage 18c-5 — Delete the container artifacts

1. Delete `docker/symphony-agent.Dockerfile`.
2. Delete the `docker/` directory if it ends up empty.
3. Remove the "build + push the agent image" operator step from
   `packages/daemon/src/skills/sandbox/SKILL.md`'s prerequisites
   section.
4. Remove the "register vault secrets" operator step from the
   same.
5. Search the repo for `symphony-agent` and `--container_name`
   references; clean them up.

### Stage 18c-6 — Update SECURITY.md

Replace the "Plan 18b — Namespace vault for `sandbox:namespace`
dispatches" subsection with an updated version describing the
stdin-pipe delivery model. Key points:

- Secrets read from the daemon's process env (`ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`).
- Embedded in the parent agent's `Bash` tool invocation as a
  heredoc to `nsc ssh -T`.
- Delivered over the SSH-equivalent transport to the microVM's
  stdin.
- Read by `dispatch.sh` and `export`'d into the script's
  environment, where `claude` (and any `git`/`gh` invocations
  inside the sub-agent) inherits them.
- Never written to disk in the daemon. Never written to disk in
  the microVM. Never on argv.
- microVM is single-tenant per dispatch and destroyed after.

### Stage 18c-7 — End-to-end smoke (EDU-26)

1. Build the daemon, point it at a fresh Linear issue labeled
   `namespace`, description "echo a one-line update to
   `README.md`" — same shape as the EDU-25 smoke that validated
   18b.
2. Watch the dispatch produce a PR in the target repo.
3. Confirm: no `Dockerfile` referenced anywhere; no vault
   secrets touched; `docker info` runs successfully inside the
   microVM during the dispatch (we can add this as a curator
   side-check or just exec it manually post-dispatch); the same
   `~2m` end-to-end time we hit on EDU-25 (plus ~10–15s for the
   claude install on first dispatch).
4. Destroy the instance, confirm clean teardown.

### Stage 18c-8 — Plan close-out

Move this plan to `completed/`. Append decision-log entries for:

- Final smoke result (instance id, timing, PR URL).
- Cold-start measurement (per-dispatch install time). If > 30s,
  open a tech-debt entry for "bake a custom Wolfi+claude
  microVM image" with the trigger being "operator reports
  dispatch latency is meaningfully worse than 18b".

## Definition of done

- A `sandbox:namespace`-labelled Linear issue produces a PR via
  the full `@sandbox → @planner → @coder → @curator → @ci`
  pipeline, end-to-end, on the bare-microVM path.
- `docker/symphony-agent.Dockerfile` does not exist.
- No `sec_…` IDs and no `NAMESPACE_IMAGE_REF` constants live in
  the source tree.
- `nsc ssh … -T --` invocations across the codebase do NOT pass
  `--container_name`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check &&
pnpm build` green.
- `SECURITY.md` and the `@sandbox` SKILL.md operator prerequisites
  match reality.

## Open questions

- **Custom microVM image vs per-dispatch install.** The cold-
  start cost of `curl claude.ai/install.sh | bash` is bounded
  but non-zero. Defer the bake decision until we have a real
  measurement from EDU-26. Likely answer: per-dispatch install
  is fine for v1 because `uniqueTag` reuse keeps it to a
  one-time cost per issue, and Plan 21's loop already amortizes
  setup over many sensor invocations.

- **Wolfi vs another base.** Namespace's bare-microVM image
  appears fixed at Wolfi 6.16 — we didn't see a way to choose.
  If a future need wants Debian (e.g., a target repo's `env_up`
  has `apt-get install` baked in), we'd need to investigate
  whether Namespace exposes alternative base images, or whether
  the target repo's env-up needs to translate to `apk`. Out of
  scope here.

- **Stdin-line escaping.** Today's secret values (`ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`) are URL-safe base64-ish strings — no newlines,
  no `=` ambiguity. If a future secret has unusual characters,
  the `KEY=value` line parser would need escaping discipline.
  Punt until we hit it.

- **What happens if the daemon's `GITHUB_TOKEN` is unset.** Today
  Plan 18b errors loudly inside the wrapper. After 18c, the
  heredoc just sends an empty value. `dispatch.sh`'s parsing
  treats `GITHUB_TOKEN=` (empty) as set-to-empty, and downstream
  `git`/`gh` invocations would fail later with a less actionable
  error. Decide: do we want `dispatch.sh` to fail-fast on empty
  required-secret values, or surface the downstream error?
  Lean: fail-fast with a clear message naming the missing key.

- **What if Namespace stops pre-installing docker.** Documented
  behavior today: `dockerd` is running, `/var/run/docker.sock`
  is mounted. If Namespace changes that in a future platform
  update, Plan 21's `@env-up` would silently degrade. Add a
  one-line health check to `namespace-create.sh`'s bootstrap:
  `docker info >/dev/null 2>&1 || die "docker daemon not
available on this microVM"`. Cheap insurance.

## Decision log

### 2026-05-17 — Probe results (pre-execution)

A 5-minute probe (instance `icl1mthslod5k`, destroyed) confirmed
that a bare Namespace microVM (POST `CreateInstance` with
`bare: true` and no `containers` field) exposes:

- **Identity:** `root` by default (uid=0).
- **Distro:** Wolfi 20230201, kernel 6.16.9. Package manager
  `apk`.
- **Capabilities:** `CapEff: 0x000001ffffffffff` (full).
  `Seccomp: 0`. Compare to the container probe earlier the same
  day on the same image (`vgn3on8n7lb14`, also destroyed):
  `CapEff: 0x0`, `Seccomp: 2`.
- **Device nodes:** `/dev/fuse`, `/dev/kvm`, `/dev/loop[0-7]`,
  `/dev/nbd[0-9]` present. Container had none of these.
- **Docker:** `/vendor/docker/docker` on PATH;
  `/var/run/docker.sock` mounted (srw-rw---- root:root);
  `Server Version: 29.3.0-namespace` daemon running.
  `buildx` + `compose` plugins included. `docker run hello-world`
  succeeded.
- **Pre-installed tooling:** `git`, `gh`, `curl`, `bash`, `jq`,
  `tar`, `gzip` all on PATH.
- **Missing tooling:** `claude` (need to install),
  `openssh-client` (apk add if ever needed; not currently),
  `node`/`npm` (claude installer bundles its own).
- **`apk add` works** (installed `gh` cleanly in the probe to
  verify; ~5s).
- **`nsc instance upload`** to a bare microVM works without
  `--container_name` (used twice in the probe).
- **`nsc ssh -T -- <cmd>` forwards stdin.** Verified with
  `echo "K=V" | nsc ssh <id> -T -- bash /root/probe.sh` and
  the script's `read -r` saw `K=V` correctly.

These five properties together close every operational concern
Plan 18b's container path carried. The plan commits to this
architecture; subsequent stages execute the migration.

### 2026-05-17 — Why drop the vault entirely (not just augment)

We considered keeping vault for the audit trail and only adding
docker access via a different mechanism (privileged container,
sidecar, etc.). Reasons we rejected the hybrid:

- The vault's value (audit log, rotation) doesn't pay rent in a
  single-operator v1.
- Every hybrid we sketched preserved the operator-overhead
  (image build + push, secret pre-registration) that this plan
  exists to remove.
- Stdin-pipe delivery is strictly better on the two hygiene
  properties that matter (no disk, no argv). The third
  property (audit log) is the only loss, and it's recoverable
  later by routing all secret reads through a daemon-side
  audit log if we ever care.
