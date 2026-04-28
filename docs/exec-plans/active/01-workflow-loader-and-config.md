# Plan 01 — Workflow loader and config layer

- **Status:** Not started
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

- **Liquid library choice.** Default is [`liquidjs`](https://liquidjs.com/).
  Decide before starting whether strict mode for unknown variables and
  filters is the default or opt-in. Spec §5.4 requires strict.
- **YAML library choice.** `yaml` (eemeli/yaml) supports strict mode and
  has good TypeScript typings. Default to it; revisit if it doesn't
  surface useful parse errors.

## Decision log

(empty)
