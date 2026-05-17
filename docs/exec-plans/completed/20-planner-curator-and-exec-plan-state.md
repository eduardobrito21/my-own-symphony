# Plan 20 — Pipeline bookends: `@planner`, `@curator`, and exec-plan state

- **Status:** ✅ Complete (2026-05-17, with deferrals — see Decision log)
- **Implements:** Two new sub-agents that wrap the existing
  `@sandbox → @coder → @ci` pipeline, plus an explicit state
  machine for execution plans so doc-level state stays observable.
  - **`@planner`** runs BEFORE `@coder` on every dispatch. Decides
    whether the issue warrants an exec plan; if yes, drafts and
    commits one to the worktree before `@coder` starts editing.
  - **`@curator`** runs AFTER `@coder` (per-pipeline mode) AND on
    operator demand (periodic mode). Audits harness docs for
    consistency, transitions exec-plan state, flags drift.
  - **Exec-plan state machine** lives in plan frontmatter
    (`status: proposed | active | completed | abandoned | on-hold`),
    backed by the existing `active/` vs `completed/` directories
    as a fast-glance index.
- **Comes AFTER:** Plan 18a (SDK native sub-agents). Both new
  sub-agents plug into the `pipeline/sub-agents.ts` config that 18a
  introduced; same architecture, same tool-scoping model.
- **Comes BEFORE:** Plan 18 (real `@coder` + `@tester`). The real
  coder will benefit immediately from a well-scoped plan as input
  — the token-cost and error-rate drop is one of the central
  motivations.
- **Spec sections:** none directly. ADR-level rationale below.
- **Layers touched:**
  - `packages/daemon/src/skills/planner/` (new bundled skill)
  - `packages/daemon/src/skills/curator/` (new bundled skill)
  - `packages/daemon/src/agent/pipeline/{parent-prompt,sub-agents,runner}.ts`
    (add the new stages; thread state through)
  - `packages/daemon/src/agent/pipeline/exec-plan-frontmatter.ts`
    (new — zod schema + parser/serializer)
  - `packages/daemon/src/orchestrator/` (new dispatch type for the
    periodic curator run)
  - `packages/daemon/src/index.ts` / CLI surface (new
    `housekeeping` subcommand or HTTP endpoint to trigger periodic
    curator)
  - `docs/exec-plans/{active,completed}/*.md` (backfill `status:`
    frontmatter into every existing plan)
  - `docs/exec-plans/README.md` (document the new state machine)
- **ADRs referenced:** ADR 0005 (harness-first development — this
  plan is the project enforcing its own harness conventions on
  itself), ADR 0014 (sub-agent pipeline — same architecture
  extended), ADR 0006 (zod at every boundary — frontmatter is a
  new boundary), ADR 0009 (multi-project orchestration — periodic
  curator's dispatch shape mirrors the per-project model).

## Goal

Two new sub-agents and a small data-model change that together
turn the harness's docs from "operator keeps re-reading them to
stay coherent" into "the pipeline itself keeps them coherent."

After this plan ships:

- Every non-trivial issue produces an exec plan in `active/`
  before `@coder` touches code. The plan ships in the same PR as
  the implementation.
- Every dispatch's final close-out leaves the relevant exec plan
  in a known terminal state (`completed`, `abandoned`, or stays
  `active` if the PR is still open).
- An operator-triggered `housekeeping` dispatch sweeps all
  `active/` plans, cross-references PR + Linear state, and
  transitions stale ones to `abandoned` with a one-line note.
- Stale ADR references, missing follow-ups, and silent doc drift
  surface as `@curator` notes attached to the dispatch's Linear
  comment — not as silent rot.

## Why

Two observations from running the project itself:

1. **Operators (here, me) cycle through harness docs constantly**
   — `AGENTS.md`, `SECURITY.md`, `docs/exec-plans/*`,
   `docs/design-docs/*`, follow-ups, `tech-debt-tracker.md` —
   to keep them consistent. Every plan closure means manually
   moving a file, updating its status line, scanning siblings
   for stale references. The harness-first ADR (0005) says these
   docs are the source of truth; nothing currently keeps them
   honest.
2. **`@coder` works dramatically better against a well-scoped
   plan** than against a sparse issue description. The Plan 17a
   smoke confirmed this informally — issues with detailed
   descriptions (EDU-15, "write 'potato2' to README" plus
   context) ran clean; issues without (the EDU-12 false start)
   produced more exploration and more wasted Bash tool calls.
   A planner that turns an issue into a scoped plan amortises
   into faster, cheaper, more correct `@coder` runs.

The two new sub-agents are bookends to the existing pipeline:
`@planner` upgrades the input, `@curator` keeps the output's
artifacts coherent over time. They're independently useful but
naturally pair.

## Out of scope

- **Splitting plan-then-implement into two dispatches.** The
  planner decides and commits inline; the same dispatch continues
  to `@coder`. We considered making the planner produce a
  plan-only PR for human review before any implementation, and
  rejected it: the cost of an extra dispatch round for trivial
  issues is high, and the agent can self-judge "this plan is too
  big to bundle, stop here" if needed later (deferred to the
  follow-up plan that introduces escalation paths).
- **Operator opt-in label for planning.** Considered briefly
  (`needs-plan` label routes through planner; everything else
  skips). Rejected because operators forget labels, and "should I
  plan?" is exactly the kind of judgement call a sub-agent is
  good at. Planner runs on every dispatch by default and
  self-skips trivial issues.
- **`@curator` rewriting plan bodies, ADRs, or AGENTS.md/SECURITY.md.**
  Curator is _mechanical_ in this plan — it transitions state,
  moves files between dirs, appends to decision logs, comments on
  Linear/PRs. It does NOT rewrite "Steps" sections, ADR text, or
  top-level harness docs. Editorial judgment stays human-loop.
  See Decision 8.
- **`@curator` auto-promoting tech-debt entries.** Curator can
  _suggest_ entries in its per-dispatch summary, but it doesn't
  write to `## Active` in `tech-debt-tracker.md` directly. The
  tracker format ("Why we accept it", "Trigger to revisit")
  requires judgment that stays human for now. See Decision 9.
- **Cron-scheduled periodic curator.** Periodic mode in this plan
  ships as an operator-triggered command (CLI subcommand or HTTP
  endpoint). Adding cron is its own follow-up — meaningful
  scheduling concerns (catchup on missed runs, leader election
  for multi-daemon setups) deserve their own plan.
- **Curator escalation for state conflicts.** If a plan's
  frontmatter says `active` but the PR is merged AND the Linear
  issue is "Won't Do", curator picks the most authoritative
  signal and notes the conflict; it does NOT halt or page. State-
  conflict workflow can grow later.
- **Cross-repo curator dispatches.** Curator only audits the
  current dispatch's repo. Multi-repo harness audits (e.g. "is
  this monorepo's child README in sync with its sibling's?") are
  out of scope and will likely never be in scope — the harness-
  per-repo invariant from ADR 0005 covers this.
- **Backfilling `status:` frontmatter as code (i.e., shipping a
  migration script).** Frontmatter backfill is a one-time docs
  edit; we do it by hand as part of this plan's Stage 20-1, not
  with a tool. (One migration's worth of work.)

## Design decisions

### Decision 1 — `@planner` self-decides whether to plan

`@planner` reads the issue (title + description + labels) plus a
list of existing exec plans (so it can spot duplicates or
extensions of in-flight work). It decides:

- **Plan** — issue is non-trivial: spans multiple files, requires
  design decisions, has multiple acceptable approaches, or
  touches a load-bearing area (orchestrator, agent runtime,
  SDK plumbing).
- **Skip** — issue is a one-liner: rename, typo fix, dep bump,
  comment edit, single-test addition.

The decision is the sub-agent's job. No operator label, no
hard-coded heuristic. The agent's `PlannerResult` carries a
`decision: "planned" | "skipped"` field plus a `reason` string;
both branches log to the event stream so we can audit the call
later if it consistently mis-judges.

**Why opt-out and not opt-in:** the cost of an unnecessary
planning round on a trivial issue is bounded — a few thousand
tokens, sub-minute latency. The cost of `@coder` reverse-
engineering intent from a sparse description is not bounded. We
prefer the cheap, bounded mistake over the expensive, unbounded
one.

### Decision 2 — Plan is committed to the repo before `@coder` runs

When `@planner` decides to plan, it writes
`docs/exec-plans/active/<slug>.md` in the worktree and stages it.
`@coder` inherits the worktree, sees the plan as a real file on
disk, and (per its updated SKILL.md) reads it first.

Two reasons:

1. **The plan ships in the PR.** Reviewer opens the PR and the
   first commit is "plan: add X"; subsequent commits implement
   it. The plan becomes a reviewable artifact, not a transcript
   artefact.
2. **`@curator` has a real file to close out.** At the end of the
   dispatch, `@curator` flips the plan's `status:` to `completed`
   and (if `@coder` actually closed out the goals) moves it to
   `completed/`. Without a file, this is impossible.

Trade-off: if the PR gets abandoned, an orphan plan lives in
`active/`. That's exactly what the periodic curator catches (see
Decision 4 / 5). The cost of an orphan plan is one cleanup pass
the curator does anyway.

### Decision 3 — Exec plans get explicit state in frontmatter

YAML frontmatter on every plan file:

```
---
status: proposed | active | completed | abandoned | on-hold
linear_issue: EDU-14            # optional; null for human-written plans
github_pr: 42                   # optional; null until @ci opens one
created: 2026-05-23
updated: 2026-05-25             # bumped by @curator on any state transition
closed: 2026-05-25              # set when status moves to completed/abandoned
---
```

**State semantics:**

| State       | Meaning                                                                          | Set by                                   |
| ----------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `proposed`  | Planner drafted it; `@coder` hasn't started yet (or the plan was hand-written).  | `@planner` on creation; human author     |
| `active`    | `@coder` is working / PR is open.                                                | `@curator` (per-pipeline) once PR exists |
| `completed` | PR merged AND the plan's Definition of Done is met per `@curator`'s read.        | `@curator`                               |
| `abandoned` | PR closed-without-merge ≥ N days quiet, OR Linear issue cancelled. (Decision 5.) | `@curator` (periodic)                    |
| `on-hold`   | Explicitly paused. Rare. Usually a human edits the frontmatter directly.         | Human; never auto-transitioned to        |

**Directory is a derived view.** Plans live in `active/` for
`proposed | active | on-hold`, `completed/` for
`completed | abandoned`. `@curator` is responsible for keeping
directory and frontmatter in sync — frontmatter is the source of
truth, directory is the fast-glance index. (Operators can `ls
docs/exec-plans/active/` and trust it.)

zod schema in `pipeline/exec-plan-frontmatter.ts` parses and
serialises the frontmatter (ADR 0006). Bad frontmatter is a
typed validation error, not a silent shrug.

### Decision 4 — `@curator` audits the harness, not the work

`@curator`'s scope is **harness-engineering consistency** — the docs
tree, the plan state machine, ADR references, follow-up tracking,
the tech-debt tracker. It is **NOT** a correctness checker. It does
not run tests, does not verify that the implementation meets the
plan's Definition of Done, does not validate API contracts.

The "did the code actually work?" question belongs to a separate
sub-agent — `@tester` (planned for Plan 18). When `@tester` exists,
the loop is `@coder ↔ @tester` until tests pass; `@curator` runs
afterwards as a separate concern operating on artefacts produced
by the coder/tester loop. Conflating the two would mean curator
needs to actually understand the code, which expands its scope
past doc-tree mechanical work into agent-judgement territory we
explicitly don't want.

A side note for whoever writes Plan 18: the `@coder ↔ @tester`
loop must be **bounded**. Without a hard iteration cap, a
coder-and-tester pair can ping-pong indefinitely on a flaky test
or a subtly-wrong fix until the per-dispatch budget is exhausted.
Plan 18 should specify a max-iteration count (initial cut: 3) and
an explicit "give up, return failure" path. Curator never enters
this loop and doesn't need a bound itself.

`@curator` runs in two modes, one skill body:

- **Per-pipeline mode.** Inserted between `@coder` (later
  `@tester`) and `@ci` in the normal dispatch pipeline. Scope:
  just this dispatch's artefacts. Inputs the parent passes in:
  - The issue (so curator knows the topic)
  - The exec plan path (if `@planner` created one, or if `@coder`
    discovered an existing one)
  - The list of files `@coder` changed (from `CoderResult`)
  - Read access to the rest of the repo (Read/Glob/Grep) so it
    can sanity-check ADR references, follow-ups, etc.

  What curator decides per-pipeline: whether the plan's state
  should transition (`proposed → active` if a PR is being opened;
  later `→ completed` once the PR merges), whether any sibling
  docs went stale (e.g. ADR references a file that moved),
  whether a follow-up note belongs in the Linear comment.

- **Periodic mode.** Triggered by an operator command (CLI:
  `nsc-symphony housekeeping`, or HTTP `POST /housekeeping`).
  Scope: the whole repo. Inputs the parent passes in:
  - List of all `active/` plans with their frontmatter
  - PR state for each `github_pr` referenced (via `gh pr view`)
  - Linear state for each `linear_issue` (via the parent's
    `linear_graphql` tool — parent fetches, hands the digest to
    curator)
  - Read access to the whole `docs/` tree

Same SKILL.md body for both. The parent's prompt differs (which
inputs it gathers, which `CuratorResult` shape it expects back).
The curator skill is "audit, transition state, write
suggestions" regardless of scope — never "verify implementation."

### Decision 5 — Abandonment signal: PR-state + grace period

For `@curator` (periodic mode) to mark a plan `abandoned`:

- **Primary signal:** the linked `github_pr` is `closed` (not
  `merged`) AND has been quiet for ≥ N days. Default
  `N = 7`. Operator-tunable later.
- **Secondary signal:** the linked `linear_issue` has moved to a
  cancelled-equivalent state (`Cancelled`, `Won't Do`, etc. —
  Linear's `archivedAt` is set and the state isn't a successful
  terminal).
- **NOT a signal on its own:** time since last commit on the
  plan's branch. Long-running plans look identical to dead ones
  from this angle.

If `linear_issue` is null (hand-written plan with no Linear
tracking), only the PR-state path applies. If `github_pr` is also
null (a `proposed` plan that never made it to implementation),
`@curator` flags it as "proposed for ≥ N days, no PR opened,
consider on-hold or abandoned" — but doesn't auto-transition.
Human call.

The N-day grace is intentional: Friday-close-Monday-reopen is a
real pattern and we don't want to panic-abandon plans.

### Decision 6 — Both sub-agents are real SDK sub-agents (Plan 18a model)

Same architecture as `@sandbox`/`@coder`/`@ci`. Each gets:

- A SKILL.md in `packages/daemon/src/skills/<name>/SKILL.md`
- An entry in `pipeline/sub-agents.ts` with a scoped tool list
- A structured return value validated by zod at the boundary

**Tool scoping:**

| Sub-agent  | Tools                                                                                 |
| ---------- | ------------------------------------------------------------------------------------- |
| `@planner` | `Read`, `Glob`, `Grep`, `Write` (plan file), `Bash` (git add)                         |
| `@curator` | `Read`, `Glob`, `Grep`, `Edit` (frontmatter + decision log), `Bash` (git, gh pr view) |

`@curator` does NOT get `mcp__linear__linear_graphql` directly —
the parent fetches Linear state and passes a digest in, same
pattern Plan 18a established. Keeps the Plan 18a invariant
("linear_graphql is parent-only") intact.

**Structured returns:**

- `PlannerResult`:
  `{ decision: "planned" | "skipped", reason: string, plan_path?: string }`
- `CuratorResult`:
  `{ state_transitions: Array<{path, from, to}>, doc_edits: Array<{path, kind}>, suggestions: string[], notes: string[] }`

zod schemas live alongside the existing
`SandboxHandle`/`CoderResult`/`CIResult` schemas.

### Decision 7 — Periodic curator is a new dispatch _type_

Today's dispatch shape: "Linear issue with eligible label → run
the per-issue pipeline." Adding periodic curator means a second
shape: "operator-triggered → run the housekeeping pipeline."

Concretely:

- `Orchestrator` gains a `dispatchHousekeeping()` entry point.
  No Linear payload — the dispatch envelope is just `{ kind:
"housekeeping", at: Date }`.
- A new `housekeeping-prompt.ts` builds the parent prompt:
  "you're auditing the repo's harness docs; here are all active
  plans, their PR states, their Linear states; invoke @curator to
  decide what to transition; post a summary comment."
- Trigger surface: at minimum, a CLI subcommand
  (`nsc-symphony housekeeping`). HTTP endpoint optional —
  whichever lands in the daemon's existing CLI/HTTP plumbing more
  cheaply. (Probably CLI for v1; HTTP is a follow-up.)

The pipeline shape for housekeeping: just `@curator` + close-out.
No `@sandbox`/`@coder`/`@ci`. Reuses the same SDK + sub-agent
plumbing.

### Decision 8 — `@curator`'s edits are bounded

`@curator` CAN:

- Edit frontmatter (`status`, `updated`, `closed`, `github_pr`)
- Move plans between `active/`, `completed/` (auto, when status
  transitions cross the boundary)
- Append to a plan's "Decision log" section with a date-stamped
  entry recording the transition + signal it used
- Comment on the linked Linear issue (via parent) summarising
  the audit
- Comment on the linked GitHub PR (via `gh`) with the same
  summary

`@curator` CANNOT:

- Delete any plan file
- Edit non-frontmatter, non-decision-log content of plan bodies
  (no rewriting "Steps", no editing "Definition of done")
- Edit ADRs, `AGENTS.md`, `SECURITY.md`, `ARCHITECTURE.md`,
  `RELIABILITY.md`, or `README` files
- Promote suggestions into `## Active` in `tech-debt-tracker.md`
  (see Decision 9)

Motivating principle: curator is mechanical. It transitions state
based on rules and surfaces inconsistencies as _suggestions_. It
doesn't make editorial judgments. When the rules say "this
crosses an editorial line," curator stops and emits a suggestion
for human review.

If curator notices an ADR references a moved file, the
`suggestions[]` field carries "ADR 0011 references
`src/foo/bar.ts` which has moved to `src/baz/bar.ts`" — and a
human follows up. Curator doesn't edit the ADR.

### Decision 9 — Tech-debt tracker stays human-curated for now

`@curator`'s `suggestions[]` can include "consider adding a
tech-debt entry: <one-liner>" — surfaced in the dispatch's
Linear/PR comment. But curator does NOT write to
`tech-debt-tracker.md` directly.

Reason: the tracker's format ("Why we accept it", "Trigger to
revisit") requires judgment about _why_ we're accepting the
debt and _when_ we'd revisit it. Both are easy for a human to
write in two minutes and hard for an agent to write well without
a lot of priors. Ship lean; lift the rule later if the
suggestions are consistently good.

### Decision 10 — Backfill existing plans in Stage 20-1, not as code

`docs/exec-plans/` has ~20 plans today. Backfilling
`status:` frontmatter into each is one hour of mechanical work,
done by hand. We do NOT ship a migration script. Reasons:

- One-time. No future plans created without the convention.
- The frontmatter parser is strict; running it against
  uncertain hand-written plans first catches edge cases that a
  blind script would paper over.
- Curator's first periodic run effectively re-validates the
  backfill — any plan whose state is wrong shows up on the
  audit.

## Steps

### Stage 20-1 — Exec-plan frontmatter schema + backfill

1. Add `pipeline/exec-plan-frontmatter.ts` with the zod schema
   from Decision 3 plus a small parser/serialiser pair
   (`parseFrontmatter`, `writeFrontmatter`). Use `gray-matter` or
   equivalent (boring tool, well-known); confirm it's already in
   `daemon/package.json` before adding.
2. Unit-test the schema: required fields, valid state values,
   date parsing, round-trip stability (parse → serialise →
   parse equals identity).
3. Backfill `status:` into every plan in
   `docs/exec-plans/active/` and `docs/exec-plans/completed/`.
   Derive from directory: `active/*` → `proposed` if it's never
   started (only Plan 17b currently fits) or `active` if there's
   evidence of in-progress work; `completed/*` → `completed`.
   Cross-check `closed:` dates against decision log final
   entries.
4. Add a test fixture: load every plan under `docs/exec-plans/`,
   parse its frontmatter, assert validation passes. Pins the
   convention going forward.
5. Update `docs/exec-plans/README.md` documenting the new state
   machine + the directory-as-derived-view rule.

### Stage 20-2 — `@planner` sub-agent

6. Scaffold `packages/daemon/src/skills/planner/SKILL.md`. Goals
   in the SKILL.md:
   - Read `<repo>/.context/issue.json` for issue payload
   - Read `<repo>/docs/exec-plans/active/` for in-flight plans
     (to spot duplicates / extensions)
   - Decide planned vs skipped
   - If planned: write
     `docs/exec-plans/active/<NN>-<slug>.md` with the
     frontmatter populated (status: `proposed`, linear_issue
     set, github_pr null, created today)
   - `git add` the new file
   - Return `PlannerResult` JSON
7. Add `PlannerResultSchema` to the existing `pipeline/contracts.ts`
   (or wherever `CoderResult` lives).
8. Add `planner` to `REQUIRED_SKILLS` and to the `agents`
   record built in `sub-agents.ts` (tools per Decision 6).
9. Update `parent-prompt.ts` to insert a "Stage 0 — Dispatch
   @planner" section at the top of the orchestration sequence.
   Re-number existing stages (1→2 for @sandbox, 2→3 for @coder,
   etc.). Decision: keep the stage labels stable across the
   prompt (Stage 1 always = the first non-planner stage) by
   instead calling the new stage "Stage 0 — Plan the work" so
   downstream Stage 1/2/3/4 numbers don't shift. (Less churn in
   existing tests.)
10. Unit-test the planner integration: a planner that returns
    `{decision: "skipped", reason: "..."}` does NOT create a
    plan file; a planner that returns `{decision: "planned",
plan_path: "..."}` causes the parent prompt to thread the
    plan path into Stage 2 (`@coder` reads it).

### Stage 20-3 — `@curator` (per-pipeline mode)

11. Scaffold `packages/daemon/src/skills/curator/SKILL.md` with
    two top-level branches: per-pipeline and periodic, selected
    by an input flag the parent sets in the prompt.
12. Per-pipeline branch of the SKILL.md does:
    - Read the exec plan (if any) referenced by the parent
    - Read the list of files `@coder` changed
    - Cross-check: any ADRs referenced in changed files? Any
      stale references (file moved/deleted)?
    - Decide state transition based on **lifecycle signals, not
      correctness**: `proposed → active` once a branch + commits
      exist for this plan's issue; `active → completed` once
      `@ci` has opened a PR and the issue is being transitioned
      to Done. Curator does NOT inspect whether the code meets
      the plan's Definition of Done — that's `@tester`'s job
      (future Plan 18). If the artefacts are there and the
      pipeline closed out, curator marks completed; if not, it
      leaves the plan as-is and notes why.
    - Return `CuratorResult`
13. Add `CuratorResultSchema`.
14. Wire `@curator` between `@coder` and `@ci` in
    `parent-prompt.ts`. New Stage 3.5 — "Audit and transition
    plan state."
15. Test: snapshot test on the per-pipeline curator's prompt
    output for a sample CoderResult; integration test with a
    stub SDK that returns a known CuratorResult and verifies the
    parent passes it through.

### Stage 20-4 — Periodic `@curator` (operator-triggered)

16. Add `dispatchHousekeeping()` to `Orchestrator`. Skeleton:
    gather active plans + PR states + Linear states; build the
    housekeeping parent prompt; run the SDK query; capture the
    `CuratorResult`; apply edits (git commit the state
    transitions on a `symphony/housekeeping-<date>` branch);
    open or update a "Housekeeping <date>" PR with the diff.
17. Add CLI subcommand: `pnpm --filter daemon run housekeeping`
    or `nsc-symphony housekeeping` (match existing CLI naming).
    Optional follow-up: HTTP `POST /housekeeping` for dashboard
    triggering.
18. Add `housekeeping-prompt.ts` parallel to `parent-prompt.ts`.
    Same shape (issue context → stages → close-out), but the
    "issue" is synthetic ("Audit harness docs across <N>
    active plans") and the only sub-agent is `@curator`.
19. Test: fixture with three plans (one healthy active, one
    abandoned-PR scenario, one cancelled-Linear scenario);
    stub SDK; assert curator's CuratorResult triggers the
    expected file moves + frontmatter updates.

### Stage 20-5 — Wiring + end-to-end smoke

20. Run a live dispatch on a non-trivial issue (target: EDU-NN
    with a real description — something like "extract the
    retry backoff into its own module"). Verify:
    - `@planner` creates `docs/exec-plans/active/<slug>.md`
      and commits it.
    - `@coder` reads the plan and the diff implements its
      "Steps".
    - `@curator` transitions plan to `completed` and moves
      the file.
    - PR contains: 1 commit for the plan, ≥1 commit for the
      implementation, 1 commit for the curator's state
      transition. (Or curator amends the implementation commit;
      acceptable either way — call out the choice in the
      decision log.)
21. Construct a fake abandoned PR scenario (close a PR without
    merging, wait the N-day window or temporarily lower N to
    0); run `nsc-symphony housekeeping`; verify the plan moves
    to `abandoned/` with the correct decision-log entry.
22. Capture before/after metrics in the decision log: time spent
    by operator manually reviewing docs per dispatch (informal
    measurement); `@coder` tool-call count on a dispatch with a
    plan vs without (proxy for "did the plan help?").

### Stage 20-6 — Docs + close-out

23. Update `AGENTS.md` to mention the new pipeline shape
    (planner → sandbox → coder → curator → ci) and the
    housekeeping subcommand.
24. Update `docs/exec-plans/README.md` if Stage 20-1 didn't
    already cover it (lifecycle section needs the new states).
25. Move this plan to `completed/` with the final accounting
    table.

## Definition of done

- Every plan under `docs/exec-plans/` has valid `status:`
  frontmatter; the validation test passes against the whole
  directory.
- `@planner` ships as a real SDK sub-agent, writes a plan file
  when invoked on a non-trivial issue, and self-skips on a
  trivial issue (both branches exercised by tests).
- `@curator` ships in per-pipeline mode: transitions plan state
  at close-out; moves files between `active/` and `completed/`
  as state dictates.
- `@curator` ships in periodic mode: `nsc-symphony housekeeping`
  (or equivalent operator entry point) runs end-to-end and
  produces a housekeeping PR with the expected transitions.
- A live smoke produces:
  (a) issue → plan committed → implementation committed → PR
  → curator marks completed → Linear comment posted; AND
  (b) periodic curator catches a fabricated abandoned-PR
  scenario.
- `@curator`'s edits respect the Decision 8 bounds (verified by
  test: curator handed a "rewrite ADR" suggestion does NOT
  rewrite the ADR; surfaces it as a `suggestion`).
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check
&& pnpm build` green.
- Tech-debt tracker has any deferred curator-related items
  appended (see Open questions below).

## Open questions

- **Should the planner's plan file land on a separate commit
  before `@coder`'s implementation, or be amended into the
  first implementation commit?** Tentative: separate commit
  ("plan: add X"), keeps the PR's history readable. Confirm
  during Stage 20-2.
- **What is the planner's threshold for "non-trivial"?** Initial
  cut: described in SKILL.md as a few examples; let the agent
  use judgement. If consistently mis-judged in either direction,
  add a sharper heuristic (e.g. "always plan if labels include
  `complex` or description has ≥ 3 paragraphs"). Measure first.
- **Plan numbering when planner creates one.** Today plans are
  numbered sequentially (00, 01, ..., 18a, 18b, 19, 20). The
  planner needs to pick a number that doesn't collide. Easiest:
  scan existing filenames, pick max + 1. Concurrent dispatches
  could collide — accept the race for now (rare in v1, single
  daemon) and let curator deduplicate if it happens.
- **Per-pipeline curator's `active → completed` trigger.** Curator
  marks a plan `completed` based on **lifecycle signals**, not DoD
  verification. The MVP heuristic: if the dispatch produced a PR
  (`CIResult.pr_url` is non-null) AND the close-out posted a
  successful Linear comment, transition to `completed` and move
  the file. If `@ci` was skipped (empty `CoderResult.changed_files`),
  leave the plan as `active` and note "no implementation landed
  for this dispatch" in the decision log. Verifying that the
  implementation actually MEETS the DoD is `@tester`'s job (Plan
  18, future) — curator never inspects code correctness.
- **Where does `@curator` post its suggestions for stale ADR
  references / tech-debt candidates?** Two options: a comment on
  the dispatch's Linear issue (per-pipeline scope) or a new
  comment on a "harness audit" Linear issue maintained by the
  operator (periodic scope). Tentative: Linear comment for
  per-pipeline; the housekeeping PR's description for periodic.
- **How to handle plan files NOT created by `@planner` (hand-
  written plans, this plan itself)?** `@curator` should treat
  them identically — same frontmatter, same state machine. The
  only divergence is that hand-written plans usually have
  `linear_issue: null`. Curator's logic handles the null case
  in Decision 5.
- **Tooling for plan-state migrations.** If we change the state
  enum later (e.g. add `blocked`), the migration is hand-edit
  the frontmatter across N files. At ~20 plans this is fine;
  if it grows past ~100 we'd want a script. Out of scope for
  now; revisit if/when the doc tree explodes.
- **Cost ceiling for per-pipeline `@curator`.** A curator that
  reads the whole `docs/` tree on every dispatch could be
  expensive. Initial estimate: curator's prompt is small (a few
  thousand tokens) and the Read tool calls are bounded by what
  `@coder` actually changed. If observed cost per dispatch
  exceeds (say) $0.05 incremental, scope down curator's read
  surface.
- **Idempotency for periodic curator.** If `housekeeping` is run
  twice in a row, the second run should be a no-op. State-
  transition logic must be idempotent (already true if it's
  driven by current PR/Linear state, not by "what changed since
  last run"). Verify with a test.

## Decision log

### 2026-05-17 — Plan close-out (with deferrals)

Shipped:

- **Stage 20-2 (`@planner` sub-agent MVP)** via PR #29.
  `@planner` decides plan-vs-skip per its SKILL.md heuristics,
  writes a plan file under `docs/exec-plans/active/` in the
  worktree, commits it with a `Committed-by: @planner` footer.
  Validated live during the EDU-25 smoke (Plan 18b).
- **Stage 20-3 (`@curator` per-pipeline mode)** via PR #32.
  Curator is wired as Stage 4 of the pipeline (between `@coder`
  and `@ci`). Three harness-integrity rules in v1:
  cross-reference resolution, exec-plan lifecycle, index ↔
  directory parity. Auto-fix bar is "mechanical and
  unambiguous"; everything else surfaces as structured `flags[]`
  rendered into the Linear close-out comment under a "Curator
  findings" section.

Dropped or deferred:

- **Stage 20-1 (frontmatter schema + backfill)** — deferred.
  Existing plans use ad-hoc `- **Status:**` markdown bullets
  rather than YAML frontmatter. New plans written by
  `@planner` _do_ use the YAML frontmatter form, so we have
  format drift between old and new. Until the backfill ships,
  `@curator`'s Rule 2 (exec-plan lifecycle integrity) is a
  no-op on pre-Plan-20 plans. Tracked as a dedicated entry in
  `tech-debt-tracker.md`.
- **Stage 20-4 (periodic `@curator`)** — explicitly dropped
  during design discussion. Per-pipeline curator only for v1.
  A housekeeping subcommand stays out of scope; if recurring
  drift becomes a problem, revisit then. Documented here so
  the dropping is intentional, not accidental.
- **Stage 20-5 (live curator smoke)** — not yet exercised on
  a real dispatch with harness-relevant changes. Will surface
  in the next dispatch that modifies anything under `docs/`.
- **Stage 20-6 (`AGENTS.md` update for the new pipeline shape)**
  — the canonical pipeline-shape doc is `parent-prompt.ts` (with
  module-level comments in `runner.ts` and `index.ts` refreshed
  during this plan's sweeps). `AGENTS.md` will absorb the
  pipeline section the next time it's edited for related work.

Why "complete with deferrals" rather than "in progress":

The two load-bearing artifacts — `@planner` and `@curator` — are
shipped, wired, tested, and one of them is live-validated. The
deferred items are either:

- Operator-driven product decisions (periodic curator → dropped),
- Format chores that don't block the new artifacts from working
  on go-forward work (frontmatter backfill),
- Or follow-ups that surface naturally (live smoke, AGENTS.md
  update).

Keeping the plan in `active/` would imply ongoing work; moving
it to `completed/` with this log makes the state observable.
