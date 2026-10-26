/**
 * workflow-state-schema-base-health — #1765: the state record of the branch
 * step's pre-develop base probe, the repo-level cache it feeds, and the rules
 * for reading either back.
 *
 * Its own module for the same reason the other schema slices are:
 * `workflow-state-schema.ts` sits at the 500-line cap AGENTS.md §12 enforces,
 * and a probe record is not a PipelineState concern anyone else has to hold in
 * their head while reading it. The rule the record serves — green cached
 * across cycles, red never — lives in `work-driver-verify-base-health.ts`.
 *
 * The READ rules (`baseHealthKey`, `matchingVerdict`) live here rather than
 * beside the probe because BOTH seams need them: the probe consults them
 * before it pays for a suite run, and the develop gate's post-failure
 * comparison consults them before it reuses a verdict the cycle already holds.
 * Two modules that read one record and import each other to do it is how one
 * of them stops loading; a shared schema leaf is the shape that keeps the
 * dependency running one way (probe → baseline → schema).
 */

/** The suite tier's bound in ms, as the probe key records it. */
export type TierBoundMs = number;

/**
 * The probe's verdict, as it lands on `pipelineState.baseHealthProbe` and, when
 * it is green, in the repo-level cache file. Optional on both: absent means
 * this cycle never probed, which the gate treats as "no opinion", never as
 * "the base is fine".
 *
 * No timestamp: a green is trusted for as long as its key matches, and the
 * reasoning for that (an immutable commit; the develop gate still judges the
 * change) is in `work-driver-verify-base-health.ts`.
 */
export interface BaseHealthVerdict {
  status: "green" | "red" | "unknown";
  baseSha: string;
  command: string;
  tierBoundMs: TierBoundMs;
  /** Why a probe established nothing (worktree add failed, missing deps). */
  reason?: string;
  /**
   * #1765 lens round 1 — the RED was earned by a run the gate KILLED at its
   * bound, the `red-timed-out` arm. It says nothing about which test broke; it
   * says the gate cannot finish inside the bound on this host. The branch
   * probe's own park never reads it (it holds the arm it just earned), but the
   * develop gate's reuse does: re-deriving a plain `red` from a record whose
   * probe timed out would hand back a colour whose evidence the record never
   * held, and the message would tell an operator to go fix a test.
   */
  timedOut?: true;
  /**
   * #1826 — the SECOND base run, recorded only for a RED whose confirmation was
   * paid for. Its presence is not decoration: the whole-command probe may call
   * the base red only after two runs of the same command on two fresh checkouts
   * agree, and this is the one field that says which colour that second run
   * reached (`green`, `red-timed-out`, …). A confirmed red carries `"red"`; a
   * red whose confirmation came back green carries `"green"`, which is the
   * record of a FLAKY base rather than a verdict on the change.
   *
   * Absent means the record states nothing about a second run, and #1826 reads
   * that as "not confirmed": a red written by an older build (or by a probe that
   * never ran the confirmation) is not reused as a confirmed red.
   */
  secondRun?: "green" | "red" | "red-timed-out" | "unknown";
}

/** What identifies one probe run: the three things a verdict speaks for. */
export type BaseHealthKey = { baseSha: string; command: string; tierBoundMs: TierBoundMs };

/**
 * The probe's identity: the three things that must all match before a verdict
 * recorded earlier may be trusted. A moved base, a different command or a
 * different bound each judge a different run, so each forces a re-probe.
 */
export function baseHealthKey(v: BaseHealthKey): string {
  return `${v.baseSha}\u0000${v.command}\u0000${v.tierBoundMs}`;
}

/**
 * A verdict whose shape we can reason about. Anything else is re-probe, never
 * green. An `at` field on an older cache file is IGNORED, not required: the
 * record no longer carries one (see the module header's trust rule), and a
 * cache written by an earlier build must stay readable rather than force a
 * suite re-run for a field nothing reads.
 */
function usableVerdict(raw: unknown): BaseHealthVerdict | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.status !== "green" && v.status !== "red" && v.status !== "unknown") return undefined;
  if (typeof v.baseSha !== "string" || v.baseSha === "") return undefined;
  if (typeof v.command !== "string" || v.command === "") return undefined;
  if (typeof v.tierBoundMs !== "number" || !Number.isFinite(v.tierBoundMs) || v.tierBoundMs <= 0)
    return undefined;
  const verdict: BaseHealthVerdict = {
    status: v.status,
    baseSha: v.baseSha,
    command: v.command,
    tierBoundMs: v.tierBoundMs,
  };
  if (typeof v.reason === "string") verdict.reason = v.reason;
  // #1765 lens round 3 — read with the same care as every other field, and
  // STRICTER: `true` is the only value the field admits, so one that is PRESENT
  // but not exactly `true` (`"true"`, `1`, `""`, `null` in an object that meant
  // to say "timed out") makes the whole record unusable rather than being
  // coerced or quietly dropped. A record this build cannot read means RE-PROBE:
  // the alternative is to trust a colour whose arm — plain red versus killed at
  // the bound — the record no longer states, and that arm is what tells the
  // develop gate whether to name a test or a bound to the operator.
  if ("timedOut" in v && v.timedOut !== true) return undefined;
  if (v.timedOut === true) verdict.timedOut = true;
  // #1826 — the same rule as `timedOut`, and for the same reason: the field
  // admits exactly these four values, so one that is PRESENT but unreadable
  // (`"ok"`, `null`, `1`) makes the whole record unusable rather than being
  // coerced or quietly dropped. The alternative is to trust a colour whose
  // confirmation the record no longer states — and the confirmation is what
  // tells the develop gate whether it may call the base red at all. An ABSENT
  // field stays readable: it means "this record never ran a second run", which
  // is a fact the reader acts on, not a malformed value.
  if ("secondRun" in v) {
    const second = v.secondRun;
    if (
      second !== "green" &&
      second !== "red" &&
      second !== "red-timed-out" &&
      second !== "unknown"
    )
      return undefined;
    verdict.secondRun = second;
  }
  return verdict;
}

/**
 * The one read rule for a stored verdict (in-state or in the cache file): a
 * record that still describes the run we would perform. `undefined` means
 * "re-probe", including for a record this build cannot read.
 */
export function matchingVerdict(raw: unknown, key: BaseHealthKey): BaseHealthVerdict | undefined {
  const v = usableVerdict(raw);
  return v !== undefined && baseHealthKey(v) === baseHealthKey(key) ? v : undefined;
}
