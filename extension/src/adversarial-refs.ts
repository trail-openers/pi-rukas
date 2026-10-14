/**
 * adversarial-refs — where the loop's diff comes from, and the ref pin (#1161,
 * round 2). Split out of adversarial.ts (500-line cap).
 *
 * A branch name is a mutable ref, so the loop never reviews "whatever the
 * name points at" and then records a row against a name. Both sides are
 * pinned to commit SHAs at the moment their diff is read:
 *   - the BASE is resolved once, at loop entry, before the first reviewer
 *     dispatch — the mainline the range is judged against does not move
 *     during a review;
 *   - the HEAD is resolved at the start of each round whose diff is read.
 *     Round 1 reads it at entry; rounds 2+ read it again, because a fix
 *     round commits onto the branch and the next review must see those
 *     commits (#859). Each read pins the SHA it used, so the ledger row binds
 *     the exact commit the approving round reviewed, never a later one.
 */

import type { ReviewProvenance } from "./adversarial-ledger.ts";
import { execp } from "./lens-exec.ts";
import { type RangeDiff, computeRangeDiff } from "./review-diff.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

export type PinnedRange = { ok: true; base: string; head: string } | { ok: false; reason: string };

/**
 * Resolve `base` and `head` to full 40-char commit SHAs via
 * `git rev-parse --verify <ref>^{commit}` (argv form; resolveHeadSha). A
 * leading `-` is refused. Any miss returns a named reason — the caller turns
 * it into an infrastructure failure, never a passing result.
 */
export async function pinRangeRefs(
  cwd: string,
  base: string,
  head: string,
  execFn: VerifyExecFn = execp,
): Promise<PinnedRange> {
  for (const ref of [base, head]) {
    if (ref.startsWith("-")) {
      trace("adversarial: refused range ref starting with '-'");
      return { ok: false, reason: `range ref "${ref}" starts with '-' and was refused` };
    }
  }
  const baseSha = await resolveHeadSha(cwd, base, execFn);
  if (!baseSha) return { ok: false, reason: `base ref "${base}" does not resolve to a commit` };
  const headSha = await resolveHeadSha(cwd, head, execFn);
  if (!headSha) return { ok: false, reason: `head ref "${head}" does not resolve to a commit` };
  return { ok: true, base: baseSha, head: headSha };
}

export type DiffSource =
  | {
      ok: true;
      diff: string;
      /** Range reviews only: re-reads the range before each later round. */
      getDiff?: () => Promise<string>;
    }
  | { ok: false; loopOutcome: "rejected" | "infra-failure"; text: string };

/**
 * #1161 — the loop's diff source, derived here rather than passed in. A
 * pasted `diff` string wins and is `pasted` provenance (traced when base+head
 * are also given). Otherwise the range is read and `pin.provenance` is set to
 * the SHAs of the diff just read. Provenance is what the ledger writer records,
 * so no caller can label a review as something it was not, and `pin` always
 * describes the diff the loop is holding.
 *
 * An empty-string `diff` is falsy and therefore a range review, consistent
 * with the loop's truthy check.
 */
export async function resolveDiffSource(
  params: { diff?: string; base?: string; head?: string; workCwd?: string },
  pin: { provenance: ReviewProvenance },
  rangeDiffFn: (cwd: string, base: string, head: string) => Promise<RangeDiff> = computeRangeDiff,
): Promise<DiffSource> {
  const range = params.base && params.head ? { base: params.base, head: params.head } : null;
  // #859 — resolve the diff: a pasted string wins over a ref range (traced);
  // with no string, base+head compute the range in workCwd (else the process
  // cwd). An error (invalid ref naming the ref, confirmed-empty range, cap
  // overflow) is returned AS the result — never a fallback to an empty
  // string, which the loop would review as "nothing to change" and approve.
  if (params.diff) {
    if (range) {
      trace(
        `adversarial: diff string supplied alongside base=${range.base} head=${range.head} — the diff string wins`,
      );
    }
    pin.provenance = { kind: "pasted" };
    return { ok: true, diff: params.diff };
  }
  if (!range) {
    return {
      ok: false,
      loopOutcome: "rejected",
      text: "Adversarial loop: provide `diff`, or both `base` and `head` (with `workCwd`) — nothing to review was supplied.",
    };
  }
  const cwd = params.workCwd ?? process.cwd();
  // #1161 — both refs are pinned before the first reviewer dispatch.
  const pinned = await pinRangeRefs(cwd, range.base, range.head);
  if (!pinned.ok) {
    return {
      ok: false,
      loopOutcome: "infra-failure",
      text: `Adversarial loop infrastructure failure: ${pinned.reason}. No verdict was produced — this is NOT a review rejection.`,
    };
  }
  // Round 1 uses the diff computed once here at tool entry.
  const initial = await rangeDiffFn(cwd, pinned.base, pinned.head);
  if (!initial.ok) {
    return {
      ok: false,
      loopOutcome: "rejected",
      text: `Adversarial loop could not compute the diff for ${range.base}...${range.head}: ${initial.reason}`,
    };
  }
  pin.provenance = { kind: "range", base: pinned.base, head: pinned.head };
  // Rounds 2+ re-compute the SAME range, so a fix round's changes are
  // reviewed (same rule as the driver's per-round getDiff re-read). The head
  // ref is resolved again — a fix round commits onto the branch — and the
  // SHA this read used is what the pin records.
  const getDiff = async (): Promise<string> => {
    const head = await resolveHeadSha(cwd, range.head, execp);
    if (!head) throw new Error(`head ref "${range.head}" no longer resolves to a commit`);
    const r = await rangeDiffFn(cwd, pinned.base, head);
    if (!r.ok) {
      // The reason names the pinned SHAs; restate it in the operator's refs.
      const reason = r.reason.replaceAll(
        `${pinned.base}...${head}`,
        `${range.base}...${range.head}`,
      );
      // #859 — a re-read failure is no longer a silent "" (which the loop
      // would ignore and review the STALE diff on). Name it in the trace;
      // the caller surfaces it in the final result.
      trace(
        `adversarial: diff re-read failed for range ${range.base}...${range.head}: ${reason} — reviewing the previous diff`,
      );
      throw new Error(reason);
    }
    pin.provenance = { kind: "range", base: pinned.base, head };
    return r.diff;
  };
  return { ok: true, diff: initial.diff, getDiff };
}
