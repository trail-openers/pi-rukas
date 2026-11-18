/**
 * The shipped-text canaries for the #2333 CI-doctrine gate — the mutants written
 * into the DOCTRINE AND BRIEF TEXT a child is actually handed, as opposed to the
 * single-line fixtures `test-ci-doctrine-poll.ts` mutates.
 *
 * Split out for the same reason `work-driver-ci-wait-brief.ts` is: the 500-line
 * file limit, along a seam that already exists. These assertions all share one
 * shape — read a shipped surface, mutate one line of it, demand the classifier
 * report exactly one hit — and none of them needs the driver constants the main
 * gate reads, so they are judged here and reported through the caller's `assert`.
 *
 * Every one of these is load-bearing in a direction the classifier's own unit
 * fixtures cannot show: a fixture proves the regex matches a shape, only the
 * shipped-text mutant proves the shipped text CONTAINS the place a human would
 * write that shape.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { blockingWatchPrescribed } from "./ci-doctrine.ts";

/** The GitHub recipe line as the doctrine writes it, in both the role doc and the
 * ci-monitoring module. The mutants below are built on it, so the FIRST assertion
 * of each group (`quoted !== shipped`) is what catches the line being reworded out
 * from under them — a canary whose mutant did not apply is a red, not a pass. */
const SANCTIONED_RECIPE = "gh pr checks <pr-number> --repo <owner/repo>";

/** The doctrine surfaces whose GitHub recipe line the watch classifier polices. */
const RECIPE_SURFACES = ["modules/workflows/ci-monitoring.md", "agents-base/ops.md"];

/** Every shipped recipe line, in both directions: the sanctioned form reads clean,
 * and each forbidden rewrite of that SAME line is reported.
 *
 * Why both halves, on the shipped text: an earlier classifier exempted non-prose
 * lines and required `--watch` to sit in the same word group as `gh pr checks`, so
 * `gh pr checks <n> … --watch` written back into the recipe (which lives in a fenced
 * block and in bullets) was invisible to every gate while only `gh run watch` was
 * actually policed. The quoted forms are the part that hole hid longest — a doctrine
 * normally writes the repo with its placeholder quotes (`--repo "o/r"`), and an arm
 * that admitted only unquoted words policed the unquoted shape while leaving every
 * quoted one free. Quoting must not be an escape hatch. */
export function shippedRecipeCanaries(
  root: string,
  assert: (cond: boolean, msg: string) => void,
): void {
  for (const rel of RECIPE_SURFACES) {
    const shipped = readFileSync(path.join(root, rel), "utf8");
    assert(
      shipped.includes(SANCTIONED_RECIPE) && blockingWatchPrescribed(shipped).length === 0,
      `${rel}: the shipped recipe line is not itself flagged`,
    );
    const watchBack = shipped.replace(SANCTIONED_RECIPE, `${SANCTIONED_RECIPE} --watch`);
    assert(
      watchBack !== shipped && blockingWatchPrescribed(watchBack).length === 1,
      `${rel}: the shipped recipe line with \`--watch\` restored IS flagged (${blockingWatchPrescribed(watchBack).length} hit(s))`,
    );
    for (const quotedForm of [
      'gh pr checks <pr-number> --repo "o/r" --watch',
      `gh pr checks <pr-number> --repo 'o/r' --watch`,
      'gh pr checks "12" --watch',
    ]) {
      const quoted = shipped.replace(SANCTIONED_RECIPE, quotedForm);
      assert(
        quoted !== shipped && blockingWatchPrescribed(quoted).length === 1,
        `${rel}: the shipped recipe line written with the QUOTED form \`${quotedForm}\` IS flagged (${blockingWatchPrescribed(quoted).length} hit(s))`,
      );
    }
  }
  // A `--watch` that lives INSIDE a quoted argument is a positional, not the flag —
  // the quoted arm must match whole tokens, not substrings.
  assert(
    blockingWatchPrescribed('Poll `gh pr checks 12 `"a --watch"`.').length === 0,
    "canary: a `--watch` inside a quoted argument is NOT the flag",
  );
}
