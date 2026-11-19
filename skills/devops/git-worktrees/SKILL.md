---
name: git-worktrees
description: Set up and manage git worktrees for parallel work on the same repo, without stomping the live/main checkout. Use when a second agent, parallel task, or experimental change needs the same repository checked out elsewhere, or when concurrent commits/pushes on one working tree are colliding.
---

# Git Worktrees (in-project layout)

Run a second (or Nth) checkout of the same repo for parallel work — a different
branch, isolated index, its own uncommitted state — while the main checkout
keeps being the live one.

**Layout convention (adopted here):** worktrees live *inside* the project:

```
<project>/.worktrees/<task-slug>/
```

This keeps everything in one place (Claude-style). The cost — a duplicate tree
visible to grep/build/indexing — is handled by gitignoring `.worktrees/` (see
First-time checklist).

## Rules

1. **The main checkout stays live.** Never create a worktree *as* the main
   branch's directory, and never commit to the main tree from a worktree
   session. One session owns commits to the live tree.
2. **One worktree = one branch = one task.** Branch name: `wt/<task-slug>`.
   Two worktrees must never check out the same branch (git will refuse; don't
   fight it).
3. **Create from the worktree, clean from the worktree.** Use `git worktree
   add` / `git worktree remove` — never bare `rm -rf` of the worktree dir
   (leaves stale refs in `<repo>/.git/worktrees/`; fix with `git worktree
   prune` if it already happened).
4. **Sync before you start; rebase before you merge.** Fetch first so
   `wt/<task>` starts from fresh main, and rebase the branch onto `main`
   before merging back.

## First-time checklist (one per repo, BEFORE the first Setup)

Before the *first* `git worktree add` in a repo, make sure the ignore files
are in place — otherwise the main checkout shows the entire duplicate tree as
untracked noise, and a careless `git add -A` in main can stage it.

1. **Tracked `.gitignore`** must contain the worktree dir, on the branch you
   branch from (fresh `main` per Rule 4). Verify:

   ```bash
   git -C <project> show origin/main:.gitignore | grep -Fx '.worktrees/'
   ```

   If missing (no output), add this line to `main` and commit + push, so
   every future branch, worktree, and clone inherits it:

   ```
   .worktrees/
   ```

2. **`.ripgignore`** — if the repo has one (or you rely on ripgrep without
   gitignore), add `.worktrees/` there too and commit, so `rg` skips the duplicate
   tree.

3. **IDE** — exclude `.worktrees` from indexing.

Ignore-file scopes (why the *tracked* `.gitignore` is the one that matters):

- **Tracked `.gitignore`** — checked out with each working tree; commits, so
  other machines and future branches get it.
- **`.git/info/exclude`** — repo-local; *is* shared by all worktrees (lives
  in the common git dir), but never leaves this machine. Don't rely on it
  for a repo cloned elsewhere.
- **`.ripgignore`** — only useful if committed; untracked copies are
  machine-local.

If you did branch from an old commit instead (against Rule 4), that
worktree's own `.gitignore` may lack the line — rebasing onto `main` brings
it back.

## Setup (in the main checkout)

```bash
cd <project>
git fetch origin
git worktree add .worktrees/<task-slug> -b wt/<task-slug> origin/main
```

Then work in the worktree like a normal repo:

```bash
cd <project>/.worktrees/<task-slug>
# edit, test, verify — all git ops operate on the shared object store,
# but the working tree and index are isolated from main
git add -A && git commit -m "..." && git push origin wt/<task-slug>
```

Pushing the `wt/` branch lets the change be reviewed/merged without ever
touching the live tree.

## Status & discovery

```bash
git worktree list          # all checkouts + their branch (run from anywhere in the repo)
git worktree list --porcelain
```

Note: inside a worktree, `.git` is a *file* (pointer into the main repo's
`.git/worktrees/<name>/`), not a directory. Tools that assume `.git/` is a
directory can misbehave — a known sharp edge.

## Merge back & cleanup

```bash
cd <project>                          # main checkout
git fetch origin
git checkout main
git rebase origin/main                # keep main fresh
git merge --ff-only wt/<task-slug>    # fast-forward only (no merge commit); if it fails, rebase the branch and retry
git push origin main
git branch -d wt/<task-slug>          # -d refuses if unmerged — correct safety
git worktree remove .worktrees/<task-slug>
```

For a dirty/abandoned worktree: inspect first (`git -C .worktrees/<t> status`),
then `git worktree remove --force .worktrees/<t>` if you accept losing it, and
`git worktree prune` if the dir is already gone.

## Pitfalls

- **Concurrent writers on the same tree** (two agents in the same checkout)
  cause the classic symptom: mysterious "behind 1 / ahead 1" races and
  half-committed state. That is what worktrees are for — if you see it,
  stop and split into a worktree.
- **`rm -rf .worktrees/<t>`** leaves stale refs → `git worktree prune`.
- **Locks**: if an editor/agent process holds the worktree open (index.lock),
  `worktree remove` fails — close the process first; only `--force` when sure.
- **Shared object store**: commits made in a worktree are immediately visible
  to `git log` in the main checkout (that's normal, not a leak).
- **Submodules / LFS / build caches** (node_modules, target/, .venv) are NOT
  shared — the worktree starts empty; re-install as needed.
- **Never** put the worktree *inside* a subdirectory of the branch it
  tracks' build output dirs unless gitignored — same logic as Hygiene.
