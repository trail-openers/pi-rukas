/**
 * lib/lean-chatty-frozen — a frozen test whose own output quotes the ATTRIBUTION shapes.
 *
 * The point of the module is the exact shape of its bytes: a real project test runner
 * prints the paths of every file it planned to run, and quotes the wording of a gate
 * message it recognises. Both are ordinary tool behaviour, and neither is evidence about
 * which criterion this run judged — which is precisely what the verify step's attribution
 * must not read them as.
 */

/** The other criterion's path, as a runner prints it while listing its collection. */
export const OTHER_AC = "tests/AC2-backoff.test.sh";

/** The renderer's own wording, quoted at the FRONT of a line — the hardest shape to refuse. */
export const ECHOED_RENDERER = "criterion AC9 (command tests/AC9-preserve.test.sh) failed: nope";

/**
 * A frozen test that fails, names itself (so `runTestFile` calls the run a real red and
 * not `unclear`), and on the way prints another criterion's path and the renderer's
 * sentence.
 *
 * `runTestFile` pastes this file's stdout and stderr into the check's `reason`, so this is
 * the text the attribution scanner is exposed to.
 */
export function chattyFrozenTest(self: string): string {
  return [
    "#!/bin/sh",
    `echo "not ok - ${self}" 1>&2`,
    `echo "collected: ${self} ${OTHER_AC}" 1>&2`,
    `echo "${ECHOED_RENDERER}" 1>&2`,
    "exit 1",
    "",
  ].join("\n");
}
