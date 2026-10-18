/**
 * work-driver-verify-names — the spelling half of #1404: reading failing-test
 * names out of a verify-loop.sh stream, and deciding when two names from two
 * different trees denote the same test.
 *
 * Split out of `work-driver-verify-attribution.ts` (500-line cap, AGENTS.md
 * §12) along the seam that already existed in that file: everything here is a
 * pure function of STRINGS — no exec, no git, no worktree — which is also why
 * it is the half the smoke tests exercise directly. The attribution module
 * keeps the probe seam that runs the base command and owns the fail-closed
 * judgement about whether to excuse a failure.
 *
 * Fail-closed is the contract, not a preference: the caller PUSHES with a red
 * gate on the strength of these answers, so a name that cannot be placed, a
 * summary that disagrees with its own count, or a tally at war with its exit
 * code all read as "no evidence", never as "the change is not implicated".
 */

import { realpathSync } from "node:fs";

/**
 * The two trees a failing-test name may be anchored in. There is no bare-name
 * membership set: a name that carries no root prefix is NOT comparable, because
 * nothing about it records which tree it came from, and two runs agreeing on a
 * bare spelling is a coincidence a forger can arrange on purpose. Bare names
 * are unattributable (park), not compared.
 */
export interface NameRoots {
  /**
   * Every tree a CHANGE-run name may live under: the integration checkout, the
   * probe tree, and (followup rounds, ci retries) any worktree the same
   * committed gate script may have been executed from.
   */
  changeRoots: readonly string[];
  /** The probe's detached worktree at the base commit. */
  probeRoot: string;
}

/**
 * Per-call memo of filesystem walks, threaded through the name comparison so
 * one run resolves each path once instead of once per comparison. Declared
 * structurally (a `get`/`set` pair) rather than as `Map<string, …>` so the
 * attribution module that owns `createNameResolution()` is the only thing that
 * has to agree with it on a concrete type, and a `Map` satisfies it without an
 * import in this direction.
 *
 * `get` returns `undefined` for "not yet attempted" and `null` for "attempted,
 * the whole path did not resolve" — the two states a caller must not conflate.
 */
export interface NameResolution {
  get(key: string): string | null | undefined;
  set(key: string, value: string | null): unknown;
}

/** The summary form: `FAILED: <n> test(s) — <name>, <name>, …` (or collapsed). */
const SUMMARY_RE = /^FAILED: (\d+) test\(s\) —(.*)$/;

/** The per-failure marker, normal mode's timeout suffix stripped. */
const PER_FILE_RE = /^FAILED: (.+)$/;

/**
 * The count printed by verify-report.sh's summary line, or `undefined` when
 * the stream carries no summary. The count is the loop's own verdict
 * (`${#names[@]}`), so it is the number a parsed name set must agree with.
 */
export function summaryCount(stream: string): number | undefined {
  let count: number | undefined;
  for (const raw of stream.split("\n")) {
    const m = SUMMARY_RE.exec(raw.trim());
    // Last summary wins: normal mode prints one, and a test that echoed the
    // shape is followed by the loop's real one at the end of the stream.
    if (m) count = Number(m[1]);
  }
  return count;
}

/**
 * A run's failing-test names, read from the RAW combined stream — never the
 * 800-char `extractAttributedTail` output, whose last-marker anchoring elides
 * every per-failure marker except the summary's.
 *
 * ONLY the loop's own emitters are read. `FAILED:` is an ordinary string a
 * test can print — a fixture that echoes `FAILED: /etc/passwd` or asserts on
 * a line beginning `FAILED: ` is the forgeable shape this function exists to
 * refuse, and a forged name on the base side would excuse a real regression.
 * So the per-failure markers (`FAILED: <file>`) and the summary
 * (`FAILED: <n> test(s) — …`) are the only two accepted shapes, and the whole
 * stream is rejected when:
 *
 * - the summary is absent (a run that never reached its report half);
 * - the summary is collapsed (`… and N more` — the hidden names cannot be
 *   guessed at, and a hidden name that fails at base would be a false
 *   "caused by the change");
 * - the summary's count disagrees with the names parsed (a forged or
 *   truncated list).
 */
export function failingTestNames(stream: string): string[] {
  const summary = summaryCount(stream);
  // No summary → this stream was never produced by the loop's report half, so
  // nothing in it is trustworthy as a name. Fail closed.
  if (summary === undefined) return [];
  if (/… and \d+ more/.test(stream)) return [];
  const names = new Set<string>();
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("FAILED:")) continue;
    if (SUMMARY_RE.test(line)) continue;
    const perFile = PER_FILE_RE.exec(line);
    if (!perFile) continue;
    const name = (perFile[1] ?? "").replace(/ \(timed out after [^)]*\)$/, "").trim();
    if (name) names.add(name);
  }
  // The tally is the loop's count of its own failures; a stream naming a
  // different number of tests is not that stream's verdict.
  if (names.size !== summary) return [];
  return [...names];
}

/**
 * The digest pass/fail tally line, exactly as verify-report.sh's `emit_tally`
 * prints it: one line, `P: <n>  F: <n>`, two spaces between the fields.
 */
const TALLY_RE = /^P: (\d+) {2}F: (\d+)$/;

/**
 * The tally's failure count, or `undefined` when the stream carries none (a
 * fast-tier short-circuit or a tsc/biome failure never reaches a tally).
 * The LAST such line wins — an earlier one is test output, the loop's own is
 * the final line it prints.
 */
export function digestTallyFailCount(stream: string): number | undefined {
  let fails: number | undefined;
  for (const raw of stream.split("\n")) {
    const m = TALLY_RE.exec(raw.trim());
    if (m) fails = Number(m[2]);
  }
  return fails;
}

/**
 * True when a run that exited non-zero contradicts its own tally. `F: 0`
 * beside a non-zero exit is a verdict at war with itself, and a passing tally
 * read as "green base" was the fail-open shape this seam is built to remove.
 *
 * Deliberately NOT `.some()` over the stream: the loop also prints each
 * failing test's own captured output, so a stream legitimately contains both
 * `FAILED:` markers and a test echoing `P: 9  F: 0`. That is a red run, not a
 * contradiction. So the tally is checked by position — it must be the stream's
 * last emitted verdict line — and a stream carrying failure names can never
 * read as all-pass, whatever its tally claims.
 */
export function isContradictoryTally(stream: string): boolean {
  const lines = stream.split("\n").map((l) => l.trim());
  const last = [...lines].reverse().find((l) => TALLY_RE.test(l));
  if (last === undefined) return false;
  // The verdict is the tally THIS function located — the last one in the
  // stream, which is the loop's own — read off the same `last` line rather than
  // re-derived by a second scan that could land on a different line and call
  // the pair coherent. `failingTestNames` is the other half of the
  // contradiction: a stream that names failures can never be an all-pass, no
  // matter what its final tally claims.
  const fails = Number(TALLY_RE.exec(last)?.[2]);
  return fails === 0 && failingTestNames(stream).length > 0;
}

/**
 * Why a base run that reported no failing test names cannot excuse anything.
 * Three shapes, each named so the park reason says what is missing.
 */
export function emptyBaseReason(timedOut: boolean, stream: string): string {
  if (timedOut) return "the base run was killed at its bound, so it named no failing tests";
  if (isContradictoryTally(stream)) {
    return "the base run exited non-zero while its pass/fail tally reported F: 0 — a verdict that contradicts its own exit code excuses nothing";
  }
  return "the base run failed but named no failing tests (no trustworthy FAILED: summary in its output)";
}

/**
 * The comparison of two failing-test names, one from each of TWO TREES: the
 * change run resolves its paths against the integration checkout at repoRoot,
 * the probe run against its throwaway detached worktree under
 * `<repoRoot>/.worktrees/`. Both trees check the same commit's content out at
 * a different absolute prefix, so one test prints as two different strings —
 * and a comparison of raw spellings would report every pre-existing failure as
 * change-caused, parking exactly the cycles this feature exists to save.
 *
 * Round 1's answer (shared trailing path segments) was WRONG in the direction
 * that matters: a shared tail only ever EXCUSES, so `tests/test-x.ts` excused
 * `p/q/r/s/tests/test-x.ts` — a genuinely different file whose tail happened to
 * match. So the comparison is anchored rather than shared: each name must sit
 * inside one of the two trees this seam knows (`changeRoots` = the integration
 * checkout, `probeRoot` = the probe worktree `probeBaselineVerify` created),
 * and the paths RELATIVE to those roots must be EQUAL. Anything else —
 * relative or bare names, a name outside both roots, an unstrippable prefix —
 * is `unknown`, which the caller treats as unattributable. Never as a match.
 */
export type NameComparison = "same" | "different" | "unknown";

/**
 * Normalise a path for comparison: forward slashes, no `.` segments, no
 * trailing slash, and resolved through `realpath`.
 *
 * The resolution is not cosmetic. A tree reached through a symlink prints its
 * names under the SYMLINKED spelling while the caller holds the resolved one
 * (or the reverse), and the two never share a prefix. That is not a test-only
 * shape: on macOS every temp dir is `/var/…` → `/private/var/…`, and a
 * `gate.sh` that resolves its own directory prints one form while `repoRoot`
 * holds the other. Without this, every name in a real run is unplaceable, every
 * run is unattributable, and the feature silently never excuses anything —
 * fail-closed, so it merely looks like it is not helping.
 *
 * Only the LONGEST EXISTING PREFIX is resolved, and a total failure to resolve
 * is not fatal: the plain spelling is returned. That matters here because the
 * probe removes its own worktree before the attribution runs, so the probe's
 * path is a string that no longer names a directory — resolving its parent
 * still puts it in the same spelling as every other path in the comparison.
 *
 * `memo` short-circuits the WHOLE-PATH walk (the common case: the path exists,
 * the first probe hits). The prefix fallback still walks, because a memoised
 * "this path did not resolve" says nothing about which of its prefixes do.
 */
function asPath(value: string, memo?: NameResolution): string {
  const parts = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) return "";
  const absolute = value.trim().startsWith("/");
  // The whole-path form first, from the memo when one is threaded: in the
  // comparison every name and every root is a real path, so this is the walk
  // that succeeds and the one worth caching. `null` is a remembered miss, so a
  // path that never resolves is attempted once and falls through here.
  const whole = `/${parts.join("/")}`;
  const cached = memo?.get(value);
  if (cached === null) {
    // Remembered miss: fall through to the prefix walk without a realpath call.
  } else if (cached !== undefined) {
    return absolute ? cached : cached.replace(/^[/]+/, "");
  } else {
    try {
      const realWhole = realpathSync(whole);
      memo?.set(value, realWhole);
      return absolute ? realWhole : realWhole.replace(/^[/]+/, "");
    } catch {
      memo?.set(value, null);
    }
  }
  for (let i = parts.length; i >= 1; i--) {
    const head = `/${parts.slice(0, i).join("/")}`;
    try {
      const realHead = realpathSync(head);
      const rest = parts.slice(i);
      const base = realHead.endsWith("/") ? realHead.slice(0, -1) : realHead;
      const joined = rest.length === 0 ? base : `${base}/${rest.join("/")}`;
      if (absolute) return joined;
      // A relative spelling stays relative on both sides of every comparison.
      return joined.replace(/^[/]+/, "");
    } catch {
      // Shorten and try again.
    }
  }
  return absolute ? `/${parts.join("/")}` : parts.join("/");
}

/** `name` relative to `root`, or undefined when it does not live under it. */
function relativeTo(name: string, root: string, memo?: NameResolution): string | undefined {
  const r = asPath(root, memo);
  if (r === "") return undefined;
  const n = asPath(name, memo);
  if (n === r) return "";
  return n.startsWith(`${r}/`) ? n.slice(r.length + 1) : undefined;
}

/**
 * Compare two failing-test names produced by two runs in two trees.
 *
 * Each name is stripped against the root it lives under and the remainders
 * must be EQUAL. There is no bare-name branch: a name that carries no root
 * prefix records nothing about which tree printed it, so it cannot be placed
 * and cannot excuse anything. The degenerate configuration — no change tree of
 * its own, or one that resolves to the probe's own directory — is `unknown`
 * too, because relative-path equality there proves nothing about which run
 * printed what.
 *
 * `unknown` is the answer whenever a name cannot be placed. The caller parks on
 * `unknown`.
 *
 * `resolution` is the per-call memo described on `NameResolution`: each root
 * resolves once for the whole call and each name once, rather than once per
 * (change-name, base-name) pair.
 */
export function compareNames(
  a: string,
  b: string,
  roots: NameRoots,
  resolution?: NameResolution,
): NameComparison {
  // The degenerate configuration: with no change tree of its own (or one that
  // resolves to the probe's own directory), relative-path equality proves
  // nothing about which run printed what, so nothing may be excused. Compared
  // AFTER normalisation, because `repoRoot` and the probe path can name one
  // directory in two spellings (a symlinked root) — that is the degenerate case
  // too, not two trees.
  //
  // The roots are resolved ONCE per call and reused: they are the same handful
  // of directories for every pair in the run, and re-walking them per pair was
  // 2·C·B realpath walks for a set that never changes inside a call.
  const probeResolved = asPath(roots.probeRoot, resolution);
  const changeTrees = roots.changeRoots
    .map((r) => asPath(r, resolution))
    .filter((r) => r !== "" && r !== probeResolved);
  if (changeTrees.length === 0) return "unknown";
  // The probe tree is nested INSIDE the integration checkout, so each name is
  // stripped against the probe root FIRST: stripping against the outer root
  // first would leave the probe's own path as `.worktrees/baseline-verify-…/x`
  // and report the same test as a different file.
  const rel = (name: string): string | undefined =>
    relativeTo(name, roots.probeRoot, resolution) ??
    roots.changeRoots
      .map((r) => relativeTo(name, r, resolution))
      .find((r): r is string => r !== undefined);
  const aRel = rel(a);
  const bRel = rel(b);
  if (aRel !== undefined && bRel !== undefined) return aRel === bRel ? "same" : "different";
  // Unplaceable on at least one side: an unknown name never excuses a failure.
  return "unknown";
}

/**
 * True when two parsed names denote the same test across two runs in two
 * trees. Exposed for callers that want the boolean; the attribution path uses
 * `compareNames` with the real roots so `unknown` stays distinguishable from
 * `different` and turns into a park rather than a silent `different`.
 *
 * With no roots the answer is always `unknown` — and therefore always `false`.
 * That is the point: a bare-name comparison is what this seam refused to do,
 * so the convenience wrapper must not be a door back to it.
 */
export function sameFailingTest(a: string, b: string): boolean {
  return compareNames(a, b, { changeRoots: [], probeRoot: "" }) === "same";
}
