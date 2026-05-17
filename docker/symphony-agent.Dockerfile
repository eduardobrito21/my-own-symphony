# Symphony agent runner image — Plan 18b.
#
# Used by Namespace sandboxes to run @planner / @coder / @ci sub-agents
# inside a container with vault-injected credentials. The container is
# the unit of execution for remote-kind dispatches: the daemon's
# parent agent invokes `nsc ssh <id> --container_name agent -- ...` to
# dispatch sub-agents inside this image.
#
# Why a container, not a Devbox host:
#   - Namespace's vault → env injection is per-CONTAINER, not per-host.
#     Putting the agent in a container is the only way to get
#     ANTHROPIC_API_KEY / GITHUB_TOKEN injected via `from_secret_id`
#     without ever touching disk.
#   - See `docs/exec-plans/active/18b-agent-in-sandbox-namespace.md`.
#
# Build + push (from the symphony repo root):
#   docker build -t nscr.io/<workspace>/symphony-agent:latest \
#                -f docker/symphony-agent.Dockerfile .
#   nsc docker login
#   docker push nscr.io/<workspace>/symphony-agent:latest
#
# The Namespace platform pulls this image when the daemon's
# `namespace-create.sh` calls ComputeService.CreateInstance with a
# container declaration referencing it.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Base tools the agent's Bash calls expect on PATH.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         bash \
         ca-certificates \
         curl \
         git \
         gnupg \
         jq \
         openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — required by @ci for `gh pr create` / `gh pr list`.
# Following the GitHub-recommended apt install path.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user. `claude` refuses to run with
# `--dangerously-skip-permissions` (or any equivalent permission-mode
# bypass) under uid 0 — Anthropic's CLI hardcodes a root-check. Our
# dispatch flow is fundamentally non-interactive and needs the bypass,
# so we run as a regular user. uid 1000 keeps file ownership tidy when
# the daemon side `nsc instance upload`s files in.
RUN useradd --create-home --shell /bin/bash --uid 1000 symphony \
    && mkdir -p /workspace /opt/symphony \
    && chown -R symphony:symphony /workspace /opt/symphony

USER symphony

# Make sure subsequent shells (including those nsc ssh spawns) find
# claude on PATH. The CLI install drops binaries under $HOME/.local/bin
# or $HOME/.claude/bin depending on version; both are listed here so we
# don't have to know which one the installer picked.
ENV PATH=/home/symphony/.local/bin:/home/symphony/.claude/bin:/usr/local/bin:/usr/bin:/bin

# Claude Code CLI — installed as the non-root user, lands under the
# symphony user's HOME.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version

# Per-dispatch worktree. namespace-create.sh clones the target repo
# into here at provision time (via the in-VM clone-and-checkout.sh
# helper).
WORKDIR /workspace

# Stay up so the daemon can attach via `nsc ssh --container_name agent`.
# If the container ever exits the platform recycles it; we don't rely
# on auto-restart, the daemon detects and reports failure.
CMD ["sleep", "infinity"]
