---
status: proposed
linear_issue: null
github_pr: null
created: 2026-05-17
updated: 2026-05-17
closed: null
---

# Plan 17b — Private repo support in `@sandbox` (GitHub credentials)

- **Implements:** SECURITY.md's existing `GITHUB_TOKEN` slot, which is
  defined but unused. Promotes it to load-bearing for the @sandbox
  skill's clone step.
- **Comes AFTER:** Plan 17a (multi-backend `@sandbox` dispatcher).
  The credential injection patterns plug into the existing
  `local-create.sh` and `namespace-create.sh` scripts that 17a
  shipped.
- **Comes BEFORE:** Plan 18 (real `@coder`). The real coder needs
  to push back to the repo, which means the token also has to work
  for `git push`, not only clone. Plan 18 may extend the contract
  further; 17b establishes the clone-side baseline.
- **Spec sections:** none directly.
- **Layers touched:**
  `packages/daemon/src/skills/sandbox/scripts/` (extend both create
  scripts + add a shared askpass helper), `SECURITY.md` (promote
  `GITHUB_TOKEN` from "optional" to "required for private repos,
  ergonomically discoverable"), `packages/daemon/src/index.ts`
  (daemon-startup token presence log — non-fatal).
- **ADRs referenced:** ADR 0014 (per-project credential isolation
  explicitly deferred — this plan stays operator-wide).

## Goal

Allow `@sandbox` to clone private GitHub repositories on both
`local` and `namespace` backends, using a single operator-wide
`GITHUB_TOKEN` env var, **without leaking the token** into
`.git/config`, daemon `ps` output, shell history, agent logs, or
the parent agent's reasoning context.

Public-repo dispatches (today's only verified path) must continue
to work unchanged when no token is set.

## Out of scope

- **GitHub App support.** Long-lived PATs only for v1. App-based
  installation-token minting is a v2 follow-up (call it Plan 17c).
  The script contract — "daemon exports a token, scripts inject
  it" — does not change when the underlying credential source
  swaps; only the daemon's token-acquisition changes.
- **`nsc vault` integration.** Production answer; needs a separate
  vault config + bootstrap step. Defer to v2. v1 passes the token
  through the `nsc ssh` channel, accepting the trade-offs called
  out below.
- **SSH-key-based cloning.** A clean alternative for the
  `namespace` branch (`nsc create --ssh_key <pub>` + `nsc ssh -A`),
  but it forces a second credential model (SSH key) alongside the
  HTTPS-PAT one. Pick one; expand later.
- **Per-project credentials.** Operator-wide token is the v1
  contract per ADR 0014. A repo that needs a different credential
  belongs in a different daemon instance.
- **BitBucket / GitLab / Codeberg / self-hosted Git.** GitHub
  only. The `GITHUB_TOKEN` env var name is a deliberate signal —
  if we add more hosts later, each gets its own env slot.
- **Credential rotation tooling.** Operator restarts the daemon
  with a new token in `.env`. Hot-swap is out of scope.
- **Surfacing token scope/expiry to the dashboard.** Daemon may
  log a one-line "GITHUB_TOKEN present, scopes: [...]" at startup,
  but no UI work.
- **Token usage for `@ci` push / PR.** Plan 19's concern. The
  token this plan threads through must also work for push (Plan
  19 should not need a second credential), but verifying push
  semantics end-to-end is Plan 19's smoke.

## Design decisions

### Decision 1 — Single env var: `GITHUB_TOKEN`

The daemon reads exactly one credential, named `GITHUB_TOKEN`,
from its process env. Already documented in SECURITY.md as
optional. This plan promotes it: still optional (public repos
continue to work), but **required** for private repos with a
clear error when missing.

No `GITHUB_USERNAME`, no `GH_TOKEN` alias, no per-host overrides.
Boring tool, one slot.

### Decision 2 — Inject differently per backend, same contract

The "what" is the same (a PAT in `GITHUB_TOKEN`). The "how"
varies by backend because the trust boundaries differ:

| Backend     | Injection pattern              | Why                                                                                                   |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `local`     | `GIT_ASKPASS` + helper script  | Token stays in daemon env. Never written to `.git/config`. Never visible in `ps` (no CLI arg).        |
| `namespace` | Heredoc-piped via `nsc ssh -T` | Token transits one SSH session into a single-tenant VM. Briefly in VM `.git/config`; VM is ephemeral. |
| `aws`       | (not implemented in v1)        | Whatever pattern fits when the branch lands.                                                          |

The two patterns make different security trade-offs and are
appropriate for different environments. Both share a precondition
check: the script verifies `GITHUB_TOKEN` is non-empty _only when
it's about to try a private clone_; public-repo dispatches don't
need the token.

### Decision 3 — Public-repo fallback is implicit, not flagged

There is **no `--public` / `--private` flag** on the script or
label on the issue. The script attempts a clone; if it fails with
an auth error and `GITHUB_TOKEN` is unset, the error message
says "no `GITHUB_TOKEN` set on the daemon — required for private
repos." If the token is set, it's used. If the repo is public,
git ignores the credential gracefully.

Rationale: operators shouldn't have to label every issue with
"this repo is private." The token's presence-or-absence is the
mode switch.

### Decision 4 — `local` branch: `GIT_ASKPASS` helper

A 3-line helper at `scripts/git-askpass.sh`:

```bash
#!/usr/bin/env bash
# git asks "Username for ...?" then "Password for ...?". We hand
# back a literal username (x-access-token, GitHub's convention)
# and the env's GITHUB_TOKEN. The token never reaches argv.
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "${GITHUB_TOKEN:-}" ;;
esac
```

`local-create.sh` invokes git with `GIT_ASKPASS="$SKILL_DIR/scripts/git-askpass.sh"`
in the environment. The cloned repo's `.git/config` ends up
referencing `https://github.com/org/repo.git` — no token in the
URL. Subsequent `git fetch / pull` in re-dispatch will re-invoke
the askpass helper and pick up the current `GITHUB_TOKEN`.

This is the standard pattern; git's manpage documents it.

### Decision 5 — `namespace` branch: heredoc with stdin piping

`nsc ssh <id> -T` with the command body passed via **stdin**, not
as a positional arg. This keeps the token out of the daemon
host's `ps`:

```bash
nsc ssh "$INSTANCE_ID" -T 'bash -s' <<EOF_REMOTE
set -euo pipefail
export GITHUB_TOKEN='$GITHUB_TOKEN'
# git clone uses URL embedding inside the VM:
git clone "https://x-access-token:\$GITHUB_TOKEN@github.com/${ORG_REPO}.git" /workspace
cd /workspace
# Scrub the token out of .git/config — even though the VM is ephemeral,
# defense in depth: a re-dispatch that runs commands later won't echo
# the URL into logs.
git remote set-url origin "https://github.com/${ORG_REPO}.git"
git fetch origin
# ... rest of checkout flow ...
EOF_REMOTE
```

Trade-offs accepted for v1:

- The token is **briefly on the daemon host's stdin pipe** to
  `nsc ssh`. Not on the CLI line; not in `ps`. Visible only if
  someone is straceing the daemon process.
- The token is **briefly in the VM's process tree** during the
  `git clone` call. The VM is single-tenant for this dispatch.
- The token is **briefly in the VM's `.git/config`** until the
  immediately-following `git remote set-url`. The VM is destroyed
  at teardown.

This is good enough for the trust posture in SECURITY.md
("trusted single-operator environments"). The vault-based v2
removes all three "briefly" cases at the cost of a one-time setup.

### Decision 6 — Daemon startup: log token presence, not value

On startup, the daemon logs one line:

- `GITHUB_TOKEN present (length: <N>)` — when set
- `GITHUB_TOKEN unset — private GitHub repos will fail to clone`
  — when unset

No scope probing in v1 (would require a GitHub API call at
startup; nice but not load-bearing). The token's _length_ is
useful for the operator to verify they didn't paste an empty
string; it doesn't leak the secret.

### Decision 7 — Repo URL normalization

The script accepts the repo URL **as configured in
`symphony.yaml`** verbatim — does not rewrite SSH → HTTPS or vice
versa. If the operator wrote `git@github.com:org/repo.git`, the
clone uses SSH (and the `GITHUB_TOKEN` is irrelevant — the SSH
agent / deploy key path applies, which is _out of scope_ for this
plan).

For HTTPS URLs (`https://github.com/org/repo.git`), the askpass
helper / token URL-embedding kicks in.

This keeps the script's behavior predictable: "I clone what
you told me to clone, with the credential pattern that matches
that scheme."

## Steps

### Stage 17b-1 — Shared askpass helper

1. Write `packages/daemon/src/skills/sandbox/scripts/git-askpass.sh`
   exactly per Decision 4. Executable via `bash <path>`, no chmod
   needed.
2. Self-test: `GITHUB_TOKEN=foo bash git-askpass.sh "Username for"`
   should print `x-access-token`; `bash git-askpass.sh "Password for"`
   should print `foo`.

### Stage 17b-2 — `local-create.sh` private-repo support

3. Extend `local-create.sh`:
   - Export `GIT_ASKPASS="$SKILL_DIR/scripts/git-askpass.sh"`
     in the environment of the git subshell. The script doesn't
     itself know `SKILL_DIR`; the parent agent injects it (Plan
     17a established this), so the script accepts it via env:
     `: "${SKILL_DIR:?SKILL_DIR is required for askpass}"`.
   - Pre-check: if the repo URL is HTTPS-on-github.com **and**
     `GITHUB_TOKEN` is empty, log a warning to stderr ("no
     GITHUB_TOKEN set — clone will fail for private repos").
     Don't `die` — public clones work without.
   - Update the script comment block to document the new env
     contract.

4. Update the SKILL.md table that lists script env vars so
   `SKILL_DIR` and `GITHUB_TOKEN` are visible.

### Stage 17b-3 — `namespace-create.sh` private-repo support

5. Refactor the existing remote heredoc block in
   `namespace-create.sh` to pipe via stdin (Decision 5):
   - Move from the current `nsc ssh "$ID" -T "$(cat <<EOF ... )"` form
     (which puts the heredoc body in argv) to
     `nsc ssh "$ID" -T 'bash -s' <<EOF_REMOTE ... EOF_REMOTE`.
   - Inside the heredoc, embed the token in the URL for the
     initial clone, then `git remote set-url origin <clean URL>`
     immediately after.
   - Use single-quoted `EOF_REMOTE` for the _outer_ form ONLY for
     the parts that should NOT expand on the daemon side; the
     `$GITHUB_TOKEN` substitution must happen on the daemon side
     (so the VM doesn't need the daemon's env). Be deliberate
     about quoting; add a comment explaining the boundary.

6. Document the trade-offs at the top of the namespace script
   (token briefly in stdin pipe, briefly in VM process tree,
   briefly in `.git/config` until scrub).

### Stage 17b-4 — Daemon startup token log

7. In `packages/daemon/src/index.ts`, add a one-line log at
   startup reporting `GITHUB_TOKEN` presence and length (or
   "unset" message). Reuse the existing pino logger, redact-aware
   already.

### Stage 17b-5 — Tests

8. **Askpass helper test** (`scripts/git-askpass.test.sh` or a
   vitest spawn-bash test):
   - With `GITHUB_TOKEN=foo`, calling the helper with first arg
     `"Username for 'https://github.com/...'"` prints
     `x-access-token`; with `"Password for ..."` prints `foo`.
   - With `GITHUB_TOKEN` unset, the password branch prints empty
     (and git's auth attempt will then fail naturally).

9. **`local-create.sh` private-repo simulation**:
   - Skip a real private-repo test (CI doesn't have a private
     repo to clone against). Instead, assert by inspection:
     when the script runs, `git config --get-all credential.helper`
     in the cloned repo is empty (no helper persisted to disk),
     and `.git/config`'s `remote.origin.url` does not contain the
     token.
   - This catches accidental URL-embedding regressions.

10. **`namespace-create.sh` argv non-leak test**:
    - Run the script in a mode where `nsc` is replaced with a
      stub that just prints `$@` and stdin to a file. Assert:
      the token does NOT appear in `argv`; it DOES appear in
      stdin. (The stub-`nsc` trick is the same shape as the
      existing test seams in `packages/daemon/src/agent`.)

11. **SECURITY.md doctest-style assertion**: optional. A test
    that greps the bundled scripts for any line containing
    `https://[^/]*:` (URL-with-credential pattern) outside of a
    documented context — fails if a regression introduces a
    token-in-URL leak.

### Stage 17b-6 — Documentation

12. **SECURITY.md** updates:
    - Promote the `GITHUB_TOKEN` entry from "optional" to
      "required for private repos; absent → clone fails with
      an actionable error."
    - Add a sub-section on the per-backend injection patterns
      (Decision 2 table verbatim).
    - Note the v2 migration path (GitHub App + `nsc vault`).

13. **`examples/repo-workflow/README.md`** — short note: "For
    private repos, set `GITHUB_TOKEN` in the daemon's `.env`."

14. **`packages/daemon/src/skills/sandbox/SKILL.md`** — update
    the "Input" section to mention that `GITHUB_TOKEN`, if set,
    is read by the create scripts; no action required from the
    agent itself.

## Definition of done

- A dispatch against a **private** GitHub repo succeeds with
  `sandbox:local` (default) when `GITHUB_TOKEN` is set, and
  fails with an actionable error when it isn't.
- A dispatch against a **public** repo succeeds with or without
  `GITHUB_TOKEN`.
- A dispatch against a private repo with `sandbox:namespace`
  succeeds end-to-end (manual smoke; documented in the decision
  log when run). Token does not appear in the daemon host's
  `ps -ef` output during the clone window.
- `.git/config` in the cloned worktree contains no token, on
  either backend. (Verified via the regression tests in
  Stage 17b-5.)
- SECURITY.md describes the credential model accurately.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm deps:check`
  clean.

## Open questions

- **Should the daemon probe the token's GitHub API at startup?**
  A `gh api user` equivalent would catch a malformed/expired
  token before the first dispatch tries to use it. Costs one
  HTTP request at startup. Worth doing in v1 or wait for the
  GitHub App migration where the probe is part of token
  minting?

- **What about repos hosted on github.com but using a different
  auth flow (e.g. fine-grained PAT with repo-scoped permissions
  that don't include push)?** Plan 19 (`@ci`) hits this; this
  plan needs to ensure the clone-side works, but should we
  surface "your token doesn't include the `repo` scope" at the
  point the dispatcher picks `sandbox:local`? Tentative: no —
  let `@ci`'s push failure be the natural surface for that.

- **`SKILL_DIR` as a precondition for `local-create.sh`.** The
  script now requires `SKILL_DIR` to construct the askpass
  helper path. Plan 17a injects this via the parent agent's
  prompt. Worth fail-fast'ing in the script if it's missing,
  but also worth re-confirming the prompt-injection path is
  reliable. Maybe add a vitest assertion that the prompt always
  contains a `SKILL_DIR=` line.

- **Should the scrubbing step in `namespace-create.sh`
  (`git remote set-url`) be unconditional, even for public
  repos that didn't need a token?** Cost is one fast local
  git operation; benefit is "scripts behave identically
  regardless of repo visibility." Tentative: yes,
  unconditional.

- **Token-in-stdin to `nsc ssh` — does the namespace edge case
  of `--ssh_agent` (`-A`) forwarding change the picture?** If
  an operator sets up SSH agent forwarding and uses a `git@`
  URL, the token path is bypassed entirely. We should test
  that case doesn't break. Probably "just works" because the
  script's HTTPS-only token logic is gated on the URL scheme.

## Decision log

### TBD — Plan opened

Plan written 2026-05-17 as a future-work doc; not started.
Triggered by the realization that today's @sandbox scripts
assume public repos, and Plan 18 (real `@coder`) needs to
work against real org repos which are predominantly private.
Captured the design space here so the implementation is a
mechanical exercise when someone picks it up.
