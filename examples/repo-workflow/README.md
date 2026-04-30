# Per-repo workflow example

`.symphony/workflow.md` is the **repo-team-owned** Symphony
configuration. It lives inside the target repo (committed alongside
the code) and tells the agent how to operate in this codebase:

- Which SDK tools are allowed.
- Optional model / budget overrides on top of operator defaults.
- Repo-specific shell hooks (typical: install deps, checkout the
  per-issue branch).
- The prompt template for each issue.

The agent-runtime pod loads this file **after cloning the repo** (per
[ADR 0011](../../docs/design-docs/0011-agent-in-pod-and-execution-backend.md)).
The Symphony daemon never reads it — operator vs. repo-team
ownership boundary.

## Why per-repo (and not in `symphony.yaml`)

Different teams own different repos. The team that owns the repo
knows:

- Which lint, test, and build commands to run.
- Which paths in the codebase are agent-safe and which are not.
- Which Linear states map to which actions.

Putting this knowledge in `symphony.yaml` would couple every workflow
change to a deployment-side edit. Putting it in the repo means a PR
to the repo can iterate the agent's behavior — and the same review
process the team uses for code applies to the agent's instructions.

## Setup

1. Copy `.symphony/workflow.md` into your target repo at the root:

   ```sh
   mkdir -p .symphony
   cp <symphony>/examples/repo-workflow/.symphony/workflow.md .symphony/workflow.md
   ```

2. Edit:
   - `agent.allowed_tools`: trim to what the agent actually needs.
     Tighter is safer.
   - `hooks.before_run`: adapt to your stack (e.g. `npm ci` instead
     of `pnpm install`, or add a `terraform init` call).
   - The prompt template body: tell the agent your repo's
     conventions (test command, lint command, PR template, etc.).

3. Optional: ship a `.symphony/agent.dockerfile` if your repo needs
   system deps not in the base image. See
   [Plan 10](../../docs/exec-plans/active/10-agent-in-pod-runtime.md)
   for the image resolution order.

4. Commit + push. Symphony picks up the new workflow on the next
   issue dispatched against this repo (no Symphony-side restart).

## Schema

The front matter is YAML. Schema definition:
`packages/daemon/src/config/repo-workflow.ts`. Sections:

- `agent` — repo-side overrides + tool allowlist
- `hooks` — repo-team-owned shell snippets

Daemon-deployment fields (`polling`, `workspace`, `tracker`,
daemon-wide concurrency caps) are intentionally **not** allowed
here — they belong in `symphony.yaml`.

## Falling back

If `.symphony/workflow.md` is missing from a repo, Symphony uses a
conservative default that posts a "no workflow.md found" comment and
exits without making changes. This is intentional — a missing
workflow file is most likely a configuration mistake, and we don't
want the agent to start doing things by accident.
