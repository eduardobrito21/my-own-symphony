# Design docs (ADRs)

This directory captures durable architectural decisions. Each document
records **one** decision, the context that drove it, the alternatives
considered, and the consequences accepted.

ADRs are append-only. If a decision is reversed, write a new ADR that
**Supersedes** the old one — do not edit the old one in place.

## Format

Each ADR has these sections:

- **Status** — one of `Proposed`, `Accepted`, `Superseded by NNNN`, `Withdrawn`.
- **Context** — what made this decision necessary; what was true at the time.
- **Decision** — what we chose.
- **Alternatives considered** — what else was on the table and why it lost.
- **Consequences** — what becomes easier, harder, or constrained as a result.

Filenames are `NNNN-kebab-case-summary.md`, four-digit zero-padded.

## Index

| ADR                                                | Title                                                                  | Status   |
| -------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| [0001](0001-claude-agent-sdk-instead-of-codex.md)  | Use the Claude Agent SDK in place of Codex's app-server                | Accepted |
| [0002](0002-no-linear-mcp.md)                      | Do not use Linear's hosted MCP for agent → Linear writes               | Accepted |
| [0003](0003-two-process-architecture.md)           | Daemon and dashboard run as separate processes                         | Accepted |
| [0004](0004-monorepo-layout.md)                    | Monorepo with `types`, `daemon`, `dashboard` packages                  | Accepted |
| [0005](0005-harness-first-development.md)          | Apply harness-engineering principles to this project's own development | Accepted |
| [0006](0006-zod-at-every-boundary.md)              | Use zod for parsing every value crossing a boundary                    | Accepted |
| [0007](0007-fake-tracker-before-linear.md)         | Implement a `FakeTracker` before the real Linear adapter               | Accepted |
| [0008](0008-fold-codex-section-into-agent.md)      | Fold the `codex.*` section into `agent.*`                              | Accepted |
| [0009](0009-multi-project-orchestration.md)        | Multi-project orchestration (deviation from spec's single-project)     | Accepted |
| [0010](0010-co-located-http-is-provisional.md)     | Co-located HTTP server is provisional; split in Plan 10                | Accepted |
| [0011](0011-agent-in-pod-and-execution-backend.md) | Agent runs inside the per-task pod; ExecutionBackend is the seam       | Accepted |
| [0012](0012-namespace-as-production-execution-backend.md) | Namespace as the v1 production ExecutionBackend                        | Proposed |
| [0013](0013-daemon-pod-transport-broker-vs-controller.md) | Daemon ↔ pod transport: pull-from-broker vs push-from-daemon           | Proposed |
