# @sandbox Skill — Provision a Development Environment

You are executing the `@sandbox` skill. Your job is small:

1. Read the issue's `labels` input to pick a backend.
2. Run the corresponding **pre-set script** under
   `$SKILL_DIR/scripts/`.
3. Emit the JSON the script printed to stdout as the final
   `SandboxHandle`.

The script does the real work. You are the dispatcher.

> **CRITICAL — you run inside the daemon's process. Do NOT modify
> any file on the daemon's filesystem.** Unlike `@planner`,
> `@coder`, and `@ci` (which run inside a remote sandbox in Plan
> 18b mode), `@sandbox` itself executes within the daemon's
> process and has filesystem access to the daemon's source tree.
> If a script fails:
>
> 1. Capture the last `[<backend>-create] ERROR: ...` line from
>    stderr.
> 2. Emit a SandboxHandle JSON with `id: ""`, `kind: "failed"`,
>    and the error string in the `teardown.script` field (no
>    sandbox was created, but the validator still gets a parseable
>    structure). The pipeline closes out with a Linear failure
>    comment.
> 3. **Stop. Do NOT** read or edit `$SKILL_DIR/scripts/*.sh`, do
>    NOT run `git`, do NOT use `Bash` to redirect into files, do
>    NOT try to "fix" the script. Bugs in the script are the
>    operator's concern, not yours — surface them via the failure
>    handle and exit. Editing the daemon's source from inside
>    `@sandbox` is exactly the host-filesystem-leak class the
>    sandbox boundary exists to prevent; stay in your lane.

## Input

You will receive (from the parent agent's Stage 1 input block):

- `repo_url` — Git repository URL.
- `default_branch` — repo's default branch (e.g. `main`).
- `branch` — work branch to checkout/create.
- `identifier` — issue identifier (e.g. `EDU-13`).
- `labels` — comma-separated list of the issue's labels.

The parent prompt also injects `$SKILL_DIR` — the absolute path to
this skill's directory on disk. The scripts live at
`$SKILL_DIR/scripts/`.

## Step 0 — Pick the backend

Scan `labels` for a backend selector. Known backends: `local`,
`namespace`, `aws`. A label counts as a selector if it is:

- **A bare backend name** — `local`, `namespace`, or `aws`
  (preferred; matches Linear's flat label model).
- **A prefixed name** — `sandbox:local`, `sandbox:namespace`, or
  `sandbox:aws` (still accepted for clarity-conscious projects).

Selection rule:

| Distinct backend selectors found | Action                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| 0                                | Use `local` (operator default).                                   |
| 1                                | Use that backend.                                                 |
| 2+                               | **Fail loud.** Print: `conflicting backend labels found: <list>`. |

Other labels (e.g. `priority:high`, project tags) are ignored.

Note: Linear stores labels as flat strings without prefixes, so a
user who creates a label called simply `namespace` in their Linear
workspace gets the namespace backend without further configuration.
The prefixed `sandbox:*` form is provided for cases where a bare
name like `namespace` would collide with another label's meaning.

## Step 1 — Run the create script

The create scripts are deterministic shell programs. They take
inputs as **environment variables** and emit the `SandboxHandle` on
stdout. Human-readable progress goes to stderr — do not include
stderr in the final JSON output.

Use the `Bash` tool to invoke the script:

```bash
SYMPHONY_REPO_URL="<repo_url>" \
SYMPHONY_DEFAULT_BRANCH="<default_branch>" \
SYMPHONY_BRANCH="<branch>" \
SYMPHONY_IDENTIFIER="<identifier>" \
  bash "$SKILL_DIR/scripts/<backend>-create.sh"
```

Where `<backend>` is `local`, `namespace`, or `aws` (the picked
one). Substitute the input values into the env vars.

The script will:

- Validate its inputs and any prerequisites (`git`, `docker`,
  `nsc`, auth) — failing loud with an actionable error if a
  prerequisite is missing.
- Provision the environment (clone, start services / create
  microVM / etc.).
- Print a single JSON object — the `SandboxHandle` — to stdout.

If the script exits non-zero, the dispatch has failed. Report the
last `[<backend>-create] ERROR: ...` line from stderr and stop.

## Step 2 — Emit the SandboxHandle (REQUIRED, do not skip)

**This step is mandatory.** The Symphony daemon validates the
SandboxHandle by scanning your assistant text for a fenced JSON
code block (three backticks + the word `json`) that matches the
schema. If you only narrate the handle in prose ("Stage 1 complete,
handle is valid…") the daemon classifies the run as failed even
when everything else succeeded.

Before continuing to Stage 2, send an assistant message containing:

- Three backticks followed by `json`,
- The JSON the create script printed to stdout in Step 1 (verbatim,
  do not reformat or modify it),
- Three closing backticks.

Then continue to Stage 2.

The script is the authority on backend-specific fields (`kind`,
`exec.template`, `teardown`). Your only job here is to surface its
output in a form the daemon's validator can find.

## Branch reference (informational)

| Backend     | Script                      | `kind`             | Typical `exec.template`                         |
| ----------- | --------------------------- | ------------------ | ----------------------------------------------- |
| `local`     | `local-create.sh`           | `local-docker`     | `docker compose -p {id} exec app sh -c '{cmd}'` |
| `local`     | `local-create.sh`           | `local-shell`      | `cd {worktree_path} && {cmd}`                   |
| `namespace` | `namespace-create.sh`       | `namespace-devbox` | `nsc ssh {id} -T -- {cmd}`                      |
| `aws`       | `aws-create.sh` (not in v1) | `aws-ec2`          | (not implemented in v1)                         |

The `aws-create.sh` script does not exist yet — selecting the
`aws` backend in v1 should fail with an actionable error from the
missing-script path.

## Idempotency notes

- `local-create.sh` reuses the daemon's per-issue workspace
  (which is its cwd) and fast-forwards the default branch. Safe
  to re-run.
- `namespace-create.sh` POSTs `CreateInstance` with
  `uniqueTag: symphony-<identifier>` in the request body, which
  is exactly idempotent: a second call with the same tag returns
  the same instance id. Re-dispatch on the same issue reuses the
  microVM (bootstrap is a no-op the second time).

## Plan 18c — bare microVM namespace dispatches

For `namespace` backends, `namespace-create.sh` calls the
Namespace API to provision a **bare microVM** (Wolfi 6.16, kernel
6.16.9, root by default, full capabilities, seccomp off, native
docker daemon already running). No container layer. The
CreateInstance POST body has no `containers` field.

After the microVM is reachable, the script runs an idempotent
bootstrap that:

1.  Creates a non-root `symphony` user (uid 1000). `claude
--dangerously-skip-permissions` hard-refuses uid 0; the
    user exists only to satisfy that check.
2.  Installs the claude CLI as the symphony user via the standard
    `claude.ai/install.sh` installer.
3.  Verifies docker is running (Plan 21's `@env-up` prereq).

Then it uploads Symphony's per-dispatch bundle to `/opt/symphony/`:

| Path in microVM             | What                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `/opt/symphony/dispatch.sh` | The in-VM wrapper the daemon invokes via `nsc ssh`              |
| `/opt/symphony/skills/`     | The daemon's `packages/daemon/src/skills/` (tarred + extracted) |

Skills + wrapper are uploaded per-dispatch (source-versioned by
the daemon) — SKILL.md changes ship with the daemon, not with a
microVM image rebuild.

The `@planner` / `@coder` / `@curator` / `@ci` sub-agents run
**inside the microVM** via the `claude` CLI invoked by the
wrapper. Credentials reach the wrapper over `nsc ssh -T`'s stdin
in a heredoc the parent agent constructs (see `SECURITY.md` for
the dispatch template). The daemon's parent agent dispatches them
by Bash'ing
`nsc ssh "$id" -T -- bash /opt/symphony/dispatch.sh <name> '<inputs>' <<EOF ... EOF`.

`@sandbox` itself stays in the daemon (it can't run inside the
VM it's provisioning). ADR 0015 is the design rationale.

### Operator-side prerequisites (one-time per workspace)

1.  `nsc login` on the daemon host (Namespace CLI authenticated).

That's it. No image to build, no vault secrets to register, no
hardcoded IDs to paste anywhere. The daemon's own process env
already has `ANTHROPIC_API_KEY` (and optionally `GITHUB_TOKEN`)
— those forward per-stage over the stdin heredoc the parent
agent's dispatch template includes.

## Why a script rather than agent-inline shell?

The decision (Plan 17a, 2026-05-17): the create / teardown step
is procedural — there is one right command sequence per backend,
known to the operator. Having the agent re-derive that sequence
every dispatch is expensive (tokens) and brittle (transcription
errors). Scripts are deterministic, reviewable as plain bash, and
testable in isolation. The agent's remaining job — picking the
backend from labels and emitting structured output — is exactly
the kind of work agents are good at.
