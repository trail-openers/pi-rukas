/**
 * adversarial-verdict-reask — when a reviewer's reply carries no readable
 * verdict, ask it for the verdict line alone, in a second child on the SAME
 * session.
 *
 * The shape this exists for: a reviewer writes its whole report — the findings
 * and the `VERDICT:` line — inside one closed ``` fence. The candidate reader
 * (`adversarial-verdict-read.ts`) refuses fenced lines BY DESIGN: a verdict
 * inside a code block is a verdict being shown, not signed, and a whole-reply
 * reader cannot tell a fenced signature from a quoted example. So the round
 * reads `verdictParsed: false` and the loop hands back an infrastructure failure
 * over a review that was actually performed.
 *
 * The loop cannot steer the child it already has: `spawnSpecialist` closes the
 * reviewer's stdin at its first `agent_end` and reaps it. So the re-ask is a
 * short follow-up child on the reviewer's own session file — the plumbing lives
 * in `adversarial-verdict-reask-child.ts`, and the vocabulary both sides share
 * lives in `adversarial-verdict-reask-constants.ts`. The model sees its own
 * previous reply, so the ask is one sentence and the answer is one line.
 *
 * What makes this safe rather than a second bite at the verdict:
 *
 *   - the answer goes through the SAME strict reader (`parseVerdict`), so a
 *     fenced answer, a menu echo or an absent answer is still unreadable and
 *     still lands on the loop's infrastructure failure;
 *   - the ask names no verdict VALUE, so the reply cannot be a menu run;
 *   - the round keeps the ORIGINAL reviewer's transcript, model and death cause:
 *     the re-ask's own result is never accumulated into the loop's tally, folded
 *     into the round, or allowed to re-point `lastTranscript` / `lastModel`;
 *   - on a spawn failure, a timeout or a missing session the round falls back to
 *     exactly the infrastructure failure this replaced. Nothing is ever passed on
 *     an absent answer.
 */

import { spawnVerdictReaskChild } from "./adversarial-verdict-reask-child.ts";
import type { ReaskOutcome, VerdictReaskFn } from "./adversarial-verdict-reask-child.ts";
import {
  VERDICT_REASK_BOUND_MS,
  VERDICT_REASK_LABEL,
  VERDICT_REASK_NOTE,
  VERDICT_REASK_PROMPT,
  VERDICT_REASK_SOURCE_TAG,
} from "./adversarial-verdict-reask-constants.ts";
import { emitSteered } from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdict, DispatchResult } from "./types.ts";

/** Re-exported so the loop's params module names the seam type without reaching
 * across the child seam for it. */
export type { ReaskOutcome, VerdictReaskFn } from "./adversarial-verdict-reask-child.ts";
import { parseVerdict } from "./adversarial-verdict.ts";

/**
 * The ONE reader of the re-ask switch. `PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK`
 * is default ON; only the literal `"0"` restores the pre-fix shape, in which an
 * unreadable verdict goes straight to the loop's infrastructure failure. Read at
 * CALL time, as every sibling switch is, so an operator can flip it between
 * rounds of a live cycle.
 */
export function adversarialVerdictReaskEnabled(): boolean {
  return process.env.PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK !== "0";
}

/** The lifecycle channels a recovered verdict travels on. A `trace()` line alone
 * is invisible in scrollback, so the ask is ALSO surfaced as a steered event on
 * the job — one event per ask, carrying the tag as its source so a reader can
 * tell a recovered verdict from the review's own reply by value. */
function emitVerdictReask(jobId: string | undefined, role: string): void {
  // One event per ask, on the channel the operator actually sees — a `trace()`
  // line is invisible in scrollback. The job id falls back to the tag so an ask
  // outside a job's scope still surfaces rather than being filed under an id no
  // reader can trace.
  emitSteered(
    jobId ?? VERDICT_REASK_SOURCE_TAG,
    VERDICT_REASK_LABEL,
    role,
    VERDICT_REASK_PROMPT,
    VERDICT_REASK_SOURCE_TAG,
  );
}

/** The answer a re-ask yielded that the strict reader still refused — the
 * fenced answer, the menu echo, the prose. The round falls back to the same
 * infrastructure failure an absent answer gets; the reply travels only so the
 * loop can say WHY nothing was readable. */
export interface ReaskUnreadable {
  unreadable: true;
  text: string;
}

/** What the loop keeps from a successful re-ask: the STATUS the answer states,
 * the re-ask child's own reply and cost, and the tag naming where the verdict
 * came from. The round's findings and raw text stay the reviewer's own reply —
 * a re-ask signs a verdict, it does not write findings. */
export interface ReaskedVerdict {
  /** The status the re-ask's answer states, read by the SAME strict reader. */
  status: AdversarialVerdict["status"];
  /** The re-ask child's own final reply — kept for the trace, not the round. */
  text: string;
  ms: number;
  usage: DispatchResult["usage"];
  source: typeof VERDICT_REASK_SOURCE_TAG;
}

/**
 * Ask the reviewer's own session for just the verdict line.
 *
 * Returns `undefined` for every way this can fail — no session file, a spawn
 * that died, a timeout, an empty answer — because the round's answer to all of
 * them is the same infrastructure failure the loop already produces, and a
 * failure code would only invite a caller to pass on one.
 */
async function reaskAdversarialVerdict(args: {
  transcriptPath: string | undefined;
  role: string;
  model?: string;
  cwd?: string;
  /** The job the ask is surfaced under, so the scrollback line lands beside the
   * round it belongs to rather than under a synthetic id. */
  jobId?: string;
  /** Injected in tests; production is {@link spawnVerdictReaskChild}. */
  reask?: VerdictReaskFn;
}): Promise<ReaskedVerdict | ReaskUnreadable | undefined> {
  const transcriptPath = args.transcriptPath;
  if (transcriptPath === undefined || transcriptPath === "") return undefined;
  const reask = args.reask ?? spawnVerdictReaskChild;
  const start = Date.now();
  const out = await reask({
    transcriptPath,
    role: args.role,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    boundMs: VERDICT_REASK_BOUND_MS,
    prompt: VERDICT_REASK_PROMPT,
  });
  if (!out.ok) {
    // A spawn, bound or stream failure reaches the trace with its reason, and the
    // round falls through to the infrastructure failure it had before this call.
    trace(
      `adversarial: verdict re-ask got no answer (${out.reason}) for ${transcriptPath ?? "<none>"}`,
    );
    return undefined;
  }
  // The answer is read by the SAME strict reader the reviewer's reply goes
  // through, so a fenced answer, a menu echo or prose stays unreadable here
  // exactly as it was in the reviewer's own reply. The reply is handed back
  // rather than dropped: the round keeps the ORIGINAL reviewer's text as its
  // findings, and the reason the ask failed is the thing an operator reads.
  const answer = parseVerdict(out.text);
  if (answer.verdictParsed !== true) {
    trace(`adversarial: verdict re-ask answered without a readable verdict for ${transcriptPath}`);
    return { unreadable: true, text: out.text };
  }
  trace(`${VERDICT_REASK_SOURCE_TAG}: verdict obtained from a second child on ${transcriptPath}`);
  emitVerdictReask(args.jobId, args.role);
  return {
    status: answer.status,
    text: out.text,
    ms: Date.now() - start,
    usage: out.usage,
    source: VERDICT_REASK_SOURCE_TAG,
  };
}

/** The loop's one call into this module: re-ask an unreadable round once, and
 * fold only the re-ask's COST into the tally.
 *
 * Returns the re-asked verdict, or `undefined` — and `undefined` means the round
 * keeps the outcome it had before this call existed. The reviewer's own result is
 * never re-attributed: the round's transcript, model and kill cause stay the
 * original dispatch's, which is what `classifyReviewer` and the budget projection
 * downstream read.
 */
export async function reaskRoundVerdict(
  adv: DispatchResult,
  round: number,
  tally: { accumulateUsageOnly: (r: DispatchResult) => void },
  reask?: VerdictReaskFn,
  jobId?: string,
): Promise<ReaskedRoundVerdict | undefined> {
  const recovered = await reaskAdversarialVerdict({
    transcriptPath: adv.transcriptPath,
    role: adv.role,
    ...(adv.model === undefined ? {} : { model: adv.model }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(reask === undefined ? {} : { reask }),
  });
  if (recovered === undefined) return undefined;
  if ("unreadable" in recovered) {
    // Nothing was salvaged, so nothing was spent beyond the ask itself — but the
    // child still ran, and an operator reading the totals should see it.
    trace(
      `adversarial: round ${String(round)} re-ask answered without a readable verdict — ` +
        `head ${JSON.stringify(recovered.text.slice(0, 120))}`,
    );
    return undefined;
  }
  // The cost of the child is the round's; its attribution is nobody's.
  tally.accumulateUsageOnly({
    role: adv.role,
    ok: true,
    text: "",
    toolUses: [],
    ms: recovered.ms,
    exitCode: 0,
    usage: recovered.usage,
  });
  trace(`adversarial: round ${String(round)} ${VERDICT_REASK_NOTE} (${recovered.source})`);
  // The round's verdict object: the STATUS from the re-ask, the findings and raw
  // text of the reviewer's own reply. A fix prompt or a PR body built from this
  // sees the review that was performed, not the one-line follow-up.
  return {
    verdict: {
      status: recovered.status,
      findings: adv.text,
      raw: adv.text,
      verdictParsed: true,
    },
    source: recovered.source,
  };
}

/** What {@link reaskRoundVerdict} hands the loop: the round's verdict object,
 * re-pointed at the re-asked status with the reviewer's own text, and the tag
 * naming where it came from. */
export interface ReaskedRoundVerdict {
  verdict: AdversarialVerdict;
  source: typeof VERDICT_REASK_SOURCE_TAG;
}

/** The result text of a round whose verdict arrived through the re-ask: the
 * round's own prose, preceded by the clause that names where the verdict came
 * from. With no re-ask the text is the caller's, unchanged, byte for byte. */
export function reaskResultText(
  recovered: { source: typeof VERDICT_REASK_SOURCE_TAG } | undefined,
  text: string,
): string {
  if (recovered === undefined) return text;
  return `${VERDICT_REASK_NOTE} (${recovered.source}).\n\n${text}`;
}
