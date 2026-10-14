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
 * Accepted limitation: the anchor is `^FAILED: .+$`, matched anywhere in the
 * combined stream and resolved to the LAST occurrence. A test whose own
 * verbose output happens to print a line of that exact shape (e.g. a test
 * asserting on marker-parsing text elsewhere in this codebase) could shift
 * the anchor away from the real verify-cmd marker and lose attribution for
 * that run. This is deliberately not special-cased — disambiguating "which
 * FAILED: line is the real one" would require either a distinguishing
 * prefix `.pi/verify-cmd` doesn't provide (it's project-supplied, not owned
 * by this repo) or brittle heuristics over test output shapes. The fallback
 * path (`attributed: false`) is the safety net when the anchor is wrong or
 * absent; test-exec-error-attribution.ts pins the last-marker behaviour so
 * this tradeoff stays deliberate and visible.
 */

import { readFileSync } from "node:fs";

/** The exact marker `.pi/verify-cmd`'s smoke-test loop emits on failure. */
const FAILED_MARKER_RE = /^FAILED: .+$/gm;

/** Result of tail extraction: the text, and whether it's anchored evidence. */
export interface AttributedTail {
  /** The extracted, bounded evidence tail. */
  tail: string;
  /** True when `tail` starts at a `FAILED:` marker (attribution is sound). */
  attributed: boolean;
}

/**
 * Extract an evidence tail from combined command output, anchored on the
 * failure marker when present so a passing sub-command's output is never
 * misattributed as the cause. Falls back to the last `maxLen` chars when no
 * marker is found (a single-command failure, or a shape this doesn't know
 * about) — the pre-#723 behaviour, preserved as the fallback rather than the
 * default, but now flagged via `attributed: false` rather than silently.
 */
export function extractAttributedTail(combined: string, maxLen: number): AttributedTail {
  const trimmed = combined.trim();
  if (!trimmed) return { tail: "", attributed: false };
  // Anchor on the LAST marker — a chain can only fail once (the loop
  // `exit 1`s right after), but staying on the last occurrence keeps this
  // correct if a future verify-cmd shape prints more than one.
  const matches = [...trimmed.matchAll(FAILED_MARKER_RE)];
  const last = matches[matches.length - 1];
  if (last?.index !== undefined) {
    const fromMarker = trimmed.slice(last.index);
    if (fromMarker.length <= maxLen) return { tail: fromMarker, attributed: true };
    // Still bound the size — the verbose re-run after the marker can itself
    // be long — but preserve BOTH ends: the marker line (attribution) and
    // the tail of the anchored region (where the real assertion failure /
    // diff / stack trace lives), not just the head.
    const newline = fromMarker.indexOf("\n");
    const markerLine = newline === -1 ? fromMarker : fromMarker.slice(0, newline);
    const elision = "\n...\n";
    const remaining = maxLen - markerLine.length - elision.length;
    const tail =
      remaining > 0
        ? markerLine + elision + fromMarker.slice(-remaining)
        : fromMarker.slice(0, maxLen);
    return { tail, attributed: true };
  }
  return { tail: trimmed.slice(-maxLen), attributed: false };
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
