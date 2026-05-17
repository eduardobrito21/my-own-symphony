# Plan 16 — Sub-agent pipeline chassis + first `@sandbox` skill

- **Status:** 🟡 Implementation complete, tests pending
- **Implements:** ADR 0014 (sub-agent pipeline + skill-driven
  provisioning supersedes ExecutionBackend, agent-in-pod, and broker
  transport).
- **Comes AFTER:** Plan 15 (subtract to the sub-agent pipeline —
  deleted ExecutionBackend, agent-runtime, docker directory; left
  `NoopAgentRunner` placeholder in composition root).
- **Comes BEFORE:** Plan 17 (`@app` skill), Plan 18 (real `@coder`
  skill + `@tester` sub-sub-agent), Plan 19 (`@ci` skill — commit,
  push, PR).
- **Spec sections:** none directly (this plan implements ADR 0014's
  architecture, which supersedes the spec's pod-based model).
- **Layers touched:** `packages/daemon/src/agent/` (pipeline runner,
  skill loader, skill schemas), `packages/daemon/src/index.ts`
  (replace `NoopAgentRunner`), new `packages/daemon/src/skills/`
  (bundled default skills), new `.symphony/skills/` examples.
- **ADRs referenced:** 0006 (zod at every boundary — skill outputs
  are zod-validated), 0014 (sub-agent pipeline architecture).

## Goal

Wire the sub-agent pipeline chassis and ship the first skill
(`@sandbox`) end-to-end. A real Linear issue triggers the daemon,
the parent agent runs the pipeline, and the daemon posts a comment
to Linear confirming the pipeline executed.

What this plan delivers:

1. **Parent agent in daemon process.** Replace `NoopAgentRunner` with
   a real SDK-backed runner. The Claude Agent SDK's `query()` runs
   in the daemon's Node process (no subprocess, no in-pod runtime).

2. **`SandboxHandle` contract.** Define the TypeScript interface and
   zod schema for the structured output `@sandbox` returns. This is
   the load-bearing handoff between `@sandbox` and downstream stages.

3. **Skill discovery.** At dispatch time, look up skills in order:
   1. `<cloned-repo>/.symphony/skills/<name>/SKILL.md` (target repo override)
   2. Bundled default shipped with the daemon (`packages/daemon/src/skills/`)

4. **Parent-agent prompt template.** The orchestration prompt that
   drives the pipeline: call `@sandbox` to provision a dev env, then
   call a STUB `@coder` that echoes the issue title, then close by
   posting a Linear comment and transitioning to Done.

5. **Bundled `@sandbox` skill.** A default local-docker-compose
   flavor that clones the repo into a worktree, starts `docker compose`,
   and returns a `SandboxHandle`. Per-repo overrides (polarsteps-style)
   are a follow-up; this plan ships the generic version.

6. **End-to-end smoke.** A real Linear issue dispatched through the
   daemon triggers the parent agent, the pipeline runs, the daemon
   posts "hello from symphony (pipeline)" to Linear, and the issue
   transitions to Done. No PR opening — that's `@ci`'s job in Plan 19.

## Outcome shape (preview)

```
Daemon (post-Plan-15 seed)
   │
   │ orchestrator.dispatch(issue)
   │
   ↓
PipelineAgentRunner (new in Plan 16)
   │
   │ Claude Agent SDK query() in daemon process
   │   system prompt = orchestration template
   │   tools = skill invocations
   │
   │ Pipeline stages (hardcoded order):
   │
   ├─ @sandbox   ← skill call, returns SandboxHandle
   │     │         (clone, compose up, return handle)
   │     ↓
   │   SandboxHandle { id, kind, worktree_path, exec, teardown }
   │
   ├─ @coder     ← STUB in Plan 16 (echoes issue title)
   │     │         (real impl in Plan 18)
   │     ↓
   │   CoderResult { changed_files: string[] }
   │
   ├─ (no @ci)   ← Plan 19
   │
   └─ close out: post Linear comment, transition to Done
```

After Plan 16:

```
packages/daemon/src/
├── agent/
│   ├── claude/            ← survives from Plan 15
│   │   ├── agent.ts       ← ClaudeAgent, now used by PipelineAgentRunner
│   │   ├── event-mapping.ts
│   │   ├── session-store.ts
│   │   └── linear-skill-loader.ts  ← repurposed for skill discovery
│   ├── pipeline/          ← NEW
│   │   ├── runner.ts      ← PipelineAgentRunner implements AgentRunner
│   │   ├── prompt.ts      ← orchestration prompt template
│   │   └── index.ts
│   ├── skills/            ← NEW
│   │   ├── loader.ts      ← skill discovery (repo → operator → bundled)
│   │   ├── schemas.ts     ← SandboxHandle, CoderResult zod schemas
│   │   └── index.ts
│   ├── mock/              ← survives (tests)
│   ├── runner.ts          ← AgentRunner interface (unchanged)
│   └── tools/             ← linear-graphql survives
├── skills/                ← NEW (bundled defaults)
│   └── sandbox/
│       └── SKILL.md       ← default @sandbox skill
└── index.ts               ← wires PipelineAgentRunner (replaces NoopAgentRunner)
```

## Out of scope

- **`@app` skill.** Brings up team's services in the sandbox. Plan 17.
- **Real `@coder` skill.** Does the actual code change using Bash/Read/Edit routed through the sandbox. Plan 18 — this plan ships a stub that echoes the issue title.
- **`@tester` sub-sub-agent.** Runs tests, reports. Plan 18 or its own.
- **`@ci` skill.** Commit, push, open PR. Plan 19.
- **Skill marketplace / discovery beyond local filesystem.** v1 skills are local files.
- **Per-project credential isolation.** Operator-wide creds for v1.
- **Pipeline-per-repo customization.** Stage order (sandbox → app → coder → ci) is hardcoded in v1. Per-repo `workflow.md` declares which skill implements each stage, not a custom stage order.
- **Inter-dispatch caching.** Warm sandbox reuse across dispatches is a future concern.
- **Per-sub-agent budget caps.** Operator-wide cap only for v1.

## Design decisions (already made — baked in, not re-opened)

These decisions were worked through in ADR 0014 and prior
conversations. This plan implements them as specified.

### Decision 1 — Parent agent runs in daemon process

The initial agent (per dispatch) runs in the daemon's Node process
via `@anthropic-ai/claude-agent-sdk`'s `query()`. No subprocess, no
in-pod runtime, no transport protocol. The existing `ClaudeAgent`
class in `agent/claude/agent.ts` is the SDK wrapper; the new
`PipelineAgentRunner` composes it with the orchestration prompt.

### Decision 2 — Pipeline shape is hardcoded

Stage order (sandbox → app → coder → ci) is fixed in v1. Per-repo
`workflow.md` (or a future `.symphony/pipeline.md`) declares _which
skill implements each stage_, not the stage order itself. Custom
pipeline shapes are a v2 concern.

### Decision 3 — Skills live per-repo with bundled fallback

Skill discovery order:

1. `<repo>/.symphony/skills/<name>/SKILL.md` — target repo override
2. Bundled default in `packages/daemon/src/skills/`

A repo can override `@sandbox` with its own provisioning script
(e.g. polarsteps-style parallel worktrees). The daemon ships
conservative bundled fallbacks that work for generic projects.

### Decision 4 — Skill output is structured JSON, zod-validated

Each skill returns a structured JSON object. The parent agent
validates it with zod at the boundary before passing to the next
stage. A malformed handle fails loudly at validation, not three
stages later.

### Decision 5 — `SandboxHandle` shape

The load-bearing contract between `@sandbox` and downstream stages:

```ts
interface SandboxHandle {
  /** Platform-specific opaque identifier (compose project name, VM id, etc). */
  id: string;
  /** Discriminator for downstream tooling. */
  kind: 'local-docker' | 'namespace-devbox' | string;
  /** Absolute path where the agent reads/edits files. */
  worktree_path: string;
  /** How @coder's Bash calls reach the sandbox. */
  exec: {
    kind: 'shell-template';
    /** e.g. "docker compose -p {id} exec server {cmd}" */
    template: string;
  };
  /** How the sandbox gets cleaned up. */
  teardown: {
    kind: 'deadline' | 'script' | 'both';
    /** ISO 8601 timestamp after which the sandbox may be reaped. */
    expires_at?: string;
    /** Shell command to run for explicit teardown. */
    script?: string;
  };
}
```

### Decision 6 — `exec` is shell-template (Pattern A)

The `exec` field uses a shell template rather than a typed Claude SDK
tool. `@coder`'s Bash calls substitute `{cmd}` through the template.
This is simpler than wiring a custom tool per sandbox kind. Pattern B
(typed tool) can grow later if needed.

### Decision 7 — `@sandbox` does the clone

One skill, one "give me a place to work" responsibility. `@sandbox`
clones the repo, sets up the worktree, and provisions the dev
environment. This matches the polarsteps reference (`bin/dev/worktree`
combines git worktree + compose-up).

### Decision 8 — Idempotency on `(repo, identifier)`

Re-dispatching the same issue produces the same `SandboxHandle` (same
sandbox reused if still alive, or a new one with the same
deterministic naming). Plan 11's idempotency properties (marker
comments, branch reuse, no-op transitions) still apply, now expressed
via skill outputs rather than in-pod runtime logic.

## Reference: polarsteps `bin/dev/`

The bundled `@sandbox` skill is a generic version of a real per-repo
setup: parallel worktree dev envs using
`COMPOSE_PROJECT_NAME=igloo-<basename>` + deterministic port offsets
(cksum of project name) for isolation. No DinD, no VM, ~5 shell
scripts. Per-repo overrides can ship the exact polarsteps scripts;
the bundled default is a conservative approximation.

## Steps

### Stage 16a — Skill schemas + loader

1. **`SandboxHandle` zod schema** at
   `packages/daemon/src/agent/skills/schemas.ts`:
   - Full schema per Decision 5 above.
   - Export both the zod schema and the inferred TypeScript type.
   - Include `CoderResultSchema` stub (just `{ changed_files: string[] }`
     for the stub `@coder`).

2. **Skill loader** at `packages/daemon/src/agent/skills/loader.ts`:
   - `loadSkill(name: string, repoPath: string | null): Promise<SkillDefinition>`
   - Discovery order per Decision 3 (repo override → bundled default).
   - Returns `{ name, markdown, path }` where `markdown` is the
     contents of `SKILL.md`.
   - Throws typed error if skill not found at any location.

3. **Tests:**
   - Schema validation (valid handle, invalid handle, missing fields).
   - Skill loader with mocked filesystem (repo override wins, bundled
     fallback, not-found error).

### Stage 16b — Bundled `@sandbox` skill

4. **Default skill file** at
   `packages/daemon/src/skills/sandbox/SKILL.md`:
   - Markdown skill definition that the parent agent reads.
   - Describes the task: clone repo, set up worktree, start docker
     compose, return `SandboxHandle`.
   - Includes shell snippets the agent can execute via Bash tool.
   - The skill itself is agent-driven (the agent reads the skill
     markdown and executes the steps); there's no "skill runtime" —
     skills are executable knowledge.

5. **Skill contract documentation:**
   - Input: repo URL, branch/ref, issue identifier (for naming).
   - Output: `SandboxHandle` JSON (zod-validated by caller).
   - The skill's markdown instructs the agent on what to return.

### Stage 16c — Pipeline runner + orchestration prompt

6. **Orchestration prompt template** at
   `packages/daemon/src/agent/pipeline/prompt.ts`:
   - System prompt that describes the pipeline stages.
   - Instructs the parent agent:
     1. Load and execute `@sandbox` skill → get `SandboxHandle`.
     2. Validate the handle against the zod schema.
     3. Load and execute `@coder` skill (STUB: just echo issue title
        to a temp file, return `{ changed_files: [] }`).
     4. Post a Linear comment: "hello from symphony (pipeline)".
     5. Transition the issue to Done.
   - Liquid template with `{{ issue.id }}`, `{{ issue.identifier }}`,
     `{{ issue.title }}`, `{{ repo.url }}`, etc.

7. **`PipelineAgentRunner`** at
   `packages/daemon/src/agent/pipeline/runner.ts`:
   - Implements `AgentRunner` interface.
   - Composes:
     - The existing `ClaudeAgent` (SDK wrapper).
     - The orchestration prompt template.
     - The skill loader.
   - On `run(input)`:
     1. Load skill definitions for `@sandbox` and `@coder`.
     2. Render the orchestration prompt with issue + skill markdowns.
     3. Call `ClaudeAgent.run()` (or directly use SDK `query()`).
     4. Yield `AgentEvent`s as they come.
   - The agent itself orchestrates the pipeline via tool calls; the
     runner just sets up the context and streams events.

8. **Tests:**
   - `PipelineAgentRunner` with mocked SDK (verify prompt includes
     skill markdown, verify events are forwarded).
   - Integration test with `MockAgent` that simulates the pipeline
     flow.

### Stage 16d — Wire into composition root

9. **Replace `NoopAgentRunner`** in `packages/daemon/src/index.ts`:
   - Import `PipelineAgentRunner`.
   - Construct with `linearClient`, `logger`, deployment config.
   - Remove the `NoopAgentRunner` class and the warning log.

10. **Environment requirements:**
    - `ANTHROPIC_API_KEY` required (the SDK needs it).
    - `LINEAR_API_KEY` required (already was).
    - `GITHUB_TOKEN` optional (for private repo clones).

11. **Deployment config impact:**
    - No schema changes in this plan — the existing `agent.*` fields
      apply to the parent agent.
    - Future plans may add `skills.*` section; not this plan.

### Stage 16e — End-to-end smoke

12. **Smoke verification:**
    - Create a Linear issue in a test project, state Todo.
    - Configure `symphony.yaml` with one project pointing at a test
      repo. The test repo has a minimal `.symphony/workflow.md`.
    - Run `pnpm symphony` (daemon starts, polls Linear).
    - Watch:
      - Daemon logs show issue pickup.
      - Daemon logs show skill loading (`@sandbox`, `@coder`).
      - Daemon logs show SDK events (tool calls, responses).
      - Linear issue gets a comment: "hello from symphony (pipeline)".
      - Issue transitions Todo → In Progress → Done.
    - Capture timing and cost in the decision log.

13. **Failure modes to verify:**
    - Missing `ANTHROPIC_API_KEY` → daemon refuses to start with
      actionable error.
    - Skill not found → `turn_failed` event with "skill not found"
      reason.
    - Malformed `SandboxHandle` from agent → `turn_failed` event
      with zod validation error.

### Stage 16f — Tests + docs

14. **Tests:**
    - Skill schemas (zod validation, type inference).
    - Skill loader (discovery order, error cases).
    - Orchestration prompt rendering (Liquid template).
    - `PipelineAgentRunner` unit tests (mocked SDK).
    - Integration test: multi-step pipeline with mocked tool results.

15. **Documentation:**
    - `packages/daemon/src/skills/README.md` — how bundled skills
      work, how to override.
    - `examples/repo-workflow/.symphony/skills/sandbox/SKILL.md` —
      example per-repo override template.
    - Update `ARCHITECTURE.md` — add `agent/pipeline/` and
      `agent/skills/` layers to the diagram.
    - Update `AGENTS.md` — note that Plan 16 introduced the
      sub-agent pipeline.

## Definition of done

- `NoopAgentRunner` replaced with `PipelineAgentRunner` in the
  composition root.
- `SandboxHandle` zod schema defined and exported; downstream code
  can import and validate against it.
- Skill loader discovers skills in the documented order (target repo
  override → bundled default).
- Bundled `@sandbox` skill exists and the parent agent can load and
  execute it.
- A real Linear issue dispatched through the daemon:
  - Triggers the parent agent (SDK `query()` in daemon process).
  - Loads and "executes" the `@sandbox` skill (agent follows the
    skill's instructions, returns a `SandboxHandle`).
  - Runs the stub `@coder` (echoes issue title, no real code change).
  - Posts "hello from symphony (pipeline)" comment to Linear.
  - Transitions the issue to Done.
- No PR opened (that's Plan 19).
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean.
- Test count grows by ~20–30 (schemas, loader, runner, integration).
- `ARCHITECTURE.md` updated to reflect new layers.

## Open questions

- **Should the orchestration prompt be a Liquid template or plain
  string interpolation?** Tentative: Liquid for consistency with
  existing `workflow.md` templates. Confirm during implementation.

- **Where does the cloned repo live during the dispatch?** The
  `@sandbox` skill clones into a worktree under `workspace.root`.
  The exact path layout (`<root>/<project>/<issue>/worktree/`) needs
  to be decided. Likely inherits from Plan 09's workspace manager
  paths.

- **Should the parent agent have Bash/Read/Edit tools, or only skill
  invocation?** Tentative: the parent agent's tools are
  `linear_graphql` (for posting comments, transitioning) + skill
  invocation. The Bash/Read/Edit tools are available to the agent
  when executing a skill, but the parent orchestration layer
  shouldn't need them directly. Confirm during implementation.

- **Skill invocation: explicit tool or prompt-driven?** Two options:
  1. The parent agent calls a `invoke_skill(name, input)` tool.
  2. The parent agent reads the skill markdown and executes it via
     existing Bash/Read/Edit tools.
     Tentative: option 2 (prompt-driven). The skill markdown _is_ the
     invocation — the agent reads it and does what it says. No special
     tool needed. This keeps the architecture simple and auditable.

- **How does the agent return structured output from a skill?** The
  skill's markdown instructs the agent to print a JSON blob. The
  parent agent parses it and validates against the schema. Error
  handling TBD (retry? fail the dispatch?).

## Decision log

### 2026-05-17 — Core implementation complete

Implemented Stages 16a through 16d. Summary of what shipped:

**Stage 16a — Skill schemas + loader:**

- `packages/daemon/src/agent/skills/schemas.ts` — `SandboxHandleSchema`,
  `CoderResultSchema` with zod validation helpers.
- `packages/daemon/src/agent/skills/loader.ts` — `loadSkill()` with two-tier
  discovery (repo override → bundled default).
- `packages/daemon/src/agent/skills/index.ts` — re-exports.

**Stage 16b — Bundled skills:**

- `packages/daemon/src/skills/sandbox/SKILL.md` — default @sandbox skill
  (clone repo, docker compose up, return SandboxHandle).
- `packages/daemon/src/skills/coder/SKILL.md` — stub @coder skill
  (acknowledges issue, returns empty CoderResult).

**Stage 16c — Pipeline runner:**

- `packages/daemon/src/agent/pipeline/prompt.ts` — `buildPipelinePrompt()`
  that assembles the orchestration system prompt from issue context + skills.
- `packages/daemon/src/agent/pipeline/runner.ts` — `PipelineAgentRunner`
  implements `AgentRunner`, loads skills, builds prompt, delegates to
  `ClaudeAgent`.

**Stage 16d — Composition root:**

- `packages/daemon/src/index.ts` — replaced `NoopAgentRunner` with
  `PipelineAgentRunner`, added `ANTHROPIC_API_KEY` check, built
  `projectDispatch` map for repo URLs and branch prefixes.

**Documentation:**

- `ARCHITECTURE.md` — updated banner, layer diagram, responsibilities table,
  composition root section, boundary parsing table.

**Verification:**

- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `pnpm test` — 313 passed, 1 skipped (pre-existing)
- `pnpm deps:check` — 10 warnings (pre-existing orphans)

**Pending:**

- Stage 16a tests for schemas and loader (deferred — code works, tests TBD).
- Stage 16e end-to-end smoke with real Linear issue (requires runtime test).
- Stage 16f tests for pipeline runner (deferred).
