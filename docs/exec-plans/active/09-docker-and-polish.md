# Plan 09 — Docker, polish, and definition of "v1 done"

- **Status:** Not started
- **Spec sections:** N/A (deployment is out of spec scope)

## Goal

Make Symphony deployable as a small set of containers, tighten any
loose ends from earlier phases, and declare v1 complete. After this
plan, `docker compose up` brings up daemon + dashboard with a
configured Linear project, and a fresh contributor (or future-you)
can read the repo top-to-bottom in under an hour.

## Out of scope

- Production hardening (managed secrets, network policies, autoscaling,
  high availability). Personal/learning project; not a SaaS.
- CI publishing of images. Local `docker build` is enough.
- Telemetry export to a remote backend.

## Steps

1. **Daemon Dockerfile** in `packages/daemon/Dockerfile`:
   - Multi-stage: builder runs `pnpm build`, runtime copies `dist/`
     and `node_modules` (production only).
   - Non-root user, `dumb-init` as PID 1.
   - Volume mount expected at `/workspaces` for `workspace.root`.
2. **Dashboard Dockerfile** in `packages/dashboard/Dockerfile`:
   - Standard Next.js standalone output build.
3. **`docker-compose.yml`** at repo root:
   - `daemon` service with env from `.env`, volume on
     `./workspaces:/workspaces`.
   - `dashboard` service depending on `daemon`.
   - Shared network so the dashboard can reach the daemon by service
     name.
4. **`.env.example`** documenting `LINEAR_API_KEY`,
   `ANTHROPIC_API_KEY`, `SYMPHONY_WORKFLOW_PATH`, etc.
5. **Polish pass**:
   - Read every doc; fix stale references.
   - Read every exec plan; ensure status reflects reality.
   - Run `pnpm deps:check` and address any new violations.
   - Run `pnpm lint` and address any new lint debt.
   - Move every completed plan from `active/` to `completed/`.
6. **`docs/exec-plans/tech-debt-tracker.md`** — populate from any
   "TODO" / "FIXME" / "XXX" comments collected during the build.
7. **README polish**:
   - Add a "What works / what doesn't" section listing the spec
     sections we conform to and the deviations.
   - Add screenshots of the dashboard.

## Definition of done

- `docker compose up` brings both processes to a healthy state on a
  fresh machine that has only `docker` and `docker compose`
  installed.
- The dashboard reflects orchestrator state after a tick.
- All exec plans are either in `completed/` or have an explicit
  status reason for remaining `active/`.
- The repo passes `pnpm typecheck && pnpm lint && pnpm test &&
pnpm deps:check && pnpm build` cleanly.
- A first-time reader following only `README.md` → `AGENTS.md` →
  `ARCHITECTURE.md` can boot the system within an hour.

## Open questions

(none yet)

## Decision log

(empty)
