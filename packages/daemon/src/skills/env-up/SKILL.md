# @env-up Skill — Boot the target repo's services (Plan 21)

You are executing the `@env-up` skill. You run **after `@planner`
and before the agentic loop**. Your job is small and mechanical:
invoke the target repository's own `env_up` script (declared in
`.symphony/recipes.yaml`) and return a structured result. You
make NO judgement calls.

> **MVP scope.** Plan 21 first cut. You are the "boot the dev
> environment" sensor — `docker compose up`, seed databases,
> wait for healthchecks, whatever the target repo's script does.
> You do NOT modify code. You do NOT touch the application
> stack beyond running the configured script.

## Inputs

- `worktree_path` — absolute path to the cloned target repo.

## Step 1 — Read the recipe

Read `<worktree_path>/.symphony/recipes.yaml`. If the file does
not exist, OR the `env_up` key is missing, you are done — return:

    {
      "skipped": true,
      "reason": "<one-line: file missing | env_up key absent>"
    }

A skipped `@env-up` is not a pipeline failure. Downstream
sensors that need a running env (typically `@verify`'s
integration-test step) will fail predictably and the loop's
escalation handles it.

If the file exists and `env_up` is set, parse out its value.
The value is either an inline shell command (e.g. `pnpm dev`)
or a path to a script file (`./.symphony/scripts/env-up.sh`).
You don't need to distinguish — both forms work when invoked
via `bash`.

## Step 2 — Run the script

Invoke the configured command from the worktree:

    bash -c 'cd "<worktree_path>" && <env_up_value>'

Capture stderr (you'll need its tail on failure). Apply a
5-minute timeout — if `docker compose up` hangs waiting on a
container that won't come up, you don't want the dispatch to
hang with it.

> **Cd discipline.** The Bash tool runs in the daemon's cwd by
> default. Every Bash invocation here MUST start with
> `cd "<worktree_path>"` (or the equivalent absolute paths) so
> the env-up script reads its own repo, not the daemon's.

## Step 3 — Emit the EnvUpResult

End your reply with a single fenced ```json block:

```json
{
  "skipped": false,
  "succeeded": true,
  "duration_seconds": 12.4,
  "stderr_tail": "(empty if succeeded; last ~50 lines on failure)"
}
```

Field meanings:

- `skipped`: false if you ran the script (true was the early-
  return case from Step 1).
- `succeeded`: did the script exit 0?
- `duration_seconds`: wall-clock time. Useful for cost / cold-
  start budgets later.
- `stderr_tail`: last ~50 lines of the script's stderr.
  Only required on failure (succeed = empty / omit).

## Constraints

- **Do NOT** run `git commit`, `git push`, or modify files in
  the worktree.
- **Do NOT** read files outside `<worktree_path>/`.
- **Do NOT** interpret the script — just run it. If the
  operator wrote `rm -rf /` in their env-up, that's the
  operator's bug, not yours.
- **Do NOT** retry on failure. Return `succeeded: false` once;
  the parent agent's escalation logic decides what to do.
