/**
 * The shell-loop / command-substitution absence checks the #2333 gate runs over
 * the CI section of a composed role prompt, plus the canaries that pin the ❌
 * carve-out `withoutProhibitionLines` applies.
 *
 * Split from `test-ci-doctrine-poll.ts` for the 500-line file limit, along the seam
 * that already exists: these assertions judge ONE thing (the CI section's own
 * prescribed shapes) and need none of the driver constants the main gate reads.
 *
 * Why presence AND absence are both judged, and why neither alone is enough: an
 * absence-only gate would go red the moment the doctrine NAMED the loop it forbids
 * (its FORBIDDEN bullet quotes `while true; do … done` to teach the child what to
 * avoid), and a presence-only gate went GREEN on the measured mutant — the shipped
 * two-call bullet replaced by a real `while true; do gh pr checks "$PR"; sleep 60;
 * done`. So the loop forms are judged on the CI text MINUS its ❌ prohibitions,
 * which name what is refused rather than prescribing it.
 */
import { ciSectionOf, withoutProhibitionLines } from "./ci-doctrine.ts";

/** The shell read-loop spellings a CI wait must never be prescribed as. `done` is
 * required so a prose "while"/"for" cannot trip them; the window is bounded so a
 * `done` from an unrelated later line cannot pair with an early keyword. */
const CI_LOOP_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwhile\b[^\n]{0,200}?\bdone\b/, "a `while … do … done` CI read loop"],
  [/\bfor\b[^\n]{0,200}?\bdone\b/, "a `for … do … done` CI read loop"],
  [/\buntil\b[^\n]{0,200}?\bdone\b/, "an `until … do … done` CI read loop"],
];

/** The shipped FORBIDDEN bullet that QUOTES the loop it refuses. The carve-out
 * canaries below run on it, because a filter that dropped EVERY line would satisfy
 * the absence assertion just as well as one that drops only prohibitions. */
const SHIPPED_LOOP_BULLET =
  "- ❌ ANY **unbounded** loop calling CI list/view commands repeatedly with no terminal check or cap (e.g. `while true; do ... done`)";

/** Judge the CI section of `composed` for prescribed shell read loops and `$(…)`
 * command substitutions, and pin both sides of the ❌ carve-out that makes the
 * absence half honest. Reported through the caller's `assert`. */
export function ciSectionShapeCanaries(
  composed: string,
  assert: (cond: boolean, msg: string) => void,
): void {
  const ciText = ciSectionOf(composed);
  assert(
    /sleep 60/.test(ciText),
    "ops: the composed prompt has a CI section to judge (it names the poll interval)",
  );
  const ciLoopHits = CI_LOOP_FORMS.filter(([re]) => re.test(withoutProhibitionLines(ciText))).map(
    ([, what]) => what,
  );
  assert(
    ciLoopHits.length === 0,
    `ops: the CI section prescribes no shell read loop as the way to wait${ciLoopHits.length ? ` (${ciLoopHits.join(", ")})` : ""}`,
  );
  const ciCommandSub = withoutProhibitionLines(ciText)
    .split("\n")
    .filter((l) => /\$\(/.test(l))
    .map((l) => l.trim().slice(0, 80));
  assert(
    ciCommandSub.length === 0,
    `ops: no CI poll uses a $(…) command substitution${ciCommandSub.length ? `: ${ciCommandSub.join(" | ")}` : ""}`,
  );
  assert(
    /\bwhile\b[^\n]{0,200}?\bdone\b/.test(SHIPPED_LOOP_BULLET) &&
      CI_LOOP_FORMS.every(([re]) => !re.test(withoutProhibitionLines(SHIPPED_LOOP_BULLET))),
    "canary: the shipped ❌ bullet that QUOTES `while … do … done` is excluded from the loop check",
  );
  assert(
    CI_LOOP_FORMS.some(([re]) =>
      re.test(withoutProhibitionLines(SHIPPED_LOOP_BULLET.replace("❌", ""))),
    ),
    "canary: the same loop line WITHOUT its ❌ marker IS caught by the loop check",
  );
}
