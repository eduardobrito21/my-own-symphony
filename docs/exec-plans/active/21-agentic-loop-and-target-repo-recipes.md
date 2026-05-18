# Plan 21 — Agentic loop, target-repo recipes, escalation integration

- **Status:** Not started
- **Implements:** The iterating sensor loop that turns Symphony
  from a one-shot pipeline (one `@coder` pass, ship it) into an
  agentic system that converges on a working PR through
  self-correction. After 21 ships, a `sandbox:namespace`-labelled
  dispatch boots the target repo's services (`@env-up`), runs an
  iterating loop of `@coder → @verify → @code-review → @curator`
  (cap N=3, budget $5, no-progress detection), and only opens a
  PR when all sensors agree. Failures escalate via the
  already-shipped Need-Human-Help label mechanism (PR #37 filter
  - PR #38 close-out label-add).
- **Comes AFTER:**
  - Plan 18c (bare-microVM sandbox: root + docker, so target
    repos can actually `docker compose up`).
  - Plan 20 (`@planner` + `@curator`: loop reuses curator with
    its existing Rule 1–3 audits, no changes to curator's
    behavior).
  - PR #37 (`excluded_labels` filter: loop's escalation path
    reuses this).
  - PR #38 (close-out adds the escalation label on failure: same
    code path the loop's cap-hit / budget-hit / no-progress
    branches dump into).
- **Comes BEFORE:** No specific plan. Possible follow-ups:
  giving `@code-review` autonomy to `Edit` (propose-only in v1),
  AWS sandbox kind (same loop, different sandbox flavor),
  parallelized sensors (sequential in v1).
- **Spec sections:** none directly. ADR 0015's "sub-agents in
  the sandbox they operate on" governs everything new here.
- **Layers touched:**
  - `packages/daemon/src/skills/env-up/SKILL.md` (NEW — script
    dispatcher; reads target repo's `.symphony/recipes.yaml`).
  - `packages/daemon/src/skills/env-down/SKILL.md` (NEW —
    mirror of env-up; runs the configured teardown script).
  - `packages/daemon/src/skills/verify/SKILL.md` (NEW —
    aggregates typecheck / lint / test recipes; mechanical).
  - `packages/daemon/src/skills/code-review/SKILL.md` (NEW —
    LLM judgement sensor; propose-only).
  - `packages/daemon/src/agent/pipeline/sub-agents.ts` (four new
    entries in `SUB_AGENT_TOOLS`, `_DESCRIPTIONS`, `_NAMES`).
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts` (the
    loop block: instructions for iterating `@coder → @verify → @code-review → @curator`, cap + budget + no-progress checks,
    escalation hand-off to the existing close-out failure
    branch).
  - `packages/daemon/src/agent/skills/schemas.ts` (new result
    schemas: `EnvUpResult`, `VerifyResult`, `CodeReviewResult`).
  - `packages/daemon/src/skills/sandbox/scripts/in-vm/dispatch.sh`
    (add `env-up|env-down|verify|code-review` to the validator
    case + per-sub-agent `ALLOWED_TOOLS` case).
  - `packages/daemon/src/skills/sandbox/scripts/namespace-create.sh`
    (a sanity-check step at provision time: if `.symphony/recipes.yaml`
    is missing from the clone, log a warning — the loop sensors
    are skipped per-recipe, not pipeline-blocking).
  - Target-repo convention: `.symphony/recipes.yaml` +
    `.symphony/scripts/*.sh`. NOT in this repo per se; documented
    as the operator-side contract.
- **ADRs referenced:** ADR 0015 (sub-agents in their sandbox),
  ADR 0014 (sub-agent pipeline shape), ADR 0006 (zod at every
  boundary — new result schemas), ADR 0005 (harness-first
  development — `.symphony/` in target repos is the target's
  half of the harness).

## Goal

After 21 ships, the pipeline shape becomes:

```
@sandbox                       ← (existing)
→ @planner                     ← (existing)
→ @env-up                      ← NEW; runs target's env-up.sh
→ LOOP (cap=3 iters, $5 budget, no-progress detection):
    @coder                     ← (existing; receives accumulated findings)
    → @verify                  ← NEW; runs typecheck / lint / tests
       └─ FAIL → continue loop, accumulate findings, back to @coder
    → @code-review             ← NEW; LLM; flag-only with proposed patches
       └─ FLAGS → continue loop, accumulate findings, back to @coder
    → @curator                 ← (existing; harness-graph)
       └─ FLAGS → continue loop, accumulate findings, back to @coder
    → EXIT loop when @verify + @code-review + @curator are ALL clean
→ @env-down                    ← NEW; runs target's env-down.sh
→ @ci                          ← (existing; reduced scope: commit + PR only)
→ close-out                    ← (existing; PR #38 escalation reused)
```

Three failure modes for the loop:

1. **Cap hit (3 iters with at least one sensor still flagging).**
   Close-out failure branch: comment + Need-Human-Help label.
2. **Budget hit ($5 cumulative).** Close-out failure branch.
3. **No-progress detected** (same finding fingerprint reported
   in two consecutive iterations). Close-out failure branch.

In all three, the issue stays in its current state, the label is
added, and the daemon's next poll-tick skips the issue
(`reason=excluded_label`, already shipped). Operator removes the
label after fixing the underlying blocker; daemon picks it up
again.

## Why

Three motivations, priority order:

1. **Convergence over single-shot.** Today's pipeline is "`@coder`
   makes an edit, `@ci` ships it." For trivial edits (README
   appends, dep bumps, config tweaks) this works. For anything
   that interacts with running services, depends on the test
   suite, or has style requirements that a linter catches —
   single-shot is gambling. The loop closes the gap: `@coder`
   gets feedback from sensors before the change reaches a human
   for review.
2. **Layered discipline.** Three different sensors catching
   three different classes of mistake:

- `@verify` (mechanical): typecheck / lint / tests. Cheap,
  deterministic, decides binary pass/fail. Fast feedback.
- `@code-review` (judgement): comment quality, naming, code
  smells, scar tissue, principle violations against top-level
  concern docs (SECURITY.md, RELIABILITY.md, QUALITY_SCORE.md,
  PRODUCT_SENSE.md). LLM-driven. Slower.
- `@curator` (harness graph): cross-references resolve,
  exec-plan lifecycle, index parity. Unchanged from Plan 20.
  No single sensor catches everything; together they cover the
  space.

1. **Symphony stops needing operator-monitoring.** Combined with
   PR #37 + #38: convergence + escalation means every dispatch
   either lands a PR or flags itself for a human. The operator's
   loop becomes "look at the Linear board once a day; PRs to
   review, plus any issues that escalated." No daemon-tailing.

## Out of scope

- **AWS sandbox kind.** Same loop, different sandbox flavor —
  separate plan.
- **Custom microVM image** with claude + repo deps pre-baked.
  Defer until Plan 21's smoke gives us a real cold-start
  number to argue from.
- `**@tester` sub-agent. `@verify` here is mechanical — it
  runs the configured test command and parses pass/fail.
  `@tester` (a hypothetical future sub-agent) would diagnose
  WHY tests fail and propose fixes that touch test code itself.
  Out of scope; the loop bounces back to `@coder` for now.
- **Target-repo skill markdowns** (`.symphony/skills/*.md`).
  Recipes only for v1 — flat key/value commands. If sensors
  ever need prose context from the target repo, add a `skills/`
  branch then.
- **Parallel sensor execution.** Loop runs sensors sequentially
  (@verify, then @code-review, then @curator). Each could in
  principle run in parallel since they don't share state, but
  the parent agent's accumulated-findings model is simpler
  serial. Revisit if total loop time matters.
- `**@code-review` getting Write/Edit access. Propose-only in
  v1. The flag includes a `suggested_fix` patch; `@coder`
  applies it on the next loop iter. Auto-fix lives behind a
  future trust-building plan.
- **Loop steering by the parent agent** (e.g., "stop iterating,
  this is converging slowly, escalate now"). The parent follows
  the rules: cap-3 OR budget-$5 OR no-progress, in any order,
  triggers escalation. No judgement-driven early-exit.

## Stages

### Stage 21-1 — Target-repo recipe loader

Adds the convention that target repos declare per-repo commands
in `.symphony/recipes.yaml`. This is the load-bearing prerequisite
for env-up/down + verify; without it those sensors have nothing
to call.

1. **Recipe schema.** Flat YAML at `<target-repo>/.symphony/recipes.yaml`:
   env_up: ./.symphony/scripts/env-up.sh
   env_down: ./.symphony/scripts/env-down.sh
   typecheck: pnpm typecheck
   lint: pnpm lint
   test: pnpm test

- All fields optional. Missing field → that sensor skips
  itself (not an error, not a flag).
- Inline commands for one-liners. Script paths (any
  extension) for multi-step.
- No autodetect, no defaults. The operator declares
  explicitly what to run.

1. **Loader location.** Doesn't need a TS-side loader. The
   sub-agents that consume recipes (env-up/env-down/verify)
   each read `<worktree>/.symphony/recipes.yaml` themselves via
   the `Read` tool. Decoupled from the daemon's bootstrap.
2. **Provision-time check.** `namespace-create.sh` after the
   clone: stat `<worktree>/.symphony/recipes.yaml`. If absent,
   log a warning at provision time so the operator knows
   sensors will skip. NOT pipeline-blocking — a repo with no
   recipes still gets `@sandbox + @planner + @coder + @curator

- @ci` (just no env-up / verify / code-review can be
  automatic).

1. **Documentation.** New section in `packages/daemon/src/skills/sandbox/SKILL.md`
   (or a new top-level `TARGET_REPO_HARNESS.md`) describing the
   convention. Operator-facing.

### Stage 21-2 — `@env-up` and `@env-down` sub-agents

Two new script-driven sub-agents that run target-repo-owned
scripts. Same shape as `@sandbox`: deterministic, structured
output.

1. `**packages/daemon/src/skills/env-up/SKILL.md`:

- Read `<worktree_path>/.symphony/recipes.yaml`.
- If `env_up` is missing or the recipes file doesn't exist:
  emit `EnvUpResult: { skipped: true, reason: '...' }` and
  return. Pipeline continues; the loop sensors that need a
  running env will fail predictably, but the loop's
  escalation handles that case.
- Otherwise: `bash <env_up_value>` from `<worktree_path>`.
  Capture stderr + exit code. Apply a 5-minute timeout.
- Return `EnvUpResult: { skipped: false, succeeded: true|false,

stderr_tail: '<last 50 lines>', duration_seconds: N }`.

1. `**@env-down`: mirror image. Run after the loop exits
   (success OR escalation) and before close-out, so the target
   repo's services tear down regardless of outcome.
2. **Tool scoping.** `Bash` + `Read` only. No Write, no Edit —
   env-up/down don't modify code.
3. **Plumbing.** Add `env-up`, `env-down` to:

- `sub-agents.ts`: `SUB_AGENT_TOOLS`, `SUB_AGENT_DESCRIPTIONS`,
  `SUB_AGENT_NAMES`, the iteration array in `buildSubAgents`.
- `dispatch.sh`: validation case + ALLOWED_TOOLS case.

1. **Schemas.** New `EnvUpResultSchema` and `EnvDownResultSchema`
   in `agent/skills/schemas.ts`. Shape above.

### Stage 21-3 — `@verify` sub-agent

The mechanical loop sensor. Aggregates typecheck + lint + tests
into one pass/fail.

1. `**packages/daemon/src/skills/verify/SKILL.md`:

- Read `<worktree_path>/.symphony/recipes.yaml`.
- Run `typecheck`, then `lint`, then `test` (in that order).
  Stop on first failure. (Cheap signals first.)
- For each: `bash <command>` from `<worktree_path>`, capture
  stderr + exit code.
- Return `VerifyResult: { passed: boolean, failed_step:

'typecheck' | 'lint' | 'test' | null, output_tail:
'<failed command's last 100 lines>', skipped_steps:
string[] }`.

- If a recipe key is missing, that step is skipped (recorded
  in `skipped_steps`) and the next step runs.

1. **Tool scoping.** `Bash` + `Read`. No Write — verify reads
   the world, doesn't change it.
2. **Plumbing.** Same as Stage 21-2.

### Stage 21-4 — `@code-review` sub-agent

The judgement loop sensor. LLM-driven; flag-only with proposed
patches.

1. `**packages/daemon/src/skills/code-review/SKILL.md`:

- Read the files in `changed_files` (passed in inputs).
- For each, look for:
  - Scar tissue / drift markers ("now X", `TODO(#NN)`-to-
    closed, "Bug N, smoke M, YYYY-MM-DD" narratives).
  - Obvious code smells in the changed lines (dead code,
    commented-out blocks, mid-sentence renamings).
  - Principle violations against top-level concern docs
    present in the target repo: SECURITY.md, RELIABILITY.md,
    QUALITY_SCORE.md, PRODUCT_SENSE.md. Read the concern
    doc, check the diff against its stated rules.
  - Comment quality: docstrings that lie, misleading function
    names, etc.
- Return `CodeReviewResult: { decision: 'audited' | 'skipped',

summary: string, flags: Flag[] }`where each`Flag`is` { rule: string, file: string, line?: number, concern:
string, suggested_fix: string }`.` **suggested_fix`is a      PATCH the next`@coder`iter can apply, not free-form prose.** E.g.:`"replace lines 42-44 of foo.ts with: "`.

1. **Discipline.** Curator-style:

- Propose-only. Never `Edit`. Never `Write`.
- One flag per concern. No "various issues" superlatives.
- `suggested_fix` must be unambiguous enough that `@coder`
  can apply it mechanically.
- If no findings, return `decision: 'audited', flags: []` —
  don't pad.

1. **Tool scoping.** `Bash` (read-only operations: `git diff`,
   `find`, etc.), `Read`, `Glob`, `Grep`. NO Edit / Write.
2. **Plumbing.** Same as 21-2/3.

### Stage 21-5 — Loop wiring in parent-prompt + close-out integration

The structural change. The parent agent's prompt gets a loop
block; the existing close-out failure branch (PR #38) becomes
the escalation hand-off for loop-exit-without-convergence.

1. **Parent-prompt.ts changes:**

- Replace the linear Stage 4 (curator) with a loop block.
- New structure: after `@coder` (Stage 3) returns with
  non-empty `changed_files`, enter the loop.
- Each loop iter runs: `@verify` → `@code-review` → `@curator`.
- Loop state the parent tracks (mentally; no structured
  persistence): iteration count, accumulated findings
  fingerprint, accumulated cost.
- Exit conditions: - **CONVERGE:** all three sensors return clean (verify
  passed, code-review flags empty, curator flags empty).
  → proceed to `@env-down` → `@ci`. - **CAP hit (iter == 3):** at least one sensor still
  flagging. → `@env-down` (no `@ci`), then close-out
  failure branch. - **BUDGET hit (cumulative cost > $5):** → same. - **NO-PROGRESS (same fingerprint twice in a row):** →
  same. Fingerprint = sorted list of `(sensor, file, line,

rule)` tuples across all flags + verify's failed_step.

1. `**@coder` re-invocation per iter. Each loop iter
   re-dispatches `@coder` with the accumulated findings:

- "Previous iteration's findings: . Address each. Do
  not re-introduce the change that caused them."

1. **Cost tracking.** SDK emits per-turn `usage` events with
   `total_cost_usd`. Parent agent reads these (via the
   `Bash`-tool-output structured fields, or via the
   `task_notification` channel) and accumulates. If cumulative
   > $5 at any iteration boundary, exit loop with BUDGET hit.
2. **No-progress detection algorithm.**

- After each iter, compute the fingerprint.
- Compare to the previous iter's fingerprint.
- If identical (same flags, same lines, no movement) →
  escalate. The next iter would just produce the same flags.
- First iter has no previous; never escalates on iter 1.

1. **Close-out failure branch (already shipped, PR #38).** Loop
   exit failure (any of cap / budget / no-progress) goes to the
   existing failure path: post comment with the loop summary
   (iteration count, cost, remaining flags), add the
   Need-Human-Help label, do NOT transition state. The
   daemon's filter (PR #37) skips on next tick.
2. `**@ci` scope reduction. `@ci` today is already
   commit-and-PR-only — its SKILL.md doesn't make judgement
   calls. No change needed except possibly cosmetic
   re-affirmation.

### Stage 21-6 — End-to-end smoke

1. **Set up a test target repo** with a real `.symphony/recipes.yaml`:

- `env_up`: a script that boots a small Postgres + a Fastify
  toy app via `docker compose up -d`.
- `env_down`: `docker compose down -v`.
- `typecheck`: `pnpm typecheck`.
- `lint`: `pnpm lint`.
- `test`: a small integration test that hits the running
  toy app and exits non-zero on failure.
- A starter bug in the toy app's code such that the test
  fails on the first `@coder` attempt but is fixable in one
  `@coder` iteration.

1. **Smoke 1 — convergence.** Dispatch the bug-fix issue. Expect:

- `@coder` iter 1 makes a change.
- `@verify` fails (test failure).
- Loop continues: `@coder` iter 2 (fed iter-1 findings) makes
  a better change.
- `@verify` passes; `@code-review` clean; `@curator` clean.
- Loop exits CONVERGE.
- `@env-down` runs. `@ci` opens PR. Close-out → Done.

1. **Smoke 2 — cap hit.** Dispatch a "contrived non-converging"
   issue: e.g., a description that asks for something
   physically impossible, or that triggers a flag the @coder
   can't address (style preference disagreement). Expect:

- Loop runs 3 iters.
- On iter 3 boundary: still flagged.
- Loop exits CAP.
- `@env-down` runs. NO `@ci`. Close-out failure branch: label
  added, state untouched.
- Next daemon tick: `skip ... reason=excluded_label`.

1. **Cost log.** Capture cumulative token cost per dispatch.
   Convergence smoke is the baseline; cap smoke is the worst
   case. Both should be well under $5.

### Stage 21-7 — Plan close-out

Decision log entries captured. Plan moved to `completed/`. Any
deferrals (e.g., parallel sensors, `@tester`) added to
tech-debt tracker if they have a concrete trigger condition.

## Definition of done

- A target repo with `.symphony/recipes.yaml` + a real docker-
  compose-based app can dispatch a "fix this bug" Linear issue
  and Symphony converges to a PR with ≥ 1 loop iteration.
- A contrived non-converging issue hits cap=3, escalates via
  the Need-Human-Help label, leaves state unchanged. Next
  daemon tick logs `skip ... reason=excluded_label`.
- Loop cumulative cost in the convergence smoke is < $1; in
  the cap smoke is < $5 (the hard cap).
- All sensors return well-formed structured JSON (zod-validated).
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green.
- Operator-side documentation describes the `.symphony/recipes.yaml`
  convention with at least one working example.

## Open questions

- **Per-sensor parallelism.** Verify + code-review + curator
  don't share state; could run in parallel. Sequential is
  simpler for v1; revisit if loop time becomes a concern.
- **Recipe autodetect from package.json / pyproject.toml.**
  Out of scope; explicit-only for v1. If operators consistently
  configure recipes that match obvious detect heuristics, add
  a fallback later.
- **Budget rotation across iterations.** $5 hard cap is total
  cumulative. Could imagine per-iter caps too (e.g., no single
  iter > $2). Not worth the complexity.
- **What if `@verify`'s configured `test` command spawns
  long-running services?** Each verify run gets a 5-minute
  timeout (same as env-up). If the test recipe needs more, the
  operator's recipe should encode that.
- **Operator-named escalation states vs labels.** PR #37/#38
  ships labels. If operators want a Linear state-transition
  instead (e.g., "move to Needs Review state, don't add a
  label"), that's a separate plan — labels are the simpler
  contract.
- `**@code-review`'s reading surface. v1 reads only files in
  `changed_files` plus the top-level concern docs it detects.
  Could expand to "files the diff touches via imports" but
  that's open-ended — start narrow.
- **What if the target repo has no concern docs?** `@code-review`
  silently skips the principle-adherence subset of its checks
  and only does scar-tissue + comment-quality. Documented in
  its SKILL.md.
- **Loop iteration as a Linear comment?** Each iter could
  append progress to the issue's Linear thread for operator
  visibility. Probably yes, but it's separate from the close-
  out comment. Defer to Stage 21-5 implementation.

## Decision log

### 2026-05-17 — Conversation-derived decisions (pre-execution)

Captured from the multi-turn design conversation. Pre-execution
because the plan starts with these assumptions baked in.

- `**@verify` = one sub-agent aggregating typecheck / lint /
  tests (sequential, stop on first failure) instead of
  separate `@typecheck`, `@lint`, `@tests`. Operator's call.
  Reasoning: same operational shape (run command, parse exit
  code), the loop is simpler with fewer sensor boundaries.
  Splitting can come later if observed cost / contention
  argues for it.
- **Target repo owns env-up + env-down scripts.** Operator's
  call. Reasoning: the target repo is the only place that
  knows whether its stack is `docker compose` vs `k3d` vs
  Postgres-on-host vs a custom Bash dance. Symphony's job is
  to invoke the operator-declared script, not to detect.
- **Recipe schema is flat YAML; missing field = sensor skips.**
  Operator's call. Reasoning: explicit over magic. No
  autodetect from `package.json` / `pyproject.toml` — that
  introduces support surface (which detection heuristics are
  blessed? which versions? when does it drift?) that an
  explicit `.symphony/recipes.yaml` sidesteps entirely.
- **Loop cap = 3 iterations.** Operator's call. Reasoning:
  if a sensor flags the same thing twice and `@coder` can't
  address it, a third try usually doesn't help. Cheap to
  raise the cap later if observed convergence patterns argue
  for it.
- **Loop budget = $5 cumulative.** Operator's call.
  Reasoning: a worst-case loop with 3 iters of `@coder` +
  `@code-review` + `@curator` (each ~$0.20–$0.50 of Haiku-4.5
  tokens, ballpark) should sit comfortably under $5. If real
  observed costs run higher than expected, this is the first
  thing to revisit.
- **No-progress detection on flag fingerprint.** Operator's
  call. Reasoning: if `@coder` produces the same flag set
  twice in a row, the loop is in an infinite-fixpoint. Same
  flags = same suggested fixes = same `@coder` response.
  Escalate immediately rather than burn the remaining cap.
- **Escalation uses the existing Need-Human-Help label
  mechanism** (PR #37 filter + PR #38 close-out label-add)
  shipped 2026-05-17. The loop's cap / budget / no-progress
  exit paths all hand off to the same close-out failure
  branch — no new escalation transport.
- `**@code-review` is propose-only, no auto-edit.
  Operator's call. Reasoning: trust isn't earned yet. The
  flag's `suggested_fix` is a literal patch that the next
  `@coder` iter applies; `@code-review` itself never
  modifies code. Mirrors `@curator`'s discipline (curator's
  Rule 1 auto-fixes a narrow set; rules 2+ are flag-only).
  Auto-fix in `@code-review` lives behind a future plan.
- `**@tester` is NOT part of Plan 21. What 21 ships as
  `@verify` is the mechanical "run the test command, did it
  pass?" sensor. A hypothetical `@tester` would diagnose
  WHY tests fail and propose fixes that touch test code
  itself. That's a separate plan; the loop bounces back to
  `@coder` for now and trusts `@coder` to update tests when
  it's appropriate.
- **AWS sandbox kind is a separate plan.** Plan 21 is shape  
  agnostic about the sandbox; same loop runs in any sandbox  
  flavor that gives us root + docker (which today is only  
  `namespace-devbox` per Plan 18c, but the loop is portable).
