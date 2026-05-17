# my-own-symphony

> **⚠️ Post-ADR 0014 architecture pivot (2026-05-17).** This document
> describes the pre-pivot architecture (per-pod agent runtime,
> `ExecutionBackend` abstraction, `LocalDockerBackend`,
> `agent-runtime` package). ADR 0014 replaces all of that with a
> sub-agent pipeline + skill-driven provisioning. Plan 15 deletes the
> dead code (this commit); Plan 16 will add the new architecture's
> code and rewrite this README to describe it. Read the sections
> below as historical context until then.

A TypeScript reimplementation of [openai/symphony](https://github.com/openai/symphony),
built harness-first using the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview).

Symphony is a long-running daemon that polls an issue tracker (Linear), creates
a per-issue workspace, and runs a coding agent inside it. This port follows the
upstream language-agnostic specification while substituting the Claude Agent
SDK for Codex's app-server.

## Status

Early development. See [docs/exec-plans/active/](docs/exec-plans/active/) for
what's in flight.

## Get started

If you are an AI agent (or working like one), read **[AGENTS.md](AGENTS.md)** first.

If you are just trying to run it:

```sh
pnpm install
cp .env.example .env       # then edit with your tokens
pnpm typecheck
pnpm test
pnpm build
```

## Project layout

```
AGENTS.md                  ← start here for orientation
ARCHITECTURE.md            ← layer map and dependency rules
SECURITY.md                ← trust model and secret handling
RELIABILITY.md             ← failure model and recovery semantics
docs/
  design-docs/             ← architecture decision records (ADRs)
  exec-plans/              ← living plans for in-flight and finished work
  product-specs/           ← the Symphony spec + our deviations
  references/              ← external library docs indexed for agents
packages/
  types/                   ← shared types
  daemon/                  ← orchestrator process
  dashboard/               ← Next.js UI (added in Phase 8)
```

## License

Apache 2.0 — same as upstream.
