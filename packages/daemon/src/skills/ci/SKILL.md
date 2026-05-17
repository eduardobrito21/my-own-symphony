# @ci Skill — Commit, Push, Open PR (MVP)

You are executing the `@ci` skill. Your job is small: commit the
changes `@coder` made, push the branch, and open (or surface a
re-used) GitHub PR.

> **MVP scope.** Shipped alongside Plan 17a for the end-to-end smoke.
> The real `@ci` is Plan 19 (it will also handle: status-check waits,
> PR template enforcement, signed envelopes for BTG-style policy).
> The MVP is opinionated and minimal — see `scripts/ci-commit-push-pr.sh`.

## When you are invoked

Only when `@coder` returned a non-empty `changed_files` list. If the
list is empty the parent agent skips this stage entirely.

## Inputs you receive (from the parent agent's Stage 3 input block)

- `worktree_path` — from `sandbox_handle.worktree_path`.
- `branch` — the work branch `@sandbox` set up.
- `default_branch` — the base branch the PR will target.
- `identifier` — Linear issue identifier (e.g. `EDU-13`).
- `issue_title` — used as the PR title.
- `issue_url` — optional; embedded in the PR body for traceability.
- `coder_summary` — `summary` field from `@coder`'s `CoderResult`.

The parent prompt also injects `SKILL_DIR` — the absolute path to
this skill's directory. The script lives at
`$SKILL_DIR/scripts/ci-commit-push-pr.sh`.

## Step 1 — Pre-check the sandbox kind

The MVP `@ci` runs `git` and `gh` **on the daemon host**. That only
makes sense if the worktree is also on the daemon host.

- If `sandbox_handle.kind` starts with `local-` (e.g. `local-shell`,
  `local-docker`): proceed to Step 2.
- If it's anything else (e.g. `namespace-devbox`): **do not run the
  script.** Print a clear stderr line — e.g.
  `[ci] ERROR: MVP @ci only supports local-* sandboxes; got kind=<kind>. See Plan 19.` —
  and stop. Do **not** emit a CIResult JSON. The parent agent will
  see no JSON, treat Stage 3 as failed, and Stage 4 will post that
  failure to Linear.

(Plan 19 will route `gh` / `git push` through
`sandbox_handle.exec.template` so remote backends work too. Until
then, the `local` backend is the only end-to-end path.)

## Step 2 — Run the script

Invoke the bundled script with the required env vars:

```bash
SYMPHONY_WORKTREE_PATH="<worktree_path>" \
SYMPHONY_BRANCH="<branch>" \
SYMPHONY_DEFAULT_BRANCH="<default_branch>" \
SYMPHONY_IDENTIFIER="<identifier>" \
SYMPHONY_ISSUE_TITLE="<issue_title>" \
SYMPHONY_ISSUE_URL="<issue_url>" \
SYMPHONY_CODER_SUMMARY="<coder_summary>" \
  bash "$SKILL_DIR/scripts/ci-commit-push-pr.sh"
```

The script will:

- Verify `git` and `gh` are on PATH.
- Verify `gh auth status` — fails loud if no `GITHUB_TOKEN` /
  `gh auth login`.
- Stage all changes in the worktree (`git add -A`).
- Commit with a Symphony-branded committer identity and a message
  derived from the issue title + identifier + coder summary.
- Push the branch with `--force-with-lease` (safe re-dispatch).
- Look for an existing open PR for the branch:
  - If found, reuse it (the push you just did updates its head).
  - If not, open a new PR via `gh pr create`.
- Print a `CIResult` JSON object on stdout.

## Step 3 — Emit the CIResult

The script already produced well-formed JSON on stdout. Echo it back
inside a fenced ```json block as your final output:

```json
{ ... the JSON the script printed ... }
```

The parent agent extracts the **last** ```json block from your
output.

## Failure modes

- `git push` is rejected (e.g. branch protection, force-push
  denied) → script exits non-zero, stderr has `[ci] ERROR: git
push failed`. Report up.
- `gh pr create` fails (e.g. permissions, base branch missing) →
  script exits non-zero with the `gh` error. Report up.
- No changes in the worktree at the time the script runs → script
  exits non-zero with `no changes in worktree — @ci should not
have been invoked`. The parent agent should not have called you;
  treat this as a coordination bug.

In all failure paths, do not invent a `CIResult`. Let the parent
see the script's non-zero exit + stderr; the close-out stage will
post the failure to Linear.
