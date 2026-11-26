/**
 * lean/verify-suite-command — is a project's `verify.full` tier the suite the roster already ran?
 *
 * The roster is the project's own runner with the step's report pair at its tail — the flag over its report,
 * then the tree — and the head run of THAT command is the verdict a duplicate tier would only repeat. Both
 * sides are put back to the placeholders the config wrote through `put`, then asked word for word: quotes
 * included, no case fold, no path normalisation, no reordering. `lean/full-tier-operand-switch.ts` owns the
 * switch and its off arm.
 */
import path from "node:path";
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
/** May the one word past the runner stand where the step's pair stood? It must name a directory of the tree the
 * whole-tree run scanned. `tree` (the roster's own directory) and `tierRunsIn` (where the tier runs) are one
 * worktree for a roster and a tier of the same run, and two different suites otherwise — what a bare name turns
 * on. The tree's own word is the head run, not a subset; the step's report pair names no directory; a tail the
 * project wrote itself is the command verbatim or nothing. */
const covers = (
  raw: string,
  extra: string,
  named: readonly string[],
  tree: string,
  tierRunsIn: string,
): boolean => {
  if (raw === "" || raw === TREE || extra === TREE) return false;
  if (named[named.length - 1] !== TREE) return false;
  // What the renderer spelled under the tree is a directory of it by its own shape, so it is judged as a path and
  // not as a `verify.testDir` value — `extension/smoke-tests` is a directory a real project names. A `..` or `.`
  // segment survives in the word as written, so it refuses here rather than after the segments are cut.
  if (extra.startsWith(UNDER)) {
    const parts = raw.split("/");
    return !raw.endsWith("/") && !parts.includes("..") && !parts.includes(".");
  }
  // The step's own report path and its own glued flag are the pair the roster added — no project word is.
  if (raw === REPORT || raw === GLUED) return false;
  // A bare name is admitted only when the roster scanned the tree the name would resolve to, and only in the
  // single-segment shape `verify.testDir` admits: it refuses an absolute path, a `..` segment, a non-canonical
  // spelling and a hidden directory; a separator, a leading `-` or a `~` is refused on the line below.
  if (path.resolve(tierRunsIn) !== path.resolve(tree)) return false;
  if (raw.startsWith("-") || raw.startsWith("~") || raw.includes("/")) return false;
  return validateTestDir(raw) === undefined;
};
/** The report held beside its flag — the step's three-word tail, `flag path tree`. */
const twoWordPair = (named: readonly string[], n: number): boolean =>
  named[n - 2] === REPORT && named[n - 3] === FLAG;

/** Did this roster's accepted head run cover the project's `verify.full` tier? */
export function fullTierSatisfiedBy(
  fullTier: string | undefined,
  rendered: { bin: string; args: string[]; report?: string },
  head: { failed: string[] },
  /** The tree the tier runs in — what an operand is resolved against. */
  worktree: string,
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
  // The roster scanned its report's own directory — the report is the only file the step built there — and the
  // tier runs in `worktree`, the tree the operand is resolved against.
  const tree = report.slice(0, report.lastIndexOf("/"));
  const named = command.map((w) => put(w, report, tree));
  const tail =
    named[n - 1] !== TREE ? 0 : named[n - 2] === GLUED ? 2 : twoWordPair(named, n) ? 3 : 0;
  const runner = named.slice(0, n - tail);
  const tier = words(fullTier).map((w) => put(w, report, tree));
  const ran = words(fullTier);
  // Three ways a tier is the run the roster already made: the runner's words, the step's pair taken back, with at
  // most one operand standing in that pair; the run's own words with that pair put back through the placeholders
  // the config wrote it with, which makes a glued pair and a two-word pair one tail; or the command verbatim, the
  // only thing standing for a run whose tail the project wrote — that ask reads the run's argv, since put back a
  // glued pair reads as the bare runner.
  const verbatim =
    ran.length === n &&
    (ran.every((w, i) => w === command[i]) || (tail > 0 && tier.every((w, i) => w === named[i])));
  const extra = tier.length === runner.length + 1 ? (tier[runner.length] ?? "") : "";
  // The operand as the tier typed it, not as `put` rewrote it: a `..` or `.` segment reads as a plain name once
  // the step's own tree spellings are sent home, and containment is a question about the typed path.
  const raw = ran.length === runner.length + 1 ? (ran[runner.length] ?? "") : "";
  const kept = raw !== "" && covers(raw, extra, named, tree, worktree) ? 1 : 0;
  return (
    verbatim ||
    (tier.length - kept === runner.length &&
      tier.slice(0, runner.length).every((w, i) => w === runner[i]))
  );
}
