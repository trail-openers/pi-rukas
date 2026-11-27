/**
 * oracle-repair-judge — the mechanical gate a repaired frozen test must pass before it may replace the
 * contract.
 *
 * A builder that dislikes an assertion has one legitimate claim: the assertion is wrong. It has a much more
 * attractive illegitimate one: delete the assertion and the run goes green. The repair round therefore never
 * accepts a child's word about its own replacement — the driver judges it, and the judgement is three facts,
 * none of which asks a model anything:
 *
 *   1. **named only** — every file replaced is a file the blocked report named. A replacement for a file
 *      nobody complained about is the round rewriting a contract it was not asked to touch;
 *   2. **red at the run's base** — at least one test case of the replacement comes back RED under the
 *      project's own `verify.test` in a real checkout of `run.baseSha`. A replacement green at base for every
 *      case is not a corrected oracle, it is an oracle that proves nothing;
 *   3. **its own red** — the failing case is a line the original never printed. Re-submitting the frozen file
 *      unchanged, or with a passing case appended, proves only that the child read it.
 *
 * The at-base run is the same runner the freeze-time proof and `verify` use, so the red is observed rather
 * than reported. A runner that could not start, was killed, or printed nothing naming the file observed
 * NOTHING and refuses the round: the only colour that accepts is a red.
 *
 * Lives outside `src/lean/` for the line budget and for the same reason as `lean-step-bound.ts` — it is a
 * judgement over a checkout, not engine state, and it never imports the machine.
 */
import { runTestFile, sha256 } from "./lean/specify-proof.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import type { BuildExec } from "./lean/build-types.ts";

/** The case the driver watched fail at the base, and the facts a reader needs to audit the acceptance. */
export interface AcceptedReplacement {
  path: string;
  /** The replacement's bytes — what the run freezes in place of the original. */
  bytes: Buffer;
  /** Content hash of the ORIGINAL frozen file this replaced. */
  originalHash: string;
  /** The runner's own words on the failing case, quoted into the brief and the disclosure. */
  redCase: string;
}

/** One replacement the caller submitted, with what the record already held for its path. */
export interface ReplacementInput {
  path: string;
  /** The bytes the child wrote, already read by the caller. */
  bytes: Buffer;
  /** The hash the run holds for this path today; `undefined` when the run never froze it. */
  frozenHash: string | undefined;
}

/** Why the whole submission is refused, or `undefined` when every file was accepted. */
export type Judgement = { accepted: true; verdicts: AcceptedReplacement[] } | { accepted: false; why: string };

/** The round's whole-submission refusal: a file outside the named set condemns the round. */
export function submissionScopeProblem(
  submitted: readonly string[],
  named: readonly string[],
): string | undefined {
  if (submitted.length === 0) return "the repair submitted no test file";
  const allowed = new Set(named);
  const extra = submitted.filter((p) => !allowed.has(p));
  if (extra.length > 0)
    return `the repair replaced ${String(extra.length)} file(s) the blocked report never named: ${extra
      .slice(0, 4)
      .join(", ")}`;
  return undefined;
}

/**
 * Judge every replacement of one round. All must be accepted or the round is refused whole: a partial repair
 * would freeze half a corrected contract and leave the builder against an oracle nobody judged.
 */
export async function judgeRepairSubmission(opts: {
  exec: BuildExec;
  /** A real checkout of the run's `baseSha` the caller created and will remove. */
  baseTree: string;
  template: string;
  named: readonly string[];
  replacements: ReplacementInput[];
  /** Shortened by a test to watch a hung base run refuse rather than hang. */
  timeoutMs?: number;
}): Promise<Judgement> {
  const problem = submissionScopeProblem(
    opts.replacements.map((r) => r.path),
    opts.named,
  );
  if (problem !== undefined) return { accepted: false, why: problem };
  const verdicts: AcceptedReplacement[] = [];
  for (const r of opts.replacements) {
    const v = await judgeOne(opts, r);
    if (v === undefined) return { accepted: false, why: `${r.path}: ${lastRefusal}` };
    verdicts.push(v);
  }
  return { accepted: true, verdicts };
}

/** The reason the last refusal happened, set by `judgeOne` on its reject path. */
let lastRefusal = "";

/** One file, or `undefined` when it is refused — `lastRefusal` then carries why. */
async function judgeOne(
  opts: { exec: BuildExec; baseTree: string; template: string; timeoutMs?: number },
  r: ReplacementInput,
): Promise<AcceptedReplacement | undefined> {
  const refuse = (why: string): undefined => {
    lastRefusal = why;
    return undefined;
  };
  if (r.frozenHash === undefined) return refuse("the run holds no frozen record for this path");
  if (r.bytes.length === 0) return refuse("the replacement is empty");
  if (sha256(r.bytes) === r.frozenHash)
    return refuse("the replacement is byte-identical to the frozen file");
  const proof = await runTestFile(opts.exec, {
    wt: opts.baseTree,
    template: opts.template,
    file: r.path,
    limits: { env: verifyChildEnv(), ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) },
  });
  if (proof.kind === "green")
    return refuse(
      "every case of the replacement passes at the base, so it tests nothing the run must build",
    );
  if (proof.kind !== "red") return refuse(`the base run observed nothing (${proof.detail})`);
  if (!caseIsNew(r.bytes, proof.output))
    return refuse("the replacement's failing case is one the frozen file already had");
  return {
    path: r.path,
    bytes: r.bytes,
    originalHash: r.frozenHash,
    redCase: proof.output ?? "",
  };
}

/**
 * Does the runner's red name a case the ORIGINAL never printed?
 *
 * The identical-bytes check cannot catch a child that kept the original's failing assertion and appended a
 * passing one: those bytes differ, and the red is the frozen file's own. The original's text is the only
 * comparison that separates a corrected oracle from a resubmitted one, so the comparison is made line by line
 * against the original's own bytes.
 */
export function caseIsNew(original: Buffer, output: string | undefined): boolean {
  if (output === undefined || output.trim() === "") return false;
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
