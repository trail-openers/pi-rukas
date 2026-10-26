/**
 * work-driver-merge-evidence — the executed CI verdict for a PR, and the head
 * that verdict was read at (#1533).
 *
 * Split out of `work-driver-merge-authority.ts` along the seam the two
 * questions already had: *may* this cycle merge (authority: doctrine, a judged
 * citation, an operator grant) and *is it safe* (evidence: what `gh` reports).
 * This half is the evidence — it reads `gh`, never a doctrine file, and its
 * only job is to answer with the truth or refuse loudly.
 *
 * Fails CLOSED, unlike most gates in this driver. Everywhere else an
 * unavailable signal means "proceed and let a later gate catch it"; here the
 * next step is irreversible, so an unreadable answer means do not merge.
 *
 * `skipped` and `neutral` are treated as NOT passing. GitHub's own docs say
 * *"Successful check statuses are `success`, `skipped`, and `neutral`"* and
 * warn to *"avoid requiring workflows that can be skipped"* — so a workflow
 * that gains a `paths-ignore:` silently becomes a required gate that always
 * reports green. That is a gate that cannot fail, which is the exact class of
 * defect this project has been removing.
 *
 * The `--json` fields requested here are pinned to gh 2.98.0 by
 * `smoke-tests/test-gh-argv.ts`; the per-check required/optional flag is not
 * among them (`isRequired` is not a field `gh pr checks` supports — #745),
 * so the per-check rows only supply the failing/pending/skipped names, while
 * the pass/not-pass verdict is `mergeStateStatus`: it already encodes the
 * repo's own branch-protection rules.
 */

import { mergeEvidenceViewCmd, prChecksCmd } from "./forge-commands.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { EvidenceFailureKind } from "./workflow-state-cap.ts";

/** Shell executor, matching `DriverContext.verifyExecFn`. */
type ExecFn = VerifyExecFn;

export type { EvidenceFailureKind } from "./workflow-state-cap.ts";

/**
 * #1533 — the full 40-char commit OID the CLI reports for the PR head, or
 * `undefined`. Deliberately NOT `isFullCommitSha` here: this function keeps the
 * raw value so the caller can name what it got when the shape is wrong (an
 * abbreviated OID, a branch name) instead of reporting a bare absence.
 */
function readOid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{7,40}$/.test(value) ? value : undefined;
}

export interface MergeEvidence {
  ok: boolean;
  /** Why not, when `ok` is false — operator-facing. */
  reason?: string;
  /** When the refusal is a tooling failure, says so distinctly from a CI verdict. */
  failureKind?: EvidenceFailureKind;
  mergeStateStatus?: string;
  failing: string[];
  /** Required checks reporting `skipped`/`neutral` — green to GitHub, not to us. */
  inconclusive: string[];
  /**
   * #1533 — the PR head the CI verdict was read at, from the SAME bounded read
   * that supplied `mergeStateStatus`. One read, one moment: the pin and the CI
   * answer describe the same state of the forge, so a head that moved between
   * the two cannot be papered over by two reads that disagree.
   *
   * `undefined` means the read did not answer, failed, or answered with
   * something that is not a commit OID — all three are refusals, never a
   * license to merge unpinned. The merged step decides; this type only reports.
   */
  headOid?: string;
  /** Why `headOid` is absent, in the operator's words (names the failed read). */
  headOidError?: string;
}

interface PrCheckRow {
  name?: string;
  state?: string;
  bucket?: string;
}

/** The head fields, spread onto every return so a refusal still reports what it saw. */
function headFields(headOid?: string, headOidError?: string) {
  return {
    ...(headOid ? { headOid } : {}),
    ...(headOidError ? { headOidError } : {}),
  };
}

/** Gather executed evidence that a PR is genuinely mergeable. */
export async function gatherMergeEvidence(
  execFn: ExecFn,
  repoRoot: string,
  prNumber: number,
): Promise<MergeEvidence> {
  let state: { mergeStateStatus?: string; state?: string };
  // #1533 — the head OID the CI verdict was read at, from this one read.
  let headOid: string | undefined;
  let headOidError: string | undefined;
  try {
    const { stdout } = await execFn(mergeEvidenceViewCmd(prNumber), {
      cwd: repoRoot,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(stdout) as {
      mergeStateStatus?: unknown;
      state?: unknown;
      headRefOid?: unknown;
    };
    state = {
      // `mergeStateStatus` is a string the CLI passes through; it lands
      // verbatim in operator-facing handoffs, so bound it on read — every
      // downstream renderer inherits the cap.
      mergeStateStatus:
        typeof parsed.mergeStateStatus === "string"
          ? parsed.mergeStateStatus.slice(0, 64)
          : undefined,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
    };
    const raw = typeof parsed.headRefOid === "string" ? parsed.headRefOid.trim() : undefined;
    if (raw === undefined || raw === "") {
      headOidError = `the PR-state read returned no head OID for PR #${prNumber}`;
    } else if (!isFullCommitSha(raw)) {
      // Named rather than blanked: an abbreviated or non-hex value is a
      // different fault from an absent one, and the operator has to be able to
      // tell "the forge said nothing" from "the forge said something odd".
      headOidError = `the PR-state read returned a head OID that is not a full 40-char SHA for PR #${prNumber} (got ${raw.slice(0, 48)})`;
    } else {
      headOid = raw;
    }
  } catch (err) {
    return {
      ok: false,
      failureKind: "tooling",
      reason: `could not read PR state: ${(err as Error).message?.slice(0, 160)}`,
      failing: [],
      inconclusive: [],
      headOidError: `the PR-state read for PR #${prNumber} failed: ${(err as Error).message?.slice(0, 120)}`,
    };
  }

  if (state.state && state.state !== "OPEN") {
    return {
      ok: false,
      reason: `PR is ${state.state}, not OPEN`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }

  // BLOCKED covers failing required checks, missing reviews and unresolved
  // conversations — GitHub has already applied the repo's own rules, which is
  // a stronger statement than anything the driver can compute itself.
  const blocking = ["BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"];
  if (state.mergeStateStatus && blocking.includes(state.mergeStateStatus)) {
    return {
      ok: false,
      reason: `mergeStateStatus is ${state.mergeStateStatus}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }

  let rows: PrCheckRow[] = [];
  let rowsRead = false;
  // Set when the invocation exited 0 but its stdout was not check data: an
  // exit-0 call cannot be a tooling failure, and the operator needs the raw
  // output to see what actually came back (a partial/HTML error page, a gh
  // version that changed its output shape).
  let malformedStdout = "";
  try {
    const { stdout } = await execFn(prChecksCmd("github", prNumber), {
      cwd: repoRoot,
      maxBuffer: 512 * 1024,
    });
    // Empty/whitespace-only stdout is NO DATA, not an empty check list: a
    // `rowsRead` here would let the gate say "no checks reported" (a CI
    // verdict) when the invocation answered with nothing at all.
    if (stdout.trim()) {
      const parsed: unknown = JSON.parse(stdout);
      if (Array.isArray(parsed)) {
        rows = parsed as PrCheckRow[];
        rowsRead = true;
      } else {
        malformedStdout = stdout;
      }
    }
  } catch (err) {
    // The catch conflates two shapes only when it hides which one happened:
    // a non-zero exit (tooling — the invocation failed before answering) and
    // a successful invocation whose stdout did not parse (a data regression
    // the operator needs to see, not "fix your tooling").
    if (err instanceof SyntaxError && !malformedStdout)
      malformedStdout = "(output was not valid JSON)";
    rows = [];
  }

  const norm = (r: PrCheckRow) => (r.bucket ?? r.state ?? "").toLowerCase();
  const failing = rows
    .filter((r) => ["fail", "failure", "cancelled", "timed_out", "error"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const pending = rows
    .filter((r) => ["pending", "queued", "in_progress", "waiting"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");
  const inconclusive = rows
    .filter((r) => ["skipping", "skipped", "neutral"].includes(norm(r)))
    .map((r) => r.name ?? "(unnamed)");

  if (failing.length > 0) {
    return {
      ok: false,
      reason: `required checks failing: ${failing.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing,
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  if (pending.length > 0) {
    return {
      ok: false,
      reason: `required checks still running: ${pending.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  if (inconclusive.length > 0) {
    return {
      ok: false,
      reason: `required checks reported skipped/neutral, which GitHub counts as success but this driver does not: ${inconclusive.join(", ")}`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  // `mergeStateStatus` is the authoritative verdict — it already encodes the
  // repo's own required-check rules — while the rows above only name what is
  // wrong. A CLEAN PR with an unreadable checks list fails closed: the gate
  // has no evidence of a green check list, and this step is irreversible.
  if (state.mergeStateStatus !== "CLEAN") {
    return {
      ok: false,
      reason: `mergeStateStatus is ${state.mergeStateStatus ?? "unreadable"}, not CLEAN`,
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive,
      ...headFields(headOid, headOidError),
    };
  }
  if (!rowsRead) {
    if (malformedStdout) {
      // An exit-0 invocation whose output was not usable check data. The
      // raw output is shown when we captured it (JSON parsed but was not an
      // array); a parse failure gets the placeholder so the operator can
      // still tell "the CLI answered but the shape is wrong" from "the CLI
      // never answered".
      return {
        ok: false,
        reason: `the gh pr checks invocation returned data the gate could not read as a check list${
          malformedStdout.startsWith("(") ? "" : ` — got: ${malformedStdout.slice(0, 160)}`
        }. Fix the gh setup or the checks configuration, then re-run.`,
        mergeStateStatus: state.mergeStateStatus,
        failing: [],
        inconclusive: [],
        ...headFields(headOid, headOidError),
      };
    }
    return {
      ok: false,
      failureKind: "tooling",
      reason:
        "the gh pr checks invocation failed before returning check data — this is a tooling failure, not a CI verdict (no check data was read). Fix the gh setup, then re-run.",
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      reason: "no checks reported — refusing to merge on the absence of evidence",
      mergeStateStatus: state.mergeStateStatus,
      failing: [],
      inconclusive: [],
      ...headFields(headOid, headOidError),
    };
  }
  return {
    ok: true,
    mergeStateStatus: state.mergeStateStatus,
    failing: [],
    inconclusive: [],
    // #1533 — the verified head rides out with the verdict it describes.
    ...headFields(headOid, headOidError),
  };
}

/**
 * Does the executed evidence contradict a subagent's "CI is green" claim?
 *
 * Returns the contradiction, or `undefined` when the evidence agrees (including
 * when the gate passed). Used by the ci step so narration cannot promote a
 * status: only executed evidence can demote one.
 */
export function contradictsSuccess(evidence: MergeEvidence): string | undefined {
  if (evidence.ok) return undefined;
  if (evidence.failing.length > 0) return `required checks failing: ${evidence.failing.join(", ")}`;
  if (evidence.inconclusive.length > 0) {
    return `required checks skipped/neutral: ${evidence.inconclusive.join(", ")}`;
  }
  if (evidence.reason?.startsWith("required checks still running")) return evidence.reason;
  if (evidence.reason?.startsWith("mergeStateStatus is")) return evidence.reason;
  return undefined;
}
