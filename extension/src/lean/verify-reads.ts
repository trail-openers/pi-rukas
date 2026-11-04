/**
 * The reads a verify run makes OUTSIDE its own verdict, extracted from `verify.ts` so
 * the gate's control flow stays the biggest thing in its file.
 *
 * Three things live here and none of them decides a colour:
 *
 * - `verifyCmdAtHead` reads the project's committed `.pi/verify-cmd`, where an absent
 *   file is "the project configured nothing" and any other failed read is
 *   infrastructure.
 * - `specCriteriaFor` reads the issue's `pi-spec` block for the `command` criteria,
 *   where a spec the gate cannot read is infrastructure and a block that holds no
 *   `command` criterion is an ordinary run that asked for nothing.
 * - `commandsFailedAsExecuted` re-expresses a command criterion's outcome as the same
 *   `Executed` shape the tiers produce, so one `firstFailure` judges tests, tiers and
 *   criteria together instead of three call sites agreeing by habit.
 *
 * `VerifyInfraError` is thrown by the code here and by the caller in the same breath,
 * so it is imported rather than re-declared: two error classes that both mean "this
 * machine could not answer" is how a run starts treating one as a verdict.
 */
import { trace } from "../trace.ts";
import { parsePiSpec, readiness } from "./spec.ts";
import type { Criterion } from "./spec.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { oneLine } from "./text-fence.ts";
import type { CommandCriteriaOutcome } from "./verify-commands.ts";
import type { Executed } from "./verify-steps.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/**
 * Is a failed `git show <ref>:<path>` git's own "this commit has no such file"?
 *
 * Two wordings are git's absence answers, and one of them is the reason a
 * path is not readable rather than absent (a file that exists in the tree but
 * never in the commit). Anything else — a timeout, an overflow, a corrupt
 * object — is a git that could not answer, which is never "the project
 * configured nothing".
 */
const ABSENT_IN_COMMIT = /does not exist|exists on disk, but not in/i;

/**
 * Why a failed read of `.pi/verify-cmd` means "there is none", or `undefined`
 * when the read failed for a reason that is not an answer.
 */
function absentVerifyCmd(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  // Exit 128 is git's "hard" refusal — for this command it only ever means the
  // path is not in the commit; a bad rev or a broken repo would have refused
  // every other git call in the step too. The wording is what decides.
  return e?.code === 128 && ABSENT_IN_COMMIT.test(text);
}

/** The committed `.pi/verify-cmd` at HEAD, or `undefined` when there is none. */
export async function verifyCmdAtHead(
  exec: VerifyExec,
  wt: string,
  head: string,
): Promise<string | undefined> {
  // An ABSENT file is "the project configured nothing"; a read that failed for
  // any other reason is infrastructure and throws, because defaulting a git
  // that would not answer to "no tiers" turns a broken machine into a green.
  // The wrapped rejection also covers an injected `readVerifyCmd` that rejects:
  // the seam is a test's stand-in for this very read, so it earns the same
  // classification — a `VerifyInfraError` it raised itself passes through
  // untouched, anything else is re-thrown with the reader's own wording.
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "show", `${head}:.pi/verify-cmd`],
    cwd: wt,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  }).catch((err: unknown) => {
    if (absentVerifyCmd(err)) return undefined;
    throw toVerifyCmdInfra(err);
  });
  if (ran === undefined) return undefined;
  return (ran.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Wrap a failed `.pi/verify-cmd` read as infrastructure.
 *
 * One wording for both readers — the production `git show` above and an injected
 * `deps.readVerifyCmd` — so a test that makes its seam reject cannot observe a
 * different failure class from the one the real read produces. A rejection that
 * is already a `VerifyInfraError` is the reader's own verdict on its machine and
 * keeps its message; anything else is reported as a read that could not answer.
 */
export function toVerifyCmdInfra(err: unknown): VerifyInfraError {
  if (err instanceof VerifyInfraError) return err;
  return new VerifyInfraError(
    `could not read .pi/verify-cmd: ${(err as Error)?.message ?? String(err)}`,
  );
}

/**
 * The `command` criteria the run must preserve, read from the issue's spec block.
 *
 * A spec the gate cannot read is infrastructure and THROWS: silently running no
 * criteria would let a broken forge read produce a ready PR over unchecked
 * criteria. Only a body that parsed and holds no `command` criterion is "none",
 * because a run whose spec has no command criteria is an ordinary run, not a broken
 * machine. A body with NO `pi-spec` block at all is the same ordinary case: `publish`
 * is the step that refuses a contractless issue, and the verify gate has no business
 * inventing a failure the next step already reports in its own words.
 */
export async function specCriteriaFor(
  deps: { fetchIssueBody: (repoRoot: string, issue: number) => Promise<string> },
  repoRoot: string,
  issue: number,
): Promise<Criterion[]> {
  const body = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new VerifyInfraError(
      `could not read the issue's spec for the command criteria: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const parsed = parsePiSpec(body);
  if (!parsed.ok) {
    if (parsed.reason !== "no pi-spec v1 block")
      throw new VerifyInfraError(
        `the issue's spec could not be read for the command criteria: ${parsed.reason}`,
      );
    trace("lean/verify: no command criteria — the issue carries no pi-spec block");
    return [];
  }
  // A spec that parses but is not runnable is a spec the gate cannot act on, and the
  // run must not proceed to a verdict on criteria a well-formed spec would not carry:
  // two criteria sharing one id, for example, mean the record keys two verdicts on one
  // slot and one reason silently stands for both. `specify` gates the run on this same
  // judgement, so re-reading it here is not a new rule — it is the rule applied where
  // its violation would otherwise be invisible.
  const unready = readiness(parsed.spec);
  if (unready.length > 0)
    throw new VerifyInfraError(
      `the issue's spec is not ready for the command criteria: ${oneLine(unready.join("; "), 300)}`,
    );
  return parsed.spec.criteria;
}

/**
 * A failed `command` criterion as an `Executed` so it routes through the same
 * `firstFailure` as the frozen tests and the tiers: `fail` is a verdict, and an
 * infra result never reaches here because `commandCriteriaOutcome` throws it.
 */
export function commandsFailedAsExecuted(outcome: CommandCriteriaOutcome): Executed {
  return outcome.failed === undefined ? { kind: "pass" } : { kind: "fail", reason: outcome.failed };
}
