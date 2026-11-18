/**
 * lib/adversarial-verdict-reask-off-arm-golden — the loop's round records and
 * result texts for the fenced-verdict shapes, as origin/main (7b143e84a1)
 * produced them BEFORE the re-ask existed.
 *
 * `PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK=0` is the arm an operator reaches for
 * to revert the feature, so "off" has to mean the bytes that shipped before it,
 * not merely a plausible infra failure. The house shape for that claim is
 * `lib/lean-review-problem-golden.ts`: the goldens live OUTSIDE the modules
 * under change, so a change to those modules cannot move the bytes that are
 * supposed to catch it. A golden that re-derived the infra sentence from
 * `adversarial-retry.ts`, or the round records from `toRoundRecords`, would move
 * with the thing it exists to catch.
 *
 * How these were produced: a detached checkout of 7b143e84a1, the four fenced
 * shapes from `adversarial-reask-fixtures.ts` driven through the real
 * `runAdversarialLoop` with the same stubbed dispatch the re-ask suite uses, and
 * the emitted `DispatchResult` copied here verbatim. `ms` is excluded from the
 * comparison — it is wall-clock by construction.
 *
 * The pre-feature brief lives on the other side (the switch removes one
 * sentence), so the byte-identity claim here is stated against the CURRENT brief
 * with that one sentence spliced back in: `offArmBrief`, below, is the
 * pre-feature sentence list, and `preFeatureBrief` builds what
 * `buildAdversarialPrompt` must print under `"0"`.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import type { DispatchResult } from "../../src/types.ts";

/** One golden: what the loop returned for one scripted reviewer reply. */
export interface OffArmGolden {
  loopOutcome: DispatchResult["loopOutcome"];
  ok: boolean;
  text: string;
  adversarialRounds: DispatchResult["adversarialRounds"];
  roundsExecuted?: number;
  transcriptPath?: string;
  model?: string;
  /** The total the loop reported for the run — every stubbed dispatch's spend
   * folded in, so a re-ask child that folded its cost on the off arm shows up
   * here rather than going unnoticed. */
  usage: DispatchResult["usage"];
}

/** The reviewer's own spend, as the stub reports it — one dispatch of it. */
export const GOLDEN_USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.1,
  turns: 2,
};

/** The mid-loop arm's total: three review rounds plus the two fixer passes the
 * stub answers, every one of them reporting {@link GOLDEN_USAGE}. */
export const GOLDEN_MIDLOOP_USAGE = {
  input: 50,
  output: 25,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.5,
  turns: 10,
};

/** The session file and model the stubbed reviewer reports — the round's own
 * attribution, which the re-ask must not move even when it runs. */
export const GOLDEN_TRANSCRIPT = "/tmp/pi-rukas-dev-fv/review-session.json";
export const GOLDEN_MODEL = "reviewer-model-1";

/** The sentence the switch adds to the reviewer's brief, spelled out here rather
 * than read back from `adversarial-prompts.ts`: the off-arm test asserts the
 * printed brief equals the current one minus this, and a golden imported from
 * the module under test could not catch it changing. */
export const OFF_ARM_SENTENCE =
  "The Output Format in your system prompt is a layout guide only: do not wrap " +
  "your reply in a code fence. Your verdict line goes at column 0, outside any " +
  "code fence, as the LAST line of your reply.";

/** What `buildAdversarialPrompt` must print with the switch off, given what it
 * prints with it on: the current brief with the one sentence (and the blank line
 * that separated it) removed. */
export function preFeatureBrief(onArmBrief: string): string {
  return onArmBrief.replace(`\n\n${OFF_ARM_SENTENCE}`, "");
}

/** The operator-visible sentence the pre-feature loop printed for an unreadable
 * round. Restated, not imported from `adversarial-retry.ts`, for the reason
 * stated in this file's header. The mid-loop arm's terminal round says the same
 * thing with its own tail, also restated below rather than read from the loop. */
const PRE_FEATURE_HEAD = (round: number, phase: string): string =>
  `Adversarial loop infrastructure failure: round ${String(round)} ${phase} dispatch produced no readable VERDICT marker`;
const PRE_FEATURE_TAIL = ". No verdict was produced — this is NOT a review rejection.";

export const PRE_FEATURE_INFRA_HEADLINE = (round: number, phase: string): string =>
  `${PRE_FEATURE_HEAD(round, phase)}${PRE_FEATURE_TAIL}`;

/** Round 3 of a mid-loop pass ends the loop, so its headline carries the tail
 * that names the round as the last one — the second unreadable path of the loop,
 * which the re-ask also sits before. */
export const PRE_FEATURE_INFRA_FINAL_ROUND = (round: number, phase: string): string =>
  `${PRE_FEATURE_HEAD(round, phase)} on the final round${PRE_FEATURE_TAIL}`;

/** The three unfenced-but-unreadable shapes plus the short repro, in the order
 * `SHAPES` lists them; the key is what `OFF_ARM_GOLDENS` is keyed by. */
export type OffArmShapeKey = "a" | "b" | "c" | "d";

/** The pre-feature result for each fenced shape on each of the loop's three
 * arms. `rounds` is `[]` on every infra arm: before the re-ask, a round the
 * ladder lost — or whose verdict the reader refused — was absent from the round
 * records while `roundsExecuted` counted it. That disagreement is what the
 * previous dispatch "fixed"; R0 says the fix is out of scope, so the off arm's
 * goldens pin it as it was. */
export const OFF_ARM_GOLDENS: Record<string, OffArmGolden> = {
  "reportOnly-routed-a": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-routed-b": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-routed-c": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-routed-d": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-terminal-a": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-terminal-b": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-terminal-c": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "reportOnly-terminal-d": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_HEADLINE(1, "review"),
    adversarialRounds: [],
    roundsExecuted: 1,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "midloop-a": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_FINAL_ROUND(3, "review"),
    adversarialRounds: [],
    roundsExecuted: 3,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_MIDLOOP_USAGE,
  },
  "midloop-b": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_FINAL_ROUND(3, "review"),
    adversarialRounds: [],
    roundsExecuted: 3,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_MIDLOOP_USAGE,
  },
  "midloop-c": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_FINAL_ROUND(3, "review"),
    adversarialRounds: [],
    roundsExecuted: 3,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_MIDLOOP_USAGE,
  },
  "midloop-d": {
    loopOutcome: "infra-failure",
    ok: false,
    text: PRE_FEATURE_INFRA_FINAL_ROUND(3, "review"),
    adversarialRounds: [],
    roundsExecuted: 3,
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_MIDLOOP_USAGE,
  },
  "readable-issues": {
    loopOutcome: "rejected",
    ok: true,
    text: "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- a.ts:1 — no test",
    adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
  "readable-approved": {
    loopOutcome: "approved",
    ok: true,
    // reportOnly returns the reviewed verdict's OWN text — the `passedRoundText`
    // header belongs to the non-reportOnly passing arm, not this one.
    text: "VERDICT: APPROVED\n\nNo issues found.",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
    transcriptPath: GOLDEN_TRANSCRIPT,
    model: GOLDEN_MODEL,
    usage: GOLDEN_USAGE,
  },
};
