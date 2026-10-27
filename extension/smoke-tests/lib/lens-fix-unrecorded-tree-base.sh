#!/usr/bin/env bash
# Prove the non-vacuity of the #1852 round 3 item 1 fence tests.
#
# `test-lens-fix-fence-unrecorded-tree.ts` asserts that a lens-fix round whose
# tree has no fence PARKS and pushes nothing. That assertion is only worth
# anything if the same fixture does NOT park on the pre-#1852 sources — which is
# what this script checks, by running the base expectations of the same fixture
# against a detached checkout of `a9758573` (the last commit before the gate).
#
# It writes nothing to the repo: the base checkout and the base-side copies of
# the fixture and test live under /tmp.
set -eu

BASE_COMMIT="${PI_1852_BASE:-a9758573}"
WORKTREE="${PI_1852_BASE_TREE:-/tmp/pi-ensemble-developer/base-1852}"
# This script lives in <repo>/extension/smoke-tests/lib, so the repo root is two
# levels above it and the head extension dir is one above `smoke-tests`.
SMOKE_TESTS="$(cd "$(dirname "$0")/.." && pwd)"
HEAD_EXT="$(cd "$(dirname "$SMOKE_TESTS")" && pwd)"
REPO_ROOT="$(cd "$(dirname "$HEAD_EXT")" && pwd)"

git -C "$REPO_ROOT" worktree add -q --detach "$WORKTREE" "$BASE_COMMIT" 2>/dev/null ||
  git -C "$REPO_ROOT" worktree add -q --force --detach "$WORKTREE" "$BASE_COMMIT"

# node_modules is gitignored, so a fresh worktree has none; reuse the head tree's.
[ -e "$WORKTREE/extension/node_modules" ] ||
  ln -s "$HEAD_EXT/node_modules" "$WORKTREE/extension/node_modules"

# The base-side fixture: a base-compatible copy, kept beside the head versions so
# a change to the fixture shape is visible in the same diff.
cp "$SMOKE_TESTS/lib/lens-fix-unrecorded-tree-fixtures.ts" \
  "$WORKTREE/extension/smoke-tests/lib/lens-fix-unrecorded-tree-fixtures.ts"
cp "$SMOKE_TESTS/test-lens-fix-fence-unrecorded-tree.ts" \
  "$WORKTREE/extension/smoke-tests/test-lens-fix-fence-unrecorded-tree.ts"
# The BASE expectations of the same file (the `PI_1852_EXPECT=base` half lives in
# `test-lens-fix-fence-unrecorded-tree.base.ts` next to this script): the head
# version asserts the round PARKS, which is false on base by construction, so the
# base copy is the variant that asserts the stray lands.
cp "$SMOKE_TESTS/lib/test-lens-fix-fence-unrecorded-tree.base.ts" \
  "$WORKTREE/extension/smoke-tests/test-lens-fix-fence-unrecorded-tree.ts"
echo "BASE ($BASE_COMMIT) expectations, run in $WORKTREE:"
( cd "$WORKTREE/extension" && bun run smoke-tests/test-lens-fix-fence-unrecorded-tree.ts )
