# Deployment config example

`symphony.yaml` is the operator-side configuration for a Symphony
install. One file per Symphony deployment; lists every Linear project
the daemon should watch.

## What lives here vs. the per-repo workflow

| Lives in `symphony.yaml` (this file)                              | Lives in `<repo>/.symphony/workflow.md`                |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| Polling interval                                                  | Prompt template body                                   |
| Workspace root path                                               | Per-repo `agent.allowed_tools`                         |
| Daemon-wide concurrency caps                                      | Per-repo `agent.model` override (optional)             |
| ExecutionBackend selector + base image                            | Per-repo budget cap floors (optional)                  |
| Per-project Linear slug + repo coordinates                        | Repo-team-owned `before_run` / `after_run` hook bodies |
| Operator-side `agent` defaults (model, max_turns, max_budget_usd) |                                                        |

The per-repo workflow lives **inside the cloned repo** and is loaded
by the agent-runtime in the pod after the clone — the daemon never
reads it. See [`examples/repo-workflow/`](../repo-workflow/) for the
template.

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

| Field                | Default                 | Use when                                              |
| -------------------- | ----------------------- | ----------------------------------------------------- |
| `repo.agent_image`   | (resolved per Plan 10)  | You want to pin an explicit pre-built image tag       |
| `repo.workflow_path` | `.symphony/workflow.md` | The repo keeps its workflow in a non-default location |
| `repo.branch_prefix` | `symphony/`             | You want per-issue branches to use a different prefix |

## Compatibility with the legacy `WORKFLOW.md`

If you're upgrading from a single-`WORKFLOW.md` setup
(`pnpm symphony path/to/WORKFLOW.md`), that command still works. The
daemon detects the legacy invocation and synthesizes a one-project
deployment in memory. To migrate, write a `symphony.yaml` whose
single `projects:` entry mirrors your existing `WORKFLOW.md`'s
`tracker.project_slug` + your repo URL.
