# Execution plans

Plans are first-class artifacts. Each meaningful piece of work gets a
plan, checked into the repo, updated as work progresses.

## Layout

- **`active/`** — plans for in-flight or upcoming work, numbered by
  intended order. Update as you learn; never let a plan get out of sync
  with reality.
- **`completed/`** — plans that have been finished. Read-only after
  move; useful as a historical record of how problems were actually
  solved.
- **`tech-debt-tracker.md`** — a single living document listing things
  we know are imperfect but chose not to address yet, with the trigger
  that would change that.

## Format

Every plan has these sections:

- **Status** — `Not started` / `In progress` / `Complete`. Always
  current.
- **Goal** — one paragraph. What changes when this is done.
- **Out of scope** — explicit non-goals. What this plan will _not_ do
  (often the most useful section).
- **Steps** — ordered list. Each step is small enough to verify
  individually.
- **Definition of done** — the falsifiable test(s) that must pass for
  the plan to move to `completed/`.
- **Open questions** — things you don't know yet. Resolve before
  starting; convert to ADRs if they're load-bearing.
- **Decision log** — append-only record of decisions made _during_
  execution. Date-stamped.

## Lifecycle

1. Write the plan in `active/`.
2. Begin execution. Update **Status** to `In progress`.
3. As you work, append to **Decision log** for any non-obvious choice.
4. When **Definition of done** is satisfied, move the file to
   `completed/`. Do not edit it after the move.
5. If a plan is abandoned, move it to `completed/` with **Status**
   `Withdrawn` and a note explaining why.
