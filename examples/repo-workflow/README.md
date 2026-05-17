# Per-repo customization example

A repo can customize how Symphony works in it by committing files
under a top-level `.symphony/` directory. The daemon picks these up
on each dispatch with no Symphony-side restart needed.

## Skill overrides (wired up today)

To override one of the bundled skills (`@sandbox`, `@coder`),
commit a `SKILL.md` at:

```
.symphony/skills/<name>/SKILL.md
```

The daemon's skill loader checks the repo first and falls back to
the bundled default at
[`packages/daemon/src/skills/<name>/SKILL.md`](../../packages/daemon/src/skills/).
Use the bundled file as a starting point — copy it, change the steps
that matter for your repo, commit.

Typical reasons to override:

- Your repo uses a non-standard sandbox shape (parallel git
  worktrees, a pre-warmed dev VM, a remote sandbox service).
- Your repo needs a specific bring-up sequence the generic skill
  doesn't know about.
- Your repo's `@coder` should follow team-specific conventions for
  branch naming, commit messages, or test commands.

## Workflow file (planned)

This directory also contains a `workflow.md` example showing the
intended shape of a per-repo workflow file (tools allowlist, model
overrides, prompt template). The pipeline does not consume
`workflow.md` yet — it's documented here as the target schema for a
future wire-up. For per-repo customization today, prefer skill
overrides above.

## Why per-repo (and not in `symphony.yaml`)

Different teams own different repos. The team that owns the repo
knows which lint, test, and build commands to run, which paths are
agent-safe, and which Linear states map to which actions. Putting
this in `symphony.yaml` would couple every workflow change to a
deployment-side edit. Putting it in the repo means a PR to the repo
can iterate the agent's behavior — and the same review process the
team uses for code applies to the agent's instructions.
