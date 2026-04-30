# symphony/agent-base:1 — base image the per-issue Docker pods run.
#
# Per ADR 0011 + Plan 10, every dispatch starts a container from this
# image (or a per-repo derivative built FROM symphony/agent-base:1).
# The container's ENTRYPOINT runs the in-pod agent runtime, which
# fetches the issue, clones the repo, renders the per-repo workflow.md,
# and drives the Claude Agent SDK.
#
# The image is built from the workspace root (build context = the repo).
# `pnpm docker:build:agent-base` is the canonical way to build it.
#
# Two-stage build:
#   1. Build stage — pnpm install + tsc build of @symphony/agent-runtime
#      and its workspace dependencies (@symphony/daemon, @symphony/types).
#   2. Runtime stage — slim image with only the build artifacts +
#      production node_modules + the system tools the agent needs at
#      runtime (git, gh, jq, tini, openssh-client, ca-certs).
#
# The version tag (`:1`) bumps when the **agent-runtime contract**
# changes — entrypoint location, mounted-paths, env-var names. A
# rebuild that doesn't move the contract reuses the same tag.

# ---- Build stage ----------------------------------------------------

FROM node:20-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate

WORKDIR /build

# Copy lockfile + workspace manifests first so dep install caches well.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages/types/package.json ./packages/types/
COPY packages/daemon/package.json ./packages/daemon/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/dashboard/package.json ./packages/dashboard/

RUN pnpm install --frozen-lockfile \
  --filter @symphony/agent-runtime... \
  --filter @symphony/daemon...

# Now copy the sources for the packages we actually need to compile.
COPY packages/types ./packages/types
COPY packages/daemon ./packages/daemon
COPY packages/agent-runtime ./packages/agent-runtime

RUN pnpm --filter @symphony/types --filter @symphony/daemon --filter @symphony/agent-runtime build

# Prune to production deps only. `--legacy` is required because pnpm v10
# changed `deploy` to demand `inject-workspace-packages=true` by default;
# we don't need injected deps for the runtime image (the symlinked
# workspace packages resolve fine), so the legacy behavior is what we want.
RUN pnpm --filter @symphony/agent-runtime --prod --legacy deploy /deploy/agent-runtime

# Strip the Claude Agent SDK's musl-libc native binary variants. The
# SDK's binary resolver tries `@anthropic-ai/claude-agent-sdk-linux-<arch>-musl`
# FIRST on Linux and only falls through to the glibc variant if the
# musl package isn't installed. Our base image is `node:20-bookworm-slim`
# which is glibc; the musl binary won't exec (kernel can't find
# `/lib/ld-musl-*`, reports it as "binary not found" — discovered the
# hard way during the 2026-04-30 smoke run). Removing the musl
# packages forces the resolver to fall through to glibc.
RUN find /deploy/agent-runtime/node_modules/@anthropic-ai \
        -maxdepth 1 -type l -name "claude-agent-sdk-linux-*-musl" -delete && \
    rm -rf /deploy/agent-runtime/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*-musl@*

# ---- Runtime stage --------------------------------------------------

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production

# Tools the in-pod agent uses:
#   - tini: PID 1 init that reaps zombies + forwards signals
#   - git, openssh-client: clone repos
#   - gh: GitHub CLI (Plan 12 will use this for PR ops)
#   - jq, ca-certificates, gnupg, curl: misc agent tooling
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini \
      git \
      openssh-client \
      jq \
      ca-certificates \
      gnupg \
      curl \
    && \
    # Install GitHub CLI from its repo (the apt one is too old).
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate

# Non-root user. The `node:20-bookworm-slim` base image already ships a
# `node` user at uid/gid 1000, which is what we want — no need to
# rename. The bind-mounted /workspace is owned by the host user at
# runtime; the daemon's `docker run` sets `--user` to the host uid so
# file permissions match.

# Install the deployed agent-runtime tree (sources + production deps).
COPY --from=build --chown=node:node /deploy/agent-runtime /opt/symphony/agent-runtime

# Symphony-side mount points.
RUN mkdir -p /workspace /etc/symphony /var/run/symphony && \
    chown node:node /workspace /etc/symphony /var/run/symphony

USER node
WORKDIR /workspace

# Tini reaps zombies + forwards signals so the daemon's `docker stop`
# actually terminates the SDK. The script self-exits on terminal event.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/symphony/agent-runtime/dist/entrypoint.js"]
