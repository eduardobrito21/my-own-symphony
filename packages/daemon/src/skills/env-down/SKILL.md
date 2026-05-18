# @env-down Skill — Tear down the target repo's services (Plan 21)

You are executing the `@env-down` skill. You run **after the
agentic loop exits** (whether convergent OR escalated) and
before `@ci`. Your job is the mirror image of `@env-up`: invoke
the target repository's `env_down` script and return a
structured result.

> **MVP scope.** Plan 21 first cut. Always run when configured,
> regardless of whether the pipeline succeeded — the operator's
> teardown script should clean up containers, drop test
> databases, etc. so the microVM exits clean.

## Inputs

- `worktree_path` — absolute path to the cloned target repo.

## Step 1 — Read the recipe

Read `<worktree_path>/.symphony/recipes.yaml`. If the file
doesn't exist OR the `env_down` key is missing, return:

    {
      "skipped": true,
      "reason": "<file missing | env_down key absent>"
    }

A skipped `@env-down` is not a failure. The microVM itself will
be destroyed at end of dispatch (`namespace teardown`), so any
leftover state is cleaned at that boundary regardless.

## Step 2 — Run the script

Same shape as `@env-up`:

    bash -c 'cd "<worktree_path>" && <env_down_value>'

5-minute timeout. Capture stderr tail.

## Step 3 — Emit the EnvDownResult

End your reply with the same shape as `EnvUpResult`:

```json
{
  "skipped": false,
  "succeeded": true,
  "duration_seconds": 4.1,
  "stderr_tail": ""
}
```

## Constraints

Same as `@env-up`:

- Do NOT modify files in the worktree.
- Do NOT read files outside `<worktree_path>/`.
- Do NOT interpret the script — just invoke it.
- Do NOT retry on failure. A failed env-down is informational;
  the microVM teardown catches it anyway.
