# Graphite CLI — Use `gt` instead of `git`

This project uses Graphite for stacked pull requests. Always use `gt`
commands instead of raw `git` commands unless explicitly requested.

## Why Graphite

Graphite enables stacked PRs — small, reviewable changes that build on
each other. Each PR in a stack can be reviewed and merged independently
while maintaining dependencies. The `gt` CLI automates rebasing and
keeps stacks healthy.

## Command Mapping

| Instead of...             | Use...                                |
| ------------------------- | ------------------------------------- |
| `git checkout -b <name>`  | `gt create <name>`                    |
| `git checkout <branch>`   | `gt checkout <branch>` or `gt co`     |
| `git add . && git commit` | `gt create -am "msg"`                 |
| `git commit --amend`      | `gt modify` or `gt m`                 |
| `git commit`              | `gt modify -c` (new commit on branch) |
| `git push`                | `gt submit`                           |
| `git push` (whole stack)  | `gt submit --stack` or `gt ss`        |
| `git pull && git rebase`  | `gt sync`                             |
| `git log`                 | `gt log` or `gt ls`                   |
| `git rebase -i`           | `gt reorder` or `gt squash`           |
| `git branch -d`           | handled by `gt sync` (auto-cleans)    |

## Core Workflow (5 steps)

1. **Create** — `gt create -am "feat: description"` (stages, commits, branches)
2. **Submit** — `gt submit` (pushes and creates/updates PR)
3. **Address feedback** — `gt modify -a` (amends current branch)
4. **Merge** — via Graphite web UI or GitHub
5. **Sync** — `gt sync` (pulls trunk, cleans merged, restacks)

## Essential Commands

### Viewing & Navigation

- `gt log` — see stack with PR info, worktree locations
- `gt log short` / `gt ls` — see all branches (compact)
- `gt checkout <branch>` / `gt co` — switch branches
- `gt up` / `gt u` — move up in stack
- `gt down` / `gt d` — move down in stack
- `gt top` / `gt t` — go to top of stack
- `gt bottom` / `gt b` — go to bottom of stack

### Creating & Modifying

- `gt create [name]` / `gt c` — create new branch from staged changes
- `gt create -am "msg"` — stage all, commit, create branch
- `gt create --onto <branch>` — create on top of another branch
- `gt modify` / `gt m` — amend staged changes to current branch
- `gt modify -a` / `gt m -a` — stage all and amend
- `gt modify -c` / `gt m -c` — add new commit (instead of amend)
- `gt modify -cam "msg"` — stage all, new commit with message
- `gt modify --into` — amend changes to a downstack branch

### Syncing & Submitting

- `gt sync` — pull trunk, delete merged branches, restack
- `gt submit` — push current branch + downstack, create/update PRs
- `gt submit --stack` / `gt ss` — push entire stack
- `gt submit -u` / `gt ss -u` — update existing PRs only (no new PRs)
- `gt get <branch>` — fetch teammate's stack locally

### Reorganizing

- `gt move` — move branch to new parent
- `gt fold` — fold branch into parent
- `gt reorder` — reorder branches in stack
- `gt squash` / `gt sq` — squash commits
- `gt split` / `gt sp` — split branch by commits, files, or hunks
- `gt absorb` / `gt ab` — auto-distribute staged changes to relevant downstack commits
- `gt pop` — delete branch but keep changes

### Recovery & Tracking

- `gt undo` — undo last mutation
- `gt track <branch>` / `gt tr` — start tracking existing branch
- `gt untrack <branch>` / `gt utr` — stop tracking branch

### Collaboration

- `gt freeze <branch>` — prevent accidental edits
- `gt unfreeze <branch>` — allow edits again

## Rules

1. **Never use `git push`** — use `gt submit` or `gt ss`
2. **Never use `git rebase`** — use `gt sync` or `gt reorder`
3. **Never use `git commit --amend`** — use `gt modify`
4. **Never use `git branch -d`** — `gt sync` auto-cleans merged branches
5. **Create branches with changes** — stage first, then `gt create`
6. **Keep stacks small** — aim for 3-5 branches max per stack
7. **One concern per branch** — each branch should be reviewable independently
8. **Submit early** — don't wait for downstack approval before submitting upstack

## When raw `git` is acceptable

- `git status` — checking working tree state
- `git diff` — viewing changes
- `git stash` — stashing changes temporarily
- `git clone` — initial repository clone
- `git fetch` — fetching without sync (rare)
- `git log` — when you need git-specific log format

## Best Practices for Stacked PRs

- Review stack PRs as independent changes
- Start review from stack bottom (the base)
- Each PR should be small and focused
- Mark work-in-progress as draft PRs
- Use `gt absorb` to auto-fix commits when addressing review feedback

## Multi-Worktree Support

Graphite supports multiple Git worktrees. Each worktree has independent
branch state. Commands affect only the current worktree.

Sources:

- [Graphite Docs](https://graphite.com/docs/)
- [CLI Cheatsheet](https://graphite.com/docs/cheatsheet)
