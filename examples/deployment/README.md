# Deployment config example

> **Note:** the per-repo `.symphony/workflow.md` flow described below
> is not currently consumed by the pipeline runner. Per-repo
> customization that IS wired up is skill overrides at
> `<repo>/.symphony/skills/<name>/SKILL.md` — the skill loader checks
> the repo first and falls back to the bundled default.

`symphony.yaml` is the operator-side configuration for a Symphony
install. One file per Symphony deployment; lists every Linear project
the daemon should watch.

## What lives here vs. the per-repo workflow

| Lives in `symphony.yaml` (this file)                              | Lives in `<repo>/.symphony/`                           |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Polling interval                                                  | Skill overrides under `skills/<name>/SKILL.md`         |
| Workspace root path                                               | Per-repo `agent.allowed_tools` (via workflow.md — TBD) |
| Daemon-wide concurrency caps                                      | Per-repo `agent.model` override (optional — TBD)       |
| Per-project Linear slug + repo coordinates                        | Per-repo budget cap floors (optional — TBD)            |
| Operator-side `agent` defaults (model, max_turns, max_budget_usd) |                                                        |

Skill overrides live **inside the cloned repo** and are loaded by
the daemon's skill loader (repo override → bundled default). See
[`examples/repo-workflow/`](../repo-workflow/) for the template.

## Setup

1. Copy `symphony.yaml` to your deployment location (e.g. the host
   running the Symphony daemon):

   ```sh
   cp examples/deployment/symphony.yaml /etc/symphony/symphony.yaml
   ```

2. Edit `projects:` to list your Linear projects + their GitHub
   repos. Each project needs:
   - `linear.project_slug`: the trailing segment of the Linear
     project URL (`https://linear.app/.../project/<slug>`).
   - `repo.url`: the GitHub clone URL (HTTPS, with PAT in the
     `GITHUB_TOKEN` env).
   - `repo.default_branch`: typically `main`.

3. Set environment variables before launching:

   ```sh
   export SYMPHONY_CONFIG=/etc/symphony/symphony.yaml
   export LINEAR_API_KEY=lin_api_...
   export ANTHROPIC_API_KEY=sk-ant-...
   export GITHUB_TOKEN=ghp_...
   ```

4. Launch:

   ```sh
   pnpm symphony      # uses $SYMPHONY_CONFIG
   ```

## Adding a project

One entry under `projects:`. The daemon picks it up on next config
reload (no restart needed).

```yaml
projects:
  - linear:
      project_slug: <slug>
    repo:
      url: https://github.com/your-org/your-repo.git
      default_branch: main
```

Optional per-project fields:

| Field                | Default                 | Use when                                                                                  |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `repo.workflow_path` | `.symphony/workflow.md` | The repo keeps its workflow in a non-default location (currently unused — see note above) |
| `repo.branch_prefix` | `symphony/`             | You want per-issue branches to use a different prefix                                     |

## Invocation

The only supported invocation is
`pnpm symphony [path/to/symphony.yaml]` (defaults to
`./symphony.yaml`).
