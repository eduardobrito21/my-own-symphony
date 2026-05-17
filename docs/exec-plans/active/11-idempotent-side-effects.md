# Plan 11 — Idempotent side effects (slim)

- **Status:** 📝 Drafted (framing reshaped 2026-05-17 for the
  sub-agent pipeline; Steps below still reference pre-Plan-15
  files and need re-targeting before execution — see "Reshape
  note 2026-05-17" below).
- **Reshape note 2026-05-17 (post-ADR-0014):** the previous
  reshape (2026-04-30) was rationalized against ADR 0012's
  Namespace backend, which ADR 0014 has since superseded. The
  three idempotency properties this plan exists to protect are
  unchanged; the surfaces that implement them have moved:
  - **Branch reuse** is already partially implemented inside
    the bundled `@sandbox` skill at
    `packages/daemon/src/skills/sandbox/SKILL.md` (the
    `git checkout "${branch}" 2>/dev/null || git checkout -b
"${branch}" "${default_branch}"` block we shipped on
    2026-05-17). A re-dispatch lands on the same branch from a
    freshly fast-forwarded default. Confirm + test (no
    `cloneAndCheckout` to modify — that file was deleted in
    Plan 15).
  - **Marker-comment dedup** is owned by the pipeline
    orchestration prompt at
    `packages/daemon/src/agent/pipeline/prompt.ts`'s Stage 3,
    not by per-repo `workflow.md`. The prompt currently
    instructs the agent to post a comment unconditionally; it
    needs the marker grep before posting.
  - **No-op transition guard** still belongs at
    `packages/daemon/src/tracker/linear/client.ts`. Unchanged
    from the prior reshape.
- **Reshape note 2026-04-30 (historical, now stale):** the
  original Plan 11 used `before_run` hook templates +
  a `symphony-pr-ensure` shim baked into the docker base image,
  both of which assumed LocalDockerBackend's in-pod-container
  model. ADR 0012's Namespace pivot retired the wrapper-script
  approach. ADR 0014 has since retired both ExecutionBackends
  entirely — see the 2026-05-17 note above for the current
  surfaces.
- **Spec sections:** none directly (operational hygiene on top
  of the spec's dispatch model).
- **Layers touched (current):** `packages/daemon/src/agent/pipeline/prompt.ts`
  (marker-comment dedup instructions in Stage 3),
  `packages/daemon/src/skills/sandbox/SKILL.md` (branch reuse
  — already partially done; needs verification + tests),
  `packages/daemon/src/tracker/linear/client.ts` (no-op
  transitions when the issue is already in the target state).
- **ADRs referenced:** 0009 (multi-project — `branch_prefix`
  config), 0014 (sub-agent pipeline — supersedes ADRs 0011/0012
  this plan previously cited).
- **Comes AFTER:** Plan 16 (sub-agent pipeline chassis — owns
  the prompt and skill surfaces this plan modifies).
- **Comes BEFORE:** Plan 19 (`@ci` skill — its "no duplicate
  PR" property is the fourth idempotency case this plan should
  cover by the time `@ci` ships).

## Goal

A re-dispatched issue produces no duplicate side effects:

1. Re-running the same issue does NOT open a second PR. If a
   PR for the per-issue branch already exists, the agent
   pushes a new commit to it instead.
2. Re-running does NOT post a duplicate "starting work"
   Linear comment. The agent finds the marker comment and
   references it instead of re-creating one.
3. The daemon does not double-fire Linear state transitions
   when the issue is already in the target state.
4. The per-issue branch is reused across attempts:
   `git fetch && git checkout <branch>` if the remote branch
   exists, `git checkout -b <branch> origin/<default>`
   otherwise.

Without this plan, every retry would double-comment, double-PR,
and double-transition.

## What the Namespace pivot already gives us

Two things from the original Plan 11 are now free:

- **Stale workspace state is impossible.** Each Namespace
  dispatch starts on a fresh VM with an empty filesystem; the
  prior attempt's working directory is gone with the prior
  instance. The original plan's `pnpm install --prefer-frozen-lockfile`
  hook to "reset" the workspace is no longer needed — the
  workspace is born reset.
- **Pod-restart-mid-run scenarios collapse.** If the daemon
  crashes mid-dispatch, the Namespace instance keeps running
  until its `deadline` and is then auto-destroyed. The next
  daemon-tick polls Linear, sees the issue still In Progress,
  and either reattaches (if we add reuse logic later) or
  re-dispatches into a fresh instance. Either path is safe
  because of the four properties above.

## Outcome shape (preview)

```
Dispatch N+1 → fresh Namespace instance →
  entrypoint:
    1. Fetch issue from Linear.
       - If already In Progress: skip the handshake transition
         (no-op guard at the tracker layer).
    2. Clone + checkout:
         git clone <repo> /workspace
         cd /workspace
         git fetch origin
         if git ls-remote --exit-code origin <branch>; then
           git checkout <branch>
         else
           git checkout -b <branch> origin/<default>
         fi
    3. Render prompt (workflow.md instructs the agent on
       marker-comment dedup).
    4. Agent runs SDK loop:
         - Before posting "starting work" comment: list
           comments, grep for `<!-- symphony:starting-work -->`,
           skip if present.
         - Before opening PR: `gh pr view <branch>` first.
           If found, push commits and reference the existing
           URL. If absent, `gh pr create`.
    5. Exit on terminal event.
```

## Out of scope

- **Hard-enforced idempotency via `PreToolUse` hooks.** Soft
  enforcement via prompt + marker is good enough for v1.
- **Linear comment editing** (rather than appending).
- **Wrapper scripts (`symphony-pr-ensure`) baked into a base
  image.** Removed in this reshape — the agent uses `gh pr
view` + `gh pr create` directly via its Bash tool.
- **PR conflict handling** when fast-forward push fails. The
  agent gets the error in `tool_result` and decides what to
  do; we don't bake conflict resolution.
- **Branch deletion / cleanup** after the PR merges.

## Steps

### Stage 11a — Branch reuse in the entrypoint

1. **Modify `cloneAndCheckout()` in
   `packages/agent-runtime/src/entrypoint.ts`** to:
   - After `git clone`, run `git fetch origin`.
   - Check `git ls-remote --exit-code origin <branch>`.
   - If exit 0 (branch exists): `git checkout <branch>`.
   - Else: `git checkout -b <branch> origin/<defaultBranch>`.
   - The current code already has the local-branch fallback
     (last-ditch `git checkout -b`); keep it.
2. **Tests:** unit test the new branch-resolution logic with
   a mocked process runner.

### Stage 11b — Marker convention + workflow.md guidance

3. **Marker convention:**
   - `<!-- symphony:starting-work issue=<identifier> -->`
   - `<!-- symphony:completed issue=<identifier> -->`
   - `<!-- symphony:pr-link issue=<identifier> pr=<url> -->`
4. **Update the standard workflow.md template** (in
   `examples/deployment/.symphony/workflow.md` or wherever the
   canonical template lives — confirm during impl) with
   explicit instructions:
   - "Before posting a `starting-work` comment, list the
     issue's comments via `mcp__linear__linear_graphql`. If
     any contains `<!-- symphony:starting-work issue=$IDENTIFIER -->`,
     skip the post. Otherwise, post the comment including the
     marker."
   - Same pattern for `completed` and `pr-link`.
   - "Before opening a PR, run `gh pr view <branch> --json
url --jq .url`. If exit 0, push commits to the existing
     branch and reference the URL. If exit 1, run
     `gh pr create`."

### Stage 11c — Daemon-side no-op transition guard

5. **Modify `LinearClient.transitionIssue` (or wherever the
   transition path is)** to first check the issue's current
   state. If it equals the target state, return a synthetic
   ok without making the API call. This prevents the
   double-fire that surfaced in the Plan 07 smoke (decision
   log entry 2026-04-29).
6. **Cache scope:** per-tick is sufficient. After a poll, the
   daemon's view is fresh; transitions decided in that tick
   rely on that freshness.

### Stage 11d — Tests

7. **Re-dispatch test:** orchestrator dispatches issue X via
   `FakeBackend`; FakeBackend records the dispatch, returns a
   terminal event; orchestrator dispatches X again; assert
   the second dispatch happened with `attempt=2` and that the
   envelope's branch is the same.
8. **Branch-reuse unit test** (in `entrypoint`'s test file):
   mocked git runner; branch exists → checkout; branch absent
   → create.
9. **Marker-dedup test** (template rendering — verify the
   prompt contains the documented marker instructions).
10. **No-op transition test:** stub current-state response;
    target == current → no API request.

## Definition of done

- Re-dispatching the same issue results in:
  - The same per-issue branch picked up (not a fresh branch).
  - Same PR (commits pushed; no duplicate PR created).
  - At most one `starting-work` comment in the issue history.
  - No duplicate state transitions in Linear's audit log.
- The `cloneAndCheckout` function handles both branch-exists
  and branch-absent cases.
- The standard workflow.md template documents the marker
  convention.
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  clean.

## Open questions

- **What happens when `gh pr create` fails (rate limit /
  network)?** Agent gets the error in `tool_result`; the
  workflow.md prompt should instruct it to comment + retry on
  next turn. Not baked into the runtime.
- **Marker comment visibility.** HTML comments render
  invisibly in Linear's UI. Pro: doesn't clutter the user's
  view. Con: human debuggers wonder "is this Symphony's
  marker?" Document in operator README.
- **Comment-dedup scope:** dedup ALL agent comments, or only
  the marker-tagged ones? V1: only marker-tagged ("status"
  comments). Free-form agent commentary is not deduplicated.
- **Branch reuse + force-push.** If the agent rebases its
  branch, push needs `--force-with-lease`. The agent's prompt
  should call this out; not baked into the runtime.

## Decision log

- **2026-04-30 — Reshape post-ADR-0012.** Original plan's
  wrapper-script + base-image-bake approach is removed. The
  three idempotency properties survive; enforcement moves to
  the agent prompt + a small daemon-side guard. Reason: the
  Namespace backend (Plan 14) doesn't have a shared base image
  to bake shims into, and the agent already has the Bash +
  linear_graphql tools needed to do the dedup checks
  directly. Net code reduction; same behavioral guarantee.
