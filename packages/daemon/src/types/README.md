# `types/` — domain types

The deepest layer. Pure TypeScript types and zod schemas for the
canonical domain model. No runtime side effects. No imports from any
other layer in this package.

## What lives here

- Branded ID types: `IssueId`, `IssueIdentifier`, `WorkspaceKey`,
  `SessionId`.
- Domain entities matching SPEC §4.1: `Issue`, `Workspace`,
  `RunAttempt`, `LiveSession`, `RetryEntry`, `OrchestratorState`.
- Typed error classes used throughout the daemon.

## What does NOT live here

- Functions that read from disk, network, or environment.
- Helpers that compute over multiple entities (those go in the layer
  that owns the operation).
- Library re-exports (just import directly).

## Why this rule

Types in this layer are imported by every other layer. Adding any
runtime behavior here creates a transitive dependency that violates
our directional rule.

See [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md).
