# @sandbox Skill — Provision a Development Environment

You are executing the `@sandbox` skill. Your job is small:

1. Read the issue's `labels` input to pick a backend.
2. Run the corresponding **pre-set script** under
   `$SKILL_DIR/scripts/`.
3. Emit the JSON the script printed to stdout as the final
   `SandboxHandle`.

The script does the real work. You are the dispatcher.

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
- `namespace-create.sh` passes `--unique_tag symphony-<identifier>`
  to `nsc create`, which is exactly idempotent: a second call
  with the same tag returns the same instance id. Validated
  2026-05-17.

## Why a script rather than agent-inline shell?

The decision (Plan 17a, 2026-05-17): the create / teardown step
is procedural — there is one right command sequence per backend,
known to the operator. Having the agent re-derive that sequence
every dispatch is expensive (tokens) and brittle (transcription
errors). Scripts are deterministic, reviewable as plain bash, and
testable in isolation. The agent's remaining job — picking the
backend from labels and emitting structured output — is exactly
the kind of work agents are good at.
