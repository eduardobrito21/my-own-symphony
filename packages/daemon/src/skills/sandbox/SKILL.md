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
- `branch`: The branch to checkout (or create)
- `identifier`: Issue identifier for naming (e.g., "ENG-123")

## Steps to Execute

### Step 1: Create Worktree Directory

```bash
# Create a unique workspace directory
SANDBOX_ID="symphony-${identifier}"
WORKTREE_PATH="${WORKSPACE_ROOT}/${SANDBOX_ID}"
mkdir -p "${WORKTREE_PATH}"
```

### Step 2: Clone Repository

```bash
# Clone if not already cloned, or fetch and checkout
cd "${WORKTREE_PATH}"
if [ ! -d ".git" ]; then
  git clone "${repo_url}" .
fi
git fetch origin
git checkout "${branch}" 2>/dev/null || git checkout -b "${branch}" origin/main
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
- Always use absolute paths for `worktree_path`.
