#!/usr/bin/env bash
# Issue #1145 — the git-environment half of verify-loop.sh: the isolated HOME /
# XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM exports the fixture
# suites depend on, the escape-hatch announcement, and the `_git_iso` name the
# EXIT trap in verify-loop.sh removes. Split out of verify-loop.sh so each file
# stays under the AGENTS.md §12 500-line cap the `test-file-size-limit.ts` gate
# enforces; verify-loop.sh sources this after the repository-locating `unset`
# line and before the #1017/#1043/#1069 export block, which is where the block
# sat before the split — the ordering is behavioural (a test's git call reads
# whatever is exported here) and nothing else in the file touches these four
# variables.
#
# Nothing here decides what the run PRINTS or how many jobs run at once: it sets
# the git view every fixture sees. The contract is that the suite's verdict is
# NOT a property of the machine it runs on — see the #1145 argument below, which
# moved here with the code rather than being rewritten.
#
# The half that is NOT here, deliberately: the `unset GIT_DIR GIT_WORK_TREE …`
# line stays in verify-loop.sh because it drops git's repository-locating
# variables — a different failure class, and one this file cannot close: a
# leaked GIT_DIR damages the CALLER's own repository rather than changing what
# a fixture sees. It is pinned by its own test, test-verify-loop-git-env.ts,
# which drives the runner rather than this file.
#
# Sourced, never executed: no `set -u` here (verify-loop.sh sets it), and every
# name is defined before use in the sourcing order.

# #1145 — the fixtures are throwaway repos, so git must read NO configuration
# the operator owns. A host-global entry silently rewrites what a fixture sees:
# a `~/.config/git/ignore` line for the tool's own local settings file makes it
# vanish from `git status --porcelain -uall`, and the tests that pin what the
# dirty-root exemption baseline, the integrate preflight and the restore claim
# see all read the tree as clean. They were red on a host that had that one
# line and green on one that did not — the suite's verdict was a property of
# the machine. Four variables, each closing a different door:
#
#   GIT_CONFIG_GLOBAL   — an empty file replaces the per-user config (git >= 2.32).
#   GIT_CONFIG_NOSYSTEM — the site-wide /etc/gitconfig is not read at all.
#   HOME                — an empty directory.
#   XDG_CONFIG_HOME     — an empty directory inside that HOME.
#
# HOME is the one that is easy to omit, and it is not optional. GIT_CONFIG_GLOBAL
# replaces the per-user CONFIG, but git derives the global EXCLUDES file from the
# HOME directory (`$HOME/.config/git/ignore`, XDG), so an empty config still
# leaves that ignore file in force. Verified on this host with git 2.50.1: with
# GIT_CONFIG_GLOBAL pointed at an empty file `git check-ignore -v` still
# attributed the path to ~/.config/git/ignore; with HOME pointed at an empty
# directory it reported "not ignored". Pinned by
# smoke-tests/test-git-host-isolation-1145.ts.
#
# HOME is not sufficient either, which is what XDG_CONFIG_HOME is for. Git reads
# the per-user config directory from $XDG_CONFIG_HOME whenever it is SET, and
# only falls back to $HOME/.config when it is unset — so on a runner that
# exports it, isolating HOME leaves `$XDG_CONFIG_HOME/git/ignore` (and `config`,
# and `attributes`) fully in force. GitHub's ubuntu-latest exports it, which is
# why the PRECONDITION of test-git-host-isolation-1145.ts was red on CI and
# green here: the fixture's hostile `$HOME/.config/git/ignore` was never read.
# Reproduced locally by pointing XDG_CONFIG_HOME at a directory carrying
# git/ignore with a clean HOME. The leak is not test-only — a developer whose
# XDG_CONFIG_HOME points at a config tree with ignores was not isolated by
# overriding HOME, which is the guarantee this block exists to give.
#
# HOME is still the broader lever for the state that IS derived from it, and the
# two are complementary: it isolates host-global git state under the home
# directory (config, and the `.config` fallback git uses when XDG is unset)
# rather than this one excludesFile. Fixtures never depend on HOME — every
# commit in every fixture carries its identity locally (`-c user.email=` or an
# in-fixture `git config user.email`), and ensureGitIdentity in
# lib/git-worktree-fixture.ts supplies the GIT_AUTHOR/GIT_COMMITTER fallback.
# A test that genuinely needs the real home reads os.homedir(), which bun
# snapshots at process start (the isolated HOME this block exports never reaches
# it). There is deliberately no `PI_ENSEMBLE_TEST_REAL_HOME` export: it was
# documented as the consumer-facing spelling of the same thing, nothing read it,
# and a second way to name a value with one correct reader is a second way to
# get it wrong.
#
# Operator escape hatch: PI_ENSEMBLE_SMOKE_HOST_GIT=1 runs the suite against
# the host's real git config (debugging a fixture that only misbehaves here).
# It is not a bypass for the gate: .pi/verify-cmd and CI do not set it, so the
# default for every gate run is isolated. It is NOT silent — see the loud line
# in the else branch: a fixture suite whose verdict depends on the operator's
# `~/.config/git/ignore` is exactly the state #1145 exists to make visible, and
# a bypass nobody can see is how that state comes back.
_git_iso=""
if [ "${PI_ENSEMBLE_SMOKE_HOST_GIT:-}" != "1" ]; then
  _git_iso="$(mktemp -d "${TMPDIR:-/tmp}/verify-loop-gitiso.XXXXXX" 2>/dev/null)" || _git_iso=""
  if [ -n "$_git_iso" ]; then
    chmod 700 "$_git_iso" 2>/dev/null || true
    : "$_git_iso/gitconfig" 2>/dev/null || true
    mkdir -p "$_git_iso/home" 2>/dev/null || true
    mkdir -p "$_git_iso/home/.config" 2>/dev/null || true
    # #1606 — vipune fetches a ~128MB embedding model into
    # $HOME/.cache/huggingface (it ignores HF_HOME), so an isolated HOME meant a
    # download per run. Share the operator's model cache; git never reads .cache,
    # and the trap's `rm -rf` removes the link without following it.
    if [ -n "${HOME:-}" ] && [ -d "$HOME/.cache/huggingface" ]; then
      mkdir -p "$_git_iso/home/.cache" 2>/dev/null &&
        ln -s "$HOME/.cache/huggingface" "$_git_iso/home/.cache/huggingface" 2>/dev/null || true
    fi
    export GIT_CONFIG_GLOBAL="$_git_iso/gitconfig"
    export GIT_CONFIG_NOSYSTEM=1
    export HOME="$_git_iso/home"
    # Set, not unset. `unset` isolates just as well when the child inherits this
    # shell's env — git then falls back to the isolated HOME/.config, which is
    # also empty — but a positive export survives the paths where the child env
    # is rebuilt from a snapshot rather than inherited, and matches what
    # lib/git-test-env.ts exports so the two levers agree on one directory.
    export XDG_CONFIG_HOME="$_git_iso/home/.config"
  else
    # Could not allocate the isolation dir: fall through to the host config
    # rather than point git at a path that does not exist, but SAY SO. The
    # re-clear below is what keeps the cleanup trap's `rm -rf` off whatever an
    # unset `$TMPDIR` expands to — the assignment on the mktemp line has already
    # run by this point, so without it the trap could inherit a bare relative
    # path from the failed substitution.
    echo "warn: verify-loop: could not allocate the git-isolation dir — tests run against the HOST's global git config; fixtures that assert on untracked paths may misjudge" >&2
    _git_iso=""
  fi
else
  # The same class of announcement the allocation-failure branch above makes,
  # for the case where the operator asked for it: the run is against the host's
  # git config, so a green suite here is not the isolated verdict .pi/verify-cmd
  # and CI produce. Written once for the whole run rather than per test — the
  # per-test half of this lives in lib/git-test-env.ts, which traces which shape
  # its own helper chose.
  echo "WARNING [verify-loop]: PI_ENSEMBLE_SMOKE_HOST_GIT=1 — HOST GIT CONFIG IN USE — isolation disabled. Fixture git views depend on this machine's git config; this run is NOT the isolated verdict CI produces." >&2
fi
