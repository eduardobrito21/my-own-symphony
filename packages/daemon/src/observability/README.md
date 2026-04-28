# `observability/` — cross-cutting telemetry

Logging, structured event emission, and snapshot helpers. This is the
only layer that may be imported from anywhere — it's intentionally
cross-cutting.

## Files (planned)

- `logger.ts` — `pino` logger with token-shaped redaction.
- `events.ts` — typed event emitter for orchestrator state changes.
- `snapshot.ts` — orchestrator snapshot serialization helpers.
- `token-accounting.ts` — SPEC §13.5 token aggregation rules.

## Allowed dependencies

- `types/` — yes.
- Anything else in this package — **no**.

## Why this rule

`observability/` is allowed to be imported from anywhere, so it must
itself depend only on the deepest layer. Otherwise we accidentally
create cycles: if `observability/` imported `tracker/`, and `tracker/`
imported `observability/` for logging, we'd have a cycle.

## Posture

- Logging output goes to stderr by default (so stdout stays usable for
  CLI integration).
- Token-shaped strings (`lin_*`, `sk-*`, etc.) are redacted via
  `pino`'s `redact` config.
- Never log raw payloads above a configured byte cap.

See [`SECURITY.md`](../../../../SECURITY.md).
