# Linear adapter smoke test

Exercises the real `LinearTracker` (Plan 06) against your actual Linear
project. The agent is still the `MockAgent` — Plan 07 wires real Claude.

## Setup

1. **Put your Linear API key in `.env` at the repo root:**

   ```
   LINEAR_API_KEY=lin_api_your_token_here
   ```

   `.env` is gitignored. The `pnpm symphony` script loads it via Node's
   built-in `--env-file` flag.

2. **Find your project's slug.** Linear project URLs look like:

   ```
   https://linear.app/<your-team>/project/q1-roadmap-3a7f8e9c
                                          ^^^^^^^^^^^^^^^^^^^
   ```

   The trailing segment after `/project/` is what Linear's API calls
   `slugId`. Right-click the project in Linear's sidebar → **Copy link**
   → grab the part after `/project/`.

3. **Edit `WORKFLOW.md` in this directory:** replace
   `REPLACE_WITH_YOUR_PROJECT_SLUG` with your slug.

4. **Build, then run:**

   ```sh
   pnpm build
   pnpm symphony examples/linear/WORKFLOW.md
   ```

5. **Watch logs for ~30 seconds.** `Ctrl-C` to stop.

## What you should see

| Log line | Meaning |
|---|---|
| `workflow loaded tracker_kind="linear"` | Parsed your WORKFLOW.md |
| `linear tracker ready endpoint="..." project_slug="..."` | Auth-ready, NO Linear call yet |
| `tick start running=0 retrying=0` | First poll about to fire |
| `tick end candidates=N dispatched=M` | `N` is real Linear active issues |
| `dispatch issue_id="..." issue_identifier="ABC-123"` | An actual ticket of yours |
| `agent_event ... kind="session_started"` | MockAgent fakes a session |
| `worker_exit reason="normal" retry_kind="continuation"` | Mock finished, retry queued |
| `retry_fired ... retry_released_claim` | Retry hit; not eligible (already_claimed) |
| `signal received` → `clean shutdown complete` | SIGINT exit |

If the project has zero `Todo`/`In Progress` issues, you'll see
`candidates=0 dispatched=0` every tick — that's correct, nothing to do.

## What to check after a run

- `/tmp/symphony-linear-test-workspaces/` should contain a directory
  per dispatched issue, named with the sanitized identifier (e.g.
  `ABC-123/`). Each should contain a `.ws-created` file from the
  `after_create` hook.
- No errors in the log. If you see `linear_api_request` /
  `linear_api_status` / `linear_graphql_errors`, the typed code tells
  you which layer failed.

## Cleanup

```sh
rm -rf /tmp/symphony-linear-test-workspaces
```

## Common issues

**`tracker.kind=linear requires tracker.api_key`:**
your `.env` doesn't have `LINEAR_API_KEY`, or the daemon isn't loading
it. Confirm `pnpm symphony` (not `node dist/index.js` directly) — only
the former passes `--env-file=.env`.

**`linear_graphql_errors`:**
your token is valid but the request was rejected — usually a wrong
`project_slug`. Linear returns a clear error message, surfaced in
`error.message`.

**`linear_api_status status=401`:**
token is wrong or expired. Generate a new one in Linear → Settings →
Security & access → Personal API keys.

**`linear_api_status status=429`:**
rate-limited. The default 5s poll interval is fine for most accounts;
bump it to `10000` if needed.

**`workflow_validation_error`:**
your WORKFLOW.md is malformed. The error tells you which key /
field — usually a typo in `project_slug` or a missing colon.
