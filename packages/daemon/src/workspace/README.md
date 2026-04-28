# `workspace/` — per-issue workspace lifecycle

Maps issue identifiers to filesystem directories, runs configured
shell hooks safely, and enforces the spec's filesystem safety
invariants.

## Files (planned)

- `paths.ts` — sanitization and root-containment.
- `manager.ts` — create / reuse / cleanup workspaces.
- `hooks.ts` — `bash -lc` execution with timeout enforcement.

## Allowed dependencies

- `types/`, `config/` — yes.
- Anything else in this package — **no**.

## Why this rule

Workspace management is filesystem-only. It must not know about
trackers, agents, or the orchestrator. The orchestrator drives the
lifecycle; this layer carries it out.

## Safety invariants enforced here

1. Workspace path is contained within the configured root.
2. Workspace directory names use only `[A-Za-z0-9._-]`.
3. Hooks have hard timeouts (default 60s) enforced via
   `AbortController`.

See [`SECURITY.md`](../../../../SECURITY.md).
