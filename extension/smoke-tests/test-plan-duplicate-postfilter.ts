#!/usr/bin/env bun
/**
 * #1856 M3 — the deterministic post-filter on the duplicate-risk verdict.
 *
 * The prompt line and the candidate-set exclusion are pinned in
 * test-plan-duplicate-self.ts; this file pins what happens when the child
 * returns HIGH anyway. Every case drives the REAL barrier (`runInvestigation`)
 * or the real pipeline with one canned child reply, because the value the driver
 * halts on, the value the investigation cache stores and the value the body
 * discloses must be ONE object — which is why the filter runs inside
 * `runInvestigation`, before it returns.
 *
 * Base-behaviour evidence (the defect this fixes): the pre-#1856 modules copied
 * `plan-duplicate-self.ts` (the commit this branch was cut from) to a scratch
 * directory outside the repo and driven by a scratch probe there, which printed
 * `filingFailure.reason: "duplicate-risk"` with ZERO gap-gate dispatches for the
 * self-only reply below — the plan stopped before drafting and demanded a human
 * answer. Against this tree the same reply reaches drafting, which the block
 * marked "end to end" asserts outright. No committed test reads a git revision:
 * CI's checkout does not carry a branch commit.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { runInvestigation } from "../src/plan-investigate.ts";
import { assemblePriorContext } from "../src/plan-prior-context-assembly.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";

const DESC = "the plan duplicate check names the issue being planned as its own duplicate";

const RELATED = [
  { number: 1856, title: "duplicate check names its own issue", state: "OPEN" },
  { number: 103, title: "landed hybrid default", state: "CLOSED" },
  { number: 7, title: "an unrelated open issue", state: "OPEN" },
];

const inv: MechanicalInventory = { memory: [], related: RELATED, errors: [] };

const SELF_ONLY_HIGH =
  "DUPLICATE_RISK: high — this is #1856 (OPEN) restated verbatim; #1856 already covers this exact scope";

/** One barrier run with a canned duplicate-risk reply. */
async function barrier(
  reply: string,
  sourceIssue?: number,
  related: MechanicalInventory["related"] = RELATED,
) {
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: reply });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: "a self-only HIGH reaches drafting without a human turn",
            angle: "x",
          },
        },
      ],
    });
  }) as never;
  const localInv: MechanicalInventory = { memory: [], related, errors: [] };
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv: localInv,
    priorContext: assemblePriorContext(undefined, localInv).priorContext,
    codeIdentifiers: [],
    ...(sourceIssue === undefined ? {} : { sourceIssue }),
  });
  return res.duplicateRisk;
}

// ------------------------------------------- the downgrade rules, at the barrier

{
  const risk = await barrier(SELF_ONLY_HIGH, 1856);
  assert(
    risk?.level === "medium" && risk?.downgradedFrom === "high",
    `self-only HIGH: downgraded to medium with the reason recorded (got ${risk?.level}/${risk?.downgradedFrom})`,
  );
  assert(
    (risk?.excludedIssues ?? []).map((e) => e.number).join(",") === "1856",
    `self-only HIGH: the excluded issue is named (${(risk?.excludedIssues ?? [])
      .map((e) => `#${e.number}`)
      .join(",")})`,
  );
  assert(
    /subject/.test(risk?.downgradeReason ?? ""),
    "self-only HIGH: the downgrade reason is the driver's own sentence",
  );
}

{
  const risk = await barrier(
    "DUPLICATE_RISK: high — duplicates the plan's own split child #1856-2 verbatim",
    1856,
  );
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).some((e) => e.reason.includes("split child")),
    `a HIGH naming only the source issue's own split child is downgraded (got ${risk?.level})`,
  );
}

{
  // #1856 review round 5: the CLOSED-prior-art exclusion is GONE. A reply that
  // names the subject AND a CLOSED issue keeps the HIGH, exactly as it does on
  // main, whatever words the child used about the closed one. Both spellings the
  // four deleted rounds argued over are pinned here so the rule cannot creep back
  // in through a reworded test.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this; #103 is prior art for this",
    1856,
  );
  assert(
    risk?.level === "high" &&
      risk?.downgradedFrom === undefined &&
      risk?.excludedIssues === undefined,
    `a reply naming the subject plus a CLOSED issue called prior art keeps the HIGH (got ${risk?.level})`,
  );
}

{
  // The same shape with the CLOSED issue named on its own, which is the case
  // rule 5 used to downgrade on the strength of the prior-art word alone.
  const risk = await barrier("DUPLICATE_RISK: high — #103 is prior art", 1856);
  assert(
    risk?.level === "high" &&
      risk?.downgradedFrom === undefined &&
      risk?.excludedIssues === undefined,
    `a HIGH resting only on a CLOSED issue the child called prior art keeps the HIGH (got ${risk?.level})`,
  );
}

{
  // The reversal wording the old rule honoured: also a stop now.
  const risk = await barrier("DUPLICATE_RISK: high — reverses the landed decision in #103", 1856);
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `a CLOSED issue the child called a reversal target keeps the HIGH (got ${risk?.level})`,
  );
}

{
  // A CLOSED issue the child did NOT call prior art is a real duplicate: the
  // verdict stands even with the source issue named alongside it.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this, and #103 is unlanded duplicate work",
    1856,
  );
  assert(
    risk?.level === "high",
    `a CLOSED issue the child called unlanded duplicate work is not prior art (got ${risk?.level})`,
  );
}

{
  // #1856 review round 1 — references the `#N` extractor cannot read must FAIL
  // CLOSED. Each reply below names the subject and rests its other evidence on
  // an issue-shaped token that `namedIssueRefs` never emits, so on the pre-fix
  // base all four read as a self-only HIGH and were DOWNGRADED while main
  // halted. The base modules were copied to a scratch directory outside the repo
  // and driven by a scratch probe there, which printed base=medium for every
  // row marked CHANGED there — the regression, observed rather than argued.
  //
  // Round 2: these five are the shapes round 1's WORD LIST happened to enumerate.
  // They stay pinned here, and the eight it leaked on (`GH-12`, `ticket 12`,
  // `bug 12`, …) plus the two clause cases are pinned in
  // test-plan-duplicate-failclosed.ts — the structural rule that replaced the
  // list has to hold for every spelling, not just the listed ones. (The base
  // comparison for these was made outside the repo, on a copy of the pre-fix
  // modules in a scratch dir; no committed test reads a git revision.)
  for (const [shape, rationale] of [
    ["`issue 12`", "DUPLICATE_RISK: high — #1856 restates this; issue 12 covers this"],
    [
      "`…/issues/12`",
      "DUPLICATE_RISK: high — #1856 restates this, see https://github.com/trail-openers/pi-rukas/issues/12",
    ],
    [
      "`…/pull/12`",
      "DUPLICATE_RISK: high — #1856 restates this, see https://gitlab.example/o/r/-/pull/12",
    ],
    ["`PR 12`", "DUPLICATE_RISK: high — #1856 restates this and PR 12 covers the same scope"],
    [
      "a 21-digit `#…`",
      "DUPLICATE_RISK: high — #1856 restates this, cf. #999999999999999999999",
    ],
  ] as [string, string][]) {
    const risk = await barrier(rationale, 1856);
    assert(
      risk?.level === "high" && risk?.downgradedFrom === undefined,
      `an unaccounted issue reference (${shape}) keeps the HIGH instead of downgrading (got ${risk?.level})`,
    );
  }
}

{
  // A `#X-k` token whose parent is NOT the planned issue is somebody else's
  // decomposition, never this plan's own split child — the HIGH stands.
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 restates this, and #404-2 is the unlanded half",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `a hyphenated token whose parent is not the source keeps the HIGH (got ${risk?.level})`,
  );
}

{
  // The same shape, negated-proof: with no other number in the rationale, a
  // subject-only reply still downgrades — so the fail-closed gate above fires on
  // the un-accounted number, not on its own caution.
  const risk = await barrier("DUPLICATE_RISK: high — #1856 restates this verbatim", 1856);
  assert(
    risk?.level === "medium",
    `a rationale with no unaccounted number still downgrades on a subject-only HIGH (got ${risk?.level})`,
  );
}

{
  const risk = await barrier(
    "DUPLICATE_RISK: high — #1856 covers this, and #7 is an open duplicate too",
    1856,
  );
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    `a HIGH that also names another OPEN issue still halts (got ${risk?.level})`,
  );
}

{
  const risk = await barrier("DUPLICATE_RISK: high — this duplicates the whole area", 1856);
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    "a HIGH that names NO issue is not attributed to the subject and still halts",
  );
}

{
  // The absent marker: medium from the parser, never recorded as a downgrade —
  // a crashed child must not read as an intentional suppression.
  const risk = await barrier("I looked at the issues and could not decide.", 1856);
  assert(
    risk?.level === "medium" &&
      risk?.downgradedFrom === undefined &&
      risk?.excludedIssues === undefined,
    "an absent marker keeps today's proceed-without-verdict path, never a downgrade",
  );
}

{
  // No source issue: the filter is inert even against a self-naming HIGH — an
  // interactive /plan with no source behaves exactly as it does today.
  const risk = await barrier(SELF_ONLY_HIGH);
  assert(
    risk?.level === "high" && risk?.downgradedFrom === undefined,
    "no source issue: the same reply still halts (no exclusion, no downgrade)",
  );
}

{
  // A duplicate-risk reply that failed yields NO verdict at all: nothing to
  // downgrade, and the pipeline proceeds as it does today.
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ok: false, role: "explore", text: "", ms: 1, exitCode: 143 });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the barrier survives", angle: "x" },
        },
      ],
    });
  }) as never;
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv,
    priorContext: assemblePriorContext(undefined, inv).priorContext,
    codeIdentifiers: [],
    sourceIssue: 1856,
  });
  assert(
    res.duplicateRisk === undefined,
    "a failed duplicate-risk dispatch yields no verdict, so nothing is recorded as downgraded",
  );
}

{
  // #1856 review round 2 (MEDIUM): the killCause half of that gate. A child
  // KILLED at a bound can report `ok` with a half-written reply, and
  // `parseDuplicateRisk` defaults an absent marker to `medium` — so a killed
  // child used to read as a clean "no duplicate risk" verdict. Here the reply
  // DOES carry a HIGH that rules 1–2 would downgrade, and the kill must stop the
  // post-filter from acting on it: the HIGH is not downgraded and nothing is
  // recorded as excluded. Both halves matter — a filter that merely declined to
  // downgrade would still leave a `medium` verdict the driver files on.
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        ...base,
        role: "explore",
        text: SELF_ONLY_HIGH,
        killCause: "inactivity",
      });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the barrier survives", angle: "x" },
        },
      ],
    });
  }) as never;
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv,
    priorContext: assemblePriorContext(undefined, inv).priorContext,
    codeIdentifiers: [],
    sourceIssue: 1856,
  });
  assert(
    res.duplicateRisk === undefined,
    `a duplicate-risk child killed at a bound yields no verdict at all, so the HIGH is neither downgraded nor filed as medium (got ${res.duplicateRisk?.level ?? "no verdict"})`,
  );
  assert(
    res.duplicateRisk?.excludedIssues === undefined,
    "a killed child excludes nothing — no candidate is silently dropped on a partial reply",
  );
}

{
  // #1856 review round 3: the DONE half of the same gate. A child that reached
  // its bound and emitted the done signal exits `ok` with NO `killCause`, so the
  // round-2 gate let it through — and a reply truncated at the bound is just as
  // partial as one whose child was killed. With the done signal set, the HIGH is
  // neither downgraded nor filed: no verdict at all, nothing excluded.
  const dispatch = ((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        ...base,
        role: "explore",
        text: SELF_ONLY_HIGH,
        endedAsDone: "reported",
      });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the barrier survives", angle: "x" },
        },
      ],
    });
  }) as never;
  const res = await runInvestigation(dispatch, {} as never, {
    type: "bug",
    descriptor: DESC,
    repoRoot: process.cwd(),
    inv,
    priorContext: assemblePriorContext(undefined, inv).priorContext,
    codeIdentifiers: [],
    sourceIssue: 1856,
  });
  assert(
    res.duplicateRisk === undefined,
    `a duplicate-risk child that ended as DONE yields no verdict at all, so the HIGH is neither downgraded nor filed as medium (got ${res.duplicateRisk?.level ?? "no verdict"})`,
  );
  assert(
    res.duplicateRisk?.excludedIssues === undefined,
    "a child that ended as DONE excludes nothing — no candidate is dropped on a reply cut at the bound",
  );
}


// =============================== the driver's halt decision, end to end =====

interface RunOut {
  reason?: string;
  gate: number;
  spec: string;
}

async function pipelineRun(reply: string, sourceIssue?: number): Promise<RunOut> {
  let gate = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.role === "adversarial-developer") {
      gate++;
      return Promise.resolve({ ...base, role: spec.role, text: "VERDICT: READY" });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: reply });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: {
            kind: "acceptance-criterion",
            text: "a self-only HIGH reaches drafting without a human turn",
            angle: "x",
          },
        },
      ],
    });
  }) as never);
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESC, dryRun: true, ...(sourceIssue === undefined ? {} : { sourceIssue }) },
    process.cwd(),
  );
  return { reason: r.filingFailure?.reason, gate, spec: String(r.spec) };
}

{
  // On the pre-fix base (a copy taken outside the repo) this exact case reported
  // reason "duplicate-risk" with gate 0; here the run drafts and the body names
  // what was excluded.
  const r = await pipelineRun(SELF_ONLY_HIGH, 1856);
  assert(
    r.reason === undefined && r.gate >= 1,
    `self-only HIGH: the plan reaches drafting with zero human turns (reason ${r.reason ?? "none"}, gate ${r.gate})`,
  );
  assert(
    r.spec.includes("## Duplicate check — excluded candidates") && r.spec.includes("#1856"),
    "self-only HIGH: the drafted body names the issue the driver excluded",
  );
}

{
  const r = await pipelineRun(
    "DUPLICATE_RISK: high — #7 is an open issue that already covers this scope",
    1856,
  );
  assert(
    r.reason === "duplicate-risk" && r.gate === 0,
    `a HIGH naming another OPEN issue still halts before the gate (reason ${r.reason}, gate ${r.gate})`,
  );
  assert(
    !r.spec.includes("## Duplicate check — excluded candidates"),
    "a genuine halt renders no downgrade disclosure (only genuine HIGHs reach the halt)",
  );
}

{
  // No source issue: today's behaviour, byte for byte — the same reply halts.
  const r = await pipelineRun(SELF_ONLY_HIGH);
  assert(
    r.reason === "duplicate-risk" && r.gate === 0,
    `no source issue: the identical reply still halts (reason ${r.reason}, gate ${r.gate})`,
  );
}

setPlanDispatch(null);
process.exit(exit);
