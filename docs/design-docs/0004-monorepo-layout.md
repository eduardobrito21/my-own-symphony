# 0004 — Monorepo with `types`, `daemon`, `dashboard` packages

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The two-process architecture (see [0003](0003-two-process-architecture.md))
asks for two deployable units that nonetheless share types and a
development cadence. Three layouts are common:

1. Two separate repos (one per process).
2. Monorepo with a single package and conditional builds.
3. Monorepo with multiple packages.

## Decision

Use a **pnpm workspaces monorepo** with three packages:

- `packages/types` — pure types and zod schemas shared by daemon and
  dashboard. No runtime side effects.
- `packages/daemon` — the orchestrator process and its HTTP API.
- `packages/dashboard` — the Next.js UI (added in Phase 8).

`tsconfig.json` at the root uses **TypeScript project references** so
each package has its own tsconfig, yet typechecking, building, and tests
all work from the root.

## Alternatives considered

1. **Two separate repositories** — would force versioning shared types
   via npm publish or git submodules. Excessive friction for a single-
   maintainer project. Rejected.
2. **Single package with build-time switches** — would mix daemon and
   dashboard dependencies (Next.js, React) into the daemon's lockfile.
   Bloats the daemon image. Rejected.
3. **Turborepo or Nx** — adds tool-specific configuration to learn on
   top of TS itself. pnpm workspaces are simpler and sufficient at this
   scale. Rejected for now; revisit if build times grow.

## Consequences

**Easier:**

- One `pnpm install`, one lockfile, one source of truth for type
  definitions.
- Per-package `package.json` lists only the dependencies that package
  needs. Daemon image stays small.
- TypeScript project references give incremental builds and surface
  cross-package type errors at the root `pnpm typecheck`.

**Harder:**

- Need to remember to add `references` entries when introducing a new
  cross-package dependency.
- Some tools (vitest, dependency-cruiser) need workspace-aware
  configuration; we do this once at the root.

**Constrained:**

- A circular dependency between packages is impossible by construction
  (project references are a DAG). Good.

## Implementation notes

- `packages/types` is exported via `package.json#exports` so it works
  with both `nodenext` and Next.js's bundler resolver.
- Each package's `package.json` declares `type: "module"`. This codebase
  is ESM throughout.
- The dashboard package is **not** created until Phase 8. Until then
  the workspace contains `types` and `daemon` only.
