# Plan 11 — Idempotent side effects

- **Status:** 📝 Drafted
- **Extracted from:** original Plan 09 stage 09e. Split out
  because side-effect hygiene is a distinct concern from "the
  pod runtime works" — Plan 10 ships the runtime, this plan
  layers on the operational hygiene needed before a re-dispatch
  can be safe.
- **Spec sections:** none directly (this is operational hygiene
  on top of the spec's dispatch model).
- **Layers touched:** standard `before_run` hook template (in
  `examples/deployment/symphony.yaml`), per-repo `workflow.md`
  template, `packages/agent-runtime/src/wrappers/` (new shim
  scripts), `packages/daemon/src/tracker/linear/client.ts`
  (no-op transitions when state already correct).
- **ADRs referenced:** 0009 (multi-project — `branch_prefix`
  config lives in the project config), 0011 (agent-in-pod —
  the wrappers run inside the pod).
- **Comes AFTER:** Plan 10 (the pod runtime must exist before
  we layer side-effect hygiene on top of it).
- **Comes BEFORE:** Plan 12 (the live PR demo's "re-trigger
  same issue, no duplicate" verification depends on this plan's
  hygiene).

## Goal

A re-dispatched issue produces no duplicate side effects:

1. Re-running the same issue does NOT open a second PR. If a PR
   for the per-issue branch already exists, the agent pushes a
   new commit to it instead.
2. Re-running does NOT post a duplicate "starting work" Linear
   comment. The agent finds the marker comment and references
   it instead of re-creating one.
3. The daemon does not double-fire Linear state transitions
   when the issue is already in the target state.
4. The per-issue branch is reused across attempts — `git
fetch` + `git pull` if the branch exists, `git checkout -b`
   from the default branch otherwise. The agent picks up where
   the last attempt left off, not from scratch on `main`.

Without this plan, every retry would double-comment, double-PR,
and double-transition. The pod-restart story from ADR 0011 is
broken without it: a daemon restart that re-dispatches a still-
in-progress issue would create chaos in Linear.

## Outcome shape (preview)

```
Dispatch → pod starts → entrypoint:
   1. Fetch issue (already in In Progress? OK — first attempt
      transitioned it; just continue).
   2. Clone:
        if remote branch exists:
          git fetch origin
          git checkout <symphony/EDU-X>
          git pull --rebase
        else:
          git checkout -b <symphony/EDU-X> origin/main
   3. Render prompt.
   4. Agent runs SDK loop.
   5. Agent calls symphony-pr-ensure (wrapper):
        gh pr view <branch>  → if found, no-op
                              → else gh pr create
   6. Agent posts "starting work" comment ONLY IF marker absent:
        list comments → grep for `<!-- symphony:starting-work -->`
        if absent: post + include marker
        if present: skip
```

The pod's behavior is the same on first dispatch and N-th
dispatch. That's idempotency.

## Out of scope

- **Hard-enforced idempotency via `PreToolUse` hooks** that
  block the agent from posting duplicate comments. Soft
  enforcement via prompt + marker is good enough for v1; hard
  enforcement is a later plan.
- **Linear comment editing** (rather than appending). The
  agent posts new comments, not edits existing ones. Editing
  would be cleaner for status updates but adds complexity.
- **PR conflict handling** when `git pull --rebase` fails. The
  agent gets the error in `tool_result` and decides what to
  do; we don't bake conflict resolution into the wrappers.

## Steps

### Stage 12a — Per-issue branch convention

1. **Branch naming**: `<branch_prefix><issue_identifier>`
   (e.g. `symphony/EDU-123`). `branch_prefix` defaults to
   `symphony/` (per-project override in deployment YAML lives
   in Plan 09 schema).

2. **Standard `before_run` hook** in
   `examples/deployment/symphony.yaml`'s `hooks.before_run`:

   ```bash
   set -euo pipefail
   cd /workspace
   git config user.email "${GIT_AUTHOR_EMAIL:-symphony@local}"
   git config user.name "${GIT_AUTHOR_NAME:-Symphony Agent}"
   git fetch origin
   if git ls-remote --exit-code origin "$SYMPHONY_BRANCH" >/dev/null 2>&1; then
     git checkout "$SYMPHONY_BRANCH"
     git pull --rebase origin "$SYMPHONY_BRANCH"
   else
     git checkout -b "$SYMPHONY_BRANCH" "origin/$SYMPHONY_DEFAULT_BRANCH"
   fi
   pnpm install --prefer-frozen-lockfile
   ```

   Runs INSIDE the pod (the wrapper PATH points there).

3. **Env injection** for the hook: `SYMPHONY_BRANCH`,
   `SYMPHONY_DEFAULT_BRANCH`, `SYMPHONY_REPO_URL`,
   `SYMPHONY_ISSUE_IDENTIFIER`, `SYMPHONY_ISSUE_ID` set by the
   agent-runtime entrypoint from the dispatch envelope before
   running the hook.

### Stage 12b — PR upsert wrapper

4. **`symphony-pr-ensure`** shim at
   `/opt/symphony/bin/symphony-pr-ensure` (baked into the base
   image — extends Plan 10 step 4):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   if gh pr view "$SYMPHONY_BRANCH" --json url --jq '.url' 2>/dev/null; then
     # PR already exists; just print its URL.
     exit 0
   fi
   gh pr create \
     --base "$SYMPHONY_DEFAULT_BRANCH" \
     --head "$SYMPHONY_BRANCH" \
     --title "${SYMPHONY_PR_TITLE:-Symphony: $SYMPHONY_ISSUE_IDENTIFIER}" \
     --body "${SYMPHONY_PR_BODY:-Automated changes from Symphony for $SYMPHONY_ISSUE_IDENTIFIER}"
   ```

   Standard prompt template instructs the agent: "to ensure a
   PR exists for your changes, run `symphony-pr-ensure`. It
   prints the PR URL whether it created one or found an
   existing one."

5. **Push before pr-ensure**: the wrapper assumes the branch is
   pushed. The standard prompt instructs the agent to run
   `git push -u origin "$SYMPHONY_BRANCH"` before calling
   `symphony-pr-ensure`. Could be folded into the wrapper, but
   keeping push explicit lets the agent decide when (e.g. after
   tests pass).

### Stage 12c — Comment dedup via marker

6. **Marker convention**: every status comment posted by the
   agent includes a stable HTML-comment marker:
   - `<!-- symphony:starting-work issue=EDU-123 -->` — first
     comment of any attempt.
   - `<!-- symphony:completed issue=EDU-123 -->` — final
     comment.
   - `<!-- symphony:pr-link issue=EDU-123 pr=<url> -->` — PR
     announcement.

7. **Standard prompt template** instructs the agent:
   - "Before posting a `starting-work` comment, list the
     issue's comments and check for the marker
     `<!-- symphony:starting-work issue=$ISSUE_IDENTIFIER -->`.
     If present, skip the post. If absent, post the comment
     including the marker."
   - Same pattern for `completed` and `pr-link`.

   Soft enforcement via prompt — not bulletproof, but good
   enough for v1. Real enforcement is a `PreToolUse` hook in a
   later plan.

### Stage 12d — Tracker write idempotency at the daemon

8. **No-op transitions**: when the daemon transitions an
   issue's state, it first checks current state via the
   `LinearClient` cache and no-ops if already correct. Avoids
   the "transition to In Progress" double-fire that surfaced
   during the Plan 07 smoke (decision log entry 2026-04-29).

9. **Cache invalidation**: the cache is per-tick. After a
   poll, the daemon's view is fresh; transitions decided in
   that tick rely on the freshness. No TTL needed.

### Stage 12e — Tests

10. **Tests**:
    - Re-dispatch test: orchestrator dispatches issue X via
      `FakeBackend`; the FakeBackend records the dispatch,
      returns terminal event; orchestrator dispatches X again;
      assert the second dispatch happened with `attempt=2` AND
      that branch reuse intent is captured (this is mostly
      verifying the envelope, not the wrapper since FakeBackend
      doesn't run shell).
    - Standard before_run hook tested with a real bash + a
      mock git (or against a local-only test repo): branch
      exists → checkout + pull; branch absent → create from
      default.
    - `symphony-pr-ensure` tested with mocked `gh`: PR exists
      → prints URL, exits 0; PR absent → calls `gh pr create`.
    - Marker dedup logic tested via prompt template + a
      stubbed `linear_graphql` that returns existing comments.
    - Linear no-op transition tested: client called with
      target state == current state → no API request.

## Definition of done

- Re-dispatching the same issue (without manual cleanup)
  results in:
  - The same per-issue branch picked up, not a fresh branch.
  - Same PR URL pushed-to (no duplicate PR created).
  - At most one `starting-work` comment in the issue history.
  - No duplicate state transitions in Linear's audit log.
- The standard `before_run` hook handles both branch-exists
  and branch-absent cases.
- `symphony-pr-ensure` is in the base image and works in both
  cases.
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean, with new tests covering the idempotency scenarios.

## Open questions

- **What happens when `gh pr create` fails (rate limit,
  network)?** The agent gets the error in `tool_result`; the
  workflow.md prompt should instruct it to comment + retry on
  next turn. Daemon doesn't bake retry semantics for this — it's
  the agent's call.
- **`branch_prefix` default — `symphony/` or `<project_key>/`?**
  Tentative: `symphony/`. Rationale: makes branches grep-able
  across repos; project context is in the issue identifier.
- **Marker comment visibility.** HTML comments render invisibly
  in Linear's UI. Nice for not cluttering the user's view of
  the comment thread; bad for human debuggers wondering "is
  this Symphony's marker?" Document in operator README.
- **Should `symphony-pr-ensure` push automatically?** Folding
  push into the wrapper is convenient but couples push to PR
  creation. Keeping them separate gives the agent a place to
  put "if tests fail, don't push" logic. Going with separate.

## Decision log

(empty — populated as the plan executes)
