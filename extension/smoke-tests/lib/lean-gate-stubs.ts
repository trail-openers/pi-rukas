/**
 * lean/review smoke fixtures — the adversarial GATE's stubs.
 *
 * Split from `lean-review-fixtures.ts` along the axis that file already had to
 * hold: the round/lens/dep builders on one side, and the *gate's* report shape on
 * the other. The gate side is where the step's blocking bar is decided, so its
 * stubs are the ones that must be exact — a bare `loopOutcome: "rejected"` used to
 * be enough to reach the fix wave, and every case that only checked "a fixer ran"
 * stayed green while quietly stopping to exercise it. Keeping them in one file is
 * what makes the distinction (status vs bucket, parsed vs defaulted) something a
 * contributor reads once instead of rediscovering per test.
 */

import type { DispatchResult } from "../../src/types.ts";
import { result } from "./lean-review-fixtures.ts";

/**
 * An adversarial stub that refuses `asks` times and then clears.
 *
 * Under the one-wave policy the gate is called at most twice — once before the
 * fix wave, once after it on the fix range — so `asks: 1` is the shape of a run
 * that fixes and clears, and `asks: 2` is the shape of a run whose findings the
 * wave did not answer. The text is fixed rather than varied per call: there is
 * no longer a tie-breaker that refuses a re-report, and a stub that changed its
 * own prose between the two passes would be writing the step's answer for it.
 */
export function rejectsThenClears(text: string, asks = 1): () => Promise<DispatchResult> {
  let n = 0;
  return async () =>
    n++ < asks ? blockingReject(text) : result({ loopOutcome: "approved", text: "" });
}

/**
 * A gate that rejects every time, but whose parsed record says `ISSUES_FOUND`.
 *
 * That is the non-blocking shape: the loop reported findings without the status
 * that means *must not proceed*, so the step owes the operator a disclosure and
 * owes the run no fixer. A case built on `rejectsThenClears` cannot show this —
 * `blockingReject` carries the CRITICAL status, and conflating the two is exactly
 * how a report-only gate ends up buying remediation.
 */
export function issuesFoundThenClears(text: string, asks = 1): () => Promise<DispatchResult> {
  let n = 0;
  return async () =>
    n++ < asks
      ? result({ loopOutcome: "rejected", text, adversarialRounds: parsedRound("ISSUES_FOUND") })
      : result({ loopOutcome: "approved", text: "" });
}

/**
 * The per-round records an adversarial stub needs in order to be believed.
 *
 * `verdictParsed: true` matters: the step refuses a `rejected` whose trailing
 * record was DEFAULTED (no readable `VERDICT:` marker), because findings that
 * were never a verdict cannot be fixed against. A case that wants the step to
 * spend its wave on these findings has to say the reviewer actually parsed one.
 *
 * The status is what decides whether the step buys a fixer at all
 * (`blockingRecord` in `review-gates.ts`): only `CRITICAL_ISSUES_FOUND` blocks,
 * so a stub that means "the gate blocked" must carry that status and not merely
 * `loopOutcome: "rejected"`.
 */
export function parsedRound(
  status: NonNullable<DispatchResult["adversarialRounds"]>[number]["status"],
): DispatchResult["adversarialRounds"] {
  return [{ round: 1, status, verdictParsed: true }];
}

/**
 * A rejected adversarial pass that BLOCKS: the loop's `rejected` arm off a
 * `CRITICAL_ISSUES_FOUND` record, which is the only status
 * `agents-base/adversarial-developer.md` calls "Must fix before proceeding".
 *
 * Every fixture that wants the step to reach its fix wave goes through here.
 * A bare `loopOutcome: "rejected"` with no record used to be enough, because the
 * step bought a fixer off the bucket alone; now the status decides, and a stub
 * that omits it would silently stop exercising the wave while still looking
 * green in every case that only checks "a fixer ran".
 */
export function blockingReject(text: string): DispatchResult {
  return result({
    loopOutcome: "rejected",
    text,
    adversarialRounds: parsedRound("CRITICAL_ISSUES_FOUND"),
  });
}

/**
 * A gate that BLOCKS every time — both the pre-fix gate and the re-gate.
 *
 * The step calls one `adversarial` dep for both passes, so a case that wants the
 * wave bought AND the re-gate blocking needs every call to block; a stub that
 * clears on the second call makes the re-gate non-blocking and quietly removes the
 * gate's prose from the fixer's brief, which is the difference between exercising
 * `fromGate` and not exercising it.
 */
export function blockingOnGateThenClears(text: string): () => Promise<DispatchResult> {
  return async () => blockingReject(text);
}
