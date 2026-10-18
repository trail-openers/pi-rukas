#!/usr/bin/env bash
# lib.sh — shared helpers for worker.sh, drive.sh and capacity.sh. Sourced, never executed.
#
# The helpers live in the lib-*.sh files beside this one, split by seam. Source this file only.
#
# Portability (bash 3.2, macOS /bin/bash):
#   1. No absolute paths to any host, repo, provider or user. Environment-specific values arrive
#      as arguments or env vars, and are validated.
#   2. Untrusted strings (issue numbers, paths, urls) reach a node evaluator through the
#      environment, never argv.
#   3. No associative arrays, bulk array readers, case-transformation operators or [[ ]].
#      Write `command -v` as `type -P`.
#
# references/design.md has the invariants these helpers keep.
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
