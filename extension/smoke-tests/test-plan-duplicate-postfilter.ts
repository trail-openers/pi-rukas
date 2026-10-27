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
 * from 98f02444 to /tmp/pi-ensemble-developer/base-1856/ and driven by
 * /tmp/pi-ensemble-developer/probe-base-halt.ts produced
 * `filingFailure.reason: "duplicate-risk"` with ZERO gap-gate dispatches for the
 * self-only reply below — the plan stopped before drafting and demanded a human
 * answer. Against this tree the same reply reaches drafting, which the block
 * marked "end to end" asserts outright.
 */

import type { MechanicalInventory } from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { duplicateExclusionSection } from "../src/plan-duplicate-self.ts";
import { filedBodyOf } from "../src/plan-gap-disclosure.ts";
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
  const risk = await barrier("DUPLICATE_RISK: high — reverses the landed decision in #103", 1856);
  assert(
    risk?.level === "medium" &&
      (risk?.excludedIssues ?? []).some((e) => e.number === 103 && e.reason.includes("prior art")),
    `a HIGH resting only on closed prior art the child named as a reversal is downgraded (got ${risk?.level})`,
  );
}

{
  // The GitLab shape: whatever case the forge's state arrived in, the rule holds.
  const risk = await barrier("DUPLICATE_RISK: high — reverses #103, already landed", 1856, [
    { number: 103, title: "landed hybrid default", state: "closed" },
    { number: 7, title: "unrelated", state: "open" },
  ]);
  assert(
    risk?.level === "medium",
    `a lower-case "closed" state still satisfies the prior-art rule (got ${risk?.level})`,
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
  // A failed duplicate-risk dispatch yields NO verdict at all: nothing to
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

// ------------------------------------- the disclosure at its one fixed site

{
  const risk = await barrier(SELF_ONLY_HIGH, 1856);
  const section = duplicateExclusionSection(risk, 1856);
  assert(
    /## Duplicate check — excluded candidates/.test(section) && section.includes("#1856"),
    "the disclosure names the excluded issue under its own heading",
  );
  assert(
    /downgraded to medium/.test(section),
    "the disclosure says the verdict was downgraded, not merely suppressed",
  );
  assert(
    filedBodyOf("BODY", [], [], undefined, section).includes(
      "## Duplicate check — excluded candidates",
    ),
    "filedBodyOf appends the section",
  );
  assert(
    filedBodyOf("BODY", [], [], undefined) === "BODY",
    "no disclosure → the filed body is byte-identical to today's",
  );
  assert(
    duplicateExclusionSection(risk, undefined) === "" &&
      duplicateExclusionSection(undefined, 1856) === "",
    "no source issue or no verdict → no section at all",
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
  // On base (98f02444) this exact case reported reason "duplicate-risk" with
  // gate 0; here the run drafts and the body names what was excluded.
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
