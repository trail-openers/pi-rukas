#!/usr/bin/env bun
/**
 * The adversarial verdict re-ask: a reviewer whose whole report — `VERDICT:`
 * line included — sat inside one closed ``` fence.
 *
 * The candidate reader refuses fenced lines BY DESIGN and that rule stays put;
 * what this suite pins is what the LOOP does with the unreadable round it
 * produces. `spawnSpecialist` closes the reviewer's stdin at its first
 * `agent_end` and reaps the child, so the round cannot be steered — the re-ask
 * is a second child on the reviewer's OWN session file, and its answer is read
 * by the same strict `parseVerdict`.
 *
 * The four fenced shapes are built by one generator in
 * `lib/adversarial-reask-fixtures.ts` and are checked against the reader's own
 * candidate rule before any case uses them.
 *
 * Every loop case pins the switch too, because both halves of the loop — the
 * brief and the round — read the same one function: with
 * `PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK=0` the shapes give today's
 * infrastructure failure and the seam is never asked.
 *
 * The re-ask is a SEAM (`verdictReask` on the loop params), not a spawn: a real
 * adversarial child is forbidden offline by `assertLiveSpawnAllowed`, and the
 * reviewer's own dispatch stays the `spawnSpecialist` stub so the round keeps a
 * real transcript, model and usage to be judged on.
 *
 * The CHILD side of the feature — the argv, the RPC reply extraction, the
 * prompt file — is asserted by `test-adversarial-verdict-reask-child.ts`.
 */

import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import type { ReaskOutcome, VerdictReaskFn } from "../src/adversarial-verdict-reask-child.ts";
import {
  VERDICT_REASK_LABEL,
  VERDICT_REASK_PROMPT,
  VERDICT_REASK_SOURCE_TAG,
} from "../src/adversarial-verdict-reask-constants.ts";
import { adversarialVerdictReaskEnabled } from "../src/adversarial-verdict-reask.ts";
import type { DispatchResult, DispatchUsage } from "../src/types.ts";
import {
  BACKTICK,
  DIFF,
  FENCE,
  REASK_USAGE,
  REVIEWER_MODEL,
  REVIEWER_USAGE,
  SHAPES,
  TRANSCRIPT,
  armReviewer,
  dispatches,
  isolateLedger,
  reaskShapesAreFenced,
  setNextTranscript,
} from "./lib/adversarial-reask-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
// The loop writes a review-ledger row per return; the run is in a worktree of
// the real clone, so every pass here is pointed at a temp ledger.
isolateLedger();

// ── (0) the shapes are what they claim: every VERDICT candidate is fenced ───
reaskShapesAreFenced(assert);

const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { parseVerdict } = await import("../src/adversarial-verdict.ts");

/** A completed re-ask answer — the shape only a child that ended its own turn gets. */
function answered(text: string, extra: { usage?: DispatchUsage } = {}): ReaskOutcome {
  return { ok: true, text, completed: true, ...extra };
}

/** The re-ask seam: what it was asked, and what it answered. */
let reaskCalls: Parameters<VerdictReaskFn>[0][] = [];
let reaskAnswer: ReaskOutcome = { ok: false, reason: "no-answer" };
const reask: VerdictReaskFn = async (args) => {
  reaskCalls.push(args);
  // The re-ask's own spend rides out on its answer, the way a child's does.
  return reaskAnswer.ok ? { ...reaskAnswer, usage: { ...REASK_USAGE } } : reaskAnswer;
};

/** One report-only pass over one reviewer reply. */
async function drive(reply: string): Promise<DispatchResult> {
  reaskCalls = [];
  armReviewer({ reply });
  return runAdversarialLoop(
    {
      diff: DIFF,
      context: "fenced verdict re-ask",
      workCwd: process.cwd(),
      branch: "fix/fenced-verdict-reask",
      reportOnly: true,
      reportRound: 1,
      reportVerdict: "routed",
      verdictReask: reask,
    },
    new AbortController().signal,
    "job-fenced-verdict-reask",
  );
}

// ── (1) switch ON + a re-ask that answers: the round yields that verdict ─────
for (const shape of SHAPES) {
  reaskAnswer = answered(`VERDICT: ${shape.verdict}`);
  const r = await drive(shape.lines.join("\n"));
  const record = r.adversarialRounds?.[0];
  assert(
    record?.verdictParsed === true && record.status === shape.verdict,
    `(1) ${shape.name}: the round yields ${shape.verdict} with verdictParsed true`,
  );
  assert(
    !r.text.includes("produced no readable VERDICT marker"),
    `(1) ${shape.name}: no infrastructure failure handed back`,
  );
  assert(
    r.text.includes("verdict obtained on re-ask"),
    `(1) ${shape.name}: the result says the verdict came from the re-ask`,
  );
  assert(
    reaskCalls.length === 1 && reaskCalls[0]?.prompt === VERDICT_REASK_PROMPT,
    `(1) ${shape.name}: the re-ask was asked exactly once, with the one prompt`,
  );
}

// ── (2) switch OFF: today's infra-failure, and the seam never asked ─────────
{
  const OFF_HEADING =
    "Adversarial loop infrastructure failure: round 1 review dispatch produced no readable VERDICT marker";
  const off: DispatchResult[] = [];
  for (const shape of SHAPES) {
    // The off arm keeps the seam installed and answered: the switch, not the
    // absence of a stub, is what must stop the second child.
    reaskAnswer = answered(`VERDICT: ${shape.verdict}`, { usage: { ...REASK_USAGE } });
    let r: DispatchResult | undefined;
    await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
      r = await drive(shape.lines.join("\n"));
    });
    if (r === undefined) throw new Error("off arm did not run");
    off.push(r);
    assert(
      r.loopOutcome === "infra-failure" && r.text.includes(OFF_HEADING),
      `(2) ${shape.name}: with the switch off the round is today's infra-failure`,
    );
    assert(reaskCalls.length === 0, `(2) ${shape.name}: and the re-ask was never asked`);
    assert(
      !r.text.includes("verdict obtained on re-ask"),
      `(2) ${shape.name}: and nothing claims a re-ask it never ran`,
    );
    // The pre-feature record for this arm, pinned against the base's own bytes:
    // the reportOnly guard returns `infraFailureResult`, which never carried the
    // round it lost — `adversarialRounds` was `toRoundRecords([])`, an EMPTY
    // array, while `roundsExecuted` counted the round anyway. The previous
    // dispatch "fixed" that disagreement; R0 rules it out of scope, so the off arm
    // has to land back on it. (The `midloop` arm in
    // `test-adversarial-verdict-reask-off-arm.ts` pins the same shape on the other
    // producer, and the goldens there are the authority for the bytes.)
    assert(
      Array.isArray(r.adversarialRounds) &&
        r.adversarialRounds.length === 0 &&
        r.roundsExecuted === 1,
      `(2) ${shape.name}: adversarialRounds is the pre-feature empty array while roundsExecuted counts the lost round (got ${JSON.stringify(
        r.adversarialRounds,
      )} / roundsExecuted ${String(r.roundsExecuted)})`,
    );
  }
  // The byte-identity claim, proved on the pre-fix sentence the loop has always
  // printed: the off arm's whole text is that sentence's own shape, with nothing
  // the re-ask could have added.
  assert(
    off[0]?.text.startsWith(OFF_HEADING) === true &&
      off[0].text.includes("No verdict was produced — this is NOT a review rejection."),
    "(2) the off arm's text is the pre-fix infrastructure sentence, verbatim",
  );
}

// ── (3) an unreadable re-ask answer stays unreadable ────────────────────────
{
  const unreadable: [string, ReaskOutcome][] = [
    ["fenced", answered(`${FENCE}\nVERDICT: APPROVED\n${FENCE}`)],
    [
      "menu echo",
      answered(
        [
          "VERDICT: APPROVED",
          "VERDICT: MINOR_OBSERVATIONS",
          "VERDICT: ISSUES_FOUND",
          "VERDICT: CRITICAL_ISSUES_FOUND",
        ].join("\n"),
      ),
    ],
    ["empty", answered("   \n")],
    ["indented", answered("    VERDICT: APPROVED")],
    ["bulleted", answered("- VERDICT: APPROVED")],
  ];
  for (const [name, answer] of unreadable) {
    reaskAnswer = answer;
    const r = await drive(SHAPES[0]?.lines.join("\n") ?? "");
    assert(
      r.loopOutcome === "infra-failure" && r.text.includes("produced no readable VERDICT marker"),
      `(3) a ${name} re-ask answer stays unreadable → the infra failure`,
    );
    assert(
      !r.text.includes("verdict obtained on re-ask"),
      `(3) and a ${name} answer is never reported as a recovered verdict`,
    );
  }
  // The seam's answer goes through the SAME reader the reviewer's reply does —
  // pinned on the function, so a re-ask result that reached the round through a
  // looser reader fails here first.
  assert(
    parseVerdict(`${FENCE}\nVERDICT: APPROVED\n${FENCE}`).verdictParsed === false,
    "(3) canary: parseVerdict refuses the fenced answer the way it refuses the reviewer's",
  );
}

// ── (4) at most one re-ask per round NUMBER ─────────────────────────────────
{
  // Round 1 fenced and recovered as ISSUES_FOUND → a fix round runs → round 2 is
  // fenced again. Each round asks once; neither asks twice.
  reaskAnswer = answered("VERDICT: ISSUES_FOUND");
  reaskCalls = [];
  dispatches.length = 0;
  armReviewer({
    reply: SHAPES[0]?.lines.join("\n") ?? "",
    queue: [SHAPES[1]?.lines.join("\n") ?? ""],
  });
  const r = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "one re-ask per round",
      workCwd: process.cwd(),
      branch: "fix/fenced-verdict-one-per-round",
      verdictReask: reask,
    },
    new AbortController().signal,
    "job-fenced-one-per-round",
  );
  // Counted against the reviewer's OWN dispatches, not the loop's round numbers:
  // the fixer runs on the same seam as the reviewer (`role: "developer"`), and a
  // claim of "one ask per round" is only worth anything if it is one ask per
  // dispatch that actually needed an answer.
  const reviewerDispatches = dispatches.filter((d) => d.role === "adversarial-developer");
  const unreadableDispatches = reviewerDispatches.filter(
    (d) => parseVerdict(d.text).verdictParsed === false,
  );
  assert(
    reaskCalls.length === unreadableDispatches.length && reaskCalls.length >= 2,
    `(4) ${String(reviewerDispatches.length)} reviewer dispatches, ${String(unreadableDispatches.length)} unreadable → ${String(reaskCalls.length)} re-asks: one per dispatch that needed an answer, never two for one`,
  );
  // The records are the loop's own account of its ROUNDS — one per round number,
  // each carrying the re-asked status and the flag that says where it came from.
  // The ladder's re-dispatches of a round are not rounds, and a claim pinned to
  // the dispatch count would fail on a retry rather than on the thing it means.
  assert(
    r.adversarialRounds?.every((x) => x.verdictParsed === true && x.verdictFromReask === true) ===
      true &&
      new Set(r.adversarialRounds?.map((x) => x.round)).size ===
        (r.adversarialRounds?.length ?? 0) &&
      (r.adversarialRounds?.length ?? 0) >= 2,
    `(4) and the round records (n=${String(r.adversarialRounds?.length)}, rounds ${String((r.adversarialRounds ?? []).map((x) => x.round).join("/"))}) each carry a re-asked, parsed verdict, one per round number`,
  );
}

// ── (5) a re-ask that fails is today's infra-failure, never a pass ──────────
{
  for (const reason of ["no-session", "spawn-failed", "timeout", "no-answer"] as const) {
    reaskAnswer = { ok: false, reason };
    const r = await drive(SHAPES[0]?.lines.join("\n") ?? "");
    assert(
      r.loopOutcome === "infra-failure" && r.text.includes("produced no readable VERDICT marker"),
      `(5) a re-ask that fails (${reason}) is the infra-failure, never a verdict`,
    );
  }
  // A round whose reviewer left no session file cannot be re-asked at all.
  reaskAnswer = answered("VERDICT: APPROVED");
  reaskCalls = [];
  armReviewer({ reply: SHAPES[0]?.lines.join("\n") ?? "" });
  // The child reported no session file for this dispatch — the case a reviewer
  // whose transcript was never written produces.
  setNextTranscript("");
  const noSession = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "no transcript",
      workCwd: process.cwd(),
      branch: "fix/fenced-verdict-no-session",
      reportOnly: true,
      reportRound: 1,
      reportVerdict: "routed",
      verdictReask: reask,
    },
    new AbortController().signal,
    "job-fenced-no-session",
  );
  // Nothing to ask, so nothing asked: the round keeps the infrastructure
  // failure it had before the re-ask existed, and no child is spawned against a
  // path the dispatch never produced.
  assert(
    noSession.loopOutcome === "infra-failure" &&
      noSession.text.includes("produced no readable VERDICT marker") &&
      reaskCalls.length === 0,
    `(5) a reviewer whose child left no session file: the infra-failure, and the seam was never asked (asked ${String(reaskCalls.length)})`,
  );
  setNextTranscript(undefined);
}

// ── (6) the prompt names no verdict value ───────────────────────────────────
{
  const values = ["APPROVED", "MINOR_OBSERVATIONS", "ISSUES_FOUND", "CRITICAL_ISSUES_FOUND"];
  const named = values.filter((v) => VERDICT_REASK_PROMPT.includes(v));
  assert(
    named.length === 0,
    `(6) the re-ask prompt names no verdict value (named: ${named.join(", ") || "none"})`,
  );
  assert(
    VERDICT_REASK_PROMPT.includes("`VERDICT:`"),
    "(6) and it still names the shape the answer must take",
  );
  assert(
    !/^```/m.test(VERDICT_REASK_PROMPT),
    "(6) and the prompt itself is not a fenced block that a model could copy",
  );
}

// ── (7) accounting and visibility ───────────────────────────────────────────
{
  reaskAnswer = answered("VERDICT: APPROVED");
  const r = await drive(SHAPES[0]?.lines.join("\n") ?? "");
  assert(
    r.transcriptPath === TRANSCRIPT,
    `(7) the round's transcript is still the reviewer's own session (${String(r.transcriptPath)})`,
  );
  assert(r.model === REVIEWER_MODEL, `(7) and its model is the reviewer's (${String(r.model)})`);
  assert(
    reaskCalls[0]?.transcriptPath === TRANSCRIPT,
    "(7) the re-ask was pointed at the reviewer's session file",
  );
  assert(
    reaskCalls[0]?.role === "adversarial-developer" && reaskCalls[0]?.boundMs === 300_000,
    `(7) same role as the reviewer, and its own short bound (${String(reaskCalls[0]?.boundMs)}ms)`,
  );
  // The re-ask's spend joined the totals; the round's attribution did not move.
  assert(
    r.usage?.input === REVIEWER_USAGE.input + REASK_USAGE.input &&
      r.usage.output === REVIEWER_USAGE.output + REASK_USAGE.output &&
      r.usage.cost === REVIEWER_USAGE.cost + REASK_USAGE.cost,
    `(7) usage totals include the re-ask child (input ${String(r.usage?.input)})`,
  );
  assert(
    r.text.includes(VERDICT_REASK_SOURCE_TAG) && r.text.includes("verdict obtained on re-ask"),
    "(7) and the result names the source the verdict came from",
  );
}

// ── (8) the reviewer's brief carries the placement instruction, by switch ───
{
  // The switch itself, pinned on its ONE reader rather than through behaviour:
  // default ON, only the literal "0" off, and read at CALL time so an operator
  // can flip it between the rounds of a live cycle.
  await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: undefined }, async () => {
    assert(adversarialVerdictReaskEnabled() === true, "(8) the re-ask is ON by default");
  });
  for (const value of ["0", "false", "off", "no"]) {
    let enabled = false;
    await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: value }, async () => {
      enabled = adversarialVerdictReaskEnabled();
    });
    assert(
      enabled === (value !== "0"),
      `(8) "${value}" ${value === "0" ? "switches it off — the one off value" : "does not switch it off"}`,
    );
  }
  assert(
    adversarialVerdictReaskEnabled() === true,
    "(8) and the reader is re-read per call: an unset env restores ON after the off arm",
  );
  /** The sentence the switch adds: everything the print site writes at the
   * verdict-placement seam, up to the blank line that ends the paragraph. */
  const INSTRUCTION_MARK = "The Output Format in your system prompt is a layout guide only";
  function instructionSentence(brief: string): string {
    const start = brief.indexOf(INSTRUCTION_MARK);
    if (start < 0) return "";
    const end = brief.indexOf("\n\n", start);
    return end < 0 ? brief.slice(start) : brief.slice(start, end);
  }
  const args = { diff: DIFF, context: "c", round: 1, maxRounds: 3 };
  const on = buildAdversarialPrompt(args);
  let off = "";
  await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
    off = buildAdversarialPrompt(args);
  });
  assert(
    on.includes("do not wrap your reply in a code fence") &&
      on.includes("as the LAST line of your reply"),
    "(8) switch on: the brief tells the reviewer where the verdict line goes",
  );
  assert(
    !off.includes("do not wrap your reply in a code fence"),
    "(8) switch off: the instruction is gone",
  );
  // The off arm is the on arm with exactly one sentence removed, and nothing
  // else: every other byte of the two briefs is the same, which is what "the
  // switch restores the pre-fix prompt" means in a test.
  const instruction = instructionSentence(on);
  assert(
    instruction.length > 0 && on.replace(`\n\n${instruction}`, "") === off,
    "(8) off arm is the on arm without the one sentence, byte for byte",
  );
  // The added sentence must not itself create the failure it prevents: no fence
  // opener, and no second menu. The menu lives in exactly one place, so a reply
  // that echoes the brief cannot be reading the instruction as a menu too.
  assert(
    !on.slice(on.indexOf("The Output Format in your system prompt")).startsWith("```"),
    "(8) and the instruction opens no fence of its own",
  );
  const menuLines = on.split("\n").filter((l) => /^VERDICT: /.test(l));
  assert(
    menuLines.length === 4,
    `(8) the brief still prints the menu exactly once — 4 lines at column 0 (${String(menuLines.length)})`,
  );
  assert(
    menuLines.every((l) => !/^\s/.test(l)),
    "(8) and every menu line sits at column 0 on this base",
  );
  const instructionAt = on.indexOf("The Output Format in your system prompt");
  const menuAt = on.indexOf("VERDICT: APPROVED");
  assert(
    instructionAt > menuAt,
    "(8) the instruction sits AFTER the menu, so it cannot become a second menu run",
  );
}

// ── (9) the ask is visible on a lifecycle channel, asserted BY VALUE ───────
// A `trace()` line is invisible in scrollback, so the ask must also reach the
// entry API. Attached to a fake ExtensionAPI that records what was appended —
// the tag, the label and the role are read off the entry's own data, not off a
// string that happens to contain the word "reask".
{
  const { attach, detach } = await import("../src/lifecycle-events.ts");
  interface Appended {
    customType: string;
    data: unknown;
  }
  const entries: Appended[] = [];
  const pi = {
    registerEntryRenderer: (_type: string, _r: unknown) => {},
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as Parameters<typeof attach>[0];
  attach(pi);
  reaskAnswer = answered("VERDICT: APPROVED");
  await drive(SHAPES[0]?.lines.join("\n") ?? "");
  detach();
  const steered = entries.filter((e) => (e.data as { kind?: string }).kind === "steered");
  assert(
    steered.length === 1,
    `(9) the re-ask emitted exactly one lifecycle event (got ${String(steered.length)})`,
  );
  const d = steered[0]?.data as
    | { steerSource?: string; label?: string; role?: string; jobId?: string }
    | undefined;
  assert(
    d?.steerSource === VERDICT_REASK_SOURCE_TAG && d.label === VERDICT_REASK_LABEL,
    `(9) and it names its source by value (${String(d?.steerSource)} / ${String(d?.label)})`,
  );
  assert(
    d?.role === "adversarial-developer" && d.jobId === "job-fenced-verdict-reask",
    `(9) and it is filed under the reviewer role and the loop's own job (${String(d?.jobId)})`,
  );
}

console.log(`\nre-ask ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
