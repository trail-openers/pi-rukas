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
import { blobAt } from "./lean/build-git.ts";
import type { BuildExec } from "./lean/build-types.ts";
import { runTestFile, sha256 } from "./lean/specify-proof.ts";
import { writeCaptured } from "./lean/specify-reset.ts";
import { type LoopBudget, runFrozen } from "./oracle-repair-prove.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";

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

/** One replacement refused, with the reason that belongs to THIS replacement and no other. */
export interface RefusedReplacement {
  refusal: string;
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
export type Judgement =
  | { accepted: true; verdicts: AcceptedReplacement[] }
  | { accepted: false; why: string };

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
  /** The commit `baseTree` checks out — the run's `baseSha`, which is also where the ORIGINAL bytes come from. */
  baseRef: string;
  named: readonly string[];
  replacements: ReplacementInput[];
  /** Shortened by a test to watch a hung base run refuse rather than hang. */
  timeoutMs?: number;
  /**
   * ONE wall clock for the whole sweep, which the caller owns because the same budget also bounds the head
   * runs. `runFrozen` enforces it at both ends of a runner, so a sweep of replacements can never exceed one
   * budget's worth of waiting. Absent, each base run carries only its own ceiling.
   */
  budget?: LoopBudget;
}): Promise<Judgement> {
  const problem = submissionScopeProblem(
    opts.replacements.map((r) => r.path),
    opts.named,
  );
  if (problem !== undefined) return { accepted: false, why: problem };
  const verdicts: AcceptedReplacement[] = [];
  for (const r of opts.replacements) {
    const v = await judgeOne(opts, r);
    // A sweep the budget took left the round with no evidence about a file it cannot re-ask, so the round
    // hands back naming the cause rather than accepting a judgement it never observed.
    if (opts.budget?.over() === true)
      throw new RepairJudgeError(
        `the base sweep gave up at its ${String(opts.budget.ms)}ms budget before judging ${r.path}`,
      );
    if ("refusal" in v) return { accepted: false, why: `${r.path}: ${v.refusal}` };
    verdicts.push(v);
  }
  return { accepted: true, verdicts };
}

/** A run that could not answer the question, as opposed to one that answered it. */
export class RepairJudgeError extends Error {
  constructor(why: string) {
    super(`oracle-repair judge: ${why}`);
    this.name = "RepairJudgeError";
  }
}

/**
 * One file: the accepted replacement, or a refusal carrying its own reason.
 *
 * The reason is RETURNED rather than stashed in a module-level slot because the loop that reads it does so
 * across an `await`: two judgements in flight in one process would otherwise report each other's reason, and
 * a handback that names the wrong refusal tells the builder to fix the wrong thing.
 */
async function judgeOne(
  opts: {
    exec: BuildExec;
    baseTree: string;
    baseRef: string;
    template: string;
    timeoutMs?: number;
    budget?: LoopBudget;
  },
  r: ReplacementInput,
): Promise<AcceptedReplacement | RefusedReplacement> {
  const refuse = (why: string): RefusedReplacement => ({ refusal: why });
  if (r.frozenHash === undefined) return refuse("the run holds no frozen record for this path");
  if (r.bytes.length === 0) return refuse("the replacement is empty");
  if (sha256(r.bytes) === r.frozenHash)
    return refuse("the replacement is byte-identical to the frozen file");
  // The original is read out of the COMMIT *before* the submitted bytes go into the checkout: the judge runs
  // the replacement under the submitted path, so a comparison made after that write is one submission read
  // back against itself, and a submission that quietly deleted a case the contract printed would compare
  // equal to itself and be accepted. The committed bytes are the only copy the round has not written.
  const original = await readOriginal(r, opts);
  // The runner classifies what it finds under the submitted path, so the submitted bytes go into the driver's
  // throwaway base checkout; judging the base's own copy would answer a question nobody asked.
  writeCaptured(opts.baseTree, new Map([[r.path, r.bytes]]));
  const run = { wt: opts.baseTree, template: opts.template, file: r.path };
  // The same bounded runner the freeze-time proof and the blocked re-run use: the scrubbed environment and a
  // kill ceiling on every run, so no project command can hold the round by its own timeout.
  const proof =
    opts.budget === undefined
      ? await runTestFile(opts.exec, {
          ...run,
          limits: {
            env: verifyChildEnv(),
            ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
          },
        })
      : await runFrozen(opts.exec, run, opts.budget);
  if (proof.kind === "green")
    return refuse(
      "every case of the replacement passes at the base, so it tests nothing the run must build",
    );
  // An unclear or infra verdict is NOT a refusal: the judge never saw the replacement run, so it holds no
  // evidence about it, and a round whose judge could not read a runner would be refused on an accident of the
  // toolchain. It throws, and the run hands back naming the cause — the same direction the release's own
  // blocked gate takes for a file it could not classify.
  if (proof.kind !== "red")
    throw new RepairJudgeError(`the base run observed nothing (${proof.detail})`);
  if (!(await provesNewRed(r, original, proof.output)))
    return refuse("the replacement's failing case is one the frozen file already had");
  return {
    path: r.path,
    bytes: r.bytes,
    originalHash: r.frozenHash,
    redCase: proof.output ?? "",
  };
}

/**
 * Did the runner's red name a case that exists only in the replacement?
 *
 * Two ways a submission steals the round, both invisible to a byte-identity check: keep the contract's failing
 * assertion and bolt a passing case on (the red on the bench is the contract's own), or DELETE a case the
 * contract printed so the remaining red names a line the contract never had. So the red must be absent from
 * the original AND every line the original printed must survive. The original is read out of the commit and
 * hash-checked, because the checkout it runs in is one this round has written into.
 */
/** The original's committed bytes, read before the round writes into the checkout it runs in. */
async function readOriginal(
  r: ReplacementInput,
  opts: { exec: BuildExec; baseTree: string; baseRef: string },
): Promise<Buffer> {
  const bytes = await blobAt(opts.exec, opts.baseTree, opts.baseRef, r.path);
  if (bytes === undefined || sha256(bytes) !== r.frozenHash)
    throw new RepairJudgeError(
      `the base checkout's copy of ${r.path} is not the frozen file the run holds`,
    );
  return bytes;
}

async function provesNewRed(
  r: ReplacementInput,
  bytes: Buffer,
  output: string | undefined,
): Promise<boolean> {
  if (output === undefined || output.trim() === "") return false;
  const before = linesOf(bytes.toString("utf8"));
  const after = new Set(linesOf(r.bytes.toString("utf8")));
  if (before.some((l) => !after.has(l))) return false;
  const seen = new Set(before);
  return linesOf(output).some((l) => !seen.has(l));
}

/** A runner output's comparable lines: trimmed, non-empty. */
function linesOf(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
