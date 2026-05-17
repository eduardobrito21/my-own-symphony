# Architecture

This document is the map. It defines the layers, the allowed dependencies
between them, and where to put new code.

The daemon runs the Claude Agent SDK in-process and orchestrates skills
(`@sandbox`, `@coder`, with `@app` / `@tester` / `@ci` planned) to
provision dev environments and make code changes.
[ADR 0014](docs/design-docs/0014-sub-agent-pipeline-supersedes-execution-backend.md)
describes the architecture.

The rules described here are **mechanically enforced** by:

- `tsconfig.json` project references (incorrect cross-package imports fail TS)
- `.dependency-cruiser.cjs` (incorrect cross-layer imports fail `pnpm deps:check`)

If this document disagrees with `.dependency-cruiser.cjs`, fix this document.
The lint config is the source of truth.

## Two processes, three packages

Symphony runs as two independent processes:

- **`daemon`** — the orchestrator. Polls Linear, manages workspaces, runs
  agents, exposes a JSON HTTP API for observability. Long-lived. No UI.
- **`dashboard`** — the Next.js UI. Polls `daemon`'s `/api/v1/*` endpoints.
  Read-only except for triggering refreshes. Can be stopped without affecting
  the daemon.

Source code is organized as a pnpm monorepo:

```
packages/
├── types/           # shared types between daemon and dashboard
├── daemon/          # the orchestrator + agent process
└── dashboard/       # the Next.js UI process
```

`types/` exists so that the dashboard can render daemon state with the same
type safety the daemon uses to produce it.

## The daemon's internal layers

Inside `packages/daemon/src/`, code is organized into directories that
correspond to architectural layers. Imports may only travel **from a higher
layer to a lower layer** (or to `observability/`, which is cross-cutting).

```
        types
          ↓
        config
          ↓
   ┌──────┼──────┬────────┐
   ↓      ↓      ↓        ↓
tracker  workspace  agent  skills   ← all may use types & config
   └──────┴──────┴────────┘
          ↓
     orchestrator
          ↓
         http
          ↓
        index.ts

  observability/  ← cross-cutting; any layer may emit logs/metrics
```

The `agent/` layer contains:

- `agent/claude/` — Claude Agent SDK wrapper
- `agent/pipeline/` — PipelineAgentRunner that orchestrates skills and validates their outputs
- `agent/skills/` — skill loader and output zod schemas

The `skills/` directory at `packages/daemon/src/skills/` contains bundled
default skill definitions (SKILL.md files) that the agent loads at runtime.

### Layer responsibilities

| Layer            | Purpose                                                                                                             | May depend on                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `types/`         | Branded IDs, domain entities (`Issue`, `Workspace`, `Session`, `OrchestratorState`). Pure types, zero runtime.      | nothing                                            |
| `config/`        | `symphony.yaml` deployment loader + per-repo `workflow.md` schema, zod schemas, `$VAR` and `~` resolution.          | `types`                                            |
| `tracker/`       | Issue tracker adapter interface + Linear/Fake implementations. Fetches and normalizes; never decides what to do.    | `types`, `config`                                  |
| `workspace/`     | Per-issue workspace lifecycle, path safety invariants.                                                              | `types`, `config`                                  |
| `agent/`         | Claude Agent SDK wrapper, pipeline orchestration, skill loading, prompt rendering, custom tools (`linear_graphql`). | `types`, `config`, `workspace`                     |
| `skills/`        | Bundled default skill definitions (SKILL.md files) loaded by the agent at runtime.                                  | nothing (markdown files, not TypeScript)           |
| `orchestrator/`  | Polling loop, single-authority state machine, dispatch, retries, reconciliation, dynamic reload.                    | `types`, `config`, `tracker`, `workspace`, `agent` |
| `http/`          | Fastify routes for `/api/v1/*`. Adapts orchestrator state to HTTP.                                                  | `types`, `orchestrator`, `observability`           |
| `observability/` | `pino` logger, structured event emission, snapshot helpers.                                                         | `types`                                            |

### Why this direction

Lower layers are **policy-free**. They know how to do a thing (fetch issues,
run a hook, render a prompt) but they do not know _when_ to do it or _why_. The
orchestrator is the only place where decisions about scheduling, retries, and
state transitions live.

This means:

- Tests for `tracker/` don't need an orchestrator.
- Tests for `workspace/` don't need a tracker.
- Swapping `tracker/linear` for `tracker/fake` requires zero changes outside
  `tracker/`.
- The HTTP layer can be deleted without breaking the daemon's correctness — it's
  observability, not behavior.

## Cross-cutting concerns

`observability/` is allowed to be imported from anywhere. Logging, metrics, and
event emission are cross-cutting in the same way the article's `Providers` slot
is cross-cutting. To prevent this from becoming an accidental dumping ground:

- `observability/` may itself only depend on `types/`.
- It must export only **interfaces and emitters**, never policy decisions.

## Composition root

`packages/daemon/src/index.ts` is the **only** file allowed to wire concrete
implementations together. It:

1. Loads `symphony.yaml` via `config/deployment-loader.ts`.
2. Validates required env vars (`LINEAR_API_KEY`, `ANTHROPIC_API_KEY`).
3. Constructs one `LinearTracker` per project entry, sharing one `LinearClient`.
4. Constructs `PipelineAgentRunner` with project dispatch info (repo URLs, branches).
5. Constructs the `Orchestrator` with all collaborators.
6. Starts the optional HTTP server (gated on `SYMPHONY_HTTP_PORT`).

The `PipelineAgentRunner` orchestrates the skill pipeline (@sandbox → @coder)
using the Claude Agent SDK running in the daemon process.

If you find yourself wiring two concrete implementations together inside a
domain layer, stop — that wiring belongs in `index.ts`.

## Boundary parsing

Every value crossing a boundary must be parsed with `zod` before it enters the
typed core:

| Boundary                                   | Parser                          |
| ------------------------------------------ | ------------------------------- |
| `symphony.yaml` (operator-side)            | `config/deployment.ts`          |
| `<repo>/.symphony/workflow.md` (repo-side) | `config/repo-workflow.ts`       |
| Linear GraphQL responses                   | `tracker/linear/responses.ts`   |
| HTTP request bodies / query params         | `http/schemas.ts`               |
| Claude Agent SDK events                    | `agent/claude/event-mapping.ts` |
| Skill outputs (SandboxHandle, CoderResult) | `agent/skills/schemas.ts`       |

Inside the typed core, values are trusted. Outside it, nothing is.

## Where new code goes

- **A new domain entity** → `types/`. If it has runtime behavior, the behavior
  goes in the layer that owns it; the type stays in `types/`.
- **A new external service** → its own subdirectory in the appropriate layer
  (e.g. `tracker/jira/` if we ever support Jira). Follow the same boundary-
  parsing rules.
- **A new orchestrator behavior** → `orchestrator/`. Update the relevant exec
  plan and, if the change is non-obvious, write an ADR.
- **A new HTTP endpoint** → `http/routes/`. Define the request/response zod
  schemas in `http/schemas.ts`, share with the dashboard via `packages/types/`.
- **A new shared type used by both daemon and dashboard** → `packages/types/`.

## Where new code does NOT go

- A "utils" or "helpers" directory. Utilities accumulate entropy. Put helpers
  in the lowest layer that needs them; if two layers genuinely need the same
  helper, that's a signal to push the helper into `types/` or to extract a
  proper subdomain.
- The composition root. `index.ts` wires; it does not implement.

## Diagrams in this file

Diagrams are intentionally ASCII to keep them legible in agent context. If a
diagram needs to be richer, generate it from a versioned source (e.g. mermaid
in a fenced block) so it stays in sync with the text.
