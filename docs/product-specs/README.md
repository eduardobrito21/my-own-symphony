# Product specs

The product spec for Symphony is vendored from upstream so it is available
in-repo (i.e. visible to agents and to readers offline). It is the
authoritative description of _what Symphony is_; the rest of this repository
is the description of _how this implementation builds it_.

## Files

| File                                   | Source                                                    |
| -------------------------------------- | --------------------------------------------------------- |
| [`symphony-spec.md`](symphony-spec.md) | Vendored verbatim from `openai/symphony` `SPEC.md`        |
| [`deviations.md`](deviations.md)       | Where this implementation diverges from the spec, and why |

## Vendoring metadata

- **Upstream:** https://github.com/openai/symphony
- **Vendored from commit:** `58cf97da06d556c019ccea20c67f4f77da124bf3`
- **Vendored on:** 2026-04-28

## Updating the vendored spec

When upstream releases a new SPEC version:

1. Replace `symphony-spec.md` with the new content.
2. Update the commit SHA and date above.
3. Re-read `deviations.md` and update any deviations whose underlying
   spec language has changed.
4. If the new spec introduces a behavior we now support or have
   intentionally chosen not to support, write or update the relevant
   ADR in `docs/design-docs/`.

```sh
gh api repos/openai/symphony/contents/SPEC.md --jq '.content' | base64 -d \
  > docs/product-specs/symphony-spec.md
```

Do not edit the vendored spec by hand. It is not ours.
