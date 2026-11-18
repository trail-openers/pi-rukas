/**
 * work-driver-exec-error — attribution-aware evidence-tail extraction.
 *
 * #723 — `.pi/verify-cmd` is one shell line chaining several sub-commands
 * (typecheck, biome, then a smoke-test loop) into a single combined
 * stdout+stderr stream. A naive `.slice(-N)` of that stream can splice the
 * tail of an earlier PASSING sub-command onto the START of a later FAILING
 * one, so a handoff reads as "biome failed" when biome actually exited 0 and
 * a smoke test two sub-commands later is what failed.
 *
 * `.pi/verify-cmd`'s smoke-test loop prints `FAILED: <test file>` immediately
 * before re-running the failing test verbosely (see the file itself). That
 * line is a reliable anchor: when present, the tail starts there rather than
 * at a fixed byte offset from the end, so the reported evidence begins at the
 * actual failure, not wherever the fixed-size window happens to land.
 *
 * Accepted limitation: the anchor is any line the shared failure-line table
 * (#1762, work-driver-verify-failures.ts) recognises, matched anywhere in the
 * combined stream and resolved to the LAST occurrence. A test whose own
 * verbose output happens to print a line of one of those shapes (e.g. a test
 * asserting on marker-parsing text elsewhere in this codebase) could shift
 * the anchor away from the real verify-cmd marker and lose attribution for
 * that run. This is deliberately not special-cased — disambiguating "which
 * failure line is the real one" would require either a distinguishing
 * prefix `.pi/verify-cmd` doesn't provide (it's project-supplied, not owned
 * by this repo) or brittle heuristics over test output shapes. The fallback
 * path (`attributed: false`) is the safety net when the anchor is wrong or
 * absent; test-exec-error-attribution.ts pins the last-marker behaviour so
 * this tradeoff stays deliberate and visible.
 *
 * #1762 — the anchor used to be only `^FAILED: .+$`, so a project gate that
 * prints `test.sh: failed checks (1)` instead of this repo's loop dialect
 * anchored nowhere and the window was the last N chars, which is how a project-runner
 * handoff quoted a PASSING `pack_release_test.sh: 36 cases, 0 failed` stage.
 * The anchor is now the last failure-looking line the table recognises, and a
 * line that reports success is never an anchor.
 *
 * Which line, when the stream holds several (#1762): the LAST plain `FAILED:`
 * marker when the stream has one — the smoke loop's own verdict line, which is
 * the region the loop's `exit 1` follows and what
 * test-exec-error-attribution.ts pins — otherwise the last recognised line,
 * preferring one that NAMES a specific assertion. Widening the shape set must
 * not move an anchor that was already sound.
 */

import { readFileSync } from "node:fs";
import {
  FAILED_MARKER_RE,
  classifyFailureLine,
  panicIsCapturedPrint,
  rustPanicTestName,
} from "./work-driver-verify-failures.ts";
import { splitLinesWithOffsets } from "./work-driver-verify-support.ts";

/** Result of tail extraction: the text, and whether it's anchored evidence. */
export interface AttributedTail {
  /** The extracted, bounded evidence tail. */
  tail: string;
  /** True when `tail` starts at a recognised failure line (attribution is sound). */
  attributed: boolean;
}

/**
 * Extract an evidence tail from combined command output, anchored on the last
 * failure line when one is present so a passing sub-command's output is never
 * misattributed as the cause. Falls back to the last `maxLen` chars when no
 * failure line is found (a single-command failure, or a shape the table doesn't
 * know about) — the pre-#723 behaviour, preserved as the fallback rather than the
 * default, but now flagged via `attributed: false` rather than silently.
 *
 * The bound is maxLen-agnostic (#1762 PM decision 5): an anchor near the end of
 * a long stream keeps its own line under both the 800- and the 1500-char cap,
 * because the elision cuts the anchored region's head, not the anchor.
 */
export function extractAttributedTail(combined: string, maxLen: number): AttributedTail {
  const trimmed = combined.trim();
  if (!trimmed) return { tail: "", attributed: false };
  // Anchor on the LAST failure line — a chain can only fail once (the loop
  // `exit 1`s right after), but staying on the last occurrence keeps this
  // correct if a future verify-cmd shape prints more than one.
  const anchor = lastFailureAnchor(trimmed, maxLen);
  if (anchor !== undefined) {
    // The window the veto was asked on, handed over as the published tail: no
    // second cut of the stream happens between the two.
    return { tail: anchor.window, attributed: true };
  }
  // The blind slice is text the extractor judges too, so it gets the same
  // verdict guarantee: it must not hand over a captured panic whose own
  // verdict line the slice happens to leave out — the guarantee lives in the
  // stream-scoped ask, not in an edited window (see {@link publishedWindow}).
  return { tail: trimmed.slice(-maxLen), attributed: false };
}

/**
 * The bytes {@link extractAttributedTail} publishes for the line beginning at
 * `anchorIndex`, together with the `should_panic` veto.
 *
 * ONE call produces the window and its verdict, and the caller receives this
 * value rather than re-cutting the stream (#2341 fix wave 5, H1/H2): the veto
 * and the published bytes come from the same cut, so the extractor cannot be
 * handed a window whose anchor the walk had already refused. The wave-4 defect
 * was the other shape of this: the walk vetoed a candidate on a window it then
 * did not publish (the `FAILED:` marker wins the anchor and publishes a region
 * starting at ITSELF), so the published window — the one whose elision had cut
 * away the `... ok` proving the panic was a passing `#[should_panic]` test's
 * captured print — reached the extractor unanswered and became "the assertion
 * at base".
 *
 * The veto is the ONE name-correlated question over the WHOLE `text` —
 * {@link panicIsCapturedPrint} — and it is asked of the stream, never of the
 * window. A window-scoped tally is what each earlier wave reopened: the window
 * is the stream's OWN bytes (no line is ever materialised into it to make a
 * question decidable, because the window is quoted to a human and an imported
 * verdict line is a window that lies), so it cannot be trusted to hold the
 * verdict it would have to be asked about.
 *
 * `panicName` is the candidate's own panic name, or `undefined` for any other
 * shape; with no name the question does not arise, and an unobserved verdict
 * vetoes nothing.
 */
function publishedWindow(
  text: string,
  anchorIndex: number,
  maxLen: number,
  panicName: string | undefined,
): { window: string; vetoed: boolean } {
  return {
    window: tailFromAnchor(text, anchorIndex, maxLen),
    vetoed: panicIsCapturedPrint(text, panicName),
  };
}

/**
 * The window {@link extractAttributedTail} publishes when the line beginning
 * at `anchorIndex` owns the anchor: the anchored region bounded to `maxLen`
 * with BOTH ends preserved — the anchor line (attribution) and the tail of the
 * region (where the real assertion / diff / stack trace lives), the elision
 * cutting the region's middle. A long WRAPPED line — one recognised line wider
 * than the window — keeps its attribution: the head of the anchor line carries
 * the marker, so clipping the line itself is far better evidence than a blind
 * slice of the stream's end.
 *
 * PRIVATE and called from {@link publishedWindow} ONLY. A caller that bounded
 * the region on its own would publish bytes the veto never read — the exact
 * shape of the #2341 fix wave 4 defect — so the cut is reachable from no other
 * site; everything above goes through the one function that pairs a window with
 * its verdict.
 */
function tailFromAnchor(text: string, anchorIndex: number, maxLen: number): string {
  const fromMarker = text.slice(anchorIndex);
  if (fromMarker.length <= maxLen) return fromMarker;
  // Still bound the size — the verbose re-run after the marker can itself
  // be long — but preserve BOTH ends, not just the head.
  const newline = fromMarker.indexOf("\n");
  const anchorLine = newline === -1 ? fromMarker : fromMarker.slice(0, newline);
  const elision = "\n...\n";
  const remaining = maxLen - anchorLine.length - elision.length;
  return remaining > 0
    ? anchorLine + elision + fromMarker.slice(-remaining)
    : fromMarker.slice(0, maxLen);
}

/**
 * Byte offset in `text` of the line to anchor on, and the window that owns it.
 * The last `FAILED:` marker when the stream has one (the loop's own verdict
 * line, and the pre-#1762 anchor, so an already-sound attribution never moves);
 * otherwise the last line the failure table recognises, preferring among the
 * recognised lines one that names a specific assertion — a trailing `FAIL`
 * tally is weaker evidence than the assertion beneath it. Undefined when the
 * stream has no failure line.
 */
function lastFailureAnchor(
  text: string,
  maxLen: number,
): { window: string; vetoed: boolean } | undefined {
  let marker: { window: string; vetoed: boolean } | undefined;
  let lastAny: { window: string; vetoed: boolean } | undefined;
  let lastNamed: { window: string; vetoed: boolean } | undefined;
  // Offsets come from the splitter, not from a `+1` the caller assumes: on a
  // `\r\n` stream a one-character advance drifts a character per line and the
  // tail would start inside the line ABOVE the failure. See
  // {@link splitLinesWithOffsets}.
  const entries = splitLinesWithOffsets(text);
  for (const { line: raw, offset } of entries) {
    const line = raw.trim();
    const at = offset + (raw.length - raw.trimStart().length);
    const isMarker = FAILED_MARKER_RE.test(line);
    const kind = classifyFailureLine(line);
    if (!isMarker && kind === undefined) continue;
    // #2341 fix wave (H1) / fix wave 7 — the SAME name-correlated
    // `should_panic` veto the extractor asks, asked on the whole stream and
    // keyed to this candidate's own test name (see {@link publishedWindow}:
    // the veto and the published bytes are produced by one call). A panic
    // header whose OWN test the run reported as passing is not evidence — it
    // names a test that passed — and is refused at BOTH tiers: not a named
    // anchor, and not the last-resort `lastAny` either (the anchor it would
    // earn could then be quoted as the assertion, the elision having cut away
    // the `... ok` that proves it did not). An unobserved verdict vetoes
    // nothing — absence is not a verdict either way.
    const published = publishedWindow(
      text,
      at,
      maxLen,
      kind?.shape === "rust-panic" ? rustPanicTestName(line) : undefined,
    );
    if (isMarker) marker = published;
    if (kind === undefined) continue;
    if (kind.shape === "rust-panic" && published.vetoed) continue;
    lastAny = published;
    if (kind.namesTest) lastNamed = published;
  }
  return marker ?? lastNamed ?? lastAny;
}

/**
 * The label a failure string carries when the command never ran because the
 * HOST could not start a process. Same convention as the classifier's
 * `[consolidation-created]` / `[needs-human-decision]` labels: the verify
 * gate's failures are strings, and the consumers (explainCap, the queue's
 * human action) route on the label rather than on the prose around it.
 */
export const HOST_EXHAUSTION_LABEL = "[host-resource-exhaustion]";

/**
 * The shapes a fork failure arrives in: dash (`/bin/sh: 1: Cannot fork`),
 * bash (`fork: retry: Resource temporarily unavailable`), coreutils
 * (`fork system call failed`), and Node's own spawn error (`spawn /bin/sh
 * EAGAIN`, `Failed to start worker: EAGAIN`). A bare `EAGAIN` is deliberately
 * NOT matched — a non-blocking read reports it too, and that is a test's
 * business, not the host's.
 */
const HOST_FORK_FAILURE_RE =
  /\bCannot fork\b|\bfork: (?:retry: )?(?:Resource temporarily unavailable|Cannot allocate memory)|\bfork system call failed\b|\bspawn\b[^\n]*\bEAGAIN\b|\bFailed to start worker: EAGAIN\b/;

/**
 * True when `output` shows the host refusing to fork. Three cycles parked
 * with a verdict about the CODE — `[needs-human-decision]`, and once "two
 * workstreams edited the same lines" on a single-workstream cycle — when
 * every command the gate ran had died on `/bin/sh: 1: Cannot fork`. Nothing
 * was executed, so nothing was learned about the change.
 */
export function isHostForkExhaustion(output: string): boolean {
  return HOST_FORK_FAILURE_RE.test(output);
}

/** True when a recorded failure string carries the host-exhaustion label. */
export function isHostExhaustionFailure(failure: string): boolean {
  return failure.includes(HOST_EXHAUSTION_LABEL);
}

export type PidLimitSnapshot = { current: number; max: number | "max" };

function fmtPids(p: PidLimitSnapshot): string {
  return `cgroup pids.current=${p.current} of pids.max=${p.max}`;
}

/**
 * Where the pid ceiling actually is, read without forking (a fork is what
 * just failed). In a container the ceiling that was hit is the container's
 * cgroup `pids.max` (docker `--pids-limit`), not a host ulimit: an operator
 * sent to "free processes on the host" found `ulimit -u` unlimited and
 * nothing to raise (#1277). Undefined when the counters cannot
 * be read (no cgroup v2, not Linux).
 */
export function pidLimitSnapshot(
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): PidLimitSnapshot | undefined {
  try {
    const current = read("/sys/fs/cgroup/pids.current").trim();
    const max = read("/sys/fs/cgroup/pids.max").trim();
    if (!/^\d+$/.test(current) || !/^(\d+|max)$/.test(max)) return undefined;
    return { current: Number(current), max: max === "max" ? "max" : Number(max) };
  } catch {
    return undefined;
  }
}

/**
 * The operator procedure, named once. The failure string and explainVerifyFailed
 * both point here, so the procedure lives in exactly one place (troubleshooting).
 */
export const HOST_EXHAUSTION_RUNBOOK = `The operator procedure (reading the counters, checking that PID 1 is an init, restarting or raising the limit) is in docs/troubleshooting.md under "${HOST_EXHAUSTION_LABEL}: the gate could not run".`;

/**
 * Headroom below which a numeric pids.max counts as exhausted. A fork needs
 * one free slot, but one gate spawns a whole shell tree and parallel
 * workstreams burst together, so a dozen spare pids is as good as none.
 */
const PID_HEADROOM = 10;

/** True only when the snapshot shows a numeric ceiling with no headroom left. */
export function pidCeilingExhausted(snapshot: PidLimitSnapshot): boolean {
  return snapshot.max !== "max" && snapshot.max - snapshot.current < PID_HEADROOM;
}

const OTHER_CEILINGS =
  "the other ceilings to check are the kernel's pid_max (/proc/sys/kernel/pid_max), the user's RLIMIT_NPROC (`ulimit -u`), and memory pressure";

/**
 * The failure string for a gate command that could not be started. It stays a
 * FAILURE — an unrun gate must never read as a pass — but it says what was
 * and was not established, and points at the process ceiling, not the diff.
 * `pids` is the caller's snapshot, taken once at the failure site so this
 * formatter stays free of side effects.
 */
export function hostExhaustionFailure(
  what: string,
  detail: string,
  pids: PidLimitSnapshot | undefined,
): string {
  let cause: string;
  if (pids === undefined) {
    cause = `the process or thread limit where the driver runs is unknown (its cgroup pid counters could not be read just after the failure); ${OTHER_CEILINGS}`;
  } else if (pidCeilingExhausted(pids)) {
    cause = `the process limit where the driver runs is exhausted: ${fmtPids(pids)} (counters read just after the failure)`;
  } else if (pids.max === "max") {
    cause = `the cgroup pid limit is NOT the ceiling here (${fmtPids(pids)}); ${OTHER_CEILINGS}`;
  } else {
    cause = `the cgroup counters read just after the failure show headroom (${fmtPids(pids)}); the limit may have been hit transiently by a burst of parallel processes, or the ceiling is elsewhere; ${OTHER_CEILINGS}`;
  }
  return `${HOST_EXHAUSTION_LABEL} ${what} could not run — the system refused to start a process (fork failed / EAGAIN); ${cause}. This is an environment failure, NOT a verdict on the change: the gate did not execute, so the change is neither confirmed nor refuted. In a container the ceiling is the CONTAINER's pid limit (docker \`--pids-limit\`), not a host ulimit. ${HOST_EXHAUSTION_RUNBOOK} Evidence: ${detail}`;
}
