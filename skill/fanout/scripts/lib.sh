#!/usr/bin/env bash
# lib.sh — shared helpers for worker.sh / drive.sh / capacity.sh. Sourced, never executed.
#
# This is the single entry point callers source. The helpers themselves live in the
# lib-*.sh files beside it, split along their natural seams; each of those is sourced
# from here, so a caller needs no knowledge of the split.
#
# Portability rules for this file and the lib-*.sh files:
#   1. No absolute paths to any particular repo, host, provider or user. Everything
#      environment-specific arrives as an argument or an env var, and is validated.
#   2. Untrusted strings (issue numbers, paths, repo paths) are passed to the node
#      evaluator through the ENVIRONMENT, never argv. An issue number that lands in argv
#      becomes an argument to an evaluator; that is the shape of bug this avoids.
#      (Exception: the one-liners in fanout_require_current read stdin, not argv, so they
#      carry no untrusted-string exposure.)
#   3. POSIX-ish and bash-3.2-safe (macOS ships an ancient bash). No associative arrays, no
#      bulk array readers, no case-transformation operators, no double-bracket compound tests.
#      (Write those constructs out in words rather than as code tokens: this file's text gets
#      echoed into agent briefs, and the host's bash guard refuses commands by matching
#      literal tokens.)
#
# Read references/design.md before changing the invariants asserted here.
set -uo pipefail

_FANOUT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=lib-runtime.sh
. "$_FANOUT_LIB_DIR/lib-runtime.sh"
# shellcheck source=lib-claims.sh
. "$_FANOUT_LIB_DIR/lib-claims.sh"
# shellcheck source=lib-triage.sh
. "$_FANOUT_LIB_DIR/lib-triage.sh"
# shellcheck source=lib-sampler.sh
. "$_FANOUT_LIB_DIR/lib-sampler.sh"
# shellcheck source=lib-budget.sh
. "$_FANOUT_LIB_DIR/lib-budget.sh"
