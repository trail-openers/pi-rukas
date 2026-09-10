#!/usr/bin/env bun
/**
 * #639 DEFECT 1 (Cause 1a) — sub-issue reconciliation across angles.
 *
 * draftSpec's epic sub-issue section used to concatenate `sub-issue` items
 * from ALL angles (itemsByKind: a bare flatMap + filter) with a running
 * index and no dedupe — an epic pinning 5 sub-issues rendered 9/10/8 across
 * three runs. The reconciliation is EXACT NORMALISED TEXT ONLY (trim,
 * collapse internal whitespace, lowercase — no fuzzy/semantic matching) and
 * applies to the sub-issue kind ONLY (the other kinds legitimately
 * aggregate across angles via itemsByKind).
 *
 * Invariants pinned here:
 *
 *   - two angles emit sub-issue items whose text differs only by leading /
 *     trailing / internal whitespace or case → exactly ONE checkbox, and the
 *     surviving copy carries the CHARTED angle's (decomposition-surface)
 *     provenance suffix + wording,
 *   - numbering is a contiguous running index 1..k over the deduped list in
 *     emission order (chartered-angle preference is a collision-resolution
 *     rule only — it does NOT reorder),
 *   - the dedupe key is normalised text; the RENDERED checkbox keeps the
 *     chartered copy's original wording (only the key is normalised),
 *   - negative canary: two genuinely different sub-issues are NOT merged.
 *   - reconciliation applies to the sub-issue kind only: acceptance-
 *     criterion items from two angles still aggregate (the Test surface /
 *     References sections legitimately pool across angles).
 */

import { draftSpec, extractPlanItems, itemsByKind } from "../src/plan-draft.ts";
import { anglePromptsFor } from "../src/plan-angles.ts";
import { setPlanDispatch } from "../src/plan-driver.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };

function sub(text: string, angle: string) {
  return extractPlanItems(
    [{ name: "report_plan_item", arguments: { kind: "sub-issue", text, angle } }],
    angle,
  );
}

function epicBody(findings: Parameters<typeof draftSpec>[2]) {
  const { body } = draftSpec("epic", "epic descriptor", findings, [], [], [], 1, NO_DIRS, []);
  return body.slice(body.indexOf("## Sub-issues"));
}

// -------------------------------------- cross-angle dedupe (whitespace/case)

{
  // Two angles emit the SAME sub-issue differing only by case + leading /
  // internal / trailing whitespace. Exactly one checkbox must survive, with
  // the chartered angle's (decomposition-surface) wording and suffix.
  // NOTE: the dedupe key normalises BOTH text and angle (trim/collapse/
  // lowercase), so the pair collides on the key regardless of case in the
  // angle name; the chartered ANGLE (decomposition-surface) wins the
  // collision by the exact angle-name match. The two source texts below
  // differ by case + internal/leading/trailing whitespace in the TEXT only.
  const findings = [
    {
      name: "success-criteria",
      ok: true,
      text: "summary",
      toolUses: sub("  retry BACKOFF config — Scope: THE retry module  ", "success-criteria"),
    },
    {
      name: "decomposition-surface",
      ok: true,
      text: "summary",
      toolUses: sub("Retry backoff config — scope: the retry module", "decomposition-surface"),
    },
  ];
  const section = epicBody(findings);
  const checkboxes = (section.match(/^- \[ \] /gm) ?? []).length;
  assert(checkboxes === 1, `cross-angle: exactly ONE checkbox for the case/whitespace-different pair (got ${checkboxes})`);
  assert(
    section.includes("(sub-issue 1, from decomposition-surface)"),
    "cross-angle: the surviving copy's provenance suffix names the CHARTED angle (decomposition-surface)",
  );
  assert(
    !section.includes("from success-criteria"),
    "cross-angle: the colliding angle's suffix is gone (it lost the collision)",
  );
  assert(
    section.includes("Retry backoff config — scope: the retry module (sub-issue 1, from decomposition-surface)"),
    "cross-angle: the surviving checkbox is the CHARTED copy's wording + suffix (only the dedupe key is normalised)",
  );
}

// ------------------------------- emission order preserved; numbering 1..k

{
  // Emission order: success-criteria emits TWO (a duplicate of the chartered
  // one, and a genuinely distinct one) BEFORE decomposition-surface emits
  // its chartered copies. The deduped list must keep emission order (the
  // chartered-angle preference is collision resolution ONLY — it does not
  // reorder) and renumber contiguously 1..k.
  const findings = [
    {
      name: "success-criteria",
      ok: true,
      text: "summary",
      toolUses: [
        ...sub("Retry backoff config — scope: retry", "success-criteria"),
        ...sub("Timeout surfaces — scope: spawn.ts", "success-criteria"),
      ],
    },
    {
      name: "decomposition-surface",
      ok: true,
      text: "summary",
      toolUses: [
        ...sub("retry backoff config — scope: retry", "decomposition-surface"),
        ...sub("Backoff constants — scope: config", "decomposition-surface"),
      ],
    },
  ];
  const section = epicBody(findings);
  // Deduped set, in emission order:
  //   1 "Retry backoff config — scope: retry" (collision → chartered copy)
  //   2 "Timeout surfaces — scope: spawn.ts" (success-criteria only → its own suffix)
  //   3 "Backoff constants — scope: config" (decomposition-surface only)
  const checkboxes = (section.match(/^- \[ \] /gm) ?? []).length;
  assert(checkboxes === 3, `emission order: 3 checkboxes after dedupe (got ${checkboxes})`);
  const order = [...section.matchAll(/\(sub-issue (\d+), from ([\w-]+)\)/g)].map((m) => ({
    n: Number(m[1]),
    angle: m[2],
  }));
  assert(
    JSON.stringify(order) ===
      JSON.stringify([
        { n: 1, angle: "decomposition-surface" },
        { n: 2, angle: "success-criteria" },
        { n: 3, angle: "decomposition-surface" },
      ]),
    `emission order: contiguous 1..k renumbering in emission order, chartered suffix only on the collision (got ${JSON.stringify(order)})`,
  );
  // The non-colliding success-criteria item keeps its OWN angle's suffix
  // (residual finding: the chartered preference applies only to the
  // surviving copy's TEXT in a true collision, never to the suffix of a
  // non-colliding item).
  assert(
    section.includes("Timeout surfaces — scope: spawn.ts (sub-issue 2, from success-criteria)"),
    "emission order: a non-colliding non-chartered item keeps its own angle's suffix",
  );
}

// ---------------------------- genuinely different sub-issues are NOT merged

{
  // Negative canary: exact-normalised-text matching means these two are
  // DIFFERENT text (mutually-exclusive architectures in the run-3
  // reproduction were genuinely different text — dedupe cannot remove them;
  // only the charter fix prevents them). They must both survive.
  const findings = [
    {
      name: "decomposition-surface",
      ok: true,
      text: "summary",
      toolUses: [
        ...sub("Importance is computed on the fly from telemetry with no schema change", "decomposition-surface"),
        ...sub("Importance is a stored TEXT column written by operators via migration v4", "decomposition-surface"),
      ],
    },
  ];
  const section = epicBody(findings);
  const checkboxes = (section.match(/^- \[ \] /gm) ?? []).length;
  assert(
    checkboxes === 2,
    `canary: genuinely different sub-issue texts are NOT merged (got ${checkboxes})`,
  );
}

// ------------------------------- reconciliation is sub-issue kind ONLY

{
  // The other kinds legitimately AGGREGATE across angles via itemsByKind:
  // two acceptance-criterion items with identical text from different angles
  // both reach the typed section (no reconciliation for that kind) — the
  // shared normalisation helper must NOT leak into itemsByKind.
  const items = [
    ...extractPlanItems(
      [{ name: "report_plan_item", arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "angle-a" } }],
      "angle-a",
    ),
    ...extractPlanItems(
      [{ name: "report_plan_item", arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "angle-b" } }],
      "angle-b",
    ),
  ];
  const findings = [
    { name: "angle-a", ok: true, text: "s", toolUses: items.slice(0, 1) },
    { name: "angle-b", ok: true, text: "s", toolUses: items.slice(1) },
  ];
  // itemsByKind itself is UN-RECONCILED: both identical items survive.
  const pooled = itemsByKind(findings, "acceptance-criterion");
  assert(
    pooled.length === 2,
    `itemsByKind: identical items from two angles are NOT deduped (got ${pooled.length}) — reconciliation must not leak into the shared helper`,
  );
  const { body } = draftSpec("feature", "d", findings, [], [], [], 0, NO_DIRS, []);
  const ac = body.slice(body.indexOf("## Acceptance criteria"), body.indexOf("## References"));
  const count = (ac.match(/- the tool registers/g) ?? []).length;
  assert(
    count === 1,
    `kind-scoped: identical acceptance-criterion items render once at the rendered line level (got ${count}) — the AC list dedupes textually by design`,
  );
}

// ---------------------------------------------------------- charter (1b)

{
  // #639 DEFECT 1 (Cause 1b): for type epic, decomposition-surface is the
  // ONLY angle whose prompt INVITES sub-issue emission, and success-criteria
  // EXPLICITLY forbids it. For a non-epic type, no angle prompt obliges
  // sub-issue emission.
  const epicAngles = anglePromptsFor("epic", "an epic descriptor", [], []);
  const dec = epicAngles.find((a) => a.name === "decomposition-surface");
  const suc = epicAngles.find((a) => a.name === "success-criteria");
  assert(!!dec, "charter: decomposition-surface is dispatched for an epic");
  assert(
    /report a sub-issue item|kind "sub-issue"/.test(dec?.prompt ?? ""),
    "charter: decomposition-surface prompt INVITES sub-issue emission (the only one that does)",
  );
  assert(
    /do NOT report sub-issue items/i.test(suc?.prompt ?? ""),
    "charter: success-criteria prompt EXPLICITLY instructs NOT to emit the sub-issue kind",
  );
  // No OTHER epic angle invites it.
  const otherEpic = epicAngles.filter((a) => a.name !== "decomposition-surface" && a.name !== "success-criteria");
  assert(
    otherEpic.every((a) => !/report a sub-issue item|kind "sub-issue"/.test(a.prompt)),
    "charter: no other epic angle prompt invites sub-issue emission",
  );
  // Non-epic: no angle prompt obliges sub-issue emission. (The charter
  // language is only in the two epic angle prompts; the shared kind menu's
  // "chartered" qualifier is a description, not an invitation.)
  for (const t of ["bug", "feature", "chore", "spike"] as const) {
    const real = anglePromptsFor(t, "a descriptor referencing plan-tool.ts", [], ["plan-tool.ts"]);
    assert(
      real.every((a) => !/report a sub-issue item/i.test(a.prompt)),
      `charter: for type ${t} no angle prompt obliges sub-issue emission`,
    );
  }
}

// --------------------------------------------------- #633 Fix 1: all-angles-failed guard

// The aggregate all-angles-failed guard is a PIPELINE-level invariant, so it
// needs the dispatch seam. test-plan-tool.ts owns the main pipeline test; this
// block exercises the guard in isolation with a minimal spike descriptor (one
// angle) so the file stays under the 500-line limit.

{
  setPlanDispatch(((pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text: "VERDICT: READY",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none — no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    // Phase 2 angle: prose-only, zero structured items
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "I investigated the scoping question but could not produce structured items.",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    } as never);
  }) as never);

  // Import runPlanPipeline directly (it's exported from plan-driver.ts).
  const { runPlanPipeline } = await import("../src/plan-driver.ts");
  const piStub = {};
  const result = await runPlanPipeline(piStub, {
    descriptor: "spike: investigate the feasibility of a new approach",
    dryRun: true,
  }, process.cwd());

  assert(result.filed === false, "Fix 1: all-angles-failed → not filed");
  assert(result.capHit === true, "Fix 1: all-angles-failed → capHit is true (distinct signal)");
  assert(
    /zero structured items/i.test(result.spec),
    "Fix 1: the spec text explains WHY (all angles returned zero structured items)",
  );
  assert(
    !result.spec.includes("## Acceptance criteria") && !result.spec.includes("## Sub-issues"),
    "Fix 1: no typed sections rendered (the spec is the failure message, not a draft spec)",
  );
  assert(
    /report_plan_item|plan-reporter/i.test(result.spec),
    "Fix 1: the failure message names the likely cause (reporter extension not loaded)",
  );
  assert(
    /scoping/i.test(result.spec),
    "Fix 1: the dispatched angle name (scoping) is named in the failure message",
  );

  // Cleanup
  setPlanDispatch(null);
}

// -------- clip contract: text clips, structure survives (vipune round 9)

{
  // #658 regression: the render budget's clip used to apply to the DECORATED
  // line, cutting mid-sentence and destroying the "(sub-issue N, from
  // angle)" attribution this suite parses as a contract. The clip now
  // applies to the sub-issue TEXT only, at every budget stage.
  const { epicSubIssues } = await import("../src/plan-angles.ts");
  const { clipItem, RENDER_BUDGETS } = await import("../src/plan-validate.ts");
  const longText = `Telemetry pipeline rework — scope: ${"introduce a bounded queue and backpressure so slow sinks cannot stall capture, ".repeat(8)}Deps: none (telemetry is self-contained)`;
  const findings = [
    {
      name: "decomposition-surface",
      ok: true,
      text: "",
      toolUses: [{ kind: "sub-issue", text: longText, angle: "decomposition-surface" }],
    },
  ];
  for (const budget of RENDER_BUDGETS) {
    const [line] = epicSubIssues(findings, (t) => clipItem(t, budget.itemClipChars));
    assert(
      (line ?? "").startsWith("- [ ] #N — ") &&
        (line ?? "").includes("…") &&
        (line ?? "").endsWith("(sub-issue 1, from decomposition-surface)"),
      `clip contract: prefix + clip marker + attribution all survive at itemClipChars=${budget.itemClipChars}`,
    );
    assert(
      (line ?? "").length <= budget.itemClipChars + 60,
      `clip contract: the decorated line is text-budget + fixed structure overhead (${(line ?? "").length})`,
    );
  }
  // Dedup still keys on FULL text: two long items identical only within the
  // clip window stay TWO sub-issues.
  const twin = [
    {
      name: "decomposition-surface",
      ok: true,
      text: "",
      toolUses: [
        { kind: "sub-issue", text: `${"same head ".repeat(50)}tail A`, angle: "decomposition-surface" },
        { kind: "sub-issue", text: `${"same head ".repeat(50)}tail B`, angle: "decomposition-surface" },
      ],
    },
  ];
  const twinLines = epicSubIssues(twin, (t) => clipItem(t, 220));
  assert(
    twinLines.length === 2,
    "clip contract: dedup keys on full text — clip-window-identical items are not merged",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
