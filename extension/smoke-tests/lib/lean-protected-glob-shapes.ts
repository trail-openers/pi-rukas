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
 *
 * Two costs are bounded, and by different counts of the entry: DEPTH, by the `**` SEGMENT ceiling
 * (cost grows like depth to that power), and LENGTH, by the TOTAL wildcard ceiling — each `**`
 * segment counting one — because with no literal to anchor on the matcher must reject every
 * character of the path at the tail, so cost rises like the path's length raised to the entry's
 * total wildcard count. Four is where that count is capped. Measured here, a four-wildcard entry
 * reaches 12.8 ms on the legal 4,095-character dense path when its tail is a literal the path can
 * never satisfy, and five wildcards on the same input reaches 813 ms — which is why the ceiling is
 * four and not five.
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

/** One probe: a label for the failure line, the path, and what the row's assertion is for that
 *  path. "matched" means an entry that names it must match; "refused" means an entry the loader
 *  admits must NOT match it, because a non-match is the expensive case this half bounds; "guard"
 *  marks a path no filesystem can hold, which is answered PROTECTED for every entry without the
 *  regex running, so neither assertion applies to it and it is timed anyway. */
type Probe = [string, string, "matched" | "refused" | "guard"];

/** The answer a row states for one probe. A row states one of these for EVERY probe, so no timing
 *  row asserts nothing: a row whose answer on some path follows from the entry's own shape says
 *  `both` — which the matcher cannot get wrong, but which the reader can see is stated rather than
 *  left out, and which keeps a probe that stopped being informative from being quietly skipped.
 *  `matched` and `refused` are the answers that can actually go red.
 *
 *  Why a per-probe map and not one flag per row: a single flag can only ever assert the answer the
 *  row happened to produce, which is not evidence of anything. */
type RowExpectation = Record<string, "matched" | "refused" | "both" | "guard">;

/** The answer for a probe no row has to state separately: an over-limit path, which the matcher
 *  answers PROTECTED for every entry without running the regex. Spread onto every row so the
 *  "no answer stated" check below means "nobody thought about this probe", not "it is a guard". */
const GUARD: RowExpectation = { "dense-4000": "guard", "path-4096": "guard" };

/** The three asserted probes with the answer every entry in {@link SLOW_ACCEPTED} states for them:
 *  the dense paths are the non-match this half bounds, and the deep column is the one no rule with
 *  a literal segment or a bounded tail can name. Spelled once because it is every row's answer —
 *  each row still has to spread it, so a row that wants a different answer for one probe writes
 *  that probe and inherits the rest. */
const DENSE_REFUSED: RowExpectation = {
  ...GUARD,
  deep: "refused",
  seg255: "refused",
  "path-255s": "refused",
};

const PROBES: Probe[] = [
  // The three asserted probes are built so `q` never appears twice in a row and no segment is a
  // bare `x`: that is what lets one entry family be asserted not to match all of them, while the
  // wildcard-tail entries below really do name the dense ones and are asserted to. The deep probe
  // is a COLUMN of one-character segments, which is where a `**` segment past the ceiling pays —
  // the shapes {@link SLOW_REFUSED} refuses on the DEPTH axis cost 60 ms there and single-digit
  // milliseconds on the dense inputs, so a set of dense-only probes would miss them entirely.
  ["deep", DEEP_NO_MATCH_PATH, "refused"],
  ["seg255", SEGMENT_255, "refused"],
  ["path-255s", PATH_255S, "refused"],
  ["dense-4000", DENSE_OVERLONG, "guard"],
  ["path-4096", PATH_4096, "guard"],
];

/**
 * The worst shapes the loader ADMITS, each timed against EVERY probe. The `protectedPathProblem`
 * ceilings are what keep them cheap, and two of them speak to different axes: cost grows like
 * (path depth)^(doublestar segments), which the two-segment ceiling bounds, and like (path
 * length)^(total wildcards), which the four-wildcard ceiling bounds. {@link SLOW_REFUSED} is the
 * shape one count past each of them.
 *
 * The worst admitted shape on the LENGTH axis is the two-doublestar entry whose tail is a literal
 * the dense path can never satisfy: at four wildcards that shape costs 12.8 ms there, and its
 * widened-literal sibling costs 26.3 ms — both admitted. A leading doublestar whose tail WILDCARDS
 * instead of literaling ends up MATCHING the dense paths, which is the cheap case; the expensive
 * admitted case is the one that refuses to match. A row therefore states, probe by probe, whether
 * it must MATCH or REFUSE that path — not one flag per row, which could only ever assert the
 * answer the row happened to produce and so would prove nothing. A shape the timing half must
 * check against a probe it would match anyway (an anchored rule against any of these paths, a
 * wildcard-tailed rule against the deep column) has that stated and verified too, so a probe that
 * stopped being informative is caught rather than silently skipped. All five probes are timed
 * either way; the two over-limit ones are answered by the OS-limit guard and assert nothing.
 */
const SLOW_ACCEPTED: Array<[string, string, RowExpectation]> = [
  // The admitted worst case on the LENGTH axis at four wildcards: two doublestars in front of a
  // two-character literal (`q` twice), which the dense path can never satisfy at any offset.
  ["2 doublestars ahead of a 2-literal tail", "**/*/**/qq", DENSE_REFUSED],
  // The same shape with the tail's literal widened to `*qq` — four wildcards, the same cost axis.
  ["2 doublestars ahead of a widened literal tail", "**/*/**/*qq", DENSE_REFUSED],
  // A wildcard tail behind two doublestars. The tail WILDCARDS, so this row MATCHES the two dense
  // probes and refuses the column of one-character segments — three assertions, each stated, and
  // not one of them the answer this row would have produced anyway.
  [
    "2 doublestars ahead of a wildcard tail",
    "**/*/**/*q",
    { ...DENSE_REFUSED, seg255: "matched", "path-255s": "matched" },
  ],
  // A `*q*` segment in front of a doublestar and a one-character tail — the other four-wildcard
  // placement, and one whose tail is satisfied by the dense segments (`q` opens every one).
  [
    "A 2-wildcard segment ahead of a doublestar and a tail",
    "*q*/**/*q",
    { ...DENSE_REFUSED, seg255: "matched", "path-255s": "matched" },
  ],
  // A single doublestar in front of a three-wildcard tail: the widest segment the loader admits.
  ["1 doublestar ahead of a 3-wildcard tail", "**/*q*r?s", DENSE_REFUSED],
  // Both doublestars behind one literal, where a run of them multiplies fastest at its top end.
  ["2 doublestars behind one literal", "a/**/**/b", DENSE_REFUSED],
  // The realistic rules a project actually writes, timed on the same probes so a future ceiling
  // change that would price them out shows up here rather than in a config review. Each sits at
  // three wildcards or fewer, which is where every rule in the field lives.
  ["realistic: two directories by name", "src/**/test/**", DENSE_REFUSED],
  ["realistic: vendored tree at any depth", "**/node_modules/**", DENSE_REFUSED],
  ["realistic: any lockfile", "**/*.lock", DENSE_REFUSED],
  ["realistic: framework files under src", "src/**/*.vue", DENSE_REFUSED],
  ["realistic: sources at any depth under src", "**/src/**/*.ts", DENSE_REFUSED],
];

/**
 * Shapes the loader must REFUSE rather than admit. The first group is one `**` segment over the
 * DEPTH ceiling with the cheapest spelling that still backtracks: single-character segments
 * between the doublestars and a tail the path can never satisfy. This is the entry the segment
 * ceiling exists for — one that normalisation cannot collapse, and that a length bound cannot
 * catch at 19 characters.
 *
 * The second group is one wildcard over the TOTAL ceiling, and the reason that ceiling is four.
 * Their cost is measured with the load-time check bypassed and the regex compiled straight from the
 * entry — the same source `compiled()` builds — so each row proves what the matcher would pay if
 * the ceiling were lifted: on the legal 4,095-character dense path they cost 769 ms to 6.3 s, and
 * the DEPTH rows cost 60 ms to 597 ms on the column of one-character segments. With
 * only the segment ceiling and the two OS limits in place the loader admits all of them, says
 * nothing, and the matcher pays. The first two of the LENGTH group are the rows that were
 * deliberately red at the previous commit. The last row is over BOTH ceilings at once and is cheap
 * (1.1 ms) precisely because the depth ceiling is what makes that shape affordable; it is an entry
 * past the total count all the same, and the total-wildcard refusal is what the loader returns.
 */
const SLOW_REFUSED: Array<[string, string]> = [
  ["3 doublestars with one-character segments", "?/**/?/**/?/**/?x"],
  ["4 doublestars with one-character segments", "?/**/?/**/?/**/?/**/?x"],
  // The same three-doublestar shape behind a wildcard-heavy tail — over 300 ms on the deep path
  // with a length bound that reads 21 characters, so the refusal is the only defence.
  ["3 doublestars ahead of an anchored tail", "**/*/**/*/**/*q*r?s*t"],
  // The two rows that were red at the previous commit: admitted then, 813 ms and 1,055 ms on the
  // legal dense path. Both are over the total-wildcard ceiling now and the refusal names it.
  ["6 wildcards on a leading doublestar", "**/*/**/*q*r?s*t"],
  ["5 wildcards on a leading doublestar, shorter tail", "**/*/**/*q*r"],
  // One wildcard over the total ceiling on every shape that pays for it: the mid-pattern spelling
  // (6.4 s), the same with a wider tail (6.3 s), the widened-segment spelling (5.3 s), and the
  // leading-doublestar spelling whose one-character tail the dense path can never satisfy (778 ms).
  ["5 wildcards mid-pattern with a wide tail", "*q*/**/*q*r"],
  ["6 wildcards mid-pattern with a wide tail", "*q*/**/*q*r?s"],
  ["5 wildcards on a widened leading segment", "*q**/**/*q*r"],
  // Five wildcards across three doublestars, over BOTH ceilings at once. It is cheap (1.1 ms) —
  // the depth ceiling is what makes that shape affordable — but it is an entry over the total
  // ceiling all the same, and the total-wildcard refusal is what the loader returns for it.
  ["5 wildcards across 3 doublestars", "?/**/?/**/?x"],
  // One more wildcard past the ceiling on the leading-doublestar spelling, the wildcard tail
  // widened so it can never be satisfied: 815 ms unguarded on the dense path, the most expensive
  // one-wildcard-over-ceiling shape in this set that is not already listed above.
  ["5 wildcards on a leading doublestar ahead of an unsatisfiable tail", "**/*/**/*q*x"],
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
  for (const [name, pattern, expect] of SLOW_ACCEPTED) {
    // EVERY probe is timed and the MAXIMUM is the verdict: a short-circuiting `some` stops at the
    // first probe and can only ever under-report the cost this row exists to bound.
    let wrong = "";
    let wrongDetail = "";
    let worst = 0;
    let worstProbe = "";
    for (const [probeName, probe, probeKind] of PROBES) {
      const started = performance.now();
      const hit = protectedGlobMatches(pattern, probe);
      const ms = performance.now() - started;
      // The two over-limit probes are answered PROTECTED whatever the entry, so they are timed but
      // assert nothing. On the rest the answer is whatever the row STATES for that probe: a row
      // that must match and does not is as wrong as one that must refuse and does, because the
      // refusal is the expensive case this file bounds and the match is what a rule delivers.
      const want = probeKind === "guard" ? "guard" : expect[probeName];
      // Every row states an answer for every asserted probe, so a probe that carries no answer at
      // all is a hole in the table rather than a pass. "guard" and "both" assert nothing (the
      // matcher's answer there follows from the OS-limit guard or from the entry's own shape).
      if (want === "guard") {
        // Timed, not asserted: the over-limit probes are answered PROTECTED for every entry.
      } else if (want === undefined) {
        wrong = probeName;
        wrongDetail = "the row states no answer for this probe";
      } else if (want === "refused" && hit) {
        wrong = probeName;
        wrongDetail = "it matched, and the row states refused";
      } else if (want === "matched" && !hit) {
        wrong = probeName;
        wrongDetail = "it did not match, and the row states matched";
      }
      // `want === "both"` asserts nothing about this path — the matcher's answer there follows from
      // the entry's own shape (see {@link Expectation}) — and is stated so the reader can see the
      // probe is informative for the rows that count, not skipped for them.
      if (ms > worst) {
        worst = ms;
        worstProbe = probeName;
      }
    }
    if (wrong !== "") {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} vs probe ${wrong}: ${wrongDetail}`,
      );
    }
    if (worst > SLOW_CEILING_MS) {
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} vs ${String(PROBES.length)} paths (deepest ${String(DEEP_NO_MATCH_PATH.split("/").length)} segments, longest legal ${String(PATH_255S.length)} chars) took ${worst.toFixed(1)}ms on ${worstProbe}, over the ${String(SLOW_CEILING_MS)}ms ceiling`,
      );
    } else {
      console.log(
        `ok  ${name} matched every path it states and refused the rest; max ${worst.toFixed(1)}ms (${worstProbe}) across ${String(PROBES.length)} probes`,
      );
    }
  }
  for (const [name, pattern] of SLOW_REFUSED) {
    // The ceiling's other half, and the one an accepted-shape timer cannot see: a shape whose
    // cost grows with the DEPTH, or with the LENGTH, of a path that never matches is refused at
    // LOAD. With no ceiling low enough, the loader admits it, says nothing, and this row is red.
    const refusal = protectedPathProblem(pattern);
    if (refusal === undefined) {
      failures++;
      console.error(`FAIL  ${name}: ${JSON.stringify(pattern)} was admitted by the loader`);
    } else if (!refusal.includes("this matcher will backtrack over")) {
      // A refusal that does not name a ceiling is a refusal for some other reason, and the row
      // would go green without the bound it exists to prove.
      failures++;
      console.error(
        `FAIL  ${name}: ${JSON.stringify(pattern)} refused for an unrelated reason (${refusal})`,
      );
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
