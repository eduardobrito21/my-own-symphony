# References

External library and protocol documentation indexed for in-repo agent
access.

When working on a feature that uses a new library, we add an
`<lib>-llms.txt` (or equivalent extracted reference) here so the agent
can look up the API surface without reaching outside the repo. This
matches the harness-engineering principle that anything not in the repo
is invisible to the agent.

## Conventions

- Filenames: `<library>-llms.txt` for canonical "llms.txt" formats.
- Use `<library>-reference.md` for hand-summarized references when no
  llms.txt exists.
- Each file should start with: source URL, fetch date, license note.
- Only vendor what we expect to use. A bloated reference dir is
  worse than a missing one (article: "context is a scarce resource").

## Current references

(empty — we vendor as needed during phase work)

## Suggested references to vendor when relevant

- `zod-llms.txt` — schemas (Plan 01).
- `liquidjs-reference.md` — strict template engine (Plan 02 prompt
  rendering).
- `chokidar-reference.md` — file watcher (Plan 05).
- Linear GraphQL schema excerpts — only the queries we actually call
  (Plan 06).
- Claude Agent SDK reference — the SDK shape we depend on (Plan 07).
- Fastify route patterns — schema validation, error envelope (Plan 08a).
- Next.js App Router patterns — RSC + client islands (Plan 08b).
