# @sandbox Skill — Provision a Development Environment

You are executing the `@sandbox` skill. Your job is to provision a
development environment (sandbox) where code changes can be made and
tested.

## Your Task

1. Clone the repository into a worktree
2. Start the development services (if docker-compose.yml exists)
3. Return a `SandboxHandle` JSON object

## Input

You will receive:

- `repo_url`: The Git repository URL to clone
- `default_branch`: The repo's default branch (e.g., "main") — used as
  the base for new work branches
- `branch`: The work branch to checkout (or create)
- `identifier`: Issue identifier for naming (e.g., "ENG-123")

## Steps to Execute

### Step 1: Confirm the Worktree Directory

The daemon already prepared a per-issue workspace and set it as your
current working directory. Use that directory as the worktree — do not
clone into `/tmp` or anywhere else.

```bash
# The daemon's per-issue workspace is your cwd. Capture absolute paths.
WORKTREE_PATH="$(pwd)"
SANDBOX_ID="symphony-${identifier}"   # substitute the issue identifier from Input
```

### Step 2: Clone or Update Repository

The worktree must always start from the **latest upstream state of the
default branch**. On a fresh dispatch the directory is empty so we
clone; on a re-dispatch the directory already has a checkout and we
fast-forward the default branch before creating/switching to the work
branch.

```bash
# Fresh dispatch: clone into the cwd
if [ ! -d ".git" ]; then
  git clone "${repo_url}" .
fi

# Always sync with upstream
git fetch origin

# Bring the default branch up to date with origin. --ff-only refuses
# to rewrite local history — if the local default branch has diverged
# (it shouldn't, the daemon owns this dir) the skill must fail loudly
# rather than silently merging or discarding commits.
git checkout "${default_branch}"
git pull --ff-only origin "${default_branch}"

# Switch to (or create) the work branch from the freshly-updated default
git checkout "${branch}" 2>/dev/null || git checkout -b "${branch}" "${default_branch}"
```

### Step 3: Start Services (if applicable)

If the repository has a `docker-compose.yml` or `compose.yml`:

```bash
# Use the sandbox ID as the compose project name for isolation
export COMPOSE_PROJECT_NAME="${SANDBOX_ID}"

if [ -f "docker-compose.yml" ] || [ -f "compose.yml" ]; then
  docker compose up -d
fi
```

### Step 4: Return SandboxHandle

After completing the above steps, you MUST output a JSON object with
this exact structure:

```json
{
  "id": "<SANDBOX_ID>",
  "kind": "local-docker",
  "worktree_path": "<absolute path to worktree>",
  "exec": {
    "kind": "shell-template",
    "template": "docker compose -p <SANDBOX_ID> exec app {cmd}"
  },
  "teardown": {
    "kind": "script",
    "script": "docker compose -p <SANDBOX_ID> down -v"
  }
}
```

If no docker-compose exists (simple repo), return:

```json
{
  "id": "<SANDBOX_ID>",
  "kind": "local-shell",
  "worktree_path": "<absolute path to worktree>",
  "exec": {
    "kind": "shell-template",
    "template": "cd <worktree_path> && {cmd}"
  },
  "teardown": {
    "kind": "script",
    "script": "rm -rf <worktree_path>"
  }
}
```

## Output Format

Your final output MUST be a valid JSON object matching the SandboxHandle
schema. Output it as the last thing you produce, wrapped in a code block:

```json
{ ... your SandboxHandle ... }
```

## Error Handling

- If `git clone` fails: Report the error and fail the skill
- If `docker compose up` fails: Report the error and fail the skill
- If the directory already exists: Reuse it (idempotent)

## Important Notes

- The `exec.template` field uses `{cmd}` as a placeholder. Downstream
  stages will substitute actual commands.
- The `id` should be deterministic for the same (repo, identifier) pair
  to support idempotent re-dispatch.
- Always use absolute paths for `worktree_path`. The current working
  directory `$(pwd)` is already absolute — use it directly.
- Do NOT clone into `/tmp/...`. The daemon's per-issue workspace (your
  cwd) is the canonical worktree location and is cleaned up by the
  workspace manager between runs.
