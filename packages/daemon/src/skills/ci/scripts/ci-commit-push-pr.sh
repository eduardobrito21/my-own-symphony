#!/usr/bin/env bash
# ci-commit-push-pr.sh — commit pending changes, push the branch,
# and open (or surface) a GitHub PR. Idempotent on re-dispatch.
#
# Inputs (env vars set by the parent agent):
#   SYMPHONY_WORKTREE_PATH   — absolute path to the cloned worktree.
#   SYMPHONY_BRANCH          — work branch the changes live on.
#   SYMPHONY_DEFAULT_BRANCH  — base branch the PR targets.
#   SYMPHONY_IDENTIFIER      — issue identifier (used in commit
#                              message + PR title).
#   SYMPHONY_ISSUE_TITLE     — Linear issue title; used as the PR
#                              title and the commit message subject.
#   SYMPHONY_ISSUE_URL       — Linear issue URL; embedded in PR body
#                              for traceability. Optional.
#   SYMPHONY_CODER_SUMMARY   — one-line summary from @coder; used in
#                              the PR body. Optional.
#
# Output: a CIResult JSON object on stdout. Progress on stderr.

set -euo pipefail

log() { printf '[ci] %s\n' "$*" >&2; }
die() {
  printf '[ci] ERROR: %s\n' "$*" >&2
  exit 1
}

: "${SYMPHONY_WORKTREE_PATH:?SYMPHONY_WORKTREE_PATH is required}"
: "${SYMPHONY_BRANCH:?SYMPHONY_BRANCH is required}"
: "${SYMPHONY_DEFAULT_BRANCH:?SYMPHONY_DEFAULT_BRANCH is required}"
: "${SYMPHONY_IDENTIFIER:?SYMPHONY_IDENTIFIER is required}"
: "${SYMPHONY_ISSUE_TITLE:?SYMPHONY_ISSUE_TITLE is required}"

command -v git >/dev/null 2>&1 || die "git not on PATH"
command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) not on PATH"

# gh uses GITHUB_TOKEN automatically; verify it's set. (Public-repo
# clones work without it but push and PR-open always need auth.)
if ! gh auth status >/dev/null 2>&1; then
  die "gh is not authenticated. Set GITHUB_TOKEN with push+pr scopes, or run 'gh auth login'."
fi

cd "$SYMPHONY_WORKTREE_PATH" || die "could not cd into $SYMPHONY_WORKTREE_PATH"

# Wire GITHUB_TOKEN into git via GIT_ASKPASS. Without this, `git push`
# over HTTPS has no way to authenticate (git doesn't read GITHUB_TOKEN
# natively, and the daemon host may not have `gh auth setup-git`
# installed as a credential helper). The askpass helper is a tiny
# inline script that prints the literal username "x-access-token"
# (GitHub's convention for token-as-password) and the env's
# GITHUB_TOKEN value. Token never reaches argv or .git/config.
#
# This is the local-side of Plan 17b's design. The full Plan 17b will
# generalize this into a shared scripts/git-askpass.sh and add the
# namespace-side counterpart.
ASKPASS_HELPER="$(mktemp -t symphony-askpass.XXXXXX)"
trap 'rm -f "$ASKPASS_HELPER"' EXIT
cat >"$ASKPASS_HELPER" <<'EOH'
#!/usr/bin/env bash
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "${GITHUB_TOKEN:-}" ;;
esac
EOH
chmod +x "$ASKPASS_HELPER"
export GIT_ASKPASS="$ASKPASS_HELPER"
# Disable the interactive terminal prompt — askpass is the only path.
export GIT_TERMINAL_PROMPT=0

# Make sure we're on the right branch (@sandbox already created it).
{
  current="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$current" != "$SYMPHONY_BRANCH" ]; then
    log "switching from $current to $SYMPHONY_BRANCH"
    git checkout "$SYMPHONY_BRANCH" || die "could not checkout $SYMPHONY_BRANCH"
  fi
} >&2

# Are there changes to commit? `git status --porcelain` prints one line
# per modified/added/deleted/untracked path; if empty, nothing changed.
# The parent agent should have skipped @ci in that case, but defend
# in depth: a no-op commit isn't worth pushing.
if [ -z "$(git status --porcelain)" ]; then
  die "no changes in worktree — @ci should not have been invoked"
fi

# Configure committer identity for this commit. We use Symphony-branded
# defaults; the daemon's git config might already provide a real
# identity for the operator. --local so we don't pollute global config.
{
  log "configuring committer identity"
  git config --local user.email "${GIT_AUTHOR_EMAIL:-symphony@local}"
  git config --local user.name "${GIT_AUTHOR_NAME:-Symphony Agent}"
} >&2

# Stage everything @coder touched.
{
  log "staging changes"
  git add -A
  log "diff summary:"
  git diff --cached --stat || true
} >&2

# Compose the commit message: subject is "[IDENT] Issue Title",
# body has the coder summary if any.
COMMIT_SUBJECT="[${SYMPHONY_IDENTIFIER}] ${SYMPHONY_ISSUE_TITLE}"
COMMIT_BODY="${SYMPHONY_CODER_SUMMARY:-}"
{
  if [ -n "$COMMIT_BODY" ]; then
    git commit -m "$COMMIT_SUBJECT" -m "$COMMIT_BODY"
  else
    git commit -m "$COMMIT_SUBJECT"
  fi
} >&2 || die "git commit failed"

HEAD_SHA="$(git rev-parse HEAD)"
log "committed $HEAD_SHA"

# Push (force-with-lease so a re-dispatch overwrites our previous head
# safely but never clobbers commits a human pushed onto the branch).
{
  log "pushing $SYMPHONY_BRANCH to origin"
  git push --force-with-lease -u origin "$SYMPHONY_BRANCH"
} >&2 || die "git push failed"

# PR open-or-reuse. If a PR already exists for this branch (re-dispatch),
# return its URL without creating a duplicate. The branch was just
# updated by the push above, so the existing PR will pick up the new
# head.
EXISTING_PR_JSON="$(gh pr list --head "$SYMPHONY_BRANCH" --state open --json url,number --limit 1)"
EXISTING_PR_URL="$(printf '%s' "$EXISTING_PR_JSON" | awk -F'"' '/"url"/ { print $4; exit }')"
EXISTING_PR_NUMBER="$(printf '%s' "$EXISTING_PR_JSON" | awk -F'[:,}]' '/"number"/ { for (i=1; i<=NF; i++) if ($i ~ /"number"/) { gsub(/[^0-9]/, "", $(i+1)); print $(i+1); exit } }')"

if [ -n "$EXISTING_PR_URL" ]; then
  log "PR already open: $EXISTING_PR_URL — reusing"
  cat <<JSON
{
  "pr_url": "$EXISTING_PR_URL",
  "pr_number": ${EXISTING_PR_NUMBER:-0},
  "branch": "$SYMPHONY_BRANCH",
  "head_sha": "$HEAD_SHA",
  "reused": true
}
JSON
  exit 0
fi

# Build PR body.
PR_BODY="$(cat <<EOF
${SYMPHONY_CODER_SUMMARY:-Made by Symphony.}

---
Issue: ${SYMPHONY_IDENTIFIER}${SYMPHONY_ISSUE_URL:+ — ${SYMPHONY_ISSUE_URL}}
Agent: Symphony (Plan 17a MVP @coder + @ci)
EOF
)"

log "opening PR base=$SYMPHONY_DEFAULT_BRANCH head=$SYMPHONY_BRANCH"
PR_URL="$(gh pr create \
  --title "$COMMIT_SUBJECT" \
  --body "$PR_BODY" \
  --base "$SYMPHONY_DEFAULT_BRANCH" \
  --head "$SYMPHONY_BRANCH" 2>&1 | tail -n 1)" || die "gh pr create failed"

# gh prints the PR URL on stdout as the final line.
case "$PR_URL" in
  https://*) ;;
  *) die "gh pr create did not return a URL (got: $PR_URL)" ;;
esac

PR_NUMBER="$(printf '%s' "$PR_URL" | awk -F/ '{ print $NF }')"

cat <<JSON
{
  "pr_url": "$PR_URL",
  "pr_number": $PR_NUMBER,
  "branch": "$SYMPHONY_BRANCH",
  "head_sha": "$HEAD_SHA",
  "reused": false
}
JSON
