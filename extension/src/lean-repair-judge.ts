import type { BuildExec } from "./lean/build-types.ts";
import { runTestFile, sha256 } from "./lean/specify-proof.ts";
/**
 * lean-repair-judge — the mechanical gate a repaired frozen test must pass before it may replace the
 * contract, plus the throwaway base checkout it is judged in.
 *
 * A builder that dislikes an assertion has one legitimate claim: the assertion is wrong. It has a much more
 * attractive illegitimate one: delete the assertion, and the run goes green. The repair round therefore
 * cannot accept a child's replacement, only the driver judges it, and the judgement is three facts, none of
 * which asks a model anything:
 *
 *   1. **named only** — every file it replaces is a file the blocked report named. A replacement for a file
 *      nobody complained about is the round rewriting the contract it was not asked to touch;
 *   2. **red at the run's base** — at least one test case of the replacement comes back RED under the
 *      project's own `verify.test` in a throwaway checkout of `run.baseSha`. A replacement green at base for
 *      every case is not a corrected oracle, it is an oracle that proves nothing;
 *   3. **not a copy** — the replacement's failing case is not a case the original already had. Re-submitting
 *      the frozen file unchanged proves only that the child read it.
 *
 * The at-base run is the same runner the freeze-time proof and `verify` use, in a tree the driver created at
 * the base commit, so the red is observed rather than reported. A runner that could not start, was killed, or
 * printed nothing naming the file observed NOTHING and refuses the round; the only colour that accepts is a
 * red.
 *
 * Lives outside `src/lean/` for the line budget and for the same reason as `lean-step-bound.ts`: it is a
 * judgement over a checkout, not engine state, and it never imports the machine.
 */
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";

/** How long one base run gets before it counts as having observed nothing. */
const BASE_RUN_TIMEOUT_MS = 120_000;

/** The verdict on one replacement file, and the facts a reader needs to audit it. */
export type ReplacementVerdict =
  | {
      accepted: true;
      /** The replacement's bytes — what the run freezes in place of the original. */
      bytes: Buffer;
      /** Content hash of the ORIGINAL frozen file this replaced. */
      originalHash: string;
      /** Whether the replacement passes at the build head (the caller runs it there; `undefined` = not run). */
      passedAtHead?: boolean;
      /** The case the driver watched fail at the base, quoted from the runner. */
      redCase: string;
    }
  | { accepted: false; why: string };

/** One replacement the caller submitted, with what the record already held for its path. */
export interface ReplacementInput {
  path: string;
  /** The bytes the child wrote, already read by the caller. */
  bytes: Buffer;
  /** The hash the run holds for this path today; `undefined` when the run never froze it. */
  frozenHash: string | undefined;
}

/** Why a whole submission is refused before any file is run, or `undefined` when it may be judged. */
export function submissionProblem(
  submitted: string[],
  named: readonly string[],
): string | undefined {
  if (submitted.length === 0) return "the repair submitted no file";
  const allowed = new Set(named);
  const extra = submitted.filter((p) => !allowed.has(p));
  if (extra.length > 0)
    return `the repair replaced ${String(extra.length)} file(s) the blocked report never named: ${extra
      .slice(0, 4)
      .join(", ")}`;
  return undefined;
}

/** The path of one replacement. */
function relOf(r: { path: string }): string {
  return r.path;
}

/**
 * Judge every replacement of one round. All must be accepted or the round is refused as a whole: a partial
 * repair would freeze half a corrected contract and leave the builder against an oracle nobody judged.
 *
 * `named` is the blocked report's own file list — the only set the round may touch.
 */
export async function judgeRepairSubmission(opts: {
  exec: BuildExec;
  /** A real checkout of `baseSha` the caller created and will remove. */
  baseTree: string;
  baseSha: string;
  template: string;
  named: readonly string[];
  replacements: ReplacementInput[];
  /** Shortened by a test to watch a hung base run refuse rather than hang. */
  timeoutMs?: number;
}): Promise<{ accepted: true; verdicts: ReplacementVerdict[] } | { accepted: false; why: string }> {
  const { replacements, named } = opts;
  const problem = submissionProblem(replacements.map(relOf), named);
  if (problem !== undefined) return { accepted: false, why: problem };
  const verdicts: ReplacementVerdict[] = [];
  for (const r of replacements) {
    const v = await judgeOne(opts, r);
    if (!v.accepted) return { accepted: false, why: `${r.path}: ${v.why}` };
    verdicts.push(v);
  }
  return { accepted: true, verdicts };
}

/** One file: hash the original it replaces, then require one base-red case it did not already have. */
async function judgeOne(
  opts: {
    exec: BuildExec;
    baseTree: string;
    baseSha: string;
    template: string;
    timeoutMs?: number;
  },
  r: ReplacementInput,
): Promise<ReplacementVerdict> {
  if (r.frozenHash === undefined)
    return { accepted: false, why: "the run holds no frozen record for this path" };
  if (r.bytes.length === 0) return { accepted: false, why: "the replacement is empty" };
  if (sha256(r.bytes) === r.frozenHash)
    return { accepted: false, why: "the replacement is byte-identical to the frozen file" };
  const proof = await runTestFile(opts.exec, {
    wt: opts.baseTree,
    template: opts.template,
    file: r.path,
    limits: {
      timeoutMs: opts.timeoutMs ?? BASE_RUN_TIMEOUT_MS,
      env: verifyChildEnv(),
    },
  });
  if (proof.kind === "green")
    return {
      accepted: false,
      why: "every case of the replacement passes at the base, so it tests nothing the run must build",
    };
  if (proof.kind !== "red")
    return {
      accepted: false,
      why: `the base run observed nothing (${proof.detail})`,
    };
  // The red must be the replacement's own: a case the original already printed is the frozen file re-summitted,
  // which the identical-bytes check above cannot catch when the child ADDED a passing case.
  if (caseIsNew(r.bytes, proof.output))
    return {
      accepted: true,
      bytes: r.bytes,
      originalHash: r.frozenHash,
      redCase: (proof.output ?? "").trim(),
    };
  return { accepted: false, why: "the base run's red named no case" };
}

/**
 * Did the runner's red name a case the ORIGINAL never printed?
 *
 * The identical-bytes check cannot catch a child that kept the original's failing assertion and appended a
 * passing one: those bytes differ, and the red is still the frozen file's own. The original's text is the only
 * comparison that separates a corrected oracle from a resubmitted one, so it is made line by line.
 */
export function caseIsNew(original: Buffer, output: string | undefined): boolean {
  if (output === undefined) return false;
  const before = new Set(linesOf(original.toString("utf8")));
  return linesOf(output).some((l) => !before.has(l));
}

/** A runner output's comparable lines: trimmed, non-empty. */
function linesOf(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
