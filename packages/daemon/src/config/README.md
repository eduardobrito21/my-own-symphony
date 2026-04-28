# `config/` — workflow loading and typed configuration

Reads `WORKFLOW.md`, validates it, and exposes a typed config plus a
prompt template to the rest of the daemon.

## What lives here

- `parse.ts` — split YAML front matter from the prompt body.
- `schema.ts` — zod schemas for every front-matter section.
- `resolve.ts` — `~` expansion, `$VAR` resolution, path normalization.
- `loader.ts` — `loadWorkflow(path)` end-to-end.
- `watch.ts` — `chokidar`-based filesystem watcher (Plan 05).
- `errors.ts` — typed config errors.

## Allowed dependencies

- `types/` — yes.
- Anything else in this package — **no**.
- Third-party libraries (`yaml`, `zod`, `chokidar`, etc.) — yes.

## Why this rule

`config/` is a pure transformation: bytes on disk → validated runtime
config. It must not know about trackers, agents, or the orchestrator;
those layers consume `config/`'s output, never the other way around.
