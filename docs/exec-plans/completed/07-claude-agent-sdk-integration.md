# Plan 07 — Claude Agent SDK integration

- **Status:** ✅ Complete 2026-04-29. All 9 steps shipped, four
  bugs found and fixed across three live smoke runs, multi-turn
  resume validated end-to-end against EDU-5. Live spend ≈ \$0.20.
- **Spec sections:** §10 (Agent Runner Protocol — substituted per
  ADR 0001), §15 (Workflow Prompt Rendering)
- **Layers touched:** `agent/` (new `claude/` adapter), `agent/tools/`
  (new `linear_graphql` tool), `prompt/` (new — Liquid rendering),
  `commands/` or `skills/` (new — Linear skill markdown).
- **ADRs referenced:** 0001 (Claude Agent SDK over Codex CLI),
  0002 (custom Linear tool over hosted MCP), 0006 (zod at every
  boundary), 0008 (`codex.*` folded into `agent.*`).

## Goal

Replace `MockAgent` with a real `ClaudeAgent` backed by
`@anthropic-ai/claude-agent-sdk`. After this plan, the daemon
dispatches **actual agent runs** against Anthropic's API on real
Linear issues, with the agent able to read its own session history
across turns and to write back to Linear via a typed
`linear_graphql` tool.

A successful smoke run is: dispatch on a real Linear issue (e.g.
`EDU-5`) → Claude Sonnet 4.5 reads the prompt + workspace → calls
`linear_graphql` to post a "starting work" comment → ends turn
cleanly → next turn resumes the same conversation.

## Out of scope

- Multi-agent / sub-issue decomposition. Future "big orchestration
  mode" — see Decision log entry 2026-04-29 below for the design
  intent. Plan 7 ships **per-issue session** only.
- Haiku for cheap sub-tasks. Sonnet 4.5 only for this plan;
  Haiku-tier work has no natural home until we add label
  classifiers / file summarizers in a later plan.
- Web dashboard. Plan 08.
- Docker / deployment. Plan 09.
- Sandboxing beyond what the SDK provides. Documented as a known
  limitation in `SECURITY.md`.
- Token / cost accounting. Deferred to Plan 11 (observability
  sidecar) — the agent runner emits raw usage events; aggregation
  lives elsewhere.
- E2B cloud devbox. Plan 10. We use the developer's local machine
  as the agent execution environment for this plan.

## Outcome shape (preview)

What working code looks like at the end of this plan:

```
WORKFLOW.md (with `agent.kind: claude`)
   ↓ (composition root in packages/daemon/src/index.ts)
ClaudeAgent (implements Agent interface)
   ↓ for each turn:
       1. Read session.json from <workspace>/.symphony/
       2. Render WORKFLOW.md prompt body via Liquid + Issue context
       3. Call SDK: query({ prompt, resume: sessionId, systemPrompt: <skill> })
       4. Stream SDK events → AgentEvent union (same one MockAgent uses)
       5. Save updated session.json
   ↓
Orchestrator (unchanged) consumes AgentEvent stream, retries, etc.
```

The contract between the orchestrator and the agent — the existing
`Agent` interface and `AgentEvent` union — does not change. This
is the harness payoff: swapping MockAgent → ClaudeAgent is a
config flip, not a refactor.

## Steps

1.  **SDK research spike** — ✅ **DONE 2026-04-29**.
    Findings captured in
    `packages/daemon/src/agent/claude/sdk-notes.md`. Concrete
    API surface we'll target:
    - Entry point: `query({ prompt, options })` →
      `AsyncGenerator<SDKMessage>`.
    - Session: `options.resume = sessionId`; capture `sessionId`
      from `SDKResultMessage.session_id` (or
      `SDKSystemMessage.session_id` on init).
    - Custom tools: `tool(name, desc, zodSchema, handler)` +
      `createSdkMcpServer({ name, version, tools })`; register
      via `options.mcpServers` and allow with
      `options.allowedTools = ['mcp__linear__linear_graphql']`.
    - System prompt: `options.systemPrompt` accepts a plain
      string. **Not sticky across resumed sessions** — must be
      passed on every call.
    - Abort: `options.abortController: AbortController`; throws
      `AbortError` on abort. Known bug (GitHub #69): aborting
      immediately after init then resuming the same `session_id`
      can fail.
    - Model id: `claude-sonnet-4-5` (alias) or
      `claude-sonnet-4-5-20250929` (dated). We use the alias.
    - Auth: SDK reads `ANTHROPIC_API_KEY` from `process.env`
      automatically — works with our existing `--env-file=.env`.
    - Token usage: per-turn only, in `SDKResultMessage.usage`.

2.  **`AgentEvent` extension** in
    `packages/daemon/src/agent/runner.ts`:
    - Existing union: `session_started`, `notification`,
      `turn_completed`, `turn_failed` (4 events).
    - Add: `tool_call` (agent invokes `linear_graphql` etc.),
      `tool_result` (tool returned), `usage` (token counts —
      emitted alongside `turn_completed` since the SDK only
      reports them at the end of a turn).
    - **Backward-compatible additive only**: orchestrator's
      existing consumer code (worker loop, log hooks, retry
      logic) must not change. MockAgent stays unmodified.
    - Mapping table SDK → AgentEvent (from sdk-notes.md):
      SDK `system` (init) → `session_started`
      SDK `assistant` (text block) → `notification`
      SDK `assistant` (thinking) → `notification` (with marker)
      SDK `tool_use` → `tool_call`
      SDK `tool_result` → `tool_result`
      SDK `status` → `notification`
      SDK `result` (success) → `usage` + `turn_completed`
      SDK `result` (error\_\*) → `usage` + `turn_failed`
    - Unit tests: every SDK message type maps to exactly one
      AgentEvent (no silent drops); verify discriminator-based
      exhaustive switch is enforced by the type system.

3.  **Liquid prompt rendering** — _already done in Plan 04_.
    Lives at `packages/daemon/src/agent/prompt.ts` with
    `strictVariables: true` and `strictFilters: true`, plus
    typed `PromptRenderError` Results and unit tests in
    `prompt.test.ts`. The orchestrator's worker already calls
    it before invoking `MockAgent`, so `ClaudeAgent` inherits
    the rendered prompt for free via `AgentRunInput.prompt`.
    Action for Plan 7: just verify the orchestrator passes the
    rendered prompt through unchanged when `agent.kind=claude`,
    and add a Decision log entry pointing at the existing
    implementation so future readers don't repeat this
    research.

4.  **Session persistence** — ✅ **DONE 2026-04-29**.
    `packages/daemon/src/agent/claude/session-store.ts`. File
    path: `<workspace>/.symphony/session.json`. Schema (zod):
    `{ sessionId: string, createdAt: ISO8601, lastTurnAt: ISO8601,
model: string }`. `loadOrNull(workspacePath)` returns null on
    missing OR corrupt file; logs a WARN on corruption.
    `save(workspacePath, session)` does an atomic write via a temp
    file plus rename, like `ensureDirectoryAtomic` in `workspace/`.
    Unit tests cover round-trip, missing-file → null, corrupt-JSON
    → null + warn, and atomic write doesn't leave half-files.

5.  **`ClaudeAgent` adapter** — ✅ **DONE 2026-04-29**.
    `packages/daemon/src/agent/claude/agent.ts`. Implements the
    existing `AgentRunner` interface (same one `MockAgent` uses).
    One `run(input: AgentRunInput)` call = one orchestrator
    dispatch = one SDK `query()` call = one turn. Multi-turn
    continuity is owned by the orchestrator's existing retry queue
    (Plan 5), not by the agent.

    Per-call flow:
    1. Build a per-call `AbortController` and bridge `input.signal`
       → `abortController.abort()`.
    2. Pass the linear skill markdown (loaded once at construction)
       as `systemPrompt` on **every** call — per spike findings the
       system prompt is not sticky on resume.
    3. Load session via `session-store.loadOrNull(workspacePath)`;
       if a session exists, attempt resume.
    4. Call SDK `query({ prompt, options })` with `model`,
       `resume` (if any), `systemPrompt`, `mcpServers: { linear }`,
       `allowedTools: ['mcp__linear__linear_graphql']`, `cwd`,
       `abortController`, `persistSession: false`.
    5. Stream `SDKMessage` → `AgentEvent` per the mapping in step
       2; `yield` to caller. **Buffer** the terminal event so we
       can reclassify on a post-result throw (Bug 2 fix).
    6. On clean iteration end, yield the buffered terminal and
       persist the observed `session_id` via `session-store.save`.
    7. On resume failure (synchronous throw OR mid-stream throw
       before any yield), log INFO `claude_resume_failed_starting_fresh`
       and retry the same `query()` call without `resume`.

    Stall timeout interplay: the orchestrator already aborts via
    `AgentRunInput.signal` when stall fires. We just respect it.
    Per the SDK spike, GitHub #69 means we should AVOID aborting
    during init; if early-abort fires we log a warning and treat
    the session as "must restart fresh next turn" — delete
    `session.json` so the next dispatch starts clean.

    Telemetry: log `claude_turn_started`, `claude_turn_ended`
    (with usage), `claude_resume_failed_starting_fresh`, and
    `claude_post_terminal_error_reclassified` via the logger, NOT
    through `AgentEvent`. Logs are for ops; AgentEvent is for the
    orchestrator's state machine.

6.  **`linear_graphql` tool** — ✅ **DONE 2026-04-29**.
    `packages/daemon/src/agent/tools/linear-graphql.ts`:
    - Defined via SDK's `tool()` helper:
      ```ts
      tool(
        'linear_graphql',
        'Execute a GraphQL query/mutation against the Linear API…',
        { query: z.string(), variables: z.record(z.unknown()).optional() },
        async (args) => {
          /* handler */
        },
      );
      ```
    - Wrapped in `createSdkMcpServer({ name: 'linear', version: '1.0.0', tools: [linearGraphql] })`
      and registered in `ClaudeAgent` constructor. The SDK
      exposes the tool to the agent as
      `mcp__linear__linear_graphql`.
    - Handler validation, in order (return SDK tool-result with
      `isError: true` and a clear text message on each):
      a. Empty / whitespace-only query → reject.
      b. `graphql.parse(query)` throws → reject with the
      parse error.
      c. Parsed AST has more than one operation → reject.
      d. Otherwise execute via the shared `LinearClient`
      (the same instance the tracker uses — injected via
      ClaudeAgent constructor).
    - Tool result content shape per SDK contract:
      `{ content: [{ type: 'text', text: JSON.stringify(payload) }], isError? }`
      where `payload = { success, data, errors, http_status }`
      per spec §10.5. The agent sees the structured payload as
      a JSON-stringified text block — common pattern in the
      SDK.
    - Crucially: do NOT throw on non-2xx Linear responses; the
      tool result `isError` flag and the JSON payload give the
      agent what it needs to decide. Throwing aborts the turn.
    - Unit tests: schema validation, GraphQL parse failures,
      empty queries, multi-operation rejection, 200 / 4xx / 5xx
      pass-through, auth header inheritance from the shared
      client.

7.  **Linear skill markdown** — ✅ **DONE 2026-04-29**.
    `packages/daemon/src/agent/claude/linear-skill.md`:
    - **Location decided**: lives next to the agent code that
      loads it. The SDK has no special path-based loading —
      we just `readFileSync` and pass the contents to
      `options.systemPrompt`. Co-locating with the consumer
      keeps reasoning about it simple.
    - One-page reference: which Linear types matter for our
      workflow (`Issue`, `IssueState`, `Comment`,
      `IssueRelation`); the four GraphQL operations the agent
      should know (`issue(id)` lookup, `commentCreate`,
      `issueUpdate`, `issueRelationCreate`); auth model is
      handled by the host — agent does NOT see the API key.
    - Safe defaults: comment when starting work; transition to
      `In Progress` on first substantive turn; comment on
      errors before exiting; never delete issues; never
      transition to terminal states without explicit instruction.
    - Loaded **once** at `ClaudeAgent` construction
      (`readFileSync` at module load) and passed via
      `options.systemPrompt` on **every** call — per spike
      findings, system prompt is not sticky across resumed
      sessions.

8.  **Composition root + config** — ✅ **DONE 2026-04-29**.
    - `packages/daemon/src/config/schema.ts` — `agent.kind`
      gains a `'claude'` variant. New fields: `agent.model`
      (default `claude-sonnet-4-5`). The SDK reads
      `ANTHROPIC_API_KEY` from `process.env` automatically, so
      we DON'T add `agent.api_key` to the schema — but the
      composition root MUST verify the env var is set before
      constructing `ClaudeAgent` and fail with a clear startup
      error if not (mirrors Plan 06's pattern).
    - `packages/daemon/src/index.ts` — wire `ClaudeAgent` when
      `agent.kind === 'claude'`. Inject the shared
      `LinearClient` so the tool reuses the tracker's transport.
    - Update `examples/linear/WORKFLOW.md` to include a
      commented-out `agent.kind: claude` block so users see
      how to switch from mock → real.

9.  **Smoke test against EDU-5** — ✅ **DONE 2026-04-29**. Three
    smoke runs against `EDU-5` ("Teste1"). The supporting code
    was launched against `examples/linear/WORKFLOW.md` with
    `agent.kind: claude` and `ANTHROPIC_API_KEY` set in `.env`.
    Every run surfaced a different correctness bug; each fix made
    the next run go further. By smoke #3 the agent posted three
    comments end-to-end ("starting work", "aloha", "completed"),
    successfully resumed the session on the orchestrator's
    continuation retry, and recognised "I've already done this"
    on subsequent dispatches. See the Decision log for per-run
    findings; in summary: **Bug 1** (orchestrator misclassified
    `turn_failed` as a normal exit), **Bug 2** (ClaudeAgent
    double-emitted terminals on post-result throws), **Bug 3**
    (`persistSession: false` made SDK resume permanently
    impossible), **Bug 4** (the `!yieldedAny` resume-failure
    detector was tripped by zero-token usage events). All four
    have unit tests.

    Total live spend across all three smokes ≈ \$0.20.

## Definition of done

- ✅ A live run against a real Linear issue with Claude Sonnet 4.5
  produces a real comment on that issue via the `linear_graphql`
  tool. Three comments posted on EDU-5 ("starting", "aloha",
  "completed") on 2026-04-29. See smoke run #3 in Decision log.
- ✅ Resume-across-turns works: smoke run #3 turn 2 dispatched
  with `resume_session="ac4876e4-..."`, SDK accepted the resume
  (same session id echoed in `session_started`), agent
  recognised "I've already completed the work on EDU-5" using
  prior conversation context. Multi-turn-with-resume validated
  end-to-end.
- ✅ Resume-failure fallback works: smoke run #3 turn 1
  attempted to resume the stale `4f7c8bd5-…` session left over
  from smoke #2. SDK rejected it; ClaudeAgent logged
  `claude_resume_failed_starting_fresh` and started a fresh
  session in the same turn. (Bug 4 fix.)
- ✅ Liquid prompt rendering fails loudly on typos —
  `prompt/render.ts` uses strict mode; covered by unit tests.
- ✅ Stall and turn timeouts fire correctly under simulated SDK
  delays — exercised by orchestrator stall-timeout tests with
  the MockAgent's tunable `turnDurationMs`.
- ✅ `pnpm test` passes — **299 tests**, all green (Plan 06
  baseline was 233; Plan 07 added 66).
- ✅ `pnpm deps:check` passes — `agent/claude/` does not import
  from `tracker/`, `orchestrator/`, etc.; only the composition
  root wires them together.
- ✅ ADR 0001 updated with the spike's clarifications and the
  four smoke-run bugs.

## Open questions

- ~~**Exact SDK function names.**~~ Resolved in spike: `query()`
  function returning `AsyncGenerator<SDKMessage>`. See
  `agent/claude/sdk-notes.md`.
- ~~**Skill loading mechanism.**~~ Resolved in spike: plain
  `options.systemPrompt: string`. No file-based loader. We
  `readFileSync` ourselves and pass the contents.
- ~~**Tool registration shape.**~~ Resolved in spike:
  `tool(name, desc, zodSchema, handler)` +
  `createSdkMcpServer(...)`. Tool name surfaces to agent as
  `mcp__linear__linear_graphql`.
- ~~**Model id.**~~ Resolved: `claude-sonnet-4-5` (alias).

## Risks adopted from SDK research

These come from the spike's "Risks & open items" section — kept
here so they're visible in code review and pre-flighted as
specific behaviors:

- **AbortController + resume bug (GitHub #69).** Aborting
  immediately after the SDK init message and then resuming the
  same `session_id` can fail. Mitigation: only abort on stall
  AFTER we see at least one non-init `SDKMessage`. If we abort
  earlier, log a WARN and treat the session as "must restart
  fresh next turn" — delete `session.json` so the next
  dispatch starts clean.
- **System prompt non-stickiness on resume.** Confirmed:
  always pass `systemPrompt` on every call, including on
  resumed sessions. Tested by including a sentinel marker in
  the skill markdown and asserting the agent honors it on
  turn 2.
- **V2 SDK is unstable.** We use the V1 stable `query()` API
  only. `unstable_v2_*` calls are explicitly OFF-LIMITS for
  this plan; flagged in code review.
- **Tool name collisions.** We register only one tool
  (`linear_graphql`) under the `linear` MCP server, surfacing
  as `mcp__linear__linear_graphql`. Built-in tool names
  (Read/Edit/etc.) are not affected. We pin the explicit
  qualified name in `allowedTools` to make accidental
  re-registration loud.
- **Per-host session storage.** SDK stores session state under
  `~/.claude/projects/<encoded-cwd>/`. This is fine for our
  local-machine plan; cross-host portability becomes a Plan 10
  (E2B devbox) concern, NOT a Plan 7 concern. Documented in
  Plan 10's open questions.
- **Token usage is per-turn only.** Confirmed: `usage` and
  `total_cost_usd` come on `SDKResultMessage`. Real-time
  per-event cost tracking would require a different SDK or
  proxying — out of scope.

## Decision log

- **2026-04-29 — Models: Sonnet 4.5 only.** No Haiku mixing for
  this plan. Reasoning: introducing two model tiers without a
  clear sub-task boundary just adds branching to the agent
  runner. We'll bring Haiku in when we have a real classifier-
  style sub-task (label normalization, change-summary
  generation), which doesn't exist until later plans. One
  cognitive cost at a time.

- **2026-04-29 — Session model: long-running thread per issue.**
  Same Linear issue across turns reuses the same Claude Agent
  SDK session ID; new issue starts fresh. Rationale: keeps the
  agent's reasoning continuity ("I tried X, didn't work, trying
  Y"), benefits from Anthropic's prompt cache when consecutive
  turns happen within the cache TTL, and matches the original
  Symphony's `thread.id` semantics. The alternative — fresh
  session every turn — was considered and deferred; the
  workspace already carries file state but cannot reconstruct
  _why_ the agent made decisions. Documented in ADR 0001.

- **2026-04-29 — Session ID persistence: per-workspace file.**
  Stored at `<workspace>/.symphony/session.json`. Why this
  location: (a) per-issue lifecycle matches the workspace's
  existing lifecycle; (b) survives daemon restarts because it's
  on disk, not in process memory; (c) cleaned up automatically
  when the workspace is removed (terminal-state cleanup
  already handles this); (d) inspectable by an operator for
  debugging. Alternatives rejected: in-memory `Map<IssueId, …>`
  (lost on restart), centralized SQLite (overkill for a single
  string per issue), Linear comment metadata (couples agent
  state to tracker, awkward).

- **2026-04-29 — Resume failure: graceful fallback to fresh.**
  If the SDK rejects a session ID (expired / unknown / corrupt
  file), the agent runner logs INFO and starts a fresh session.
  No retry, no propagation as a hard error. Reasoning: session
  resumption is an optimization, not a correctness invariant.
  The workspace + issue prompt are sufficient for the agent to
  make progress; the lost continuity costs us re-discovery, not
  a wrong answer.

- **2026-04-29 — Future: tree-of-agents for sub-issue
  decomposition.** Per-issue session is the right call for now,
  but the eventual "big orchestration mode" will let a parent
  agent decompose work into Linear sub-issues, each picked up
  as its own dispatch with its own scoped context. Rationale:
  context is a cost; you only pay for it where you need it.
  Sub-issues are the natural decomposition boundary because
  they're already first-class objects in the tracker. The
  parent has full memory; sub-agents get focused minimal
  prompts. Same pattern Anthropic uses for Claude Code's
  `Task` tool. NOT in scope for Plan 7 — we just leave the
  seam open by keeping `Agent` and `Tracker` as small
  interfaces.

- **2026-04-29 — Liquid templating: already implemented.**
  Plan 04 already shipped strict-mode Liquid rendering at
  `packages/daemon/src/agent/prompt.ts` (with
  `strictVariables: true` + `strictFilters: true`, typed
  `PromptRenderError`, golden tests). The orchestrator already
  passes the rendered prompt through `AgentRunInput.prompt`,
  so `ClaudeAgent` inherits it. No new code in Plan 7 — caught
  during Step 1 prep and trimmed from the plan to avoid
  duplicate work.

- **2026-04-29 — `linear_graphql` over hosted MCP.** Per ADR 0002. Custom tool, hand-rolled, validates input, reuses the
  same `LinearClient` as the tracker layer. The agent never
  sees the API key — host injects it via the shared client.

- **2026-04-29 — Skill file in markdown, not in code.** A
  one-page markdown file describing Linear semantics + safe
  defaults. Why markdown: (a) the agent reads it the way a
  human teammate would; (b) edits don't require a rebuild;
  (c) the same file can serve as documentation for human
  operators reading the repo. Per ADR 0002's "B + skill
  markdown" decision.

- **2026-04-29 — Reusing `LinearClient` between tracker and
  tool.** Single instance lives in the composition root,
  injected into both `LinearTracker` (read-only queries from
  daemon's polling loop) and the `linear_graphql` tool
  (queries + mutations from the agent). Same auth, same
  endpoint, same transport. The `linear_graphql` tool is just
  a thin "let the agent send arbitrary GraphQL through the
  same pipe". Single source of truth for Linear access.

- **2026-04-29 — One `Agent.run()` call = one SDK `query()`
  call = one turn.** Multi-turn lifecycle stays owned by the
  orchestrator's existing retry queue (Plan 5). We do NOT
  wrap multiple `query()` calls inside a single `Agent.run()`
  invocation. Why: (a) keeps the `AgentRunner` interface flat
  and matches MockAgent's lifecycle; (b) the orchestrator
  already has clean cancellation, stall detection, and
  reconciliation around `Agent.run()` boundaries; (c) the
  session ID file is the seam that gives us
  cross-`Agent.run()` continuity without coupling the agent
  to the orchestrator's loop.

- **2026-04-29 — `attempt` field semantics for resumption.**
  The orchestrator passes `attempt: null` on first dispatch
  and `attempt >= 1` on retries. Our resume rule is
  independent: ALWAYS try `resume` if `session.json` exists,
  regardless of `attempt`. Rationale: a session.json from a
  previous epoch (issue went terminal then re-opened) is
  still useful context if the SDK accepts it; if it rejects,
  graceful fallback runs. The `attempt` field is for
  retry-aware _prompting_ (template can say "this is your
  N-th attempt"), not for session continuity.

- **2026-04-29 — SDK research findings folded into plan.**
  Step 1 spike captured in
  `packages/daemon/src/agent/claude/sdk-notes.md` (525 lines,
  10 sections, all questions answered with citations). Plan
  steps 2–8 updated to reference concrete API names instead
  of placeholders. Six identified risks moved to a new
  "Risks adopted from SDK research" section so they're
  pre-flighted in code review.

- **2026-04-29 — System prompt is NOT sticky on resume.**
  Counter-intuitive finding from the spike: the SDK does not
  carry `systemPrompt` across resumed sessions. We pass it on
  every call. To verify this works as intended in our
  implementation, the smoke test will include a sentinel
  string in the skill markdown ("If asked, identify yourself
  as Symphony's resident assistant") and assert the agent
  honors it on turn 2 after resume.

- **2026-04-29 — V1 SDK only; V2 preview off-limits.** The
  spike noted `unstable_v2_*` APIs exist but are explicitly
  flagged as preview-only. We use the stable V1 `query()`
  function. If V2 stabilizes during our timeline, migration
  will be a separate plan with its own ADR.

- **2026-04-29 — `agent.kind` defaults to `mock` for
  back-compat.** Pre-Plan-7 `WORKFLOW.md` files (and the CI
  fixtures in `examples/`) don't set `agent.kind` at all. The
  composition root reads `(config.agent.kind ?? 'mock')` so
  those configurations keep using `MockAgent` without edits.
  Switching to real Claude is opt-in: add `agent.kind: claude`.

- **2026-04-29 — Skill markdown copied into `dist/` at build.**
  `linear-skill-loader.ts` does a `readFileSync` against a
  path resolved from `import.meta.url`. To make this work for
  both `tsx` dev runs (which read from `src/`) and the built
  `node dist/index.js` startup path, the daemon's `postbuild`
  script copies `src/agent/claude/linear-skill.md` into
  `dist/agent/claude/`. The root `build` script invokes
  `pnpm -r run --if-present postbuild` after `tsc --build`, so
  the copy is part of the standard build pipeline. Inlining
  the markdown as a TS string was rejected: the file doubles
  as human documentation, and a generator would create a
  "did-you-regenerate?" footgun.

- **2026-04-29 — Single `LinearClient` wired by composition
  root.** Both the `LinearTracker` (read-only polling) and the
  `ClaudeAgent`'s `linear_graphql` tool (read+write) receive
  the SAME `LinearClient` instance, constructed once in
  `index.ts`. `maybeBuildLinearClient` materializes it iff
  either side needs it (so the FakeTracker + MockAgent path
  stays offline and key-free). This realizes the "single
  source of truth for Linear access" principle from ADR 0002
  in actual code rather than just intent.

- **2026-04-29 — `ANTHROPIC_API_KEY` checked in composition
  root, NOT in schema.** The Claude Agent SDK reads the env
  var itself; we don't add `agent.api_key` to the schema (per
  Plan 7 step 8). But the composition root performs an
  explicit pre-flight check for a non-empty `ANTHROPIC_API_KEY`
  and refuses to construct `ClaudeAgent` without one,
  surfacing a single, obvious startup error instead of letting
  the failure surface mid-turn.

- **2026-04-29 — Smoke run #1 against EDU-5: surfaced two bugs,
  both fixed.** First live `agent.kind: claude` run with a
  zero-credit Anthropic account. Pipeline worked end-to-end
  (composition root → ClaudeAgent → SDK call → event mapping
  → session save), but two correctness bugs showed up that
  the test suite didn't catch:
  - **Bug 1 — orchestrator misclassified `turn_failed` as a
    normal exit, scheduling a 1-second continuation retry
    instead of failure-tier backoff.** The worker's `exitReason
= 'abnormal'` was set only when `agent.run()` _threw_; an
    agent that yielded a `turn_failed` event and returned
    cleanly was treated identically to a successful run. With
    a 5s poll and 1s continuation delay this becomes a tight
    retry loop on persistent failures (we burned through ~5 SDK
    calls before Ctrl-C). **Fix:** the orchestrator's worker
    now tracks the last terminal event emitted by the agent
    and flips `exitReason` to `'abnormal'` when it's
    `turn_failed`. New tests in
    `orchestrator-plan07-events.test.ts` pin both directions —
    a `turn_failed` schedules failure-tier backoff (10s first
    attempt), a `turn_completed` still gets the continuation
    retry.

  - **Bug 2 — `ClaudeAgent` violated the single-terminal
    invariant.** The SDK yielded a `result subtype=success`
    with empty usage when credits were exhausted, then the
    underlying CLI exited nonzero and surfaced as a thrown
    error. Old code yielded both a `turn_completed` (from the
    "success" result) AND a synthetic `turn_failed` (from the
    catch block) — two terminals per run, against the SPEC
    contract. **Fix:** `ClaudeAgent` now BUFFERS the SDK's
    terminal event instead of forwarding immediately. On clean
    iteration end the buffered terminal is yielded as-is. On a
    post-result throw the buffered terminal is discarded and a
    `turn_failed` is yielded with the throw's reason —
    treating the throw as the more authoritative signal about
    whether the turn actually succeeded. Logged as
    `claude_post_terminal_error_reclassified` for ops
    visibility. New tests in `agent.test.ts` pin both the
    reclassification and the happy-path regression.

  Together these turn a real-money smoke from "loops 5x in 30
  seconds, double-terminals every run" into "one failure-tier
  retry with a 10s backoff, exactly one terminal per run".

- **2026-04-29 — `WORKFLOW.md` hardened for the live smoke.**
  Updated `examples/linear/WORKFLOW.md`:
  - `polling.interval_ms`: 5000 → 30000 (slow enough to
    Ctrl-C between turns).
  - `tracker.active_states`: `[Todo, "In Progress"]` → `[Todo]`
    initially, then reverted back to `[Todo, "In Progress"]` —
    see smoke run #2 below.
  - `agent.max_concurrent_agents`: 2 → 1 (queue rather than
    fan out across multiple issues during the smoke).
  - `agent.turn_timeout_ms`: 5000 → 120000;
    `read_timeout_ms`: 1000 → 30000 (the Plan 06 values were
    MockAgent-tier and would expire mid-turn for real Claude).
  - Plan 06's `after_create` hook is commented out — having
    both the hook and the agent post Linear comments was
    confusing, and the agent itself is now the canonical
    write-back path.

- **2026-04-29 — Smoke run #2 against EDU-5: smoke PASSED, surfaced
  one more bug + one more workflow lesson.** With Bug 1 + Bug 2 fixes
  applied and credits topped up, the agent successfully posted
  "aloha" on EDU-5 (turn 2, 35.3s, $0.064, 1058 tokens). Both new
  fixes were observed in production: the Bug 1 retry-tier routing
  picked failure-tier (10s) not continuation-tier (1s), and the Bug
  2 reclassification of post-result throws fired correctly on the
  follow-up retry. Two new findings:
  - **Bug 3 — `persistSession: false` makes `resume:` permanently
    impossible.** Every dispatch after the first tried to resume
    via `session.json` and got rejected by the SDK with `"No
conversation found with session ID: <id>"`. Root cause: the
    SDK's `resume:` option looks the session up in its OWN
    `~/.claude/projects/` store, and we'd explicitly disabled
    that store. The original "belt-and-suspenders" comment was
    wrong — disabling SDK persistence isn't defensive, it's
    self-defeating. **Fix:** removed `persistSession: false`
    from the `query()` options in `agent.ts`. The SDK now
    persists sessions in `~/.claude/projects/` (its default
    behavior); our `session.json` remains a workspace-local
    pointer to "the latest session id for this issue", and the
    SDK holds the full transcript. New regression test in
    `agent.test.ts` pins that we never re-introduce
    `persistSession: false`.

  - **Workflow lesson — `active_states: [Todo]` is incompatible
    with agents that self-transition.** With only `Todo`
    eligible, the agent's own first-turn transition to "In
    Progress" caused SPEC §8.5 reconciliation to cancel the
    in-flight worker mid-turn — killing the run before it could
    post its work-product. Reverted to `[Todo, "In Progress"]`.
    The right stop condition for a one-shot smoke is either
    (a) Ctrl-C after the agent posts the closing comment, or
    (b) instruct the agent in the prompt body to move the issue
    to a terminal state (e.g. Done) once finished. The
    workflow's comment now warns about this trap.

  Outcome of the full smoke (turn-by-turn):
  1. Turn 1: agent transitioned Todo→In Progress, then got
     self-cancelled by reconciliation (workflow lesson, before
     the revert).
  2. Turn 2: clean run after the workflow hot-reload — agent
     posted "aloha", `turn_completed`, `worker_exit reason="normal"`,
     1s continuation retry scheduled.
  3. Turn 3 (the continuation retry): tried to resume the
     just-completed session, SDK rejected with
     "No conversation found" → Bug 3 surfaced. Bug 1 fix
     correctly routed this to failure-tier (10s) backoff
     instead of a tight loop.

  Three bugs found, three bugs fixed; total smoke spend ≈ \$0.06.
  Resume is now enabled but unproven against the live SDK —
  next smoke (after switching `persistSession: false` off) will
  exercise the multi-turn-resume path end-to-end.

- **2026-04-29 — Smoke run #3 against EDU-5: surfaced Bug 4 in the
  resume-failure detector.** Stale `session.json` from smoke run #2
  (sessionId `4f7c8bd5-…`) plus the just-deployed Bug 3 fix gave us
  a clean repro: Anthropic-side, the session was never persisted
  (because Bug 3 was live during smoke #2), so the smoke-#3
  dispatch tried to resume it, got rejected, and the agent failed
  to fall back to a fresh session — every retry burned an SDK call
  with "No conversation found with session ID: 4f7c8bd5-…".
  - **Bug 4 — `!yieldedAny` is the wrong "resume never started"
    signal.** The `ClaudeAgent` catch-block check
    `resumeWith !== null && !yieldedAny` was meant to trigger a
    fresh-session retry when the SDK rejected resume before any
    real conversation began. But the SDK's rejection path emits a
    `result subtype=error_*` message that our event mapper splits
    into a `usage` event (yielded immediately, sets
    `yieldedAny=true`) AND a `turn_failed` (buffered by the Bug 2
    fix). So `yieldedAny` was always true on resume failure, the
    catch fell through to the post-terminal reclassify branch, and
    the consumer saw a `turn_failed` instead of a transparent
    fallback. **Fix:** swapped the condition to
    `observedSessionId === null` — `system: init` only emits when
    the SDK has actually accepted the session, so a null
    `observedSessionId` after iteration (whether the iteration
    threw or closed cleanly) is a reliable "resume never started"
    signal. Also added the same check for the iteration-completed-
    cleanly-with-buffered-`turn_failed` case, so resume failures
    via either path now retry without resume. New regression test
    in `agent.test.ts` (Bug 4) pins the result-error + post-throw
    repro and asserts the consumer never sees the rejected
    resume's `turn_failed`.

  Four bugs found and fixed across three smoke runs. Live spend
  to date ≈ \$0.10. The interaction of Bug 2 (buffered terminal)
  and the legacy `!yieldedAny` check was the underlying cause —
  Bug 2 hid Bug 4 behind a "looks-like-real-output" false signal,
  and Bug 4 hid Bug 3's recovery path. Worth an ADR if a similar
  pattern surfaces again: **buffered terminals interact with
  retry signals; switch retry signals to track structural
  invariants (did the SDK initialize a session?) rather than
  observable side-effects (did we yield anything?).**
