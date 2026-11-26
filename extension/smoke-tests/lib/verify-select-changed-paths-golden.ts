#!/usr/bin/env bun
/**
 * lib/verify-select-changed-paths-golden — what the develop selector answered,
 * per changed-file set, at origin/main c96d685430 (the base of #2649).
 *
 * `PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS=0` promises the pre-#2649 selection, so
 * the promise is checked against the bytes the OLD code produced — never against a
 * re-derivation of it from the modules under change (a golden that called today's
 * classifier could only agree with it). The house shape is
 * `lib/adversarial-verdict-reask-off-arm-golden.ts`: capture once from a detached
 * checkout of the base commit, commit the answer, and compare.
 *
 * How these were produced (one run, no re-derivation):
 *
 *   cd extension && bun smoke-tests/lib/capture-verify-select-golden.ts
 *
 * against a detached checkout of c96d685430, with the same `extension/node_modules`
 * the development tree uses. The table below is the emitted JSON, verbatim.
 *
 * `alwaysRun` is the tree's computed text-reader set, and it is EXCLUDED from the
 * comparison: it is a property of the tree the selection runs in (this checkout,
 * which #2649 adds tests to), not of the classification, so pinning it would make
 * the golden disagree with the off arm for a reason the switch has nothing to do
 * with. Everything that IS the decision — `mode`, the selected `tests`, and the
 * `fallbackReason` — is compared byte for byte.
 */

/** One row's answer, as the pre-#2649 selector returned it. */
export interface GoldenSelection {
  mode: "selected" | "full";
  tests: string[];
  fallbackReason?: string;
}

/** The base commit these were captured from. */
export const GOLDEN_BASE_COMMIT = "c96d685430d6890d218aa147f9ffb38d6faf95d7";

/** The changed-file sets the golden covers — extension-relative, as the selector takes them. */
export const GOLDEN_CHANGED_SETS: readonly (readonly string[])[] = [
  ["src/work-driver-verify-select.ts"],
  ["src/work-driver-verify-select.ts", "docs/troubleshooting.md"],
  ["docs/troubleshooting.md"],
  ["docs/configuration.md"],
  ["docs/nonexistent-doc.md"],
  ["README.md"],
  ["AGENTS.md"],
  ["modules/core/codemode.md"],
  [".gitignore"],
  [".dockerignore"],
  ["LICENSE"],
  ["agents.json"],
  ["package.json"],
  ["bun.lock"],
  ["bunfig.toml"],
  ["tsconfig.json"],
  ["tsconfig.smoke-tests.json"],
  [".pi/work.json"],
  [".github/workflows/ci.yml"],
  [".devcontainer/Dockerfile"],
  ["weird/unplaceable.bin"],
  ["smoke-tests/lib/verify-loop.sh"],
  ["smoke-tests/lib/verify-pool.sh"],
  ["smoke-tests/lib/adversarial-reviewer-harness.ts"],
  ["smoke-tests/lib/no-such-helper.sh"],
  ["smoke-tests/test-ci-verify-digest.ts"],
  ["smoke-tests/test-000-does-not-exist.ts"],
  ["src/000-not-a-real-module.ts"],
  ["smoke-tests/test-work-driver-verify-select.ts"],
  ["src/work-driver-verify-shared.ts"],
  
  
  [],
];

/** The captured answers, keyed by the `+`-joined changed-file set. */
export const GOLDEN_SELECTIONS: Record<string, GoldenSelection> = {};
