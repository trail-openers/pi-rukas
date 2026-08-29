#!/usr/bin/env bash
# Canary fixture for test-prerequisite-drift.ts — NOT a runnable preflight.
# Carries the same MIN_PI_VERSION line the real install-preflight.sh has, so
# parsePiFloors's install.sh-side regex is exercised by the fixture the same
# way it is by the real tree. The floor here (0.84.4) is at-or-above the
# README pin (0.84.3 → below floor, flagged) and below the Dockerfile pin
# (0.99.0 → above floor, NOT flagged), which is the shape the canary asserts.

set -o allexport
MIN_PI_VERSION=0.84.4
set +o allexport
