# `docker/` — Symphony container images

Per ADR 0011 + Plan 10, every per-issue dispatch starts a Docker pod
from a base image built here.

## `agent-base.Dockerfile` — `symphony/agent-base:1`

The default base image for the in-pod agent runtime. Bundles:

- Node 20 (slim Debian bookworm).
- `tini` as PID 1 (signal forwarding + zombie reaping).
- `git`, `openssh-client`, `gh`, `jq`, `curl`, `gnupg`, `ca-certificates`.
- `pnpm@10.18.2` via corepack.
- The compiled `@symphony/agent-runtime` package + its production
  dependencies under `/opt/symphony/agent-runtime/`.

`ENTRYPOINT` runs `node /opt/symphony/agent-runtime/dist/entrypoint.js`,
which reads the dispatch envelope, fetches the issue, clones the repo,
renders the per-repo `workflow.md`, and drives the Claude Agent SDK.

### Build

```sh
pnpm docker:build:agent-base
```

That script (in the repo root `package.json`) does the equivalent of:

```sh
pnpm --filter @symphony/types --filter @symphony/daemon --filter @symphony/agent-runtime build
docker build -f docker/agent-base.Dockerfile -t symphony/agent-base:1 .
```

The build context is the **repo root** (`docker build ... .`) because
the Dockerfile copies `packages/*` for the workspace install.

### When to bump the version tag

The `:1` tag is the **agent-runtime contract version**. Bump it when:

- The entrypoint moves from `/opt/symphony/agent-runtime/dist/entrypoint.js`.
- The dispatch envelope path changes (`/etc/symphony/dispatch.json`).
- The event socket path changes (`/var/run/symphony/events.sock`).
- The mounted workspace path changes (`/workspace`).
- An env var the entrypoint reads is renamed.

A rebuild that ships within the same contract reuses `:1` — operators
re-run `pnpm docker:build:agent-base` and pick up the new image.

## Per-repo derivative images

Repos with custom tooling can ship a Dockerfile at
`.symphony/agent.dockerfile`. The convention is:

```dockerfile
FROM symphony/agent-base:1
RUN apt-get install -y <whatever the agent needs>
```

The image-resolution order (Plan 10 step 7) picks per-repo images
ahead of the base. Build them with `pnpm docker:build:<projectKey>`
(operator-side script, not yet auto-generated).
