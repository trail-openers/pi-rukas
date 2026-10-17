/**
 * The batch's delivery half (#1389).
 *
 * Split out of `async-jobs-batch.ts` for the 500-line cap, and it is the seam
 * that file was already asking for: `startBatch` owns the member lifecycle
 * (registry rows, deck entries, child handles, slow-run watches), and this owns
 * the one question the settle has to answer — did anything reach this batch's
 * host, and if not, what does the PM get told? Nothing in here touches the
 * registry or the deck, and nothing in `async-jobs-batch.ts` decides a delivery
 * outcome, so neither half can drift into the other's contract.
 *
 * `deliverBatchReport` is the only place that knows whether the report, a
 * stand-in, or neither reached the host, which is why it — and not `settleBatch`
 * — prints the "nothing reached Pi" lines. A second stand-in from the caller is
 * the double-delivery bug the comment at the foot of this file's doc block
 * records.
 */

import type { Writable } from "node:stream";
import { type DispatchHost, deliverReport, deliverStandIn } from "./async-jobs-lifecycle.ts";
import { type BatchReportInput, formatBatchReport } from "./async-jobs-report.ts";
import type { GitLineFor } from "./git-state.ts";
import { trace, traceWarn } from "./trace.ts";

/**
 * #1389 — a batch member's handle exists from the moment the member is
 * registered, but the real stdin only appears when the child spawns. Until then
 * the slot carries this: a `Writable` that does nothing, because nothing is
 * reading it. `dispatch_steer` writes an RPC frame to a handle it believes is
 * live, so a member killed before its spawn must not have a real stream there —
 * and `ChildHandle.stdin` is not optional, so something has to occupy the field.
 */
export function deadStdin(): Writable {
  return {
    write: () => true,
    end: () => deadStdin(),
    destroyed: true,
    writable: false,
  } as unknown as Writable;
}

/**
 * #1389 — what the batch's one send produced. Three values, each a thing that
 * actually happened to the send, and each answered by the code that made it:
 *
 *   - `"sent"` / `"rejected"` — the send reached the host, and the host accepted
 *     it or threw. These come from `deliverReport`'s own return value.
 *   - `"never"` — no send was ever made. The formatter threw, or a host broke
 *     `deliverReport`'s never-throws contract and its exception escaped `send()`.
 *
 * `"never"` is NOT the pre-send initialiser standing in for an answer the code
 * never computed (the round-2 pre-send-default defect, which made "delivered but
 * not answered" and "never sent" the same value, so the tail's `=== "rejected"`
 * test was false for both). The distinction survives because it is a real, final
 * state the batch acts on: a rejected send gets a stand-in that says "re-read
 * /runs"; a send that never happened gets one that says "could not be built",
 * and neither is reachable from the other.
 */
export type BatchSendState = "sent" | "rejected" | "never";

/**
 * #1015 — computes the git-state line for each developer/ops member (against its own
 * cwd; failed members and reviewers get none), then delivers the one batch steer.
 *
 * #1389 — `delivered` used to be set unconditionally after `send()`, and
 * `send()` called `deliverReport`, which cannot throw: a host whose
 * `sendUserMessage` throws left the flag true on a message that never arrived,
 * so the batch released its pending slot to "0" with nothing handed over and no
 * witness. The state now comes from `deliverReport`'s own return value — the
 * batch reads the result of the call it made, not a counter some other
 * deliverer may have moved — and a rejected send is answered by `settleBatch`'s
 * stand-in, so a batch never reaches "0" with neither a report nor a stand-in,
 * and never sends the same report twice.
 *
 * Returns whether ANYTHING reached Pi — the report, or the stand-in that
 * replaces a rejected one. `false` is the batch's own "handed Pi NOTHING"
 * signal, and `settleBatch` is the ONLY party allowed to answer it: this
 * function reports a send it made, and the one shape it cannot report is a send
 * that never ran (a formatter that threw), because there is nothing to have
 * returned. The caller asks that of the return value — never by making a second
 * send of its own, which is how a `false` here became a double delivery: the
 * unannotated fallback and the annotated report both landed on the wire.
 */
export async function deliverBatchReport(
  pi: DispatchHost,
  head: { batchLabel: string; batchId: string; startedAt: number },
  memberResults: BatchReportInput["members"],
  gitMembers: Map<string, string | undefined>,
  gitLineFor: GitLineFor,
): Promise<boolean> {
  // The send's outcome, assigned ONLY on the path that actually reached the
  // host. `"never"` lives here, outside the union above, and is both the
  // initialiser and the truth for a `send()` that threw before its send (a
  // formatter that broke): it means "this batch's host was never asked", which
  // is neither outcome above and cannot be mistaken for either. A host-produced
  // value is only ever `"sent" | "rejected"` — the two the tail compares against
  // — so "delivered but not attempted" has no spelling.
  // `error` is what the host actually threw — `deliverReport` swallows it behind
  // its never-throws contract, so this is the only place the real cause survives,
  // and the stand-in's WARN reads it.
  const sendState: { value: BatchSendState; error?: unknown } = { value: "never" };
  const send = (lines?: Map<string, string>): void => {
    const members = memberResults.map((m) => ({
      ...m,
      gitLine: lines?.get(m.jobId),
    }));
    // Building the report is the half that CAN throw (`formatBatchReport` reads
    // `usage`, `describeOutcome`, the truncation heuristics), so it is separated
    // from the send: a throw here means no send was ever made, which is a
    // different fact from "the host rejected the send" and gets its own stand-in
    // below rather than being read as one.
    let report: string;
    try {
      report = formatBatchReport({ ...head, members });
    } catch (err) {
      // The build failed, not the send: `"never"` is the honest answer (no send
      // was made), and `error` is what the formatter actually threw — the
      // stand-in's text and WARN both read it, so it survives the swallow.
      sendState.value = "never";
      sendState.error = err;
      return;
    }
    // The outcome IS the return value of this very call — no counter delta, no
    // bracket read around it, no exception to catch: `deliverReport` answers its
    // own caller (#1389). It is assigned BEFORE the stand-in branches read it, and
    // on no other path, so "delivered but not attempted" cannot be spelled.
    sendState.value = deliverReport(pi, report) ? "sent" : "rejected";
  };
  // A send the host REJECTED is a report that does not exist, and the
  // unannotated fallback below must NOT fire for it (that would be a second
  // doomed send of the same content). A send that never RAN — the git-state
  // step threw — is the opposite case: the unannotated report is still owed,
  // so it fires exactly once, and only while no send has been made at all.
  const retryUnannotatedOnce = (): void => {
    if (sendState.value === "never") send();
  };
  // The two stand-ins name different failures, and the PM acts on them
  // differently: a delivery failure says the members ran and their results are
  // in /runs (re-read, do not re-dispatch); a build failure says the report
  // could not be built at all. `sendState.error` separates them — it is set only
  // when there is a cause to report, which is the build failure and the escaped
  // host throw, never a plain rejection.
  const standInFor = (): string =>
    sendState.error === undefined
      ? batchDeliveryFailureReport(head.batchLabel, head.batchId)
      : batchFailureReport(head.batchLabel, head.batchId, sendState.error);
  try {
    const lines = new Map<string, string>();
    await Promise.all(
      memberResults.map(async (m) => {
        if ("failed" in m.result || !gitMembers.has(m.jobId)) return;
        lines.set(m.jobId, await Promise.resolve().then(() => gitLineFor(gitMembers.get(m.jobId))));
      }),
    );
    send(lines);
  } catch (err) {
    trace(`async batch ${head.batchId} git-state report failed: ${String(err)}`);
    retryUnannotatedOnce();
  }
  if (sendState.value === "sent") return true;
  // Both remaining shapes reached the stand-in, and each says which it was.
  traceWarn(
    sendState.value === "never"
      ? `async batch ${head.batchId} report never reached the host — ${String(sendState.error ?? "its report could not be built")}`
      : `async batch ${head.batchId} report delivery rejected by the host`,
  );
  const standInLanded = deliverStandIn(pi, `async batch ${head.batchId}`, sendState.error, () =>
    standInFor(),
  );
  // #1389 — the last honest word. A report that did not reach the host AND a
  // rejected stand-in means `releaseAfter` is about to print "0" on a session
  // that received neither message, which is the exact lie this ticket exists to
  // close. The count still has to drop (a bound must not strand it), but the
  // channel's "nothing is coming" is now contradicted on stderr, in a line
  // naming the batch — not left as silence indistinguishable from a clean send.
  if (!standInLanded) {
    traceWarn(
      `async batch ${head.batchId} handed Pi NOTHING: the report and its stand-in were both rejected — the pending count will reach 0 with no message delivered`,
    );
  }
  return standInLanded;
}

/** The stand-in report for a batch whose settle threw before its report reached Pi. */
export function batchFailureReport(batchLabel: string, batchId: string, err: unknown): string {
  return `[ensemble:async] Batch \`${batchLabel}\` (batch ${batchId}) FAILED — its report could not be built: ${String(err)}. Its members' results are lost; re-dispatch the batch if they are still needed.`;
}

/**
 * #1389 — the stand-in for a batch whose report was built but whose send the host
 * rejected. Distinct from `batchFailureReport`: the members' results are NOT lost
 * here (they were formatted, and the transcripts still hold them) — only the
 * delivery failed, so the line says that instead of telling the PM to re-run a
 * batch that already ran.
 */
export function batchDeliveryFailureReport(batchLabel: string, batchId: string): string {
  return `[ensemble:async] Batch \`${batchLabel}\` (batch ${batchId}) FINISHED but its report could not be delivered — the host rejected the message. Its members ran; their results are in /runs, not in this session. Re-read the transcripts rather than re-dispatching the batch.`;
}
