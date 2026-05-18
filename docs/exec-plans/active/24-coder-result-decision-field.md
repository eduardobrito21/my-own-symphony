---
status: proposed
linear_issue: null
github_pr: null
created: 2026-05-18
updated: 2026-05-18
closed: null
---

# Plan 24 — Distinguish "done" from "stuck" in the agentic loop's iter-2+ exit

- **Implements:** A discovery from the EDU-39 live smoke (Plan
  22 + 23 end-to-end test, 2026-05-18). The pipeline did the
  work correctly on iter 1, @curator legitimately flagged a
  broken cross-reference (`CODE_OF_CONDUCT.md` not in the
  worktree), @coder on iter 2 correctly judged "no further
  changes — the issue text explicitly forbids creating that
  file." The loop algorithm then forced `coder_gave_up` because
  iter 2 produced no changes, escalated with the
  `Need Human Help` label, and the operator (the user) was
  paged for an issue that was actually done.
- **Comes AFTER:** Plan 21 (loop + escalation), Plan 22 (DRY
  prompt — the loop algorithm pseudocode lives there). The
  current rule
  > `If changed_files is empty AND iter > 1: EXIT with
outcome="coder_gave_up"`
  > is the line that needs to fork on @coder's intent.
- **Comes BEFORE:** any future plan that touches loop
  semantics. After this lands the loop has three intent-aware
  iter-2+ exit paths, not one fall-through.
- **Spec sections:** none.
- **Layers touched:**
  - `packages/daemon/src/agent/skills/schemas.ts` —
    `CoderResultSchema` gains a `decision` enum field
    ([schemas.ts:108-115](packages/daemon/src/agent/skills/schemas.ts)).
  - `packages/daemon/src/skills/coder/SKILL.md` — emits the
    new field in its output JSON; one sentence each on when to
    use which value.
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts` —
    the loop algorithm pseudocode's iter-2+ exit rule changes
    from one rule to a two-way fork on `decision`.
  - `packages/daemon/src/agent/skills/schemas.test.ts` —
    enum-validation tests.
  - `packages/daemon/src/agent/pipeline/parent-prompt.test.ts`
    — pin the new exit semantics in the prompt text.
- **ADRs referenced:** none directly. ADR 0014 (sub-agent
  pipeline) is the architecture this refines; the change is a
  one-line decision-rule extension within that architecture.

## Goal

Let @coder distinguish "I made changes" / "no further changes
needed — iter 1 was right" / "I'm stuck on findings I can't
address." The loop algorithm reads the distinction and exits
differently:

- `decision: 'changes_made'` → normal iter 1 (or further iter)
  flow.
- `decision: 'no_changes_needed'` on iter > 1 with empty
  `changed_files` → EXIT `converged` (run @ci, open PR).
  @curator's flags still render in the close-out comment as a
  heads-up section — informational, not blocking.
- `decision: 'stuck'` on iter > 1 with empty `changed_files`
  → EXIT `coder_gave_up` (current behavior — escalate with
  `Need Human Help`).

After this plan ships:

- The EDU-39 scenario (and any future "the issue text says
  don't do X" interactions) ends with a PR + a heads-up
  comment on the curator's flag, not with an escalation label
  the operator has to defuse.
- @coder's intent is structured data — the algorithm doesn't
  have to guess from `changed_files.length`.
- Pre-existing tests against `CoderResult` keep passing:
  `decision` defaults to `'changes_made'` when omitted, which
  is the iter-1-empty-changes behavior (already mapped to
  `no_changes`, success).

## Why

Three observations from EDU-39:

1. **The empty-iter-2 signal is overloaded.** Today the rule
   conflates two semantically distinct situations: "@coder
   bouncing off findings it can't address" (the case Plan 21
   designed for) and "@coder explicitly accepts the previous
   iter's findings as intentional." Both produce empty
   `changed_files`; only the first warrants escalation.
2. **Haiku saw the bug, the algorithm overrode it.** The
   smoke's thinking log shows the agent reasoning: "I should
   override the algorithm and mark it as 'converged' instead.
   But no — I need to stick with the algorithm as defined."
   The LLM had the right judgment; the rule strait-jacketed
   it. That's exactly the case for structured intent — make
   the judgment available to the algorithm.
3. **The curator's flag is information, not a veto.** A
   broken cross-reference is worth surfacing — operator may
   want to follow up — but it shouldn't force escalation when
   the responsible code path is "the issue text says don't
   create that file." Today the close-out renders curator
   findings in both success and failure outcomes (Plan 22).
   This plan preserves that rendering; it just stops escalating.

## Out of scope

- **Loop algorithm structural changes beyond the iter-2+
  exit fork.** Same five outcomes (`converged`, `no_changes`,
  `coder_gave_up`, `no_progress`, `cap_hit`), same per-iter
  step ordering, same fingerprint-based no-progress check.
- **@curator behavior changes.** Curator's flags remain
  exactly as they are today — including the cross-reference
  rule that fired on EDU-39. The flag was correct.
- **@coder's job description.** @coder still reads previous
  findings, still tries to address them, still emits
  `changed_files`. The decision field is one extra structured
  output — not a workflow rewrite.
- **Auto-promoting a coder_gave_up to converged retroactively.**
  No re-classifying on the way to close-out. The outcome
  decides at loop exit; close-out just renders it.

## Stages

### Stage 24-1 — Schema: `CoderResult.decision`

Add to `CoderResultSchema` in
[schemas.ts:108-115](packages/daemon/src/agent/skills/schemas.ts):

    decision: z
      .enum(['changes_made', 'no_changes_needed', 'stuck'])
      .default('changes_made'),

`default('changes_made')` keeps existing tests passing
without churn. The iter-1 happy path (coder makes changes,
emits files) is `'changes_made'` and that's the no-op default.

Update `parseCoderResult` / `safeParseCoderResult` — no change
needed, zod handles the new field through the existing parse
path.

### Stage 24-2 — @coder SKILL.md: emit the new field

In `packages/daemon/src/skills/coder/SKILL.md`, document the
three values and when to use each:

- `'changes_made'` — you produced one or more file edits.
  Default; emit on every iter-1 run that touches a file.
- `'no_changes_needed'` — iter > 1, you reviewed previous
  findings, and you judge the existing changes are correct as
  shipped (e.g. the issue text explicitly accepts the
  finding's premise; the finding is informational; @coder's
  iter-1 implementation already addresses what the operator
  asked for). `changed_files` will be empty. The loop will
  exit with `converged` and open a PR.
- `'stuck'` — iter > 1, you can't address the findings (you
  don't know how to fix the issue the sensor flagged, OR the
  fix would violate something else, OR you've tried and the
  same flag keeps coming back). `changed_files` will be
  empty. The loop will exit with `coder_gave_up` and
  escalate.

Add a one-paragraph illustrative example based on EDU-39 (the
discovery case): "Issue text says 'do not create
CODE_OF_CONDUCT.md'; @curator flags the missing file →
iter 2 → `decision: 'no_changes_needed'`, `summary` explains
the reasoning."

### Stage 24-3 — Parent prompt: fork the iter-2+ exit rule

In [parent-prompt.ts](packages/daemon/src/agent/pipeline/parent-prompt.ts)'s
Stage 4 loop algorithm pseudocode, replace:

    If `changed_files` is empty AND iter > 1:
      EXIT with outcome="coder_gave_up".

with:

    If `changed_files` is empty AND iter > 1:
      If CoderResult.decision == "no_changes_needed":
        EXIT with outcome="converged" (run @ci with the
        iter-1 changes; render any sensor findings in the
        close-out comment as informational).
      Otherwise (decision == "stuck" or unset):
        EXIT with outcome="coder_gave_up".

Add ~2 lines below the iter-1 branch reminding the reader
that iter 1 + empty changes → `"no_changes"` (unchanged).

The change is local to Stage 4's algorithm subsection. No
other prompt text moves.

### Stage 24-4 — Tests

Two test additions:

- `schemas.test.ts` — the new enum parses correctly; default
  applies when omitted; invalid values reject.
- `parent-prompt.test.ts` — Stage 4 section contains both
  branches of the new exit rule. Regex: `/no_changes_needed/`
  → match in the loop algorithm pseudocode, and the converged
  branch references @ci.

No new orchestrator test — the orchestrator doesn't read
`decision` directly; it threads CoderResult opaquely. The
agent-side change is prompt + schema only.

### Stage 24-5 — Smoke

Re-run an EDU-39-shaped issue (link to a non-existent file)
and verify it converges + opens a PR with a "Curator
findings" heads-up section in the close-out comment.

## Definition of Done

- `CoderResult.decision` is an enum on the zod schema with
  default `'changes_made'`.
- @coder SKILL.md describes the three values with concrete
  guidance on when to use each.
- The parent prompt's iter-2+ exit rule reads `decision` and
  forks into `converged` vs `coder_gave_up`.
- All existing tests (schemas, parent-prompt) pass without
  changes (the default keeps back-compat).
- New tests cover enum validation + prompt-text pinning.
- One smoke run reproduces an EDU-39-shape issue and ends
  with a PR + heads-up comment (NOT a `Need Human Help`
  label).
- Plan 24's plan doc moves to `completed/` with a decision
  log.

## Open questions

- **Should @coder be ALLOWED to use `'no_changes_needed'` on
  iter 1?** Edge case: @coder discovers in iter 1 that the
  issue is already implemented (someone fixed it manually
  between dispatch and tick). Today iter-1 + empty changes
  exits with `"no_changes"` (success — comment "Symphony
  made no changes: ..."). That's the right behavior; this
  plan doesn't need to touch it. `decision` on iter 1 is
  effectively cosmetic — the algorithm only branches on it
  for iter > 1.
- **Should `decision: 'stuck'` carry a `reason` field?** A
  human-readable explanation would help the operator
  understand the escalation. The `summary` field already
  carries this and is rendered in the close-out comment, so
  no new field needed — just document in SKILL.md that
  `summary` should explain WHY when `decision: 'stuck'`.
- **Could @coder lie and always emit `'no_changes_needed'` to
  avoid escalation?** In principle yes; in practice the
  `summary` field is shown to the operator in the Linear
  comment, and a PR that doesn't address the curator's flag
  is visible. The escalation label is one signal among many;
  this plan doesn't try to make it the only safety net.
- **What if iter 2's curator flags a NEW finding that the
  iter-1 changes introduced?** That's a genuine "loop should
  keep going" case. @coder should NOT emit
  `'no_changes_needed'` — the finding is new, the @coder
  should address it. The loop algorithm handles this
  correctly today (iter 2's findings → fingerprint differs
  → loop continues if iter < 3). The new exit rule only
  kicks in when @coder explicitly produces zero changes.

## Source

- EDU-39 live smoke ([Linear](https://linear.app/eduardobrito/issue/EDU-39/add-a-code-of-conduct-link-to-the-readme),
  2026-05-18). Pipeline did the work correctly, escalated
  anyway. Discovery captured in the conversation log between
  the smoke run and this plan doc.
- Plan 22's compressed parent-prompt loop-algorithm
  pseudocode (the one-line rule that this plan forks).
- Plan 21 design: loop algorithm + escalation contract
  (`Need Human Help` label, no state transition on failure).
  Plan 24 narrows the scope of that escalation by carving
  off the "deliberately no further changes" path.
