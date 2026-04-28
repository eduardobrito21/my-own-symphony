# AGENTS.md

You (an AI agent, or a human acting like one) are working in `my-own-symphony`,
a TypeScript reimplementation of [openai/symphony](https://github.com/openai/symphony)
built harness-first with the Claude Agent SDK.

This file is a **table of contents**, not an encyclopedia. It tells you where to
look. The deeper sources of truth live in `docs/`.

## Read first, before doing anything

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — layer map and the dependency rules
   you must respect. Violations are caught by `pnpm deps:check`.
2. **[docs/product-specs/symphony-spec.md](docs/product-specs/symphony-spec.md)**
   — the language-agnostic Symphony specification (vendored from upstream).
3. **[docs/product-specs/deviations.md](docs/product-specs/deviations.md)** —
   where this implementation intentionally diverges from the spec, and why.
4. **[docs/exec-plans/active/](docs/exec-plans/active/)** — the working plan,
   one file per phase. Find the lowest-numbered active plan that is not yet
   complete; that is the current focus.

## How knowledge is organized

| Directory                        | What lives there                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `docs/design-docs/`              | Architecture decision records (ADRs). Each captures one durable decision and the reasons behind it. Numbered, append-only. |
| `docs/exec-plans/active/`        | Plans for in-flight work. Updated as work progresses; moved to `completed/` when done.                                     |
| `docs/exec-plans/completed/`     | Historical record of finished work. Read-only reference.                                                                   |
| `docs/product-specs/`            | The Symphony spec itself plus our deviations from it.                                                                      |
| `docs/references/`               | External reference material indexed for agents (e.g. library `llms.txt` files).                                            |
| [SECURITY.md](SECURITY.md)       | Trust boundaries, secret handling, agent sandboxing posture.                                                               |
| [RELIABILITY.md](RELIABILITY.md) | Failure model, retry behavior, recovery semantics.                                                                         |

## How to work

- **Layered architecture is enforced mechanically.** Before adding an import,
  check it points the allowed direction. If `pnpm deps:check` fails, fix the
  layer violation — don't suppress the rule.
- **Boundary parsing is required.** Anything crossing a process boundary
  (filesystem, HTTP, subprocess stdio, environment) must be parsed with `zod`.
  Trust internal types; never trust external shapes.
- **Decisions go in `docs/design-docs/`.** If you make a non-obvious choice
  (which library, what shape, what behavior on edge case X), write a short ADR.
  Numbered, dated, with **Status / Context / Decision / Consequences** sections.
- **Plans are first-class artifacts.** When you start a meaningful piece of
  work, either pick up an existing plan in `docs/exec-plans/active/` or write
  a new one. Update it as you learn.
- **Errors should teach.** When you write a validation error, lint message, or
  thrown exception, phrase it so the next reader knows how to fix it. The
  audience is a future agent or developer who lacks your context.
- **Boring tools beat clever tools.** zod, fastify, vitest, pino, chokidar.
  Picking technology with stable APIs and clear semantics makes the codebase
  legible to agents (and to you in three months).

## How to run

```sh
pnpm install         # one-time
pnpm typecheck       # run TS in build mode
pnpm lint            # eslint + prettier
pnpm test            # vitest
pnpm deps:check      # mechanical layer enforcement
pnpm build           # produces dist/ for each package
```

All four checks (`typecheck`, `lint`, `test`, `deps:check`) must pass before
opening a pull request.

## What this project is — and is not

- **Is:** a faithful TypeScript port of the Symphony spec, using the
  Claude Agent SDK in place of Codex's app-server. Built as a vehicle for
  learning TS and harness engineering.
- **Is not:** a drop-in replacement for upstream Symphony. The deviations file
  enumerates differences. Some are pragmatic (Claude SDK vs Codex), some are
  pedagogical (one-pager fake tracker before the real Linear adapter).

## When in doubt

Read the relevant exec plan. If still unclear, write the question into the plan
as an open question and surface it. Never silently guess on a load-bearing
decision; capture the decision in an ADR or escalate.
