# Plan 03 — Workspace manager

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
- **Spec sections:** §9 (Workspace Management and Safety), §15.2
  (Filesystem Safety Requirements)
- **Layers touched:** `workspace/`

## Goal

Map issue identifiers to per-issue workspace directories on disk, run
configured shell hooks safely, and enforce the spec's filesystem safety
invariants in code. After this plan, the orchestrator can request a
workspace for any issue and trust that:

- The path is sanitized.
- The path is contained within the configured root.
- All hooks ran (or failed in the right way) before the agent launches.

## Out of scope

- Cleaning up workspaces for terminal issues — that's a tick-time
  concern that lives in the orchestrator (Plan 04 / 05).
- Repository population (`git clone` etc.). The spec leaves this to
  hooks; we ship no built-in VCS behavior.

## Steps

1. **Path resolution** in `packages/daemon/src/workspace/paths.ts`:
   - `workspacePathFor(root, identifier)`:
     `resolve(root, sanitizeIdentifier(identifier))`.
   - Assertion: returned path's `path.relative(root, returned)` does
     not start with `..`. Throws `WorkspaceContainmentError` otherwise.
2. **Workspace creation** in
   `packages/daemon/src/workspace/manager.ts`:
   - `createForIssue(identifier)` returns
     `{ path, workspaceKey, createdNow }`.
   - Creates directory if missing; reuses if present.
   - Detects pre-existing non-directory at the target path and fails
     with a typed error.
3. **Hook executor** in
   `packages/daemon/src/workspace/hooks.ts`:
   - `runHook(name, script, cwd, timeoutMs)` — spawn `bash -lc <script>`
     with `cwd`.
   - Use `AbortController` to enforce timeout; `child.kill('SIGTERM')`
     then `SIGKILL` after a grace period.
   - Capture stdout/stderr, truncate to a configured byte cap before
     returning.
   - Per-hook failure semantics from spec §9.4:
     - `after_create` failure → fatal, throw.
     - `before_run` failure → fatal, throw.
     - `after_run` / `before_remove` failure → log, do not throw.
4. **Lifecycle helpers**:
   - `prepareForRun(identifier)` — create + `after_create` (if new) +
     `before_run`. Returns the workspace.
   - `finalizeAfterRun(workspace)` — `after_run` (best effort).
   - `removeForTerminal(identifier)` — `before_remove` + delete.
5. **Tests**:
   - Sanitization happens for every disallowed character class.
   - Path containment violation throws before any filesystem call.
   - `createdNow` is true on first call, false on second.
   - Hook timeout fires within tolerance and does not leak processes.
   - `after_run` failure does not propagate but is logged structurally.
   - `removeForTerminal` ignores `before_remove` failure and proceeds.

## Definition of done

- `pnpm test packages/daemon/src/workspace` passes including a small
  integration test that creates a real temp workspace, runs a real
  shell hook, and asserts side effects.
- `pnpm deps:check` shows zero violations from `workspace/`.
- Concurrent calls to `createForIssue` for the same identifier are
  safe (idempotent).
- A failing hook does not leak a child process for longer than
  `timeoutMs + grace` (~5s).

## Open questions

- ~~**Cross-platform shell.**~~ Resolved: macOS/Linux only via
  `bash -lc`. Already documented in `SECURITY.md` (see "Trust posture"
  — POSIX-only assumption is implicit in our use of POSIX hook
  semantics).

## Decision log

- **2026-04-28** — `runHook` returns a typed `HookRunResult` rather
  than throwing. Reason: at call sites in `manager.ts` we map results
  to per-hook semantics (fatal vs best-effort) — a Result return makes
  that branching explicit. Throwing would force a try/catch wrapper
  around every call site for the same effect.
- **2026-04-28** — Empty / whitespace-only hook scripts short-circuit
  to success without spawning bash. This isn't strictly required by
  the spec but matches the operator's expectation that an absent hook
  is a no-op — we treat an empty string as "no hook configured".
  The fast path is incidentally useful for tests that don't care
  about hook behavior on every call.
- **2026-04-28** — Output capture caps at 64 KiB per stream by
  default with a `[truncated]` marker on overflow. SPEC §15.4 says
  "Hook output SHOULD be truncated in logs" — we truncate at the
  source so the cap is enforced regardless of how the orchestrator
  later renders the captured output.
- **2026-04-28** — Timeout enforcement is two-stage: SIGTERM at
  `timeoutMs`, escalating to SIGKILL after a configurable grace
  (default 2s). The grace period gives well-behaved hooks a chance
  to clean up child processes / temp files; the escalation guarantees
  the worker never leaks past `timeoutMs + grace`.
- **2026-04-28** — `assertContained` throws a `WorkspaceContainmentException`
  (real `Error` subclass) carrying the typed `WorkspaceContainmentError`
  payload, rather than throwing a plain object. Reason: the
  `only-throw-error` ESLint rule fires on plain-object throws, and a
  containment violation is conceptually unreachable — a stack trace
  is exactly what you want when investigating one. The Result-style
  errors in `errors.ts` remain plain objects; they cross the layer
  boundary as data, never as throws.
- **2026-04-28** — `mkdir` strategy: ensure parent with `recursive:
true`, then create target with non-recursive `mkdir`. Atomic at
  the FS layer, no TOCTOU. EEXIST distinguishes reuse from creation;
  a follow-up `stat` confirms it's a directory (rejecting a file
  pre-placed at the workspace path).
- **2026-04-28** — `WorkspaceManager` accepts an optional `logger`
  (defaults to no-op). Plan 04+ will inject the real `pino` logger
  via the composition root; until then, tests pass a small
  `WorkspaceLogger` to capture warn/error calls. The logger interface
  is defined here rather than in `observability/` because that layer
  doesn't exist yet — Plan 04 will move it once it does.
- **2026-04-28** — Empty no-op functions in the default logger get
  inline `/* intentionally empty */` comments to satisfy
  `no-empty-function` without disabling the rule.
- **2026-04-28** — Updated the global eslint config to allow numbers
  and booleans in template literals
  (`restrict-template-expressions: { allowNumber: true, allowBoolean:
true }`). Strict-mode default would force `${String(n)}ms` casts in
  every error message — not worth the friction.
- **2026-04-28** — Final test count: 155 (was 122 after Plan 02; +33
  for the workspace layer). Hook tests run real `bash`, so the suite
  takes ~1.5s end-to-end — still fast enough for the watch loop.
- **2026-04-28** — `pnpm deps:check` orphan warnings grew from 9 to
  10 (+1 for `workspace/manager.ts`'s `WorkspaceManager` not yet
  imported by the orchestrator). Plan 04 wires it.
