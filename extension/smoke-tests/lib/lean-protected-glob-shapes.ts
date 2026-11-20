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
import { protectedGlobMatches } from "../../src/lean/protected-globs.ts";

/** How long one accepted entry may take against a path it does NOT match. A regex over
 *  wildcards backtracks, so this is the one cost a project's own config file can choose. */
const SLOW_CEILING_MS = 50;

/** How many timed passes each row makes per probe, of which the WORST decides the verdict.
 *  A single pass is a coin flip against this ceiling on a loaded host: the same entry on the same
 *  path measured 12 ms and 52 ms minutes apart while another team's timed trials shared the machine,
 *  which is a gate that reports a confident wrong answer in both directions. Repeating and taking the
 *  maximum removes the fluke in the direction that matters (a real regression is caught on any pass)
 *  while the ceiling's headroom over the measured worst case (~13 ms against 50 ms) keeps a merely
 *  busy host from turning the row red. */
const TIMED_PASSES = 3;

/** The same characters as a COLUMN of 400 one-character segments. Kept because a doublestar's
 *  cost does turn on the number of segment splits a path offers for the DEPTH-refused shapes
 *  below — it is where a three-doublestar entry pays, and why the load-time ceiling is a count of
 *  `**` SEGMENTS rather than a bound on entry length: those refused shapes are nineteen chars. */
const DEEP_NO_MATCH_PATH = `${"x/".repeat(400)}x`;

/**
 * A path of 255 characters — the longest a single segment can be on disk (NAME_MAX, mirrored by
 * `SEGMENT_CEILING` in the module) — packed with the alternating literals a `*` must reject one
 * character at a time. The widest input a real path can offer the matcher.
 */
const SEGMENT_255 = `${"q-".repeat(127)}q`;

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
  // the shapes refused on the DEPTH axis (see the refusals module) cost 60 ms there and single-digit
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
 * length)^(total wildcards), which the four-wildcard ceiling bounds. One count past each of them is
 * what the refusals module refuses.
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
 *
 * The shapes the loader must NOT admit, and the advice its refusals carry, are the sibling module
 * `lib/lean-protected-glob-refusals.ts` — same contract, opposite verdict.
 */
const SLOW_ACCEPTED: Array<[string, string, RowExpectation]> = [
  // The admitted worst case on the LENGTH axis at four wildcards: two doublestars in front of a
  // two-character literal (`q` twice), which the dense path can never satisfy at any offset.
  ["2 doublestars ahead of a 2-literal tail", "**/*/**/qq", DENSE_REFUSED],
  // A wildcard tail behind two doublestars. The tail WILDCARDS, so this row MATCHES the two dense
  // probes and refuses the column of one-character segments — three assertions, each stated, and
  // not one of them the answer this row would have produced anyway.
  [
    "2 doublestars ahead of a wildcard tail",
    "**/*/**/*q",
    { ...DENSE_REFUSED, seg255: "matched", "path-255s": "matched" },
  ],
  // A single doublestar in front of a three-wildcard tail: the widest segment the loader admits.
  ["1 doublestar ahead of a 3-wildcard tail", "**/*q*r?s", DENSE_REFUSED],
  // Both doublestars behind one literal, where a run of them multiplies fastest at its top end.
  ["2 doublestars behind one literal", "a/**/**/b", DENSE_REFUSED],
  // The bare wildcard BETWEEN two doublestars — the shape the mirror refusal has to exempt, because
  // a lone `*` is one `[^/]*` the doublestar beside it swallows whole. Priced here so that if the
  // exemption ever stops being cheap the gate says so, rather than a config review finding it out.
  ["bare wildcard segment between two doublestars", "**/*/**/sub", DENSE_REFUSED],
  // The realistic rules a project actually writes, timed on the same probes so a future ceiling
  // change that would price them out shows up here rather than in a config review. Each sits at
  // three wildcards or fewer, which is where every rule in the field lives.
  ["realistic: two directories by name", "src/**/test/**", DENSE_REFUSED],
  ["realistic: vendored tree at any depth", "**/node_modules/**", DENSE_REFUSED],
  ["realistic: any lockfile", "**/*.lock", DENSE_REFUSED],
  ["realistic: framework files under src", "src/**/*.vue", DENSE_REFUSED],
  ["realistic: sources at any depth under src", "**/src/**/*.ts", DENSE_REFUSED],
];

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
      // Repeated passes, worst kept: one pass on a shared host is noise, and the verdict has to be
      // the entry's cost rather than the machine's mood. The matcher caches its regex per entry, so
      // every pass after the first measures backtracking alone — the cost this ceiling is for.
      let ms = 0;
      let hit = false;
      for (let pass = 0; pass < TIMED_PASSES; pass++) {
        const started = performance.now();
        hit = protectedGlobMatches(pattern, probe);
        const elapsed = performance.now() - started;
        if (elapsed > ms) ms = elapsed;
      }
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
      console.error(`FAIL  ${name}: ${JSON.stringify(pattern)} vs probe ${wrong}: ${wrongDetail}`);
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
  return failures;
}

/** How many rows {@link runSlowShapeCases} owns, so the caller's denominator is honest. */
export const SLOW_CASE_COUNT: number = SLOW_ACCEPTED.length;
