/**
 * lib/lean-verify-runner — the two shapes of "the frozen runner could not judge
 * this file", as data.
 *
 * Both arrive at `frozenTestFailure` as an `unclear` proof — a non-zero exit whose
 * output never named the file — and the step must tell them apart: one is a red
 * the developer can act on, the other is a machine nobody can. A fixture that
 * only wants a green or a red never touches this module; a case that asks what an
 * unjudgeable runner becomes asks for one of these two shapes by name.
 *
 * Split from `lean-verify-fixture.ts` because the tables are pure data with no
 * repo, git or exec behind them — the seam is "what a broken runner is", not "how
 * a fixture repo is built".
 */

export type BrokenRunner = "silent" | "missing-binary";

/**
 * The `verify.test` template for each {@link BrokenRunner} shape.
 *
 * Both are `sh silent-runner.sh {file}` because the script is what carries the
 * difference (see {@link BROKEN_RUNNER_SCRIPT}). A template must keep the
 * `{file}` placeholder as a whole word and free of shell metacharacters —
 * `validateTestRunner` in `src/lean/config.ts` refuses anything else — which is
 * also why a missing program is exec'd *inside* a committed script rather than
 * handed over as `sh -c 'nonexistent …'`: the latter reports the shell's own
 * usage error, not the 127.
 */
export const BROKEN_RUNNER_TEMPLATE: Record<BrokenRunner, string> = {
  silent: "sh silent-runner.sh {file}",
  "missing-binary": "sh silent-runner.sh {file}",
};

/**
 * The script each {@link BrokenRunner} shape commits as `silent-runner.sh`.
 *
 * `silent` — exits non-zero without naming the file. The fixture's own
 * `sh {file}` cannot produce that shape (its test echoes its own path when it
 * fails), so a case that wants to see what an unattributable failure becomes
 * needs a runner of its own. The file was proven red-and-named at freeze time,
 * so this is that failure continuing: a RED.
 *
 * `missing-binary` — exits 127, the shell's "not found", by exec'ing a program
 * no host has. The exit status is REAL, so `neverStarted` (which asks for a
 * non-numeric code) cannot see it and the proof lands in the same `unclear` kind
 * as a genuine failure; reading it as a red would send a developer to fix code
 * nothing ever executed. A bare `nonexistent-runner-xyz {file}` template is the
 * other half of that line and needs no fixture: it rejects with the string code
 * `ENOENT`, so `neverStarted` classifies it before any verdict rule is reached.
 */
export const BROKEN_RUNNER_SCRIPT: Record<BrokenRunner, string> = {
  silent: "exit 1\n",
  "missing-binary": '#!/bin/sh\nexec nonexistent-runner-xyz "$1"\n',
};

/** The committed name of the helper script a broken runner case writes. */
export const BROKEN_RUNNER_FILE = "silent-runner.sh";
