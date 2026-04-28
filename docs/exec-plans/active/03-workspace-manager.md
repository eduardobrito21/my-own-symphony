# Plan 03 — Workspace manager

- **Status:** Not started
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

- **Cross-platform shell.** Spec mandates POSIX `bash -lc` on POSIX
  systems. We do not support Windows. Document that explicitly in
  `SECURITY.md`.

## Decision log

(empty)
