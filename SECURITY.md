# Security

This document describes Symphony's trust model, the secrets it handles, and
the operational safety invariants enforced by the codebase.

## Trust posture (this implementation)

This implementation is intended for **trusted, single-operator environments**.
That means:

- The operator owns the host machine, the Linear workspace, and any repository
  the agent is asked to work on.
- The operator's credentials (`LINEAR_API_KEY`, `ANTHROPIC_API_KEY`) authorize
  full access to the resources scoped to those tokens.
- Workflow files (`WORKFLOW.md`) and any embedded shell hooks are treated as
  trusted code. Do not run untrusted `WORKFLOW.md` files.
- The Claude Agent SDK runs with the same filesystem and network privileges as
  the daemon process.

This is the same posture as upstream Symphony's "high-trust" example. It is
**not** suitable for multi-tenant deployment, untrusted issue input, or shared
infrastructure without additional sandboxing layers (containers, VMs,
network segmentation).

## Trust boundaries

| Boundary                           | Direction     | Trust assumption                                                                                     |
| ---------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| Operator → `WORKFLOW.md`           | Inbound       | Trusted: the file is repo-versioned and operator-authored.                                           |
| Linear → `tracker/`                | Inbound       | Untrusted shape; trusted operator. Parse with zod, don't echo into shell.                            |
| Agent → `linear_graphql` tool      | Inbound       | Untrusted query content; validated to be a single GraphQL operation before send.                     |
| Agent → workspace filesystem       | Bidirectional | Constrained: agent's `cwd` must be the per-issue workspace and may not escape it.                    |
| Daemon → tracker / agent providers | Outbound      | Trusted credentials; never log secrets.                                                              |
| HTTP API consumers                 | Inbound       | Loopback-only by default. If exposed, treat all input as untrusted (zod-parse every body and query). |

## Secrets

Symphony reads two credentials:

- `LINEAR_API_KEY` — Linear personal API token. Used by the daemon's tracker
  for polling and by the `linear_graphql` agent tool.
- `ANTHROPIC_API_KEY` — used by the Claude Agent SDK.

Rules:

- Secrets are read from environment variables only. Never check secrets into
  the repo or into `WORKFLOW.md`.
- `WORKFLOW.md` may reference `$VAR_NAME` to pull from the environment; the
  config layer resolves these.
- Validate presence of secrets without printing their values. The startup
  preflight may say "LINEAR*API_KEY missing" but never "LINEAR_API_KEY = lin*…".
- The `pino` logger has a `redact` config that masks token-shaped values; do
  not bypass it.

## Filesystem invariants

These invariants are enforced in code in `workspace/` and tested:

1. **Workspace path containment.** Every workspace path must resolve to an
   absolute path that has the configured `workspace.root` as a prefix. Paths
   outside the root are rejected before agent launch.
2. **Sanitized identifiers.** Workspace directory names use only
   `[A-Za-z0-9._-]`. All other characters in the issue identifier are replaced
   with `_`.
3. **Agent cwd matches the workspace.** Before launching the agent for an
   issue, the runner asserts `cwd === workspacePath`. Any mismatch fails the
   run before a single line of agent output is produced.

## Hook script safety

Workspace hooks (`after_create`, `before_run`, `after_run`, `before_remove`)
are arbitrary shell scripts read from `WORKFLOW.md`. They are trusted
configuration, but they are not safe by default:

- Hooks run inside the workspace directory only; their `cwd` is the
  per-issue workspace.
- Hooks have a configured `hooks.timeout_ms` (default 60s). Timeouts are
  enforced via `AbortController` so they cannot hang the orchestrator.
- Hook stdout/stderr is truncated in logs to bound disk and memory use.
- A hook failure has documented per-hook semantics: see `RELIABILITY.md`.

## Agent tool surface

The Claude Agent SDK is exposed only the tools we explicitly opt into. As of
this writing those are:

- Built-in tools (file edits, shell execution within the workspace).
- `linear_graphql` — a custom client-side tool that proxies a single GraphQL
  operation through Linear using the daemon's existing credentials. We
  intentionally do **not** plug in Linear's hosted MCP server (see
  [docs/design-docs/0002-no-linear-mcp.md](docs/design-docs/0002-no-linear-mcp.md)).

The `linear_graphql` tool wrapper enforces:

- `query` must be a non-empty string.
- The document must contain exactly one operation (parsed before send).
- Reuses the daemon's existing Linear endpoint and auth — the agent never sees
  raw tokens.

## Reporting

This repository is a personal learning project; there is no formal disclosure
process. If you find a real issue you'd like to share, open a GitHub issue or
contact the maintainer directly.
