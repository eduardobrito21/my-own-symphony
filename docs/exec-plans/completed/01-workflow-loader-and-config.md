# Plan 01 — Workflow loader and config layer

- **Status:** Complete
- **Started:** 2026-04-28
- **Completed:** 2026-04-28
- **Spec sections:** §5 (Workflow Specification), §6 (Configuration
  Specification)
- **Layers touched:** `types/`, `config/`

## Goal

Read `WORKFLOW.md`, validate it, and expose a typed config object
plus a Liquid-compatible prompt template to the rest of the daemon.
After this plan, the daemon can be pointed at a `WORKFLOW.md` and will
either print its parsed config or surface a clear, typed error.

## Out of scope

- Watching the workflow file for changes (covered by Plan 05).
- Rendering the prompt template against an issue object (covered by
  Plan 02 once the `Issue` type exists).
- Any orchestrator behavior. The config layer is policy-free.

## Steps

1. **Domain types** in `packages/daemon/src/types/`:
   - `WorkflowDefinition` (config + prompt template).
   - `ServiceConfig` (typed view of all front-matter values).
   - Each typed sub-config (`TrackerConfig`, `PollingConfig`,
     `WorkspaceConfig`, `HooksConfig`, `AgentConfig`, `CodexConfig`).
   - Workflow error types (`MissingWorkflowFile`, `WorkflowParseError`,
     `WorkflowFrontMatterNotMap`, `TemplateRenderError`).
2. **Front matter parser** in `packages/daemon/src/config/parse.ts`:
   - Split YAML front matter from prompt body.
   - Use `yaml` library with strict parsing.
   - Return a typed `WorkflowDefinition` or a typed error.
3. **zod schema** in `packages/daemon/src/config/schema.ts`:
   - One schema per top-level front-matter key.
   - Apply spec defaults via `.default(...)`.
   - Coerce path values (`~` expansion, `$VAR` resolution) through
     `.transform(...)`.
   - Export inferred types from the schema (no parallel hand-written
     types).
4. **Path / env resolution** in `packages/daemon/src/config/resolve.ts`:
   - `expandHome(path)` — `~` to `os.homedir()`.
   - `resolveEnvVar(value)` — `$VAR_NAME` to `process.env[VAR_NAME]`,
     empty string → treat as missing.
   - `absolutize(path, base)` — relative paths relative to the
     workflow file directory.
5. **Loader** in `packages/daemon/src/config/loader.ts`:
   - `loadWorkflow(path)`: read file → parse → validate → return
     typed result or typed error.
6. **Tests** under `packages/daemon/src/config/*.test.ts`:
   - Front matter detection (with / without `---` markers).
   - Empty / non-map / malformed YAML cases.
   - Each default applies when the key is absent.
   - `~` and `$VAR` resolution for path-shaped fields only.
   - Strict schema rejects unknown top-level keys (with a forward-
     compatible escape hatch documented inline).

## Definition of done

- `pnpm test packages/daemon/src/config` passes with at least 20 tests
  covering each behavior named above.
- `loadWorkflow('non/existent')` returns `MissingWorkflowFile`, not a
  thrown exception.
- `loadWorkflow('valid.md')` returns a fully-defaulted `ServiceConfig`
  even when the front matter contains only `tracker.kind: linear`.
- A CLI entry point `pnpm --filter daemon dev path/to/WORKFLOW.md`
  prints the parsed config object as JSON and exits 0; prints the
  typed error and exits non-zero on parse failures.
- The `config/` layer's `pnpm deps:check` shows zero violations.

## Open questions

- ~~**Liquid library choice.**~~ Deferred to Plan 02 (template rendering
  is out of scope for this plan; the prompt body is returned as an
  opaque string here).
- ~~**YAML library choice.**~~ Resolved: `yaml` (eemeli/yaml). See
  decision log.

## Decision log

- **2026-04-28** — Used `yaml` (eemeli/yaml) as the YAML parser. It
  has strict mode, good TypeScript typings, surfaces useful parse
  errors, and zero native deps (matters for Plan 09 Docker images).
- **2026-04-28** — Schema strictness: top-level uses `.passthrough()`,
  each named section uses `.strict()`. Reason: SPEC §5.3 says unknown
  top-level keys SHOULD be ignored (forward compat with extensions
  like `server.port` from Plan 08), but typos within a known section
  (e.g. `tracker.kid` instead of `tracker.kind`) should fail loudly.
  This deviates from the original Plan 01 wording ("Strict schema
  rejects unknown top-level keys") which contradicted the spec.
- **2026-04-28** — Domain types (`ServiceConfig`, `WorkflowDefinition`,
  etc.) live in `config/schema.ts`, not in `types/`. Reason: they are
  inferred from zod schemas (`z.infer<...>`), and zod is a runtime
  library — `types/` must remain runtime-free per ARCHITECTURE.md.
  Plan 01 step 1 was loose on this; the actual placement is
  `config/schema.ts` for inferred types and `config/errors.ts` for
  the error union. The `types/` directory remains for pure-domain
  entities (`Issue`, `Workspace`, etc.) that arrive in Plan 02.
- **2026-04-28** — Errors modeled as a discriminated union of plain
  objects rather than `Error` subclasses. Reason: the orchestrator
  pattern-matches on `.code` for retry decisions, and TypeScript's
  narrowing on string-literal unions is more reliable than
  `instanceof` checks across module boundaries. See `config/errors.ts`
  for the full rationale.
- **2026-04-28** — Used `safeParse` (not `parse`) inside `loadWorkflow`
  so zod failures become typed return values rather than exceptions.
  Errors must not unwind across the loader boundary; the orchestrator
  startup preflight needs to surface them as structured operator output.
- **2026-04-28** — Split each package's `tsconfig.json` into two
  files: `tsconfig.json` (no-emit, includes tests; consumed by ESLint
  and the IDE) and `tsconfig.build.json` (emit, excludes tests;
  consumed by `tsc --build`). This is the standard pattern for
  monorepos with type-aware ESLint plus project references. Without
  it, ESLint's `projectService` could not parse `*.test.ts` files
  because they were excluded from the build tsconfig.
- **2026-04-28** — Renamed package script `dev` (with `--watch`) to
  split: `dev` (one-shot tsx run) and `dev:watch` (the watch variant).
  Reason: the DoD CLI invocation `pnpm --filter daemon dev path` must
  exit cleanly to be testable; watch mode never exits.
- **2026-04-28** — Final test count: 55 (vs the DoD's "at least 20").
  Coverage spans every behavior named in step 6 plus path-resolution
  pipeline tests, error-formatter tests, and the `loadWorkflow`
  end-to-end happy path / error paths.
- **2026-04-28 (post-completion)** — Folded the spec's `codex.*`
  section into `agent.*` per [ADR 0008](../../design-docs/0008-fold-codex-section-into-agent.md).
  The schema's `codex.command` / `codex.approval_policy` / etc. are
  gone; the three timeout fields (`turn_timeout_ms`, `read_timeout_ms`,
  `stall_timeout_ms`) moved to `agent.*`. Triggered by Eduardo asking
  "didn't we change to anthropic sdk?" while reviewing `schema.ts` —
  the misleading `codex` name in our own schema was an unforced cost
  for compatibility we'll never use. Tests count became 56 (added
  one for legacy `codex.*` passthrough).
