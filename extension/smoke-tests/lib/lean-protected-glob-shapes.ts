/**
 * The timing half of `test-lean-protected-globs.ts`: the worst shapes the `lean.protectedPaths`
 * loader ADMITS, the paths that make a backtracking matcher pay for them, and the ceiling that
 * says when an admitted shape has become too expensive. It lives here rather than in the test so
 * the semantics table in that test stays readable on its own; the two files together are the
 * matcher's contract — what it matches, and what a match or a non-match costs.
 *
 * Why the probes are the shapes they are: a doublestar's cost is driven by the length it has to
 * reject, not by how many separators a path offers. A column of one-character segments is cheap
 * per character because `**` swallows separators whole, so the interesting inputs are dense — the
 * widest segment the filesystem can hold, and the longest path it can hold. The over-limit probes
 * are timed too, because the guard that answers them in microseconds is exactly what they measure.
 */
import { protectedGlobMatches, protectedPathProblem } from "../../src/lean/protected-globs.ts";

/** How long one accepted entry may take against a path it does NOT match. A regex over
 *  wildcards backtracks, so this is the one cost a project's own config file can choose. */
const SLOW_CEILING_MS = 50;

/** The same characters as a COLUMN of 400 one-character segments. Kept because a doublestar's
 *  cost does turn on the number of segment splits a path offers for the DEPTH-refused shapes
 *  below — it is where a three-doublestar entry pays, and why the load-time ceiling is a count of
 *  `**` SEGMENTS rather than a bound on entry length: those refused shapes are nineteen chars. */
const DEEP_NO_MATCH_PATH = "x/".repeat(400) + "x";

/**
 * A path of 255 characters — the longest a single segment can be on disk (NAME_MAX, mirrored by
 * `SEGMENT_CEILING` in the module) — packed with the alternating literals a `*` must reject one
 * character at a time. The widest input a real path can offer the matcher.
 */
const SEGMENT_255 = "q-".repeat(127) + "q";

/**
 * A path of about 4,096 characters — the longest a whole path can be (PATH_MAX, mirrored by
 * `PATH_CEILING`) — made of dense 255-character segments. Note the arithmetic: 15 of them plus
 * separators is only 3,825 characters, so the ~270-character tail this completes to reach 4,096 is
 * itself over NAME_MAX, which makes the whole path over-long and answers it at the guard rather
 * than in the regex. {@link PATH_255S} is the same idea inside both OS limits, where the regex
 * really does run.
 */
const PATH_4096 = `${SEGMENT_255.repeat(15)}/${"q-".repeat(134)}q`;

/**
 * A single segment four times NAME_MAX. No filesystem reports one, and before the two OS limits
 * in `protected-globs.ts` it cost ~6 s of backtracking against a leading-doublestar entry — the
 * cost that guard exists to remove.
 */
const DENSE_OVERLONG = "q-".repeat(2000);

/**
 * The 4,096-character path the filesystem can actually hold: 16 segments of exactly
 * {@link SEGMENT_255} sit at 4,095, one under PATH_MAX. Every segment here is legal, so the guard
 * lets the regex run and this is the most length a real path can hand a backtracking matcher.
 */
const PATH_255S = `${`${SEGMENT_255}/`.repeat(15)}${SEGMENT_255}`;

/** One probe: a label for the failure line, the path, and whether a real entry must NOT match it.
 *  An over-limit path is answered PROTECTED by construction, so it is excluded from the non-match
 *  assertion (an entry like `**` would match it anyway) and still timed. */
type Probe = [string, string, boolean];

const PROBES: Probe[] = [
  ["deep", DEEP_NO_MATCH_PATH, true],
  ["seg255", SEGMENT_255, true],
  ["path-255s", PATH_255S, true],
  ["dense-4000", DENSE_OVERLONG, false],
  ["path-4096", PATH_4096, false],
];

/**
 * The worst shapes the loader ADMITS, each timed against EVERY probe. The `protectedPathProblem`
 * ceilings are what keep the ANCHORED shapes cheap: cost grows like (path depth)^(doublestar
 * segments), so at the admitted maximum those stay well under {@link SLOW_CEILING_MS} and one
 * segment past it they do not (see {@link SLOW_REFUSED}).
 *
 * The two LEADING-doublestar rows measure a cost that the two ceilings and the two OS limits
 * together still do not bound: with no literal to anchor on, the matcher must reject every
 * character of the path at the tail, and measured cost rises like the fourth power of length at a
 * FIXED doublestar count: the four-wildcard-tail row costs ~3 ms on the 255-character segment,
 * ~230 ms on a 2 KB legal path and ~800-1,000 ms on this 4,095-character one — over {@link SLOW_CEILING_MS} on a path no
 * guard can call unrealistic. That is a real defect in the shipped ceiling, not a flake and not a
 * regression from the OS-limit guard, and it was present before it. It stays RED deliberately: the
 * minimal fixes are a literal-prefix anchor for a leading doublestar, or a third load-time count,
 * and a matcher rewrite or a ceiling change is PM's call, not a test's. Every probe is timed and
 * the worst is printed, so the row says what it grew on.
 */
const SLOW_ACCEPTED: Array<[string, string]> = [
  // Two doublestar segments separated by a `?`, and the widest segment at the four-wildcard
  // ceiling — together the most of each the loader admits in one entry.
  ["2 doublestars separated by literals", "?/**/?/**/?x"],
  // A doublestar at each end of a wildcard-heavy segment: the two splits multiply into each
  // other rather than into a second literal, so this is the other shape worth timing.
  ["2 doublestars around a wide tail", "**/*q*r?s*t/**/?x"],
  // Both doublestars behind one literal, where a run of them multiplies fastest at its top end.
  ["2 doublestars behind one literal", "a/**/**/b"],
  // A segment at the wildcard ceiling, beside the run of doublestars it has to be placed into.
  ["2 doublestars and a 4-wildcard segment", "a/**/**/*q*r?s*t"],
  ["2 leading doublestars and a 4-wildcard tail", "**/*/**/*q*r?s*t"],
  ["2 leading doublestars and a 2-wildcard tail", "**/*/**/*q*r"],
];

/**
 * Shapes the loader must REFUSE rather than admit, because their cost on a non-matching path
 * grows with that path's depth. Each row is one `**` segment over the ceiling with the cheapest
 * spelling that still backtracks: single-character segments between the doublestars and a tail
 * the path can never satisfy. This is the entry the ceiling exists for — one that normalisation
 * cannot collapse, and that a length bound cannot catch at 19 characters.
 */
const SLOW_REFUSED: Array<[string, string]> = [
  ["3 doublestars with one-character segments", "?/**/?/**/?/**/?x"],
  ["4 doublestars with one-character segments", "?/**/?/**/?/**/?/**/?x"],
  // The same three-doublestar shape behind a wildcard-heavy tail — over 300 ms on the deep path
  // with a length bound that reads 21 characters, so the refusal is the only defence.
  ["3 doublestars ahead of an anchored tail", "**/*/**/*/**/*q*r?s*t"],
];

/**
 * Refusals whose MESSAGE has to carry the fix, not just the complaint. The doublestar-ceiling
 * refusal is the one an author hits by putting a leading doublestar and a slash in front of an
 * already-anchored path, and dropping that prefix is the edit that keeps the rule's own literals
 * while taking one doublestar off the matcher. The row below is over the ceiling and starts with
 * that prefix; the suggestion is the entry without it. (The prefix cannot be spelled literally in
 * this comment: a comment is not a string, and those two characters end the block.)
 */
const REFUSAL_TEXT: Array<[string, string, string]> = [
  ["leading doublestar ceiling refusal suggests dropping it", "**/src/**/test/**", "src/**/test/**"],
];

/** Runs the timing half. Returns the failure count so the calling test folds it into its own
 *  total and prints one verdict for the whole matcher contract. */
export function runSlowShapeCases(): number {
  let failures = 0;
  for (const [name, pattern] of SLOW_ACCEPTED) {
    // EVERY probe is timed and the MAXIMUM is the verdict: a short-circuiting `some` stops at the
    // first probe and can only ever under-report the cost this row exists to bound.
    let matched = "";
    let worst = 0;
    let worstProbe = "";
    for (const [probeName, probe, mustNotMatch] of PROBES) {
      const started = performance.now();
      const hit = protectedGlobMatches(pattern, probe);
      const ms = performance.now() - started;
      if (hit && mustNotMatch) matched = probeName;
      if (ms > worst) {
        worst = ms;
        worstProbe = probeName;
      }
    }
    if (matched !== "") {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} unexpectedly matched probe ${matched}`,
      );
    }
    if (worst > SLOW_CEILING_MS) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} vs ${String(PROBES.length)} paths (deepest ${String(DEEP_NO_MATCH_PATH.split("/").length)} segments, longest legal ${String(PATH_255S.length)} chars) took ${worst.toFixed(1)}ms on ${worstProbe}, over the ${String(SLOW_CEILING_MS)}ms ceiling`,
      );
      // Two admitted shapes are red on purpose, and this line is why a red suite here is a finding
      // and not a broken build: see the {@link SLOW_ACCEPTED} header.
      if (name.startsWith("2 leading doublestars")) {
        console.error(
          "      KNOWN OPEN: cost grows with path LENGTH at a fixed doublestar count, so the two OS limits and the doublestar ceiling together do not bound a leading doublestar. Needs a matcher fix or a third load-time count (PM's call).",
        );
      }
    } else {
      console.log(
        `ok  ${name} matched nothing; max ${worst.toFixed(1)}ms (${worstProbe}) across ${String(PROBES.length)} probes`,
      );
    }
  }
  for (const [name, pattern] of SLOW_REFUSED) {
    // The ceiling's other half, and the one an accepted-shape timer cannot see: a shape whose
    // cost grows with the DEPTH of a path that never matches is refused at LOAD. With no ceiling
    // low enough, the loader admits it, says nothing, and this row is red.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined) {
      failures++;
      console.error(`FAIL  ${name}: ${JSON.stringify(pattern)} was admitted by the loader`);
    } else {
      console.log(`ok  ${name} refused at load (${refusal})`);
    }
  }
  for (const [name, pattern, want] of REFUSAL_TEXT) {
    // A refusal is only useful if it tells the author which spelling works. These rows check the
    // advice carried in the message, not merely that a message exists.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined || !refusal.includes(want)) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} refused with ${JSON.stringify(refusal)}, which does not suggest ${JSON.stringify(want)}`,
      );
    } else {
      console.log(`ok  ${name} refusal suggests \`${want}\``);
    }
  }
  return failures;
}

/** How many rows {@link runSlowShapeCases} owns, so the caller's denominator is honest. */
export const SLOW_CASE_COUNT: number =
  SLOW_ACCEPTED.length + SLOW_REFUSED.length + REFUSAL_TEXT.length;
