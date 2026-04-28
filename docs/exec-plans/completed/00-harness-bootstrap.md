# Plan 00 — Harness bootstrap

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28

## Goal

Establish the harness: project scaffolding, documentation, layer
enforcement, and tooling — all before any application logic is written.
After this plan completes, the repository is shaped like a real
harness-engineered codebase, even though it does not yet _do_ anything.

## Out of scope

- Any application logic. No workflow loader, no tracker, no orchestrator.
- The dashboard package. It's added in Plan 08, not here.
- Docker. It's added in Plan 09.
- Choosing specific libraries (zod version, fastify version) beyond what
  is needed for the scaffolding to compile and lint.

## Steps

1. **Root config** — `package.json`, `pnpm-workspace.yaml`,
   `tsconfig.base.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`,
   `.npmrc`, `.nvmrc`. ✅
2. **Quality tooling** — `eslint.config.js`, `.prettierrc.json`,
   `.prettierignore`, `vitest.config.ts`, `.dependency-cruiser.cjs`. ✅
3. **Top-level docs** — `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`,
   `RELIABILITY.md`, root `README.md`. ✅
4. **Design docs (ADRs)** — `docs/design-docs/` populated with
   `0001`–`0007` capturing the decisions made before any code lands. ✅
5. **Product specs** — vendor upstream `SPEC.md`, write
   `deviations.md`, write `docs/product-specs/README.md`. ✅
6. **Execution plans** — populate `docs/exec-plans/active/` with one
   skeleton per phase (this file plus 01–09). ✅
7. **`packages/types` skeleton** — `package.json`, `tsconfig.json`,
   empty `src/index.ts`. Compiles with no exports. ✅
8. **`packages/daemon` skeleton** — `package.json`, `tsconfig.json`,
   `src/index.ts` printing a startup banner, layer directory placeholders
   (`types/`, `config/`, `tracker/`, `workspace/`, `agent/`,
   `orchestrator/`, `http/`, `observability/`) each with a `README.md`
   describing its responsibility. ✅
9. **Install + verify** — `pnpm install` succeeds; `pnpm typecheck`,
   `pnpm lint`, `pnpm test`, `pnpm deps:check`, and `pnpm build` all
   pass against the empty skeleton. ✅

## Definition of done

All of the following are true:

- `pnpm install` succeeds with no errors.
- `pnpm typecheck` passes (no source files yet, but project references
  resolve).
- `pnpm lint` passes (eslint + prettier).
- `pnpm test` passes (zero tests is fine).
- `pnpm deps:check` passes (no source files = no violations).
- `pnpm build` produces empty `dist/` directories.
- `AGENTS.md` exists and is readable end-to-end in under 5 minutes.
- All ADRs, exec plans, and the deviations file are linked from at
  least one other document (no orphan docs).

## Open questions

None at this point. The structural decisions are captured in ADRs
0001–0007.

## Decision log

- **2026-04-28** — Decided to ship a `packages/types` package even
  though only the daemon will consume it initially. Rationale: avoids a
  Phase-8 migration when the dashboard arrives. Cost: one tiny package.
  Benefit: type sharing is "free" forever.
- **2026-04-28** — Chose `dependency-cruiser` over `eslint-plugin-boundaries`
  for layer enforcement. Reason: `dependency-cruiser` has clearer error
  messages and supports custom messages per rule. ESLint plugin remains
  available if we want to layer it on top later.
- **2026-04-28** — Chose `tsconfig` `"NodeNext"` resolution and
  `"verbatimModuleSyntax": true`. Reason: matches modern Node + ESM
  conventions; forces `import type` discipline that pairs with the
  `consistent-type-imports` lint rule.
- **2026-04-28** — Pinned `typescript-eslint` to `~8.18.2` and
  `typescript` to `~5.7.2` because the latest versions of
  `typescript-eslint` pull `eslint-visitor-keys@5` which requires
  Node >= 20.19. Local Node is 20.18. Tech-debt: bump these and
  `.nvmrc` once Node 20.19+ is on the local machine.
- **2026-04-28** — Set `engine-strict` off in `.npmrc`. With it on,
  pnpm refuses installs over peer engines we cannot control transitively.
- **2026-04-28** — Added `--passWithNoTests` to the `test` and
  `test:watch` scripts. Phase 0 has no tests, but later phases will;
  the flag prevents an empty repo from breaking CI on day one without
  changing behavior once tests exist.
- **2026-04-28** — Renamed `eslint.config.js` to `eslint.config.mjs`.
  ESM imports require either `.mjs` or `"type": "module"` at the root
  package; the latter would force every config file in the repo to be
  ESM, including `.dependency-cruiser.cjs` and CJS Next.js configs in
  Plan 08. Less surface to reason about.
- **2026-04-28** — Bumped local Node from 20.18.0 to 20.20.1. Lifted
  the version-pin workarounds above:
  - `engine-strict=true` is back in `.npmrc`.
  - `engines.node` is `>=20.19.0` in root `package.json`.
  - `typescript-eslint` and `typescript` are back on caret ranges
    and resolved to the latest minors (`typescript-eslint@8.59.1`,
    `typescript@5.9.3`, `eslint@9.39.4`).
  - `.nvmrc` is `20.20.1`.
    Full verification chain (typecheck, lint, test, deps:check, build,
    run banner) still green.
