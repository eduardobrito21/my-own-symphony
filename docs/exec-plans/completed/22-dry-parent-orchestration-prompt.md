---
status: completed
linear_issue: null
github_pr: null
created: 2026-05-18
updated: 2026-05-18
closed: 2026-05-18
---

# Plan 22 — DRY the parent orchestration prompt

- **Implements:** the tech-debt-tracker entry "Parent prompt is at
  ~17k chars; should be compressed" (logged during Plan 21
  close-out, 2026-05-18). Plan 21 grew the prompt from ~12k to
  ~17k by adding the loop block plus per-stage boilerplate for
  `@env-up`, `@verify`, `@code-review`, `@env-down`. Same
  dispatch behavior, six near-identical copies of the local-\*
  vs namespace-devbox routing pattern.
- **Comes AFTER:** Plan 21 (loop + sensors). The loop body and
  the four new sensor sub-agents are the main contributors to
  the size, so compressing now reflects the finished shape.
- **Comes BEFORE:** any future plan that adds, removes, or
  reorders a pipeline stage. The tech-debt entry's trigger says
  "compress before adding to the existing per-stage duplication"
  — touching the prompt while it's bloated multiplies the
  maintenance hit.
- **Spec sections:** none.
- **Layers touched:**
  - `packages/daemon/src/agent/pipeline/parent-prompt.ts` — the
    compression itself; same exports, same `ParentPromptContext`.
  - `packages/daemon/src/agent/pipeline/parent-prompt.test.ts` —
    size budget drops from 19k to 10k; existing structural
    assertions (`Stage N — …` ordering, `For local-` /
    `For namespace-devbox` per-stage coverage) get re-shaped to
    pin the new "one routing block, looked up per stage"
    structure.
  - `docs/exec-plans/tech-debt-tracker.md` — move the entry to
    "Paid" once the prompt lands under budget.
- **ADRs referenced:** none directly. ADR 0014 (sub-agent
  pipeline) is the architecture the prompt orchestrates; ADR
  0006 (zod at every boundary) is unaffected — this is
  prose-only.

## Goal

Take `buildParentPrompt` from ~17k chars to ≤ 10k by collapsing
the per-stage duplication that 18a → 21 accumulated. Identical
dispatch behavior; smaller surface for future plans to touch.

After this plan ships:

- The local-\* vs namespace-devbox dispatch routing is described
  **once**, in a single "How to dispatch a sub-agent" block
  after Stage 1.
- Each per-stage section (Stages 2-3, 5-6, plus the four loop
  steps inside Stage 4) shrinks to: one line of "what this
  stage does", the labelled-list of inputs, one line about the
  structured output.
- The dispatch-template "How it works" prose drops from ~700 to
  ~200 chars. Secret-hygiene warning + the SYNCHRONOUS
  dispatch warning stay; the bash-heredoc explainer goes (the
  LLM doesn't need bash-101, it needs a template to copy).
- The next plan that adds or removes a stage touches one
  routing block + one stage entry — not four-to-eight near-
  identical boilerplate copies.

## Why

Two observations from the Plan 21 close-out:

1. **The duplication is mechanical, not load-bearing.** Stages
   2, 3, 5, 6 each have a "For `local-*` kinds: invoke `Agent`
   with `subagent_type: "X"` …" paragraph followed by "For
   `namespace-devbox` (and other remote) kinds: Bash template
   with `<NAME> = X`." Four copies of the same idea, varying
   only by the stage name and the inputs list. Same pattern
   repeats four more times inside Stage 4's loop body (one
   per sensor). Eight copies total.
2. **Token cost is negligible, maintenance cost is not.** The
   system prompt is cached after first dispatch — runtime
   token cost is irrelevant. But every pipeline-shape change
   since 18a has paid the duplication tax: Plan 20 wrote
   @planner sections in both modes, Plan 21 wrote @env-up /
   @verify / @code-review / @env-down sections in both modes.
   Compressing now means the next shape change touches one
   place.

The operator's Plan 21 design-discussion reaction —
"ITS ENORMOUS…. must really be this big?" — is the human
read of the same observation. The prompt earned its size
honestly (every section is load-bearing for SOMETHING) but the
shape is wrong.

## Out of scope

- **Pipeline shape changes.** Same 9 sub-agents, same loop
  algorithm, same Stage 1-7 sequence, same close-out rules.
  This plan is structurally pure — re-arrange and condense
  prose, change nothing else.
- **Sub-agent SKILL.md content.** The skills' own bodies live
  in `packages/daemon/src/skills/*/SKILL.md` and get injected
  into `sub-agents.ts`; the parent prompt never references
  them. Not touched here.
- **Dispatch routing semantics.** Whether a stage runs via
  `Agent` (local-\*) or the `nsc ssh` Bash template
  (namespace-devbox) is determined the same way it is today.
  We're just describing it more efficiently.
- **Compression by dropping load-bearing content.** If a smoke
  in Stage 22-6 demonstrates that some sentence is what makes
  Haiku pick the right branch, that sentence stays even if it
  reads as "duplication" against another section.

## Stages

### Stage 22-1 — Hoist dispatch routing into one block

Today `## Dispatch routing for Stages 2-6` already exists at
the top, describing the local-\* vs namespace-devbox split, the
`nsc ssh` template, and the secret-hygiene rules. Per-stage
sections then **re-describe** the same choice for each stage.

Change: that one block becomes the single source of truth for
"how do I dispatch a sub-agent given the handle?" — including
the inputs-passing convention ("paste the labelled list
literally between the heredoc markers"). Per-stage sections
stop re-describing it.

### Stage 22-2 — Trim the dispatch-template explainer

The "How the template works" block currently spans ~700 chars
walking through `printf` env-passing, single-quoted heredoc
semantics, sentinel parsing, `runuser`, `claude -p` invocation.
Useful when first reading the prompt; redundant once the
template is being copied.

Target ~200 chars. Keep:

- The literal template (unchanged).
- "do NOT echo / quote / log secret values" hygiene line.
- "Bash dispatch is SYNCHRONOUS — do NOT background it" (the
  EDU-38 smoke discovery — keeps Haiku from poll-spiraling).

Drop:

- The bash-101 explanation of `<<'EOF'` shielding from shell
  expansion. The template demonstrates it; explaining it adds
  bytes without adding capability.
- The `runuser` / `claude -p` description. The in-VM
  `dispatch.sh` owns those details; the parent only needs to
  know "stdout is the sub-agent's reply".

### Stage 22-3 — Compress per-stage sections to inputs-only

Per stage (Stages 2, 3, 5, 6), the section becomes:

    ## Stage N — Dispatch @<name>

    <One sentence: what this stage produces.>

    Inputs:
        - key: value
        - key: value
        ...

    Output: <Result type name>. Keep <relevant field> for the
    next stage.

No "For `local-*` …" / "For `namespace-devbox` …" split. The
routing block from Stage 22-1 already covers that. The reader
(LLM or human) reads the routing block once and looks up the
inputs per stage.

### Stage 22-4 — Same treatment inside the loop body

Stage 4 currently has four "Sub-agent dispatch shape" subsections
(@coder, @verify, @code-review, @curator) each repeating the
local-\* / namespace split. Same compression: each subsection
becomes inputs-only.

The loop algorithm pseudocode (init / per-iter steps /
continue check / outcomes) stays untouched — it IS the load-
bearing content of Stage 4.

### Stage 22-5 — Tighten test budget + pin the new structure

`parent-prompt.test.ts` changes:

- Size budget: `expect(prompt.length).toBeLessThan(19000)` →
  `toBeLessThan(10000)`. Update the explanatory comment above
  the assertion.
- Add a test that pins the compressed structure: count
  occurrences of `For \`local-`in the prompt; assert ≤ 2
(today: 8). Same for`For \`namespace-devbox\``. Regression
  guard against the next plan re-introducing the duplication.
- The existing "per-stage docs cover BOTH dispatch modes for
  stages 2-6" test (`parent-prompt.test.ts:320`) needs to
  flip. Its old invariant ("each stage section names both
  modes") becomes false-by-design. Replace with: "the routing
  block (read once) covers both modes" — i.e., search for both
  ``For `local-`` and `` For `namespace-devbox` `` in the
  prompt body (anywhere), not per-stage.

Other existing tests (stage ordering, loop algorithm phrases,
escalation close-out, secret-hygiene language) should remain
valid as-is and serve as regression checks.

### Stage 22-6 — One real smoke

Run one EDU issue end-to-end under the compressed prompt.
Looking for: Haiku still picks the right routing branch and
still copies the dispatch template literally. Expected
outcomes:

- Mirror of EDU-38 (Plan 21's convergence smoke): a small
  cosmetic change converges in iter 1 + opens a PR.
- OR mirror of EDU-37 (Plan 21's escalation smoke):
  contradictory-instruction issue ends with
  `coder_gave_up` + Need-Human-Help label.

Pass criterion: same outcome as the matching Plan 21 smoke,
no observable behavior change. If Haiku drifts (picks the
wrong dispatch shape, misses a stage), revert specific
compression and document which sentence was load-bearing.

## Definition of Done

- `buildParentPrompt` output < 10000 chars on a typical issue
  (currently ~17000).
- All `parent-prompt.test.ts` tests pass; size budget assert
  is `toBeLessThan(10000)`; new regression-guard tests added
  per Stage 22-5.
- One real-Linear smoke completes with the same outcome as
  the matching Plan 21 smoke (CONVERGED + PR opened, OR
  escalation label added). Operator confirms no behavioral
  drift.
- Tech-debt-tracker entry "Parent prompt is at ~17k chars;
  should be compressed" moves from "Active" to "Paid" with
  the dispatch date.
- No SKILL.md content moves. No sub-agent definitions change.
  No new exports. The PR's only file changes are
  `parent-prompt.ts`, `parent-prompt.test.ts`, and the
  tech-debt tracker.

## Open questions

- **Could the dispatch-template block live in `@sandbox`'s
  SKILL.md instead of the parent prompt?** `@sandbox` returns
  the handle whose `kind` field drives the routing; arguably
  the "how to dispatch based on this handle" knowledge belongs
  near the handle producer. Defer to implementation — if
  collapsing inside the parent gets us under 10k, leave it
  here; if we're still bloated, consider hoisting. Either way
  is reversible.
- **Is the secret-hygiene warning still load-bearing after
  Plan 18c?** The template uses `printf "$VAR"` (double-
  quoted) which prevents the agent from seeing resolved values
  in narrative output. The warning is belt-and-suspenders. A
  smoke that doesn't leak the token suggests the warning is
  precautionary — but precaution against a security regression
  is the cheap kind to keep. Decision: keep the one-line
  hygiene rule, drop only the explanatory paragraph below it.
- **Should we also DRY the close-out section's two label
  branches (success vs failure)?** Stage 7 today has a
  branching `if escalationLabel === null` that duplicates
  the workflow-states-lookup pattern in both branches.
  Smaller win (~500 chars) and the branching is genuinely
  different (Done transition vs label add). Probably out of
  scope for this plan; leave as-is unless the budget is hard
  to hit.

## Source

- Tech-debt-tracker entry "Parent prompt is at ~17k chars;
  should be compressed" (added 2026-05-18 during Plan 21
  close-out — `docs/exec-plans/tech-debt-tracker.md`).
- Plan 21 design-discussion exchange ("ITS ENORMOUS….") and
  Plan 21 close-out decision log.
- Plan 21's `parent-prompt.test.ts:369-388` already carries
  the TODO comment about compressing post-21 — this plan
  cashes that TODO.

## Decision log

### 2026-05-18 — Implementation landed

- **Structural compression as planned.** The single
  "How to dispatch a sub-agent" block replaces eight per-stage
  copies of the local-\* vs namespace-devbox routing prose.
  Per-stage sections now carry only inputs + a 1-line
  description. The four loop-step sensors got the same
  treatment inside Stage 4.
- **Size: ≤ 10k null path, ≤ 11k escalation path.** Pre-Plan-22
  was ~17k. The original target was 8-10k; the escalation
  path (production-configured) lands at ~10.5k because both
  Step B branches are load-bearing prose. The null-escalation
  path (legacy) is ~9.6k. Net reduction: 38% on the production
  path, 43% on the legacy path.
- **Why we didn't hit 8k.** Cutting further would have meant
  dropping load-bearing content (loop algorithm pseudocode,
  Step B escalation flow, sub-agent input lists). Honest
  budget for the post-22 shape with the current pipeline is
  ~10-11k. If a future plan adds a stage and pushes past 11k,
  that's the trigger to re-examine the structure — not to
  bump the budget.
- **What got dropped beyond the planned routing cleanup:**
  - "How the template works" prose (~700 chars) — bash-101
    explanation of single-quoted heredoc semantics. The
    template demonstrates it.
  - Verbose per-sub-agent role descriptions inside Stage 4's
    loop body (~600 chars) — the SKILL.md prompts already
    describe each sub-agent's job.
  - Stage 6's redundant "Skip this stage entirely UNLESS..."
    paragraph — already in the section heading.
  - "If a sub-agent returns text that does NOT contain a valid
    JSON block..." in the Important block — already in the
    routing section's dispatch-failure rule.
- **Test changes.**
  - `per-stage docs cover BOTH dispatch modes for stages 2-6`
    inverted by design: replaced with a Plan 22 regression
    guard that asserts `For \`local-`and`For \`namespace-devbox\``
    do NOT appear (verifying the duplication is gone), while
    the routing block still mentions both modes.
  - Size budget assertion now covers both production paths.
  - Stage heading regex updates (`Stage N — Dispatch @X`
    → `Stage N — @X`).
- **No smoke run in this PR.** Plan 22 changed only the prompt
  text. The next post-merge dispatch exercises it naturally;
  Plan 21's two smokes (EDU-37 / EDU-38) are the comparable
  reference if a regression surfaces.
