# Tech debt tracker

A single living document for known imperfections that we have chosen
**not** to fix yet — and the trigger that would change that.

Format per entry:

- **What:** the actual debt.
- **Where:** file paths or layer names.
- **Why we accept it:** the tradeoff.
- **Trigger to revisit:** the concrete condition that would prompt a fix.

This file is append-only during normal operation. When a debt is paid
down, move the entry to a "Paid" section at the bottom with a date.

## Active

### Post-hoc `findSandboxHandleInText` validator is now belt-and-suspenders

- **What:** A regex + zod pass that scans the parent agent's
  accumulated assistant text for a fenced JSON code block matching
  `SandboxHandleSchema`. Post-Plan-18a it isn't load-bearing — sub-
  agent text flows through via `forwardSubagentText: true`, and the
  SDK emits structured `task_notification` events with `status`
  values `completed | failed | stopped` per sub-agent. The right
  replacement is stage-level success tracking off those events.
- **Where:** `packages/daemon/src/agent/pipeline/validation.ts` +
  its call site in `pipeline/runner.ts`.
- **Why we accept it:** Only one live smoke under the new pipeline
  shape (EDU-16, 2026-05-17). Removing the safety net standalone
  buys nothing concrete; replacing it with `task_notification`
  status checks is the right move but bundles into a future runner
  refactor.
- **Trigger to revisit:** Whichever plan next touches
  `pipeline/runner.ts` (most likely Plan 18b or the unwritten
  Plan 18 — real `@coder` + `@tester`). Drop the text scanner and
  add status-driven stage tracking as part of that work.
- **Source:** Plan 18a decision log + the close-out discussion.

### `nsc ssh <id> <cmd>` exit codes don't propagate to the caller

- **What:** When a command run via `nsc ssh` exits with code `N`,
  the local `nsc ssh` invocation always exits `1`. The real code
  is only visible in stderr (`Failed: Process exited with status
N`). Today the bundled `namespace-create.sh` relies on `set -e`
  pass/fail semantics, which works for "did the remote run
  succeed?" but blocks any future feature that needs the actual
  exit code.
- **Where:** `packages/daemon/src/skills/sandbox/scripts/namespace-create.sh`
  (in its own use); will become more pressing in future `@coder`
  and `@ci` skills that route through `sandbox_handle.exec.template`
  on remote sandboxes.
- **Why we accept it:** Discovered during the 2026-05-17 `nsc`
  probe (Plan 17a). For the MVP `@sandbox` script we only need
  binary pass/fail, which `set -e` handles. Real exit-code
  propagation is a downstream `@coder` / `@ci` concern.
- **Trigger to revisit:** Plan 18b (sandbox-aware tools / agent-
  in-sandbox per ADR 0015) or Plan 19 (`@ci` on remote sandboxes).
  Either will need a sentinel pattern — wrap the remote command
  to echo a known marker plus `$?` and parse it back on the
  daemon side.
- **Source:** Plan 17a "Open questions" + decision log probe
  results.

### Liquid template cache doesn't invalidate on workflow reload

- **What:** The Liquid engine in `agent/prompt.ts` is constructed
  with `cache: true` for per-issue render performance across one
  poll tick. If the operator edits a workflow body mid-tick (or
  the file watcher reloads it between renders), the cached parse
  tree won't reflect the change until the engine is reconstructed.
- **Where:** `packages/daemon/src/agent/prompt.ts` — Liquid engine
  constructor.
- **Why we accept it:** Workflow files reload at most every 30s
  in practice (polling interval) and operator edits are rare in
  production. Cache hits dominate the cost path; invalidation
  adds bookkeeping (mtime tracking, engine reset on watcher
  events) that hasn't paid for itself.
- **Trigger to revisit:** First operator-reported "I edited
  workflow.md and the agent is still using the old prompt." Zero
  reports through Plan 18a; this is precautionary.
- **Source:** Plan 02 (workflow loader + prompt renderer).

### POSIX-only shell for `before_run` / `after_run` hooks

- **What:** Workspace hook execution shells out via `bash -lc
'<script>'`. Windows isn't supported; hook scripts must be
  POSIX-compatible (no PowerShell, no `cmd.exe`).
- **Where:** `packages/daemon/src/workspace/hooks.ts` — `runHook`.
- **Why we accept it:** Documented in `SECURITY.md` under "Trust
  posture." Symphony's stated v1 audience is macOS + Linux
  operators; cross-platform shell selection adds real test
  surface for zero current users.
- **Trigger to revisit:** First Windows-host operator request.
  None to date.
- **Source:** Plan 03 (workspace manager).

### Retry backoff is exponential without jitter

- **What:** `computeDelay(attempt) = min(10000 * 2^(attempt - 1),
maxRetryBackoffMs)`. No randomization — N concurrent failures
  retry at the same wall-clock moment, creating a thundering
  herd at the upstream (Linear, Anthropic, GitHub).
- **Where:** `packages/daemon/src/orchestrator/retry.ts` —
  `computeDelay`.
- **Why we accept it:** Single-operator deployments dispatch 1–5
  issues concurrently. Real-world herd-size is too small to
  measure the effect; jitter adds complexity and a non-determinism
  surface in tests.
- **Trigger to revisit:** First production deployment with 50+
  concurrent dispatches. Or any sign of correlated upstream 429s
  during retry storms.
- **Source:** Plan 05 (retries, reconciliation, reload).

### Prompt rendering lives in `agent/` rather than its own layer

- **What:** The Liquid template renderer (`agent/prompt.ts`) is
  conceptually shared between the orchestrator (dry-runs, config
  validation) and the agent dispatcher. Today it sits inside the
  `agent/` package, which makes the dependency arrow from
  orchestrator → agent point the "wrong" way for that single
  use.
- **Where:** `packages/daemon/src/agent/prompt.ts`.
- **Why we accept it:** Plan 02 deferred the question
  explicitly. Only one cross-layer caller; promoting to its own
  layer for a single non-canonical consumer is premature
  abstraction.
- **Trigger to revisit:** A third caller appears (CLI render-
  debug tool, sub-skill that needs partial re-render, etc.). At
  that point it's clearly its own layer and we move it cleanly.
- **Source:** Plan 02 "Open questions."

### SDK session persistence lives in `~/.claude/projects/` — not part of the SDK's public API

- **What:** `@anthropic-ai/claude-agent-sdk` stores per-session
  state under `~/.claude/projects/<encoded-cwd>/`. Symphony's
  per-workspace `session.json` is a thin pointer to the latest
  session id; resume needs the SDK's directory to also exist
  intact. The path is an internal SDK convention, not a
  documented contract.
- **Where:** `packages/daemon/src/agent/claude/session-store.ts`
  and `agent.ts`'s resume path — two parallel sources of truth
  for session ids.
- **Why we accept it:** Plan 07 surfaced and accepted this:
  Symphony's v1 target is a single laptop. Resume failures are
  detected and the runner falls back to a fresh session within
  the same dispatch (one retry attempt), which is acceptable.
- **Trigger to revisit:** Symphony runs on ephemeral compute
  (containers without `~` persistence) or multiple daemon
  instances share a Linear workspace. Either of those means the
  per-host session directory becomes the bottleneck and we need
  an explicit transport for session state.
- **Source:** Plan 07 (Claude Agent SDK integration), "Risks
  adopted from SDK research."

## Paid

(empty)
