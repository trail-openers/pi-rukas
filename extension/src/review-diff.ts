/**
 * review-diff — tool-side git ref-range diff computation (#859).
 *
 * `adversarial_loop` and `dispatch_lens_review` accept `base`/`head` ref
 * names and compute the diff themselves instead of receiving a pasted
 * string. This module is the one seam that reads such a range:
 * `git diff <base>...<head>` (three-dot, merge-base semantics) run via
 * execFile — no shell, so a PM-typed ref can never inject commands.
 *
 * Refs are validated first with `git rev-parse --verify --quiet
 * <ref>^{commit}`; an invalid ref produces an error that NAMES the ref
 * rather than an empty-string fallback (the bug class #384 closed for the
 * driver's integrated-diff read). Emptiness is established POSITIVELY,
 * the same way as #384's `readIntegratedDiff`: an empty range is a
 * distinct "empty diff" error, never a value a caller can mistake for
 * "nothing to review" (and never an APPROVED verdict).
 *
 * The cap on these reads is {@link REVIEW_DIFF_READ_MAX_BYTES}, ONE ceiling
 * shared by every size-sensitive git read on the base+head path — the range, the
 * delta, the changed-line ranges and the patch identity — so a diff that clears
 * one read clears them all and a review cannot pass its own precondition and then
 * die inside the layer that reads the same range. {@link DIFF_MAX_BUFFER} is the
 * pre-#2261 value that one operator switch restores, and {@link diffReadMaxBytes}
 * is the only function that decides which of the two a read gets.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execp } from "./exec.ts";
import { lensLargeDiffEnabled } from "./lens-large-diff-switch.ts";
import { resolveHeadSha } from "./review-head-sha.ts";

const execFileP = promisify(execFile);

/** The 1 MiB cap this module shipped with, and the value the switch's `"0"` arm
 * restores. Named separately from the ceiling it is beside, because the reason
 * string for the off arm must name the limit that actually stopped the read. */
export const DIFF_MAX_BUFFER = 1024 * 1024;

/**
 * The ONE ceiling every size-sensitive git read on the base+head path shares
 * (#2261): `computeRangeDiff`, `computeDeltaDiff`, `changedRanges`,
 * `patchIdOfRange` and `diffDigestOfRange`.
 *
 * 16 MiB is not an arbitrary multiple. Lean's own precondition read of the SAME
 * range (`lean/review-git.ts`, through `GIT_MAX_BUFFER`) runs at 16 MiB, and the
 * layer beneath it read at 1 MiB — so a diff between the two passed lean's check
 * that the branch could be reviewed and then failed inside the review, with the
 * cause lost. Matching the precondition's ceiling removes the band rather than
 * adding a message to it; the two reads are deliberately left as two reads (one
 * per layer, each owned by its caller) with one agreed size.
 *
 * What a diff this large costs the child is a separate question with a separate
 * answer: the lens prompt inlines only what fits its own bound
 * (`lens-diff-bound.ts`), so admitting a 16 MiB read does not mean putting 16 MiB
 * in front of six models.
 */
export const REVIEW_DIFF_READ_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The `maxBuffer` a size-sensitive review git read must pass, read at CALL time
 * so a test (or a running cycle) that flips `PI_ENSEMBLE_LENS_LARGE_DIFF` gets
 * the ceiling it asks for rather than the one that was in force when this module
 * was first imported.
 */
export function diffReadMaxBytes(): number {
  return lensLargeDiffEnabled() ? REVIEW_DIFF_READ_MAX_BYTES : DIFF_MAX_BUFFER;
}

/** The ceiling's name as it appears in a reason: the constant, not just a byte
 * count, so an operator reading the reason can find the knob. */
function limitLabel(effective: number): string {
  return effective === DIFF_MAX_BUFFER
    ? `DIFF_MAX_BUFFER (${String(DIFF_MAX_BUFFER)} bytes)`
    : `REVIEW_DIFF_READ_MAX_BYTES (${String(REVIEW_DIFF_READ_MAX_BYTES)} bytes)`;
}

export type RangeDiff = { ok: true; diff: string } | { ok: false; reason: string };

/**
 * Per-file changed line ranges of a diff, in head-file line numbers: what
 * `changedLineRanges` returns. Named so the findings memory (and its fate rule)
 * can state the type without restating the tuple (#1125 decision 5).
 */
export type ChangedRanges = Map<string, Array<[number, number]>>;

/**
 * True when a diff was produced beyond the cap (the tail was cut).
 *
 * Classified from the ERROR OBJECT, not only stderr: `execFile`'s maxBuffer
 * overflow surfaces as `code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` with an EMPTY
 * `stderr` and the words in `message`. A stderr-only match therefore missed the
 * common runtime and let the overflow fall through to the generic
 * "`git diff … failed:`" arm — which is how a 1 MiB+ range came to report
 * nothing but a size it never named. `e2big` is the OTHER shape: a spawn that
 * died on the OS argument limit (`Linux MAX_ARG_STRLEN`) before git ran.
 */
export function diffOverflow(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string; stderr?: string } | null;
  if (!e) return false;
  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.code === "E2BIG") return true;
  if (typeof e.code === "number" && Math.abs(e.code) === 7) return true;
  const haystack = `${e.message ?? ""}\n${e.stderr ?? ""}`;
  return /E2BIG|exceeded maxBuffer|maxBuffer length exceeded|argument list too long/i.test(
    haystack,
  );
}

function refError(ref: string, err: unknown): { ok: false; reason: string } {
  const msg = (err as Error)?.message ?? String(err);
  return { ok: false, reason: `git rev-parse failed for ref "${ref}": ${msg.slice(0, 200)}` };
}

/**
 * Resolve a ref name to a commit. Returns false when the shared resolver
 * (review-head-sha.ts) cannot resolve it to a commit — i.e. the ref is not
 * a revision (or a revision of something other than a commit), whatever the
 * reason. A refname starting with `-` is rejected up front by the resolver:
 * the value is never shell-interpolated (execFile), but a leading dash would
 * be parsed by git as an option (argument injection), and such a name is
 * never a legitimate ref here.
 */
async function refIsCommit(cwd: string, ref: string): Promise<boolean> {
  return (await resolveHeadSha(cwd, ref, execp)) !== undefined;
}

/**
 * Compute `git diff <base>...<head>` in the given directory.
 *
 * Three-dot (merge-base) semantics — deliberately NOT the driver's
 * two-dot `origin/<base>..origin/<branch>`; the two differ when the
 * branch has diverged from base, and the tool's contract is the plain
 * `git diff base...head` the operator would run.
 *
 * - invalid base or head → `{ok:false}` naming the offending ref;
 * - a ref starting with `-` → `{ok:false}` (argument injection);
 * - a confirmed-empty range → `{ok:false}` "empty diff" (never a value
 *   a caller can mistake for "nothing to review");
 * - a diff beyond the 1 MiB cap → `{ok:false}` (never a silent "" or a
 *   silently truncated string).
 */
export async function computeRangeDiff(
  cwd: string,
  base: string,
  head: string,
): Promise<RangeDiff> {
  for (const ref of [base, head]) {
    if (ref.startsWith("-")) {
      return { ok: false, reason: `ref "${ref}" is rejected: ref names must not start with '-'` };
    }
    if (!(await refIsCommit(cwd, ref))) {
      return refError(ref, new Error("not a valid commit ref (rev-parse --verify failed)"));
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileP("git", ["-C", cwd, "diff", `${base}...${head}`], {
      maxBuffer: diffReadMaxBytes(),
    }));
  } catch (err) {
    if (diffOverflow(err)) {
      return { ok: false, reason: overflowReason(`git diff ${base}...${head}`, err) };
    }
    return {
      ok: false,
      reason: `git diff ${base}...${head} failed: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`,
    };
  }
  if (!stdout.trim()) {
    return {
      ok: false,
      reason: `empty diff for range ${base}...${head} (nothing to review — this is never an approval)`,
    };
  }
  return { ok: true, diff: stdout };
}

/**
 * #973 — a delta diff: `git diff <since>..<head>` (TWO-dot, exactly what
 * changed since `since`), with the same ref validation, cap and injection
 * guard as `computeRangeDiff`.
 *
 * Emptiness means something different here than in `computeRangeDiff`, and
 * the distinction is load-bearing: an empty FULL diff is still an error
 * (#384 — a value nobody may mistake for "nothing to review", i.e. an
 * approval), but an empty DELTA range is the normal outcome of a follow-up
 * review on an unchanged branch — the churn the delta path exists to stop.
 * It returns `{ ok: true, empty: true }`, and the caller turns that into
 * the no-review outcome (no re-review, no ledger entry) rather than
 * faking findings or failing the cycle.
 *
 * The two-dot form is deliberate and different from `computeRangeDiff`'s
 * three-dot: a delta is "what changed since this commit", which is exactly
 * `git diff since..head`, not a merge-base diff.
 */
export type DeltaDiff =
  | { ok: true; diff: string; empty: false }
  | { ok: true; diff: ""; empty: true }
  | { ok: false; reason: string };

export async function computeDeltaDiff(
  cwd: string,
  since: string,
  head: string,
): Promise<DeltaDiff> {
  for (const ref of [since, head]) {
    if (ref.startsWith("-")) {
      return {
        ok: false,
        reason: `ref "${ref}" is rejected: ref names must not start with '-'`,
      };
    }
    if (!(await refIsCommit(cwd, ref))) {
      return refError(ref, new Error("not a valid commit ref (rev-parse --verify failed)"));
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileP("git", ["-C", cwd, "diff", `${since}..${head}`], {
      maxBuffer: diffReadMaxBytes(),
    }));
  } catch (err) {
    if (diffOverflow(err)) {
      return { ok: false, reason: overflowReason(`git diff ${since}..${head}`, err) };
    }
    return {
      ok: false,
      reason: `git diff ${since}..${head} failed: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`,
    };
  }
  if (!stdout.trim()) return { ok: true, diff: "", empty: true };
  return { ok: true, diff: stdout, empty: false };
}

/**
 * The reason a size-bounded read refused: the limit's CONSTANT, its VALUE, and
 * how much the read actually produced.
 *
 * "exceeded the cap" is what the field reported, and it was not actionable — the
 * operator could not tell a 1 MiB guard from a 16 MiB one, nor whether git had
 * produced 2 MB or 200 MB. The measured size comes from the error's own partial
 * buffer when the runtime kept one and from the limit as a floor otherwise, so
 * the reason never claims a number nobody measured.
 */
export function overflowReason(command: string, err: unknown): string {
  const e = err as { stdout?: string | Buffer; stderr?: string | Buffer } | null;
  const produced = (e?.stdout?.length ?? 0) + (e?.stderr?.length ?? 0);
  const effective = diffReadMaxBytes();
  const measured =
    produced > 0
      ? `${command} produced at least ${String(produced)} bytes`
      : `${command} produced more than ${String(effective)} bytes`;
  return `${command} exceeded the limit ${limitLabel(effective)} — ${measured}`;
}

/**
 * #1105 — the new-side line ranges a unified diff touches, per repo-relative
 * path. A hunk that only deletes lines maps to the single line where the
 * deletion lands, so a finding citing that spot counts as touched. A deleted
 * file (`+++ /dev/null`) contributes no ranges.
 */
export function changedLineRanges(diff: string): ChangedRanges {
  const out = new Map<string, Array<[number, number]>>();
  const lines = diff.split("\n");
  let file: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("+++ ") && (lines[i - 1] ?? "").startsWith("--- ")) {
      const name = line.slice(4).replace(/\t.*$/, "");
      file = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const end = count === 0 ? start : start + count - 1;
      const spans = out.get(file) ?? [];
      spans.push([start, end]);
      out.set(file, spans);
    }
  }
  return out;
}
