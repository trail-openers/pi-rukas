#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK=0` is byte-identical to origin/main
 * (7b143e84a1) — the loop brief, the round records and the result text.
 *
 * Split from `test-adversarial-verdict-reask.ts` (AGENTS.md §12): that file asks
 * what the re-ask recovers, this asks what the switch TAKES AWAY, and the two
 * are compared against different things — the on arm against the fixtures, this
 * against the pre-feature goldens in
 * `lib/adversarial-verdict-reask-off-arm-golden.ts`. The house shape is
 * `test-lean-review-problem-off-arm.ts`: an off-arm golden that re-derived its
 * bytes from the modules under change could not catch those modules changing,
 * which is precisely what an off arm exists to catch.
 *
 * The previous dispatch of this issue also made a round the ladder lost get
 * recorded in the loop's round records — a behaviour the re-ask does not need
 * (a re-ask that fails leaves the round exactly as it was, and the loop's own
 * `rounds` array is not what that change touched). R0 makes it out of scope:
 * under `"0"` the records must be the pre-feature ones, and for an infra arm
 * those are `[]` while `roundsExecuted` counts the round that died. That
 * disagreement between the two fields is pinned here as it shipped, not fixed.
 *
 * What "byte-identical" covers, per R0: the reviewer's brief
 * (`buildAdversarialPrompt`), the loop's result `text`, `adversarialRounds`,
 * `roundsExecuted`, `loopOutcome`, `ok`, `transcriptPath`, `model` and `usage`.
 * `ms` is excluded — it is wall-clock by construction.
 * `agents-base/adversarial-developer.md` is not edited by this issue, so the
 * role prompt is not a surface this test compares.
 *
 * Offline: the real loop over stubbed spawns, no child, no model, no token.
 */

import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import type { ReaskOutcome, VerdictReaskFn } from "../src/adversarial-verdict-reask-child.ts";
import { adversarialVerdictReaskEnabled } from "../src/adversarial-verdict-reask.ts";
import {
  SHAPES,
  armReviewer,
  isolateLedger,
  reaskShapesAreFenced,
} from "./lib/adversarial-reask-fixtures.ts";
import {
  OFF_ARM_GOLDENS,
  OFF_ARM_SENTENCE,
  preFeatureBrief,
} from "./lib/adversarial-verdict-reask-off-arm-golden.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
isolateLedger();

// The shapes are the same four the on-arm suite drives, and they are re-checked
// against the reader's own rule here rather than trusted from the other file: an
// off arm that measured a reply the reader would have ACCEPTED would pass for the
// wrong reason.
reaskShapesAreFenced(assert);

const { runAdversarialLoop } = await import("../src/adversarial.ts");

const DIFF = "diff --git a/a.ts b/a.ts\n+export const draw = () => 1;\n";
/** A readable reply whose verdict the terminal round would have BLOCKED, so the
 * reportOnly arm lands on the loop's third result shape — the one a fenced round
 * reaches once the re-ask answers. It never came out of the re-ask, so its
 * verdict must not be able to pick up the re-ask's clause. */
const CRITICAL_REPLY =
  "VERDICT: CRITICAL_ISSUES_FOUND\n\n### CRITICAL\n- a.ts:1 — the bound is never armed";

/** The re-ask answer every case installs. It is answered, not absent: under `"0"`
 * the switch — not the missing stub — is what must keep the second child away,
 * and a case with no seam installed would pass even if the loop asked anyway. */
const ANSWER: ReaskOutcome = { ok: true, text: "VERDICT: APPROVED" };
let reaskCalls: Parameters<VerdictReaskFn>[0][] = [];
const reask: VerdictReaskFn = async (args) => {
  reaskCalls.push(args);
  return ANSWER;
};

/** The arms the loop can exit through, all of which the re-ask sits before (R4). */
type Arm = "reportOnly-routed" | "reportOnly-terminal" | "midloop";
function armParams(arm: Arm, branch: string): Record<string, unknown> {
  if (arm === "midloop") return { branch };
  return {
    branch,
    reportOnly: true,
    reportRound: 1,
    reportVerdict: arm === "reportOnly-terminal" ? "terminal" : "routed",
  };
}

/** Compare one result against its golden, field by field, and report which field
 * moved rather than only that something did. */
function compareGolden(key: string, r: Awaited<ReturnType<typeof runAdversarialLoop>>): void {
  const golden = OFF_ARM_GOLDENS[key];
  if (golden === undefined) {
    assert(false, `${key}: no golden was recorded for this arm`);
    return;
  }
  const fields: [string, unknown, unknown][] = [
    ["loopOutcome", r.loopOutcome, golden.loopOutcome],
    ["ok", r.ok, golden.ok],
    // Compared as a backtick-delimited pair, not as one string: the assertion's
    // own message then prints both arms verbatim, which is how a mutant's output
    // gets quoted here rather than reconstructed later. Backticks (not a fence) so
    // the pair survives the digest's `^✗` filter as one line.
    ["text", `\`${r.text}\``, `\`${golden.text}\``],
    [
      "adversarialRounds",
      JSON.stringify(r.adversarialRounds),
      JSON.stringify(golden.adversarialRounds),
    ],
    ["roundsExecuted", r.roundsExecuted, golden.roundsExecuted],
    ["transcriptPath", r.transcriptPath, golden.transcriptPath],
    ["model", r.model, golden.model],
    ["usage", JSON.stringify(r.usage), JSON.stringify(golden.usage)],
  ];
  const moved = fields.filter(([, got, want]) => got !== want);
  assert(
    moved.length === 0,
    `${key}: byte-identical to 7b143e84a1${
      moved.length
        ? ` — ${moved.length} field(s) moved: ${moved
            .map(
              ([name, got, want]) =>
                `${name} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
            )
            .join(" | ")}`
        : ` (${String(golden.text.length)}-char text, ${String(
            (golden.adversarialRounds ?? []).length,
          )} round record(s))`
    }`,
  );
}

// ── (1) the four fenced shapes, on the three arms the re-ask sits before ─────
for (const arm of ["reportOnly-routed", "reportOnly-terminal", "midloop"] as Arm[]) {
  for (const shape of SHAPES) {
    const key = `${arm}-${shape.key}`;
    reaskCalls = [];
    // Same reply on every round of a mid-loop pass: an empty queue makes the stub
    // answer with its default APPROVED, and a scripted test that asserted on a
    // reply it never queued would be judging a fiction.
    armReviewer({ reply: shape.lines.join("\n"), queue: [shape.lines.join("\n")] });
    let r: Awaited<ReturnType<typeof runAdversarialLoop>> | undefined;
    await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
      r = await runAdversarialLoop(
        {
          diff: DIFF,
          context: "fenced verdict off arm",
          workCwd: process.cwd(),
          ...armParams(arm, `fix/off-arm-${key}`),
        },
        new AbortController().signal,
        `job-off-arm-${key}`,
      );
    });
    if (r === undefined) throw new Error(`${key}: the off arm did not run`);
    compareGolden(key, r);
    assert(
      reaskCalls.length === 0,
      `${key}: and the re-ask seam was never asked (${String(reaskCalls.length)} calls)`,
    );
    assert(
      !r.text.includes("verdict obtained on re-ask"),
      `${key}: nothing in the result claims a re-ask the loop never ran`,
    );
  }
}

// ── (2) a normal readable reply: also byte-identical, and also never asked ───
{
  const readable: [string, string][] = [
    ["readable-issues", "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- a.ts:1 — no test"],
    ["readable-approved", "VERDICT: APPROVED\n\nNo issues found."],
  ];
  for (const [key, reply] of readable) {
    reaskCalls = [];
    armReviewer({ reply });
    let r: Awaited<ReturnType<typeof runAdversarialLoop>> | undefined;
    await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
      r = await runAdversarialLoop(
        {
          diff: DIFF,
          context: "readable reply off arm",
          workCwd: process.cwd(),
          reportOnly: true,
          reportRound: 1,
          reportVerdict: "routed",
          branch: `fix/off-arm-${key}`,
        },
        new AbortController().signal,
        `job-off-arm-${key}`,
      );
    });
    if (r === undefined) throw new Error(`${key}: the off arm did not run`);
    compareGolden(key, r);
    // The on arm's own prize — the round record's `verdictFromReask` — must not
    // appear on a round the reviewer signed, which is also true with the switch
    // on; pinned here because this is the arm an operator reads as "reverted".
    assert(
      (r.adversarialRounds ?? []).every((rec) => !("verdictFromReask" in rec)),
      `${key}: no round record carries verdictFromReask`,
    );
    assert(reaskCalls.length === 0, `${key}: and the seam was never asked`);
  }
}

// ── (3) the brief: the on arm with exactly the one sentence removed ──────────
{
  const args = { diff: DIFF, context: "fenced verdict off arm", round: 1, maxRounds: 3 };
  let on = "";
  let off = "";
  await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: undefined }, async () => {
    on = buildAdversarialPrompt(args);
  });
  await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
    off = buildAdversarialPrompt(args);
  });
  const golden = preFeatureBrief(on);
  assert(
    golden.length > 0 && off === golden,
    `(3) the off-arm brief equals the pre-feature brief byte for byte (${String(
      off.length,
    )} vs ${String(golden.length)} chars)`,
  );
  assert(
    OFF_ARM_SENTENCE.length > 0 &&
      on.includes(OFF_ARM_SENTENCE) &&
      !off.includes(OFF_ARM_SENTENCE) &&
      on.length === off.length + OFF_ARM_SENTENCE.length + 2,
    `(3) and the difference between the two arms is exactly that one sentence plus its blank line (brief ${String(
      on.length,
    )} vs ${String(off.length)} chars, sentence ${String(OFF_ARM_SENTENCE.length)})`,
  );
  assert(
    adversarialVerdictReaskEnabled() === true,
    "(3) the switch is back ON after the off arm: the reader is re-read per call",
  );
  // The third reportOnly shape — the rejection a blocking verdict produces. This
  // is the arm a fenced round REACHES when the re-ask answers, so the clause the
  // on arm prepends must be provably absent here: the re-ask did not sign this
  // verdict and the round must not read as though it did.
  reaskCalls = [];
  armReviewer({ reply: CRITICAL_REPLY });
  let blocked: Awaited<ReturnType<typeof runAdversarialLoop>> | undefined;
  await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
    blocked = await runAdversarialLoop(
      {
        diff: DIFF,
        context: "blocking verdict off arm",
        workCwd: process.cwd(),
        reportOnly: true,
        reportRound: 1,
        reportVerdict: "routed",
        branch: "fix/off-arm-blocked",
      },
      new AbortController().signal,
      "job-off-arm-blocked",
    );
  });
  assert(
    blocked?.loopOutcome === "rejected" &&
      blocked.text === CRITICAL_REPLY &&
      !blocked.text.includes("verdict obtained on re-ask") &&
      reaskCalls.length === 0,
    `(3) a readable blocking verdict keeps its own text verbatim and is never asked (${String(
      blocked?.text.length,
    )} chars)`,
  );
}

// ── (4) the off arm also restores the pre-feature SHAPE of every result ──────
// The strongest form of the claim, and the one a same-file golden cannot make on
// its own: the off arm's result and a result built from origin/main's own field
// list are the same object. The pre-feature `infraFailureResult` left
// `adversarialRounds` as `toRoundRecords([])` — an EMPTY array — while counting
// the round in `roundsExecuted`; the loop's readable arms never set the field at
// all. A key that the base never emitted, present here, fails this arm and is
// caught no matter what the goldens say.
{
  const keysOf = (o: object): string[] => Object.keys(o).sort();
  /** The keys a pre-feature `synthesizeResult` / `infraFailureResult` emitted.
   * Written out, not derived from the module under change. */
  const BASE_SYNTH_KEYS = [
    "adversarialRounds",
    "exitCode",
    "loopOutcome",
    "model",
    "ms",
    "ok",
    "role",
    "roundsExecuted",
    "text",
    "toolUses",
    "transcriptPath",
    "usage",
  ];
  const BASE_INFRA_KEYS = [
    "adversarialRounds",
    "exitCode",
    "loopOutcome",
    "model",
    "ms",
    "ok",
    "role",
    "roundsExecuted",
    "text",
    "toolUses",
    "transcriptPath",
    "usage",
  ];
  const arm = async (armName: Arm, key: string, reply: string) => {
    reaskCalls = [];
    armReviewer({ reply, queue: [reply] });
    let r: Awaited<ReturnType<typeof runAdversarialLoop>> | undefined;
    await withEnv({ PI_ENSEMBLE_ADVERSARIAL_VERDICT_REASK: "0" }, async () => {
      r = await runAdversarialLoop(
        {
          diff: DIFF,
          context: "off arm shape",
          workCwd: process.cwd(),
          ...armParams(armName, `fix/shape-${key}`),
        },
        new AbortController().signal,
        `job-shape-${key}`,
      );
    });
    if (r === undefined) throw new Error(`${key}: shape arm did not run`);
    return r;
  };

  const infra = await arm("reportOnly-routed", "shape-infra", SHAPES[0]?.lines.join("\n") ?? "");
  const infraExtra = keysOf(infra).filter((k) => !BASE_INFRA_KEYS.includes(k));
  assert(
    infraExtra.length === 0 &&
      Array.isArray(infra.adversarialRounds) &&
      infra.adversarialRounds.length === 0,
    `(4) infra arm: no key the base did not emit (extra: ${infraExtra.join(", ") || "none"}) and adversarialRounds is the pre-feature empty array (got ${JSON.stringify(
      infra.adversarialRounds,
    )}) while roundsExecuted says ${String(infra.roundsExecuted)}`,
  );

  const readable = await arm("reportOnly-routed", "shape-readable", "VERDICT: APPROVED\n\nnice");
  const readableExtra = keysOf(readable).filter((k) => !BASE_SYNTH_KEYS.includes(k));
  assert(
    readableExtra.length === 0 && !("verdictFromReask" in (readable.adversarialRounds?.[0] ?? {})),
    `(4) readable arm: no key the base did not emit (extra: ${readableExtra.join(", ") || "none"}) and its round record has no verdictFromReask`,
  );

  const blocked = await arm("reportOnly-routed", "shape-blocked", CRITICAL_REPLY);
  const blockedExtra = keysOf(blocked).filter((k) => !BASE_SYNTH_KEYS.includes(k));
  assert(
    blockedExtra.length === 0 &&
      blocked.text === CRITICAL_REPLY &&
      !("verdictFromReask" in (blocked.adversarialRounds?.[0] ?? {})),
    `(4) blocked arm: no key the base did not emit (extra: ${blockedExtra.join(", ") || "none"}), its text is the reply's own, and the record carries no verdictFromReask`,
  );
}

console.log(
  `\noff-arm goldens ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`,
);
process.exit(failures());
