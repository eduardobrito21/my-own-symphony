# Plan 12 — End-to-end real PR demo + Symphony self-hosting

- **Status:** 📝 Drafted
- **Extracted from:** original Plan 09 stage 09f. Split out
  because the live-fire test against real Linear + real GitHub
  is operational work distinct from the code work in Plans 10
  and 12. Failures here are typically setup/credentials/network,
  not the runtime code itself.
- **Spec sections:** none directly (this is the integration
  test that proves the spec's behavior end-to-end).
- **Layers touched:** new top-level `.symphony/` directory in
  this repo (the dogfood demo), `examples/deployment/symphony.yaml`
  with Symphony as one of the projects, scripts under `scripts/`
  for smoke setup.
- **ADRs referenced:** 0009 (multi-project), 0011 (agent-in-pod
  and ExecutionBackend).
- **Comes AFTER:** Plans 09, 11, 12. All three are prerequisites
  — Plan 09 ships multi-project + ExecutionBackend; Plan 10
  ships the pod runtime; Plan 11 ships idempotency that this
  plan's verification depends on.
- **Comes BEFORE:** Plan 13 (deployment containerization needs
  this plan's "it works end-to-end on a laptop" baseline before
  containerizing the daemon itself).

## Goal

A real Linear issue, in a real Linear project, triggers a real
PR on a real GitHub repo, end-to-end, with Symphony self-hosting:

1. Operator declares two projects in `symphony.yaml`:
   - The Symphony repo itself.
   - One additional throwaway test repo.
2. A Linear issue is created in either project, in `Todo`.
3. Symphony picks it up, dispatches a pod, the pod runs the
   full agent loop, opens a PR on GitHub, comments on Linear
   with the PR URL, transitions the issue to Done.
4. The four verification scenarios from the original 09f all
   pass:
   - PR opens against the right branch.
   - Linear comment lands with the PR URL.
   - Linear issue transitions per the workflow.
   - **Daemon-restart-mid-run**: kill the daemon mid-turn;
     restart. The daemon's next poll sees `In Progress`,
     leaves the still-running pod alone, the pod completes,
     terminal state lands. (This is what ADR 0011's
     pod-fetches handshake makes trivially safe.)
   - **Idempotency**: cancel + re-trigger the same issue.
     Result: same PR URL pushed-to, no duplicate comments.
   - **Host has no `pnpm`**: `which pnpm` empty on the host
     (or returns the host's, doesn't matter — the agent's
     `pnpm` is the container's, by construction). Verify via
     recorded `tool_call` events that no host paths leaked.

## Outcome shape (preview)

```
symphony.yaml (operator config — multi-project)
   projects:
     - linear: { project_slug: <symphony-project> }
       repo: { url: github.com/eduardobrito/my-own-symphony.git, ... }
     - linear: { project_slug: <test-project> }
       repo: { url: github.com/eduardobrito/symphony-smoke-test.git, ... }

Real Linear issue in either project (e.g. "Bump prettier patch,
run pnpm lint:fix, open PR")
   ↓
Daemon poller picks it up
   ↓
ExecutionBackend.start({ image: symphony/agent-base:1, envelope: ... })
   ↓
Pod (sibling container on host docker)
   ↓
   Linear: "starting work" comment → transition In Progress
   git clone → checkout symphony/<issue-id>
   read .symphony/workflow.md
   render prompt
   agent loop:
     - read package.json, find prettier version
     - edit package.json: bump patch
     - bash: pnpm install --prefer-frozen-lockfile (no, frozen
       won't work after edit — the workflow's hook uses --no-frozen)
     - bash: pnpm lint:fix
     - bash: git add -A && git commit
     - bash: git push -u origin symphony/<issue-id>
     - bash: symphony-pr-ensure → prints PR URL
     - linear_graphql: post completion comment with PR URL
     - linear_graphql: transition to Done
   ↓
Pod exits → daemon stops + cleans up
```

## Out of scope

- **Multiple concurrent pods.** This plan's smoke is one issue
  at a time. Concurrency was already exercised in Plan 06's
  MockAgent runs; the multi-project orchestrator from Plan 09
  handles it. Re-verifying with real pods is nice but not
  required for the DoD.
- **Repos with complex build matrices.** The smoke uses
  Symphony itself (TS + pnpm) and a minimal test repo. Repos
  with non-trivial polyglot stacks are tested in their own
  workflows by their owning teams.
- **Performance benchmarking.** "Did it work" is the gate, not
  "how fast." Benchmarking is a later concern.
- **Cost reporting beyond the existing `usage` events.** The
  smoke will emit usage events; reading + summarizing them on
  the dashboard is out of scope.

## Steps

### Stage 13a — Symphony's own `.symphony/` files

1. **`.symphony/workflow.md`** at the repo root:
   - Front-matter declares `agent.allowed_tools` for working on
     Symphony itself (Bash, Read, Edit, Write, Glob, Grep,
     `mcp__linear__linear_graphql`).
   - Prompt body instructs the agent on Symphony conventions:
     TS strict mode, `pnpm test`, layer rules from
     `ARCHITECTURE.md`, ADR/exec-plan documentation discipline.
   - Includes the standard "starting work / completed / pr-link"
     marker convention from Plan 11.

2. **`.symphony/agent.dockerfile`** at the repo root:
   - Extends `symphony/agent-base:1`.
   - Adds Symphony-specific deps if any (likely nothing for v1
     — Symphony is plain TS + pnpm, already in the base).
   - Exists as a working example for other repos.

3. **`pnpm docker:build:symphony`** script in root
   `package.json`:
   - `docker build -f .symphony/agent.dockerfile -t symphony-agent/symphony:latest .`
   - Documented in README.

### Stage 13b — Smoke test repo

4. **Create a smoke test GitHub repo** (e.g.
   `eduardobrito/symphony-smoke-test`). Minimal contents:
   - `package.json` with prettier as a dev dep.
   - `.symphony/workflow.md` from the
     `examples/repo-workflow/` template.
   - `README.md` explaining: "This repo exists for Symphony
     end-to-end smoke tests. PRs opened here by Symphony are
     expected and can be closed without merging."
   - Linear project linked to this repo.

5. **Operator `symphony.yaml`** for the smoke (committed at
   `examples/deployment/symphony.yaml` with explanatory
   comments — operator copies + edits for their own use):

   ```yaml
   polling: { interval_ms: 30000 }
   workspace: { root: /tmp/symphony-workspaces }
   agent:
     kind: claude
     model: claude-haiku-4-5
     max_concurrent_agents: 1
     max_budget_usd: 1
   execution:
     backend: local-docker
     base_image: symphony/agent-base:1
   projects:
     - linear: { project_slug: <symphony-project-id> }
       repo:
         url: https://github.com/eduardobrito/my-own-symphony.git
         default_branch: main
         agent_image: symphony-agent/symphony:latest
     - linear: { project_slug: <smoke-test-project-id> }
       repo:
         url: https://github.com/eduardobrito/symphony-smoke-test.git
         default_branch: main
   ```

### Stage 13c — Live smoke run

6. **Bringup**:
   - `pnpm docker:build:agent-base` (Plan 10)
   - `pnpm docker:build:symphony` (this plan)
   - Set env: `LINEAR_API_KEY`, `ANTHROPIC_API_KEY`,
     `GITHUB_TOKEN` (with PR + comment perms on both repos).
   - `pnpm symphony` (with `SYMPHONY_CONFIG=examples/deployment/symphony.yaml`).
   - Open dashboard at `http://localhost:3001`.

7. **Smoke issue 1 — smoke-test repo**:
   - Create Linear issue: "Bump prettier patch version, run
     `pnpm lint:fix`, open PR."
   - Watch:
     - Pod starts (visible in `docker ps`).
     - Linear comment "starting work" lands.
     - Issue transitions Todo → In Progress.
     - Pod runs the agent (visible in events stream).
     - Branch `symphony/<issue-id>` pushed.
     - PR opens on GitHub.
     - Linear comment with PR URL lands.
     - Issue transitions to Done.
     - Pod removed.
   - Capture screenshots + the captured `tool_call` events in
     the decision log.

8. **Smoke issue 2 — Symphony self-host**:
   - Create Linear issue in the Symphony project: "Add a
     trailing newline to `RELIABILITY.md` if it's missing."
     (Trivial change; tests verify Symphony can edit itself
     without breaking.)
   - Verify:
     - PR opens against the Symphony repo.
     - The PR's CI passes (or at least doesn't worsen).
   - This is the dogfood proof: Symphony works on Symphony.

### Stage 13d — Verification scenarios

9. **Daemon-restart-mid-run**:
   - Start a smoke issue.
   - When the agent is mid-turn (visible in the events
     stream), kill the daemon process (`pkill -f symphony`).
   - Wait for the pod to keep running (`docker ps` still
     shows it).
   - Restart the daemon.
   - Verify: the daemon's next poll sees `In Progress`, does
     NOT re-dispatch, leaves the pod alone. The pod completes,
     emits its terminal Linear transition. The next-after-
     completion poll picks up the now-`Done` state and
     archives the run.
   - This is the ADR 0011 dispatch-handshake guarantee in
     action. Capture in decision log.

10. **Idempotency re-trigger**:
    - After a smoke completes, manually transition the Linear
      issue back to Todo.
    - Wait for the next poll.
    - Verify: dispatched again, but:
      - Same PR URL (pushed to, not re-created).
      - No duplicate "starting work" comment (Plan 11
        marker logic skips the post).
      - At most one new commit on the branch (the agent's
        re-evaluation may produce a no-op or a small diff).
    - Capture in decision log.

11. **Host-has-no-pnpm verification**:
    - Run smoke issue 1.
    - During the run, `which pnpm` on the host (terminal). It
      may return the host's pnpm or empty — both fine.
    - Inspect the captured `tool_call` events for the run.
      Every `Bash` call's path should resolve inside the pod
      (no `/usr/local/bin/pnpm` from the host, no host paths
      at all).
    - Document the inspection method in decision log.

### Stage 13e — Docs

12. **Documentation updates**:
    - `README.md`:
      - "What works / what doesn't" section now reflects
        end-to-end PR loop working.
      - Screenshots of dashboard (single + multi-project +
        a completed run with PR URL).
      - "Run the smoke yourself" section linking to
        `examples/deployment/`.
    - `examples/deployment/README.md` — operator setup
      walkthrough including the docker:build steps.
    - `examples/repo-workflow/README.md` — repo-team setup
      walkthrough (workflow.md + agent.dockerfile +
      devcontainer fallback).
    - `ARCHITECTURE.md` — full layer map updated for the
      shipped state.
    - `docs/product-specs/deviations.md` — entries for §5,
      §11.2, §9.3 marked "Implemented" (pointing to ADRs
      0009, 0011 + this plan).

## Definition of done

- `symphony.yaml` with two projects (Symphony itself + the
  smoke test repo) drives the daemon end-to-end.
- A real Linear issue in the smoke test repo triggers a real
  PR on GitHub, with a Linear comment linking to it. PR URL
  - screenshots captured in decision log.
- A real Linear issue on the Symphony project triggers a real
  PR on the Symphony repo (dogfood). Screenshot captured.
- Daemon-restart-mid-run scenario passes: kill daemon, pod
  keeps running, daemon restart re-attaches via the Linear
  state-machine handshake (no socket reattach), pod completes
  cleanly.
- Idempotency re-trigger scenario passes: same PR URL, no
  duplicate comments.
- Host-has-no-pnpm verification: `tool_call` event audit shows
  zero host-path leaks.
- Dashboard's "Running" panel groups by project (already from
  Plan 09; reverified live).
- `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test`
  remain clean (no new tests typically added in this plan;
  it's smoke-driven).
- All four verification scenarios captured in the decision log
  with timestamps + observations.

## Open questions

- **Throwaway smoke test repo or use a Symphony-owned org?**
  Tentative: a personal repo `eduardobrito/symphony-smoke-test`
  for v1. If/when Symphony has multiple operators, move to a
  shared org.
- **Closing the smoke PRs.** Each smoke run leaves a real PR
  open. Manual close is fine for v1; an "auto-close after N
  hours" sweep is a later concern.
- **What if the smoke issue has actual bugs the agent surfaces?**
  Document them in decision log + open follow-up issues. The
  smoke is meant to exercise the runtime, not produce shipped
  changes — but if Symphony catches a real issue, that's a
  bonus.

## Decision log

(empty — populated as the plan executes)
