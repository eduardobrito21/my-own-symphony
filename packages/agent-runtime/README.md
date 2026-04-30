# `@symphony/agent-runtime`

The in-pod agent runtime — the script that runs **inside** each
per-issue Docker pod the daemon's `LocalDockerBackend` starts.

Per ADR 0011 + Plan 10, this package is **not consumed by other
workspace packages**. Its build artifact (`dist/entrypoint.js`) is
baked into the `symphony/agent-base:1` Docker image and executed by the
container's `ENTRYPOINT`.

## What runs in the pod

The entrypoint, on every dispatch:

1. Reads + zod-validates the **dispatch envelope** mounted at
   `/etc/symphony/dispatch.json`.
2. Connects to the host daemon's Unix socket bind-mounted at
   `/var/run/symphony/events.sock`.
3. Fetches the issue from Linear (eligibility check). Exits cleanly
   ("no longer eligible") if the issue is gone.
4. Transitions the issue to **In Progress** — this is the dispatch
   handshake (per ADR 0011, the daemon's next poll uses this transition
   as authoritative claim state).
5. `git clone`s `envelope.repo.url` into `/workspace`, checks out
   (or creates) the per-issue branch `<branchPrefix><issueIdentifier>`.
6. Reads `<workspace>/<envelope.repo.workflowPath>` for the per-repo
   `workflow.md`. Falls back to `defaultRepoWorkflow()` if missing
   (conservative: posts a comment, no code changes).
7. Renders the prompt template (Liquid) against the freshly-fetched
   issue.
8. Resolves effective execution settings: repo-side wins for `model`,
   `min(operatorCaps, repoCaps)` for budget fields.
9. Constructs `ClaudeAgent` (imported from `@symphony/daemon/agent/claude`)
   and runs `query()`.
10. Streams every `AgentEvent` as a JSON line to the host socket.
11. Exits 0 on terminal event, non-zero on crash (after emitting a
    `turn_failed` event so the daemon records the outcome).

## Environment variables

The host daemon plumbs these into the container at start time:

- `LINEAR_API_KEY` — required. Used by both the eligibility/handshake
  helper and the agent's `linear_graphql` tool.
- `ANTHROPIC_API_KEY` — required. Read by the Claude Agent SDK.
- `GITHUB_TOKEN` — optional, only needed for private repo HTTPS clones.

## Build

```sh
pnpm --filter @symphony/agent-runtime build
```

The build produces `dist/entrypoint.js`, which the
`docker/agent-base.Dockerfile` baseline image copies to
`/opt/symphony/agent-runtime/dist/entrypoint.js`.

## Why `@symphony/daemon` is a dependency

The pod runtime imports `ClaudeAgent`, `LinearClient`, prompt rendering
helpers, and the per-repo workflow schema from the daemon package. The
dependency arrow is **agent-runtime → daemon** only; the daemon does
not depend on this package at runtime (it only references the Docker
image tag, not the package source). No circular import.
