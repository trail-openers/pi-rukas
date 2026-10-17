/**
 * work-driver-verify-attribution — #1404: per-test baseline attribution for
 * the commit-pr consolidated verify.
 *
 * The commit-pr gate (`runCommitPrConsolidatedVerify`) ran the project's
 * verify command against the consolidated tree and parked ANY failure as
 * `integration-verify-failed` — terminal, no PR, handoff blames the diff.
 * On this host every one of those parks was a gate that was already red at
 * the cycle's base commit (queue census 2026-10-16: 4 groups, #1043/#1111/
 * #1114/#1105, zero code defects). The develop step learned this lesson in
 * #1349 and got `compareWithBaseline`; the commit-pr seam never did.
 *
 * This module answers the commit-pr seam's question — WHICH failing tests did
 * the change cause? — by diffing the failing-test-name SETS of the change run
 * and a base-commit run. It is deterministic by design: no model, no decision
 * seam, just set difference over names parsed from verify-loop.sh's `FAILED:`
 * markers.
 *
 * Two deliberate departures from the develop step's `baselineExplainsChange`
 * (which stays that step's ONLY attribution path, untouched):
 *
 * - It is all-or-nothing over ONE extracted assertion; this is per-name over
 *   two parsed sets, so a mixed run excuses the names that fail at base and
 *   still parks the ones that do not.
 * - Absence of names is NOT "all pre-existing". A tsc/biome failure prints no
 *   `FAILED:` marker; a truncated `… and N more` hides names; a killed run's
 *   stream ends wherever the kill landed. In every such shape the verdict is
 *   `unattributable` and the caller parks with a named reason — a wrong
 *   "the change is not implicated" is worse than none.
 */

import { trace } from "./trace.ts";
import { probeBaselineVerify } from "./work-driver-verify-baseline.ts";
import type { ExecFn } from "./worktree.ts";

/** The three-way per-test verdict over the change run's failing test names. */
export interface FailureAttribution {
  /**
   * Failing tests that ALSO failed at base — the change did not cause them.
   * Empty whenever `unattributable` is set.
   */
  preExisting: string[];
  /**
   * Failing tests that PASSED at base — caused by this change. These are the
   * only failures that may park the cycle as `integration-verify-failed`.
   */
  changeCaused: string[];
  /**
   * Why no per-test verdict could be reached, naming the evidence that is
   * missing. Set = `preExisting` and `changeCaused` are empty and the caller
   * parks (fail closed), never continues.
   */
  unattributable?: string;
}

/**
 * The one rule: a failing test name in BOTH runs' sets is pre-existing; a
 * name in the change run's set only is change-caused. An empty change set is
 * never a pass — a failure the parser produced no names for cannot be
 * excused per-test, so it is unattributable (a tsc/biome failure prints no
 * `FAILED:` marker at all).
 */
export function attributeFailuresByName(
  changeNames: readonly string[],
  baseNames: readonly string[],
): FailureAttribution {
  if (changeNames.length === 0) {
    return {
      preExisting: [],
      changeCaused: [],
      unattributable:
        "the failing tests could not be named from the verify output, so no per-test comparison was possible",
    };
  }
  // Match on the shared project-relative tail, not the printed string: the two
  // runs resolve the same test under different trees, and comparing the raw
  // spellings would report every pre-existing test as new (see `sharedTail`).
  // The names RETURNED are the change run's own spellings — those are what an
  // operator greps for and what the PR body lists.
  const changeCaused: string[] = [];
  const preExisting: string[] = [];
  outer: for (const name of new Set(changeNames)) {
    for (const baseName of baseNames) {
      if (sharedTail(name, baseName) !== "") {
        preExisting.push(name);
        continue outer;
      }
    }
    changeCaused.push(name);
  }
  return { preExisting, changeCaused };
}

/**
 * Leading-edge collapse the reporter emits when the name list no longer fits
 * the 800-char tail budget: `FAILED: 9 test(s) — a.ts, b.ts… and 7 more`.
 * The count survives; the hidden names do not — and a hidden name that fails
 * at base would be a false "caused by the change". A collapsed summary makes
 * the whole run unattributable rather than guessed at.
 */
const COLLAPSE_RE = /… and \d+ more/;

/** The summary form: `FAILED: <n> test(s) — <name>, <name>, …` (or collapsed). */
const SUMMARY_RE = /^FAILED: \d+ test\(s\) —(.*)$/;

/** The per-failure marker, normal mode's timeout suffix stripped. */
const PER_FILE_RE = /^FAILED: (.+)$/;

/**
 * The comparison key for a failing-test name.
 *
 * verify-loop.sh prints the paths IT was handed, and the two runs being
 * compared happen in DIFFERENT trees: the change run resolves them against
 * repoRoot on the integration branch, the probe run against its throwaway
 * detached worktree under `<repoRoot>/.worktrees/`. So the same test prints as
 * two different strings, and comparing the raw spellings would report every
 * pre-existing failure as change-caused — the attribution would park exactly
 * the cycles it exists to save.
 *
 * Neither side knows where the other's tree begins (the driver's roots are
 * temp dirs, the integration checkout, and a `.worktrees/` path), so the key
 * is the SHARED SUFFIX below the deepest directory both paths have in common
 * at a boundary. For two trees of one repo that is the project-relative path;
 * for two genuinely different tests it degenerates to the basename at worst
 * and to nothing when even that differs.
 *
 * Deliberately conservative in one direction: a name is only ever EXCUSED by a
 * match, so a too-long match is the risk, and requiring the shared tail to span
 * at least one directory (a bare basename is not enough) is what keeps two
 * same-named tests in different directories from excusing each other.
 */
function sharedTail(a: string, b: string): string {
  const as = a
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  const bs = b
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  let shared = 0;
  while (
    shared < as.length &&
    shared < bs.length &&
    as[as.length - 1 - shared] === bs[bs.length - 1 - shared]
  ) {
    shared++;
  }
  // A gate that names tests by bare file name (`FAILED: test-a.ts`, the shape
  // `.pi/verify-cmd` gets when it lists them that way) has ONE segment on both
  // sides, and there is no directory to anchor on — so exact equality is the
  // whole comparison available, and it is the right one.
  if (as.length === 1 && bs.length === 1) return shared === 1 ? (as[0] ?? "") : "";
  // Two or more shared segments anchor the match in a directory both trees
  // really have. One shared segment alone is not identity — `tests/a/x.ts` and
  // `tools/b/x.ts` would otherwise excuse each other.
  if (shared < 2) return "";
  return as.slice(as.length - shared).join("/");
}

/**
 * True when two parsed names denote the same test across two runs in two
 * trees. See `sharedTail` for why a raw string comparison is wrong here.
 */
export function sameFailingTest(a: string, b: string): boolean {
  return sharedTail(a, b) !== "";
}

/**
 * The set of failing test names verify-loop.sh printed, from the RAW combined
 * stream — never the 800-char `extractAttributedTail` output, whose
 * last-marker anchoring elides every per-failure marker except the summary's.
 *
 * Covers both modes the loop runs in (verify-loop.sh's header contract):
 * normal mode's per-test `FAILED: <file>` markers echo BEFORE each test's
 * output (the same line repeats in each mode; a Set dedupes), and digest
 * mode's markers plus the trailing summary. The `(timed out after Ns)`
 * suffix normal mode appends is stripped so a timed-out test still names the
 * same file and compares equal to its base-run name.
 */
export function failingTestNames(stream: string): string[] {
  const names = new Set<string>();
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("FAILED:")) continue;
    const summary = SUMMARY_RE.exec(line);
    if (summary) {
      // A collapsed summary hides names the comparison cannot see; that
      // silence is not evidence, so the whole run becomes unattributable.
      if (COLLAPSE_RE.test(line)) return [];
      for (const part of (summary[1] ?? "").split(",")) {
        const name = part.trim();
        if (name) names.add(name);
      }
      continue;
    }
    const perFile = PER_FILE_RE.exec(line);
    if (!perFile) continue;
    const name = (perFile[1] ?? "").replace(/ \(timed out after [^)]*\)$/, "").trim();
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * True when `stream` is a verify-loop digest whose tally says nothing
 * actually failed. Only the `P:`/`F:` lines digest mode prints (verify-
 * report.sh's `emit_tally`) match this shape exactly, so a stream that never
 * reached a tally — a fast-tier short-circuit, a tsc/biome failure — reads as
 * "not a tally", which is the conservative answer: never a reason to continue.
 */
export function isAllPassDigestTally(stream: string): boolean {
  return stream.split("\n").some((l) => /^P: \d+ {2}F: 0$/.test(l.trim()));
}

/**
 * Why a base run that reported no failing test names cannot excuse anything.
 * Two shapes, both named so the park reason says what is missing:
 *
 * - killed at its bound (the caller passes the flag the executor stamped —
 *   the stream itself cannot prove a kill; it just ends);
 * - a digest tally that contradicts the non-zero exit: `F: 0` with an exit
 *   code is a run whose verdict disagrees with itself, and an unexamined
 *   passing tally read as "green base" was the fail-open shape this seam is
 *   built to remove — the only base that excuses is one whose FAILED: names
 *   the comparison can actually see.
 */
export function emptyBaseReason(timedOut: boolean, stream: string): string {
  if (timedOut) return "the base run was killed at its bound, so it named no failing tests";
  if (isAllPassDigestTally(stream)) {
    return "the base run exited non-zero while its pass/fail tally reported F: 0 — a verdict that contradicts its own exit code excuses nothing";
  }
  return "the base run failed but named no failing tests (no FAILED: marker in its output)";
}

// ─────────────────────────────────────────────────────────────────────────────
// #1404 — the probe seam the commit-pr consolidated verify calls when its gate
// is red: run the project's verify command AGAIN at the cycle's base commit and
// split the change run's failing-test names into the ones the base already had
// (pre-existing — the gate owns them) and the ones that pass at base (caused by
// the change — the cycle owns them). It lives beside the name parser because the
// whole judgement is a property of names: `failingTestNames` reads both streams
// and `attributeFailuresByName` does the difference, so one module owns both the
// spelling of a name and what two spellings mean together. The verify seam's job
// stays "run it, classify it, report it".
// ─────────────────────────────────────────────────────────────────────────────
/** What one baseline probe learned about a consolidated verify failure. */
export interface BaselineProbeOutcome {
  /** Failing test names that also fail at base — not caused by the change. */
  preExistingFailures: string[];
  /** Failing test names that pass at base — caused by the change. */
  changeCausedFailures: string[];
}

/**
 * #1404 — run the base probe and diff the failing-test-name sets.
 *
 * Returns `undefined` — the park stands with the original reason — for every
 * shape the probe cannot establish: the base could not be checked out, the
 * base run died for want of dependencies, the base run was killed at its
 * bound, no failing-test name parsed from either stream, or a contradiction
 * like an all-pass tally beside a non-zero exit. Fail-closed is the default:
 * a wrong "not the change" is worse than a park, so absence of evidence is
 * never read as evidence of innocence.
 *
 * Otherwise returns the per-name split, and the ONLY case that may continue
 * (all change names pre-existing, both name sets non-empty) is expressed by
 * the caller checking `changeCausedFailures.length === 0`.
 */
export async function attributeAgainstBase(
  execFn: NonNullable<ExecFn>,
  opts: {
    repoRoot: string;
    verifyCmd: string;
    timeoutMs?: number;
    baseSha?: string;
    baselineProbeLabel?: string;
  },
  changeStream: string,
): Promise<BaselineProbeOutcome | undefined> {
  const changeNames = failingTestNames(changeStream);
  const bound = opts.timeoutMs ?? 30 * 60_000;
  const verdict = await probeBaselineVerify(execFn, {
    repoRoot: opts.repoRoot,
    baseSha: opts.baseSha as string,
    // Deliberately NOT the bare issue number: the develop step's probe tree
    // is `baseline-verify-<issue>`, and two steps sharing one tree name means
    // one step's teardown removes the other's checkout.
    issue: opts.baselineProbeLabel ?? "commit-pr",
    cmd: opts.verifyCmd,
    timeoutMs: bound,
  });
  if (verdict.status !== "red") {
    trace(
      `work-driver: commit-pr verify — the baseline probe did not establish a red base (${verdict.status === "unknown" ? verdict.reason : "the base is green"}); the consolidated failure parks as before`,
    );
    return undefined;
  }
  if (verdict.timedOut) {
    trace(
      "work-driver: commit-pr verify — the baseline run was killed at its bound, so no per-test comparison was possible; the consolidated failure parks as before",
    );
    return undefined;
  }
  const baseStream = verdict.rawStream ?? "";
  const baseNames = failingTestNames(baseStream);
  const attribution = attributeFailuresByName(changeNames, baseNames);
  if (attribution.unattributable !== undefined) {
    const why =
      changeNames.length === 0 ? attribution.unattributable : emptyBaseReason(false, baseStream);
    trace(`work-driver: commit-pr verify — the baseline probe is unattributable: ${why}`);
    return undefined;
  }
  return {
    preExistingFailures: attribution.preExisting,
    changeCausedFailures: attribution.changeCaused,
  };
}
