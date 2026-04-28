# 0006 — Use zod for parsing every value crossing a boundary

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

A typed core is only as trustworthy as the validation at its edges. The
Symphony daemon has many edges:

- `WORKFLOW.md` YAML front matter (operator input).
- Linear GraphQL responses (network).
- Claude Agent SDK events (subprocess / SDK output).
- HTTP request bodies and query parameters (consumer input).
- Environment variables (host).
- Workspace hook script outputs (subprocess).

If any of these is consumed without parsing, a single upstream change can
silently corrupt orchestrator state. The Harness Engineering post calls
this out explicitly: "we don't probe data 'YOLO-style'."

## Decision

**Use [`zod`](https://zod.dev) to parse every value that crosses a
process or trust boundary** before it enters the typed core.

- Each boundary has a schema file colocated with the code that owns the
  boundary (e.g. `tracker/linear/responses.ts`,
  `http/schemas.ts`, `config/schema.ts`).
- Schemas are the **canonical** types — application code consumes
  `z.infer<typeof Schema>`, not hand-written interfaces.
- Parse errors are converted to typed domain errors with
  remediation-oriented messages.
- **Inside** the typed core, values are trusted; we do not re-parse
  what we have already validated.

## Alternatives considered

1. **Hand-written type guards** — ad hoc, easy to forget, never as
   strict as a schema. Rejected.
2. **`io-ts` or `effect/Schema`** — capable libraries but with steeper
   learning curves. zod has the largest ecosystem and the gentlest TS
   onboarding. Rejected for now; revisit if zod's runtime overhead
   becomes a bottleneck.
3. **`valibot`** — smaller bundle, faster, similar ergonomics. Less
   ubiquitous documentation. Rejected for now; the daemon is not
   bundle-size-sensitive.

## Consequences

**Easier:**

- A Linear response with a missing field surfaces a clear validation
  error at the parse point, not a `Cannot read property of undefined`
  ten lines downstream.
- Schemas double as documentation of the expected shape.
- Tests can construct typed fixtures by parsing JSON literals rather
  than maintaining duplicate type definitions.

**Harder:**

- Slight runtime cost per validation. Acceptable: validations happen at
  IO boundaries, not in tight loops.
- Schemas drift if a remote API changes silently. We mitigate by
  preferring strict schemas (`.strict()`) and treating unexpected fields
  as parse errors during development.

**Constrained:**

- We do not add a "trust this just this once" escape hatch. If a value
  enters the typed core without parsing, that is a bug.

## Implementation notes

- Schemas live in `**/schemas.ts` or `**/schema.ts` files within their
  owning layer. Avoid a global `schemas/` directory — schemas belong to
  the boundary that produces them.
- The `config/` layer additionally exports inferred types for the rest
  of the codebase to import; downstream code should not reach into the
  schema module directly.
- Error messages produced by `.parse()` failures should be wrapped into
  typed errors (see `RELIABILITY.md` for the failure taxonomy).
