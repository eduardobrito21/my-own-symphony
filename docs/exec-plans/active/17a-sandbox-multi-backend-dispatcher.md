# Plan 17a — Multi-backend `@sandbox` dispatcher (Namespace + local)

- **Status:** In progress
- **Implements:** ADR 0014's "the @infra agent's skill picks per
  dispatch" framing for the platform choice between local docker,
  Namespace microVM, and (placeholder) AWS.
- **Comes AFTER:** Plan 16 (sub-agent pipeline chassis + bundled
  `@sandbox` skill — single-backend, local docker only).
- **Comes BEFORE:** Plan 17 (`@app` skill). Plan 17a slots ahead so
  the load-bearing `SandboxHandle` contract gets exercised on a
  second platform before downstream stages start consuming it for
  real (Plan 18 `@coder`).
- **Spec sections:** none directly (extends ADR 0014's architecture).
- **Layers touched:** `packages/daemon/src/agent/runner.ts` (extend
  `AgentRunInput`), `packages/daemon/src/agent/pipeline/prompt.ts`
  (surface labels), `packages/daemon/src/skills/sandbox/SKILL.md`
  (rewrite as dispatcher), `packages/daemon/src/agent/skills/schemas.ts`
  (document `kind` discriminator values), `packages/daemon/src/orchestrator/orchestrator.ts`
  (thread `labels` through to runner).
- **ADRs referenced:** 0006 (zod at every boundary), 0014 (sub-agent
  pipeline architecture), 0012 (Namespace as the reference second
  backend — superseded as an architecture, but the platform
  characteristics carry forward).

## Goal

Promote the bundled `@sandbox` skill from a single-backend script
(local docker compose only) to a **dispatcher**: one skill, one
sub-agent, three branches. Each dispatch picks `local`, `namespace`,
or `aws` based on signals on the Linear issue. The chosen branch
provisions the right kind of environment and returns a
`SandboxHandle` with a `kind` discriminator that downstream stages
key off.

What this plan delivers:

1. **Label-driven backend selection.** A `sandbox:<backend>` label
   on the Linear issue (e.g. `sandbox:namespace`) selects the
   backend. With no label, fall back to operator default (`local`).
2. **Labels surfaced to the parent agent.** Extend `AgentRunInput`
   to include `labels`, thread them from the orchestrator, and
   render them into the orchestration prompt so the dispatcher
   skill can read them.
3. **Dispatcher `SKILL.md`.** Rewrite `packages/daemon/src/skills/sandbox/SKILL.md`
   with a "Step 0: pick the backend" section, then three labelled
   branches (`local`, `namespace`, `aws`).
4. **Namespace branch (real).** Implements `nsc create`, `nsc ssh`,
   `nsc destroy` against the [Namespace](https://namespace.so/docs)
   CLI. Returns a `SandboxHandle` with `kind: "namespace-devbox"`
   and an `nsc ssh {id} {cmd}`-shaped `exec.template`.
5. **AWS branch (placeholder).** Section exists in the skill so the
   structure is documented, but the body says "not implemented in
   v1; fail loud with an actionable message." Lets a future plan
   slot real AWS in without restructuring the skill.
6. **Fail-loud cred checks.** Each branch verifies its prerequisites
   (`docker` on PATH, `nsc` on PATH + authenticated, etc.) before
   doing any work. Missing prerequisite → skill stops with a
   pointed error.
7. **Tests for selection logic.** Pure unit tests verify the
   prompt-rendering surfaces labels correctly and that the agent's
   eventual `SandboxHandle` (in our test, fed in directly) is
   well-formed for each backend kind.

## Out of scope

- **Actually running a Namespace dispatch end-to-end** in CI or as
  part of `pnpm test`. The Namespace SaaS requires a paid account
  and outbound network access from the test environment. We verify
  the skill structure and selection logic by inspection + fakes;
  a real smoke run is a manual operator-side gesture, captured in
  the decision log as it happens.
- **AWS branch implementation.** Placeholder only.
- **`workflow.md` as a signal source.** The repo's `workflow.md`
  lives _inside_ the repo, which @sandbox clones — chicken-and-egg.
  A future iteration can do a shallow remote read of
  `.symphony/workflow.md` before deciding; for v1 only labels and
  the operator default drive the choice.
- **Per-project credentials.** Operator-wide env vars only (`NSC_*`,
  future `AWS_*`). ADR 0014 explicitly defers per-project isolation.
- **Idempotent reuse of a Namespace instance across dispatches.**
  The skill creates a new instance per dispatch. Reuse via the
  `--tag` flag is a future optimization.
- **Renaming `@sandbox` → `@infra`.** Discussed; kept as `@sandbox`.
  The skill name describes _what it produces_ (a sandbox), not
  _what it is_ (an infra agent). Less ambiguous.
- **A `finalize_sandbox` typed SDK tool.** The existing post-hoc
  text scan in `pipeline/validation.ts` still applies. Tightening
  that boundary is a separate plan.

## Design decisions

### Decision 1 — Signal source: Linear labels, with operator default fallback

Selection precedence (highest first):

1. **Linear issue label** matching `sandbox:<backend>`, where
   `<backend>` ∈ `{local, namespace, aws}`. Lowercased (the
   `Issue.labels` field is already lowercased per SPEC §11.3).
2. **Operator default** — defaults to `local` if no label.

Future precedence layers (not v1): `.symphony/workflow.md` repo
default, operator env var override.

If an unknown `sandbox:*` label is present (e.g. `sandbox:gcp`),
the skill fails loudly with the list of known backends — better
than silently falling through to the default.

If multiple `sandbox:*` labels are present, the skill fails loudly.
Ambiguity is a user error, not something to silently resolve.

### Decision 2 — `SandboxHandle.kind` is open-ended `z.string()`, not an enum

`SandboxHandleSchema.kind` stays `z.string().min(1)` rather than
becoming a zod enum. Reasons:

- The contract is "discriminator for downstream tooling," and
  downstream code (e.g. future `@coder`) should pattern-match
  defensively (`if (kind === 'namespace-devbox') ...`), not assume
  a closed set.
- Future per-repo overrides may invent their own `kind` strings.
- Adding new backends shouldn't require a schema change.

The skill markdown documents the canonical values (`local-docker`,
`local-shell`, `namespace-devbox`) and operators are encouraged to
follow the convention, but it's not enforced at the schema level.

### Decision 3 — Namespace branch uses the `nsc` CLI, not the TypeScript SDK

Two viable surfaces for hitting Namespace: shell `nsc` CLI or
`@namespacelabs/sdk` Connect-RPC. The skill picks the CLI for v1:

- Skills are markdown the agent executes via Bash. CLI fits
  naturally.
- One fewer runtime dependency in the daemon process.
- The skill can be reviewed by a security team as a shell script
  rather than a TypeScript blob.
- Future per-repo override could use the SDK if the operator
  prefers; the contract is the resulting `SandboxHandle`.

Operator runs `nsc login` (interactive, one-time) on the daemon
host. The skill verifies `nsc whoami` exits 0 before proceeding;
if not, it fails with: _"nsc is not authenticated. Run `nsc login`
on the daemon host."_

### Decision 4 — `exec.template` per backend

| Backend   | `kind`             | `exec.template`                                 |
| --------- | ------------------ | ----------------------------------------------- |
| local     | `local-docker`     | `docker compose -p {id} exec app sh -c '{cmd}'` |
| local     | `local-shell`      | `cd {worktree_path} && {cmd}` (no compose file) |
| namespace | `namespace-devbox` | `nsc ssh {id} {cmd}`                            |
| aws       | `aws-ec2`          | (placeholder; not implemented v1)               |

The `{id}` placeholder is the same `SandboxHandle.id` field. The
existing schema doesn't require this — it's a convention the skill
documents. `{cmd}` is substituted by downstream stages.

### Decision 5 — Labels are surfaced in the prompt as plain text

`AgentRunInput` gains `labels: readonly string[]`. The
`PipelineAgentRunner.getIssueContext` fallback uses this directly.
The `buildHeader` in `prompt.ts` adds a `Labels: ...` line. The
dispatcher SKILL.md instructs the agent to scan that line for
`sandbox:*` entries.

No special selector field, no MCP tool — labels are plain
information the agent reads. Keeps the surface small.

## Steps

### Stage 17a-1 — Thread labels through to the runner

1. **Extend `AgentRunInput`** (`packages/daemon/src/agent/runner.ts`):
   - Add `readonly labels: readonly string[]` (additive, all
     existing MockAgent code paths continue to work — they just
     ignore it).
   - Update the docstring to note the field is the Linear issue's
     labels, lowercased.

2. **Wire labels through the orchestrator**
   (`packages/daemon/src/orchestrator/orchestrator.ts:385`):
   - Pass `labels: issue.labels` to `this.agent.run({...})`.

3. **Surface labels in the prompt**
   (`packages/daemon/src/agent/pipeline/prompt.ts`):
   - `buildHeader` adds `- Labels: ${issue.labels.join(', ') || '(none)'}`
   - Inject `${issue.labels.join(', ')}` into Stage 1's input block
     (`buildStage1SandboxSection`) so the agent has them in
     immediate reading range.

4. **Use labels in the runner's `getIssueContext` fallback**:
   - When `fetchIssue` is not provided, build the placeholder
     `Issue` with `labels: input.labels` instead of `labels: []`.

### Stage 17a-2 — Rewrite the bundled `@sandbox` SKILL.md

5. **New skill structure** at
   `packages/daemon/src/skills/sandbox/SKILL.md`:

   ```
   # @sandbox skill

   ## Step 0 — Pick a backend (REQUIRED FIRST STEP)
   Read the issue labels. Find any `sandbox:*` label.
   - 0 matches → use `local` (operator default).
   - 1 match → use that backend.
   - 2+ matches OR unknown backend → fail with actionable error.

   ## Branch: local
   (Existing logic — clone, docker compose up, return local-docker
   or local-shell handle.)

   ## Branch: namespace
   (New — verify nsc, create instance, return namespace-devbox handle.)

   ## Branch: aws
   (Placeholder — fail with "not implemented in v1.")

   ## Output
   (Same SandboxHandle JSON envelope as today, just with backend-
   specific id/kind/exec/teardown.)
   ```

6. **Namespace branch shell snippets**:
   - `nsc whoami` precheck → fail-loud if unauthenticated.
   - `nsc create --machine_type 4x16 --duration 30m --label symphony-id=<identifier> --output_to /tmp/sandbox-<identifier>.id`
   - Capture `INSTANCE_ID=$(cat /tmp/sandbox-<identifier>.id)`
   - `nsc ssh "$INSTANCE_ID" git clone <repo_url> /workspace && cd /workspace && ...` for repo setup.
   - Return handle with `exec.template: "nsc ssh <INSTANCE_ID> {cmd}"` and `teardown.script: "nsc destroy <INSTANCE_ID>"`.

7. **Worktree-path semantics for non-local backends**:
   - For `namespace-devbox`, the `worktree_path` is the path
     _inside the VM_ (e.g. `/workspace`). Downstream stages route
     file ops through `exec.template`.
   - The skill documents this clearly so `@coder` (Plan 18) knows
     to use Bash-through-exec rather than direct `Read`/`Edit`
     when `kind === 'namespace-devbox'`.

### Stage 17a-3 — Tests

8. **Prompt rendering test**
   (`packages/daemon/src/agent/pipeline/prompt.test.ts`, new):
   - Given an `Issue` with `labels: ['sandbox:namespace', 'priority:high']`,
     `buildPipelinePrompt` includes a `Labels:` line containing
     `sandbox:namespace, priority:high`.
   - Given an `Issue` with no labels, the prompt says
     `Labels: (none)`.

9. **Selection-logic verification (via fake agent output)**
   (`packages/daemon/src/agent/pipeline/validation.test.ts`,
   extend):
   - Already tests SandboxHandle extraction. Add cases for:
     - A valid `namespace-devbox` handle (with `nsc ssh {id} {cmd}`
       template) passes validation.
     - A handle with an unknown `kind` still parses (open-ended
       per Decision 2).

10. **Runner test** (`packages/daemon/src/agent/pipeline/runner.test.ts`,
    new if not present, otherwise extend):
    - Given `AgentRunInput.labels = ['sandbox:namespace']`, the
      pipeline prompt the runner builds contains the label.

### Stage 17a-4 — Composition root and docs

11. **Orchestrator wiring** (`orchestrator.ts`): one-line change to
    pass `labels: issue.labels`.

12. **Update `examples/repo-workflow/README.md`** with a one-line
    note: _"Labels like `sandbox:namespace` on a Linear issue
    route the dispatch to a Namespace microVM."_

13. **No ARCHITECTURE.md changes** — this plan keeps the same
    layers; the new behavior lives entirely in skill markdown.

## Definition of done

- `AgentRunInput.labels` exists and is threaded through the
  orchestrator → runner → prompt.
- `packages/daemon/src/skills/sandbox/SKILL.md` is a dispatcher
  with three labelled branches.
- `nsc whoami` failure produces an actionable error message that
  names the fix (run `nsc login`).
- Unknown / ambiguous `sandbox:*` labels fail with a pointed error
  listing the known backends.
- Unit tests cover: label rendering in the prompt, valid
  `namespace-devbox` handle validation, and ambiguous/missing
  label fallback to `local`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check`
  all green.
- The local-docker path still works exactly as before for an issue
  with no `sandbox:*` label (regression target).

## Open questions

- **Does `nsc create` need explicit image selection for our use
  case, or is the default Kubernetes-with-k3s base sufficient?**
  Tentative: use `--bare` to get a minimal Ubuntu environment;
  Docker is pre-installed per ADR 0012's verification. Confirm
  during implementation.
- **Does `nsc ssh <id> <cmd>` propagate the command's exit code
  back to the local shell?** Tentative: yes (standard SSH
  semantics). If not, the downstream `@coder` skill will need to
  parse a sentinel line. Confirm via a manual run before Plan 18.
- **What's the right `--duration` for a dispatch?** Today's
  dispatches finish well under 10 minutes. Using `30m` for headroom.
  Operator-tunable later.

## Decision log

### 2026-05-17 — Plan opened

Plan written after a design discussion that confirmed:

- One `@sandbox` skill, three branches (not three skills).
- Selection by Linear label, operator default `local`.
- Skill name stays `@sandbox` (not `@infra`).
- Namespace branch first because the SDK plumbing from the
  superseded Plan 14 branch is the easiest non-local backend to
  recover, and proves the `SandboxHandle` contract is platform-
  portable before Plan 18's real `@coder` starts consuming it.

### 2026-05-17 — Stages 17a-1 through 17a-3 shipped

**Stage 17a-1 — Labels threaded:**

- `AgentRunInput.labels: readonly string[]` added in
  `packages/daemon/src/agent/runner.ts` (additive — MockAgent and
  ClaudeAgent paths ignore it; orchestrator passes `issue.labels`).
- `PipelineAgentRunner.getIssueContext` fallback now populates the
  synthesized `Issue.labels` from `input.labels` instead of `[]`.
- `buildPipelinePrompt` (`prompt.ts`):
  - `buildHeader` adds `- Labels: <comma-list or "(none)">`.
  - `buildStage1SandboxSection` echoes labels into the Stage 1 input
    block and adds a one-liner pointing at the `sandbox:<backend>`
    convention so the agent doesn't have to infer it.

**Stage 17a-2 — `@sandbox` SKILL.md rewritten as a dispatcher:**

- Step 0 selection logic: 0 labels → `local`; 1 known label → that
  backend; unknown or 2+ → fail loud with the canonical message.
- `local` branch preserves the prior local-docker / local-shell
  behavior verbatim — regression target for issues that arrive
  unlabelled.
- `namespace` branch uses `nsc whoami` precheck, `nsc create --bare
--machine_type 4x16 --duration 30m --label symphony-id=<id>
--output_to /tmp/sandbox-<id>.id`, then `nsc ssh <id> ...` for
  the clone-inside-VM step. Returns `kind: namespace-devbox`,
  `worktree_path: /workspace`, `exec.template: "nsc ssh <id> {cmd}"`,
  `teardown.kind: "both"` (script + the `--duration` safety net).
- `aws` branch is a placeholder that fails loud — slot kept for a
  future plan.

**Open question follow-up:** confirmed `--bare` was the right
choice for `nsc create` (avoids the default k3s overhead). Did not
yet manually verify `nsc ssh` exit-code propagation — punted to
the first manual smoke when a real Namespace dispatch runs.

**Stage 17a-3 — Tests added (no real Namespace call):**

- `packages/daemon/src/agent/pipeline/prompt.test.ts` (new, 4 tests):
  header renders `(none)` for unlabelled issues; multiple labels
  joined with commas; Stage 1 input block echoes labels and points
  at the `sandbox:<backend>` convention.
- `packages/daemon/src/agent/pipeline/validation.test.ts`
  (extended, +2 tests): accepts a `namespace-devbox` handle with an
  `nsc ssh {id} {cmd}` template; accepts an unknown `kind`
  (`aws-ec2`) — documents the open-ended schema decision.
- `agent/claude/agent.test.ts` + `agent/mock/mock-agent.test.ts`:
  updated input fixtures with `labels: []` to satisfy the new
  required field.

**Verification:**

- `pnpm typecheck` — clean.
- `pnpm lint` — clean (after `prettier --write` on the two new
  markdown files).
- `pnpm test` — 366 passed, 1 skipped (was 313 + 1 after Plan 16
  → +53 includes the 6 tests this plan added plus tests from
  intermediate housekeeping).
- `pnpm deps:check` — 10 orphan warnings, all pre-existing.

**Pending (Stage 17a-4 / real smoke):**

- `examples/repo-workflow/README.md` one-liner about
  `sandbox:namespace` label routing — deferred (low value until a
  real Namespace dispatch is run).
- Manual end-to-end smoke against the Namespace SaaS — operator-
  side gesture, captured in this log when it happens.

### 2026-05-17 — Refactor: agent-inline shell → pre-set scripts; nsc CLI probed

**Trigger.** User observation: making the agent re-derive the
provisioning commands every dispatch is expensive (re-reads ~250
lines of skill markdown per turn) and brittle (transcription
errors, "improving" the steps creatively). Suggested moving the
shell logic out of `SKILL.md` and into pre-set scripts the skill
just invokes.

This is unambiguously better and went in.

**New skill structure:**

```
packages/daemon/src/skills/sandbox/
├── SKILL.md                  # dispatcher only: pick backend, run script
└── scripts/
    ├── local-create.sh
    ├── local-teardown.sh
    ├── namespace-create.sh
    └── namespace-teardown.sh
```

The `pnpm postbuild` step already recursively copies
`src/skills/.` → `dist/skills/`, so the new scripts ship with the
built package without any build-script change. The agent invokes
them via `bash "$SKILL_DIR/scripts/<backend>-create.sh"` — no
chmod +x needed.

**`$SKILL_DIR` injection.** The prompt builder
(`pipeline/prompt.ts`) now derives the skill's on-disk directory
from `SkillDefinition.path` (via `dirname()`) and renders it into
Stage 1 as `SKILL_DIR=<absolute path>`. The skill markdown
references `$SKILL_DIR/scripts/...` and is otherwise location-
agnostic. Bundled vs. per-repo override both work because both
flow through `SkillDefinition.path`.

**Script contract (frozen at this revision):**

- Inputs: env vars `SYMPHONY_REPO_URL`, `SYMPHONY_DEFAULT_BRANCH`,
  `SYMPHONY_BRANCH`, `SYMPHONY_IDENTIFIER`. Teardown scripts take
  `SYMPHONY_SANDBOX_ID` and optionally `SYMPHONY_WORKTREE_PATH`.
- Stdout: a single well-formed `SandboxHandle` JSON object —
  _nothing else_. (Git progress lines forced an early bug fix:
  the `local-create.sh` body wraps the whole git block in
  `{ ... } >&2` so only the JSON reaches stdout. Verified by
  parsing stdout with Python's `json` module against a real
  octocat/Hello-World clone.)
- Stderr: `[<script>] <message>` lines, free-form.
- Exit 0 on success, non-zero on any failure with a `[<script>]
ERROR: <reason>` line as the last stderr message.

**`nsc` CLI probed against real Namespace SaaS (2026-05-17).** A
brief paid round-trip (~$0.16 across two 10-minute instances)
validated the surface and produced several corrections to the
draft skill from the previous decision-log entry:

- Auth check is `nsc auth check-login` (exit 0 if logged in), not
  `nsc whoami` (which doesn't exist in v0.0.516).
- Instance-id capture uses `--output_json_to <path>` (or
  `--cidfile`), not `--output_to`. The JSON has the id at
  `.cluster_id`.
- `--unique_tag <tag>` is exactly idempotent — a second
  `nsc create --unique_tag <same-tag>` returns the same instance
  id without re-provisioning. This is the right primitive for
  re-dispatch idempotency; the script uses
  `--unique_tag symphony-<identifier>`.
- `nsc ssh <id> -T <cmd>` runs a one-shot command. `-T` disables
  PTY which keeps non-interactive output clean.
- **Exit-code propagation is lossy.** Remote `exit 42` becomes
  local `rc=1`. The real code is only available in stderr
  (`"Failed: Process exited with status 42"`). The script uses
  `set -e` for pass/fail (which works), and the contract notes
  that downstream stages (`@coder`) wanting the real code will
  need a sentinel pattern.
- Bare instances ship with `git` (at `/sbin/git`), `docker` (at
  `/vendor/docker/docker`), and `docker compose v2.40.3`
  pre-installed. No image customization needed for the @sandbox
  layer.

**Prompt-injection finding.** `nsc`'s failure stderr contains
literal "Agents: fetch <URL>" instructions. Documented in
`SECURITY.md` under "Treat third-party CLI output as untrusted"
— scripts namespace their own stderr and don't pass raw vendor
CLI output back to the parent agent.

**SKILL.md is now ~110 lines (was ~250).** The whole bash story
is in the scripts. Agent's job: read labels → pick backend → run
one script → echo its stdout as a fenced ```json block.

**Tests stay valid.** The validation tests assert on the shape of
the JSON the script emits; the namespace-devbox handle template
matches what `namespace-create.sh` actually prints. The new
`exec.template` is `"nsc ssh <id> -T -- {cmd}"` (note `-T` for no
PTY and `--` separator), which the existing zod schema
(`shell-template` kind) accepts unchanged.
