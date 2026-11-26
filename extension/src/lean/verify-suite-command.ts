/**
 * lean/verify-suite-command — is a project's `verify.full` tier the suite the roster already ran?
 *
 * The roster is the project's own runner with the step's report pair at its tail — the flag over its
 * report, then the tree — and the head run of THAT command is the verdict a duplicate tier would only
 * repeat. Both sides are put back to the placeholders the config wrote through `put`, then asked word for
 * word: quotes included, no case fold, no path normalisation, no reordering. `lean/full-tier-operand-switch.ts`
 * owns the switch and its off arm.
 */
import { validateTestDir } from "./config-test-location.ts";
import { leanFullTierOperandEnabled } from "./full-tier-operand-switch.ts";

const REPORT = "{report}";
const TREE = "{dir}";
const UNDER = "{dir}/";
const GLUED = `--junitxml=${REPORT}`;
/** The step's report flag as its own word, its path the next word over. */
const FLAG = "--junitxml";
/** The words of one command line: outer blanks the author's typing, blanks inside a word its own. */
const words = (line: string): string[] =>
  line
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
/** A word of a roster's argv that belongs to the roster, not to the project's command. */
const REPORT_WORD = /^--junit-?xml=/;
/** The word as the config wrote it, when the value is one the step substituted for its placeholder; a
 * project's own word comes back nowhere, so a tail the project wrote is never traded. */
const put = (w: string, report: string, tree: string): string =>
  w === report
    ? REPORT
    : w === tree
      ? TREE
      : w === `${FLAG}=${report}`
        ? GLUED
        : w.startsWith(`${tree}/`)
          ? UNDER + w.slice(tree.length + 1)
          : w;
/** May the one word past the runner stand where the step's pair stood? It must name one directory the
 * whole-tree run covered — under the tree, or the project's relative name for it, the shape
 * `validateTestDir` admits for `verify.testDir`. The tree's own word is the head run, not a subset, and a
 * flag or a nested path names no directory. */
const covers = (extra: string, named: readonly string[], tail: number): boolean =>
  extra !== "" &&
  extra !== TREE &&
  tail > 0 &&
  (extra.startsWith(UNDER) ||
    (!extra.startsWith("/") &&
      !extra.startsWith("-") &&
      named.includes(TREE) &&
      !extra.includes("/"))) &&
  validateTestDir(extra.startsWith(UNDER) ? extra.slice(UNDER.length) : extra) === undefined;
/** The report held beside its flag — the step's three-word tail, `flag path tree`. */
const twoWordPair = (named: readonly string[], n: number): boolean =>
  named[n - 2] === REPORT && named[n - 3] === FLAG;

/** Did this roster's accepted head run cover the project's `verify.full` tier? */
export function fullTierSatisfiedBy(
  fullTier: string | undefined,
  rendered: { bin: string; args: string[]; report?: string },
  head: { failed: string[] },
): boolean {
  const report = rendered.report;
  if (head.failed.length > 0 || fullTier === undefined || report === undefined) return false;
  const command = words([rendered.bin, ...rendered.args].join(" "));
  const n = command.length;
  // Off: only the roster's own pair at the tail comes back, and only the command as the head ran it can match.
  if (!leanFullTierOperandEnabled()) {
    const cut = n >= 3 && REPORT_WORD.test(command[n - 2] ?? "") ? n - 2 : n;
    const tier = words(fullTier);
    return tier.length === cut && tier.every((w, i) => w === (command[i] ?? ""));
  }
  // The roster scanned the report's own directory, the report being the only file the step built there.
  const tree = report.slice(0, report.lastIndexOf("/"));
  const named = command.map((w) => put(w, report, tree));
  const tail =
    named[n - 1] !== TREE ? 0 : named[n - 2] === GLUED ? 2 : twoWordPair(named, n) ? 3 : 0;
  const runner = named.slice(0, n - tail);
  const tier = words(fullTier).map((w) => put(w, report, tree));
  const ran = words(fullTier);
  // Three ways a tier is the run the roster already made. It is the runner's words — the step's pair taken
  // back — with at most one operand standing in that pair; or it is the run's own words with the step's pair
  // put back, asked through the placeholders the config wrote that pair with, which is what makes a glued
  // pair and a two-word pair the same tail; or it is the command verbatim, the only thing that can stand for
  // a run whose tail the project wrote itself. That last ask reads the run's own argv, not the placeholders:
  // put back, a glued pair reads as the bare runner and would claim the whole tree as its own operand.
  const verbatim =
    ran.length === n &&
    (ran.every((w, i) => w === command[i]) || (tail > 0 && tier.every((w, i) => w === named[i])));
  const extra = tier.length === runner.length + 1 ? (tier[runner.length] ?? "") : "";
  const kept = tail > 0 && covers(extra, named, tail) ? 1 : 0;
  return (
    verbatim ||
    (tier.length - kept === runner.length &&
      tier.slice(0, runner.length).every((w, i) => w === runner[i]))
  );
}
