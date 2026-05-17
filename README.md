# my-own-symphony

A TypeScript reimplementation of [openai/symphony](https://github.com/openai/symphony),
built harness-first using the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview).

Symphony is a long-running daemon that polls Linear for eligible issues
and dispatches each to a parent agent (running in the daemon's Node
process via the Claude Agent SDK). The parent agent orchestrates a
fixed pipeline of specialist sub-agents driven by markdown skill
files (`@sandbox`, `@coder`, with `@app` / `@tester` / `@ci` planned)
to provision a sandbox, make code changes, and close out the issue.
This port follows the upstream language-agnostic specification while
substituting the Claude Agent SDK for Codex's app-server.

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
