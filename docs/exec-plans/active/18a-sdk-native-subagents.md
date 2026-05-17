# Plan 18a — Migrate the pipeline to SDK native sub-agents

- **Status:** Not started
- **Implements:** A reshape of how Plan 16/17a's pipeline is
  represented to the Claude Agent SDK. Same external behavior
  (same stages, same handoffs); different SDK-level mechanics.
- **Comes AFTER:** Plan 17a (multi-backend dispatcher, MVP @coder
  and @ci, end-to-end smoke landed). The skill markdown contracts
  and `SandboxHandle` / `CoderResult` / `CIResult` schemas carry
  over unchanged.
- **Comes BEFORE:** Plan 18b (sandbox-aware tools — TBD pending
  E2B research), Plan 18 (real @coder + @tester), Plan 19 (real
  @ci on remote sandboxes).
- **Spec sections:** none directly.
- **Layers touched:**
  `packages/daemon/src/agent/pipeline/{prompt.ts,runner.ts}`
  (significant refactor), `packages/daemon/src/agent/claude/`
  (SDK-config plumbing for sub-agent definitions),
  `packages/daemon/src/skills/<name>/SKILL.md` (each becomes a
  sub-agent system prompt rather than a section in the parent
  prompt), bundled skill loader (unchanged in API, but consumers
  change).
- **ADRs referenced:** ADR 0014 (sub-agent pipeline architecture —
  this plan finally implements the "sub-agent" part literally
  rather than in name only), ADR 0006 (zod at every boundary —
  the sub-agents' structured outputs still get validated).

## Goal

Stop hand-rolling the "sub-agent pipeline" as inlined sections in
one giant 75k-token system prompt. Use the Claude Agent SDK's
native sub-agent mechanism so each skill is a real sub-agent with
its own context window, its own scoped tool set, and a clean
structured handoff via the SDK's `Task` tool.

Same pipeline shape (`@sandbox → @coder → @ci? → close-out`).
Same skill markdowns. Same JSON contracts between stages. The
change is internal to how the daemon talks to the SDK; observable
behavior at the Linear / GitHub level is identical.

## Why

Plan 17a's MVP works but exposed two concrete pain points that
all trace back to the "one giant agent walking through stages"
implementation choice:

1. **The 75k-token first prompt hits Sonnet 4.6's 30k TPM org
   cap.** Every dispatch's first attempt 429s, costs ~$0.30, and
   only succeeds on retry after the cache warms. The prompt is
   mostly three inlined SKILL.md bodies — sub-agents would only
   pay for the skills they actually invoke.
2. **Each stage's "stage boundary" is a regex search on assistant
   text** for a fenced ```json block. We bolted on a SandboxHandle
   validator (Plan 16), discovered it only catches one of three
   structured outputs, and depend on the agent explicitly echoing
   JSON it could just as easily return as a sub-agent result.
   SDK sub-agents return structured values to the parent natively
   — no text-scraping needed.

Tertiary wins:

- Each sub-agent gets focused context — no risk of @coder's
  reasoning drifting into @sandbox or @ci concerns.
- Sub-agents can be given **different tool sets**. This is the
  unlocking property for Plan 18b (sandbox-aware tools): @coder
  gets sandbox-routed Read/Edit/Write, @ci gets `gh` access, the
  parent gets neither.
- Stage events become first-class in the SDK stream rather than
  inferred from tool-call sequencing.

## Out of scope

- **Sandbox-aware tools.** Plan 18b. The Read/Edit/Write tools
  this plan exposes to @coder/@ci are still the SDK's built-in
  local-host versions; this plan keeps the existing "@coder bails
  on remote sandboxes" MVP behavior. The two plans compose:
  18a moves us to sub-agents; 18b swaps their tool sets when the
  sandbox is remote.
- **Replacing the MVP @coder/@ci** with the full Plan 18 (real
  @coder + @tester) versions. This plan only restructures how
  they're invoked; their SKILL.md contracts and behavior are
  preserved verbatim.
- **Removing the post-hoc text-scan validator** in
  `pipeline/validation.ts`. It becomes vestigial once handoffs
  are structured but we keep it as a safety net during the
  migration. Removal is a follow-up cleanup.
- **Skill discovery changes.** Loader still finds SKILL.md files
  in the same order (repo override → bundled). It just feeds them
  into a different consumer.
- **Per-sub-agent budget caps / per-sub-agent model selection.**
  Worth doing eventually (Plan 18 might want Haiku for @coder
  routing decisions but Sonnet for actual code edits); this plan
  uses the operator default model for all sub-agents.
- **Caching strategy across sub-agent invocations.** Each sub-
  agent call is a separate Anthropic request; cache hit semantics
  inherit from whatever the SDK does. We measure but don't tune.

## Design decisions

### Decision 1 — Each skill is a sub-agent, parent owns orchestration

The Claude Agent SDK supports declarative sub-agent definitions
(an `agents` config field). Mapping:

| Today (Plan 17a MVP)                              | After 18a                                               |
| ------------------------------------------------- | ------------------------------------------------------- |
| Parent prompt inlines all skill SKILL.md bodies   | Each SKILL.md is a sub-agent's system prompt            |
| Agent narrates "Stage 1, Stage 2…" through stages | Parent's tools include `Task` invocations of sub-agents |
| Structured handoff is text scrape for ```json     | Sub-agent return value IS the JSON, validated by zod    |
| Single big context window                         | Parent context small; each sub-agent gets fresh context |

The parent's job becomes purely orchestrational: "given an
issue, spawn @sandbox, then @coder, then maybe @ci, then
@close-out (or the inline close-out for now)." Its system prompt
is a short orchestration script, not a stage-by-stage manual.

### Decision 2 — Parent's system prompt shrinks; skills do NOT inline

Today's `buildPipelinePrompt` returns ~19k chars dominated by
three `<sandbox_skill>...</sandbox_skill>` blocks. After 18a:

- Parent's system prompt: issue context + the pipeline's shape
  ("call @sandbox first, then @coder; if @coder returned non-
  empty changed_files, call @ci; then close out"). Maybe 2-3k
  chars.
- Each sub-agent's system prompt: its SKILL.md verbatim. Read
  by the SDK only when that sub-agent is actually invoked.

For a "no changes needed" dispatch, @ci is never invoked, so
its ~3k SKILL.md is never tokenized. Net per-dispatch context
goes from ~75k → estimated ~30k (parent + @sandbox + @coder),
~50k if @ci runs. Real cache wins on re-dispatch since each sub-
agent's prompt is independently cacheable.

### Decision 3 — Sub-agent outputs replace text-scrape validation

The SDK's `Task` tool returns a structured result from the sub-
agent. We define each sub-agent to return its JSON contract:

- `@sandbox` returns `SandboxHandle`
- `@coder` returns `CoderResult`
- `@ci` returns `CIResult`

zod still validates at the boundary (ADR 0006); the validation
moves from "scan agent text for fenced JSON" to "parse sub-agent
return value." If the sub-agent returns malformed shape, that's
a `Task` failure surfaced as a typed error to the parent, which
can decide whether to retry or fail out the dispatch.

The post-hoc `findSandboxHandleInText` validator stays during the
migration (defensive belt-and-suspenders) but is no longer
load-bearing.

### Decision 4 — Tools surfaced per sub-agent, not globally

Today every tool (Bash, Read, Edit, Write, Glob, Grep,
linear_graphql) is available to the parent agent during all
stages. After 18a:

| Sub-agent  | Tools                                                           |
| ---------- | --------------------------------------------------------------- |
| Parent     | `Task(@sandbox)`, `Task(@coder)`, `Task(@ci)`, `linear_graphql` |
| @sandbox   | `Bash` (to invoke create scripts), `Read` (only for log review) |
| @coder     | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`                 |
| @ci        | `Bash` (to invoke ci-commit-push-pr.sh)                         |
| @close-out | (still inline in parent for now) `linear_graphql`               |

This makes the tool surface auditable per stage and prevents
accidental cross-stage tool use (e.g. @coder accidentally
posting to Linear). It also sets up 18b cleanly: swap @coder's
tool set when the sandbox is remote.

### Decision 5 — `linear_graphql` stays on the parent

Stage 4 (close-out) is currently inline in the parent's system
prompt. We could promote it to a `@close-out` sub-agent but it
wouldn't materially change anything except adding one more sub-
agent definition. Punt to Plan 19 or whenever close-out grows
real logic.

### Decision 6 — Skill markdowns evolve to "sub-agent system prompt" tone

Today's SKILL.md files address "you, the parent agent, in stage
N." They can stay mostly as-is, but tightening passes are worth
doing while we're touching them:

- Drop the "Step 0 — Pick the backend" preamble in @sandbox now
  that the SDK can pass `labels` as a typed input to the sub-
  agent (less prone to misreading).
- Drop the "REQUIRED, emit JSON in fenced block" reminders —
  obviated by structured return.
- Drop the "$SKILL_DIR" injection — sub-agents know where their
  own resources live without needing an env var passed through
  the parent prompt.

These are cleanups, not blockers. Could be deferred to a 18a
follow-up if the migration itself is risky enough.

## Steps

### Stage 18a-1 — Verify the SDK's sub-agent surface

1. Read `@anthropic-ai/claude-agent-sdk` docs for the exact
   `agents` config field, sub-agent invocation tool name, return
   value shape, and event types. Confirm the assumptions in
   Decisions 1-4 against the actual API. Update this plan's
   decisions if reality differs.
2. Sketch the smallest possible "hello world" pipeline with one
   parent + one sub-agent, run it in a scratch script, capture
   the event stream. This proves the model before we commit to
   the refactor.

### Stage 18a-2 — Parent prompt + sub-agent definitions

3. Rename `pipeline/prompt.ts` → `pipeline/parent-prompt.ts`. Its
   output shrinks to just the parent's orchestration prompt
   (issue context + pipeline shape + tool guide). Skill bodies
   no longer inlined.
4. New file `pipeline/sub-agents.ts`: builds the `agents` config
   for the SDK — one entry per skill, each pointing at the
   skill's SKILL.md (loaded via `loadSkill`) and declaring the
   tool subset from Decision 4's table.
5. The runner composes these and passes both to the SDK in a
   single `query` call. The query is one parent invocation;
   sub-agents fire under the hood via `Task`.

### Stage 18a-3 — Structured returns

6. Each sub-agent SKILL.md's final-step instruction changes from
   "emit a fenced ```json block as your last assistant message"
to "return the following JSON object via the `Task` tool's
   completion mechanism." The exact mechanism is SDK-specific
   (TBD in Stage 18a-1).
7. zod validation moves from `pipeline/validation.ts`
   (text-scrape) to inline at the parent's `Task` return point.
   The old validator stays but isn't called on the happy path.

### Stage 18a-4 — Event model

8. Update `pipeline/runner.ts` to map the SDK's sub-agent events
   onto the existing `AgentEvent` shape. Likely:
   - SDK's "Task started for sub-agent X" → `notification` with
     `message: "starting @X"`.
   - SDK's "Task tool calls inside sub-agent" → forwarded as-is
     with a `sub_agent: 'X'` field added.
   - SDK's "Task completed with result" → `notification` +
     synthesized text describing the handoff.
   - SDK's terminal `turn_completed` → unchanged at the top
     level.
9. Decide whether to add a new event kind (`sub_agent_started`,
   `sub_agent_completed`) for the dashboard's benefit. Tentative:
   yes, additive only, so older event consumers ignore it.

### Stage 18a-5 — Tests

10. Rewrite `pipeline/prompt.test.ts` — most existing tests check
    properties of the inlined big prompt (label rendering,
    SKILL_DIR injection, etc.). Some still apply to the
    parent-only prompt; others migrate to sub-agent definition
    tests.
11. New tests in `pipeline/sub-agents.test.ts`: verify the agents
    config carries the right SKILL.md content, the right tool
    subset per sub-agent, the right output schema attached.
12. Update `pipeline/runner.test.ts` (if it exists, otherwise
    create) to verify the new event mapping with a stub SDK.

### Stage 18a-6 — Smoke + Plan 17a parity

13. Re-run a `local-shell` smoke against EDU-NN with the same
    description as Plan 17a's EDU-15 success. Expected: PR opens,
    Linear transitions to Done — same outcome, but the
    cumulative prompt tokens should be meaningfully lower per
    dispatch (capture before/after in the decision log).
14. Confirm cache-hit numbers improve on a re-dispatch (each sub-
    agent's prompt should be independently cached).

## Definition of done

- `buildPipelinePrompt` no longer inlines any skill SKILL.md body.
  The parent prompt is < 5k chars on a typical issue.
- Each of @sandbox / @coder / @ci is a real SDK sub-agent with a
  scoped tool list per Decision 4.
- Structured handoffs (SandboxHandle, CoderResult, CIResult) flow
  via sub-agent return values; the post-hoc text validator stays
  for safety but isn't load-bearing.
- A `local-shell` smoke matches Plan 17a's EDU-15 outcome (PR
  opened, Linear → Done) with measurably lower per-dispatch token
  count (target: at least 40% reduction in first-attempt input
  tokens vs. the current 75k baseline).
- 429 rate-limit failures on the first attempt should drop
  meaningfully or disappear at the current Sonnet 4.6 30k TPM
  cap. (Falsifiable: run the smoke 3x cold; if any 429s, plan is
  not done.)
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check`
  green.

## Open questions

- **What is the exact shape of the SDK's `agents` config?** The
  sub-agent declarative API — Stage 18a-1 confirms before
  starting the refactor. If the SDK doesn't actually have a
  declarative sub-agent feature (only the imperative `Task` tool
  on the parent), Decisions 1-4 need revisiting.

- **Can sub-agents have completely different tool sets, or is the
  tool list a superset across all agents?** Decision 4 assumes
  per-sub-agent tool scoping. If the SDK only allows a single
  global tool list with per-agent allow/deny rules, the design
  still works but the wiring differs.

- **How does a sub-agent return structured data?** Possibilities:
  the sub-agent emits a final assistant message that the SDK
  parses; the parent calls `Task` with a `responseSchema` and
  the SDK enforces it; the sub-agent calls a special
  `finalize_result(json)` tool. TBD in Stage 18a-1.

- **Should the parent agent's `linear_graphql` be moved to a
  `@close-out` sub-agent?** Tentative: not in this plan. Close-
  out logic is short; sub-agentizing it doesn't simplify
  anything until close-out grows real branches (Plan 19).

- **Cache semantics across sub-agents.** If the parent's prompt
  is cached and a sub-agent's prompt is also cached, do they
  count as the same conversation for caching purposes? Or
  separate? Stage 18a-1 should answer empirically.

- **Per-sub-agent budget enforcement.** Today's
  `max_budget_usd` is a single cap on the whole agent run. With
  sub-agents this might want to be per-stage. Out of scope for
  this plan but worth flagging — the SDK may already support
  this and we'd just need to wire it.

## Decision log

### 2026-05-17 — Plan opened

Plan written following the live observation that the 75k-token
first prompt was thrashing Sonnet 4.6's 30k TPM cap during the
Plan 17a smoke. Subsidiary motivation: SDK native sub-agents
unlock per-sub-agent tool scoping, which is the precondition
for Plan 18b's sandbox-aware tools.

The user surfaced the SDK's `agents` parameter as a possibility
based on ecosystem research. Stage 18a-1 verifies the assumption
before any refactor.
