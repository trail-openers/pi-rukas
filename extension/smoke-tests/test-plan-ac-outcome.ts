#!/usr/bin/env bun
/**
 * #1855 — the operator OUTCOME block as an Acceptance-criteria source.
 *
 * A feature plan filled `## Acceptance criteria` only from an `ACCEPTANCE
 * CRITERIA` directive block plus angle items, so an operator who stated the
 * outcome in prose ("Done when:" with bullets) had those bullets land ONLY in
 * the Prior context inventory. The plan then halted draft-invalid (exit 40)
 * with a section no angle was ever chartered to fill — 4 of 7 plan sessions on
 * one external factory, two of them the same issue twice.
 *
 * These cases pin the fix against the bytes that actually failed:
 *   - the golden fixture passes validateDraft at round 1, rendering verbatim;
 *   - operator outcomes carry the SAME authority as a directive block (they win
 *     over angle criteria, which move to Suggested additional criteria; they
 *     are never clipped or count-capped on the angle cap);
 *   - a heading with no item is no outcome at all (PM decision 2);
 *   - outcome bullets join the operator-line set the conflict stage judges
 *     investigation items against, and a drop is disclosed (PM decision 5);
 *   - the round-2 corrective re-draft renders the same operator bullets as
 *     round 1 (PM decision 6 — the threading cannot silently lose them);
 *   - a NEVER CLAIM phrase inside an outcome bullet halts (PM decision 8).
 */

import {
  AC_CRITERIA_FORBIDDEN,
  FEATURE_AC_CHARTER,
  anglePromptsFor,
} from "../src/plan-angles.ts";
import { parseOperatorDirectives } from "../src/plan-directives.ts";
import { draftInvalidHalt } from "../src/plan-driver-phases.ts";
import {
  type AngleFindings,
  type PlanItemKindName,
  draftSpec,
} from "../src/plan-draft.ts";
import { AC_FALLBACK, validateDraft } from "../src/plan-validate.ts";
import { runRound2Pin } from "./plan-ac-outcome-round2.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * What a real operator context parses to. The AC source is the PARSED
 * operator-outcome channel, never a hand-written directive field — a test that
 * set `acceptanceCriteria` by hand would pass with the parser never running.
 */
function dirs(context: string) {
  return parseOperatorDirectives(context);
}

function angle(name: string, kind: PlanItemKindName, texts: string[]): AngleFindings {
  return {
    name,
    ok: true,
    text: `${name} summary`,
    toolUses: texts.map((text) => ({ kind, text, angle: name })),
  };
}

/** Section text from `## heading` to `## next`, or to end-of-body when `next` is omitted. */
function section(body: string, heading: string, next?: string): string {
  const start = body.indexOf(`## ${heading}`);
  const end = next === undefined ? -1 : body.indexOf(`## ${next}`, start + 1);
  return start < 0 ? "" : body.slice(start, end < 0 ? undefined : end);
}

/** True when `item` is rendered as its own bullet in `sec`. */
function renders(sec: string, item: string): boolean {
  return sec.includes(`- ${item}\n`);
}
// ------------------------------------------------- #1855 operator outcomes

/** The golden fixture: the bytes that actually failed in the field. */
const OUTCOME_CTX = "Done when:\n- the tool registers\n- dryRun never files";

{
  // AC-1: a feature context whose ONLY outcome statement is the operator's
  // own `Done when` block passes validateDraft at the first round.
  const r = draftSpec("feature", "d", [], [], [], [], 0, dirs(OUTCOME_CTX), []);
  const ac = section(r.body, "Acceptance criteria", "References");
  assert(
    renders(ac, "the tool registers") && renders(ac, "dryRun never files"),
    "#1855 golden fixture: both operator outcome bullets render in the AC section",
  );
  assert(
    validateDraft("feature", r.body, 0, { operatorOmitted: [] }).ok,
    "#1855 golden fixture: validateDraft passes at round 1 (no exit 40)",
  );
}

{
  // Verbatim: no clipping, no re-wrapping, trailing punctuation survives.
  const r = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    dirs("Done when:\n- dryRun never files.\n- the tool registers with the exact TypeBox schema"),
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "References");
  assert(
    ac.includes("- dryRun never files.\n") &&
      ac.includes("- the tool registers with the exact TypeBox schema\n"),
    "#1855 verbatim: outcome bullets render exactly as the operator wrote them",
  );
}

{
  // Operator authority: outcome bullets win over angle criteria, which move
  // under Suggested additional criteria (same as a directive block, #1087).
  const r = draftSpec(
    "feature",
    "d",
    [angle("test-surface", "acceptance-criterion", ["CSV export works for users"])],
    [],
    [],
    [],
    0,
    dirs("Done when:\n- Users can export CSV"),
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "Suggested additional criteria");
  assert(
    ac.includes("- Users can export CSV") && !ac.includes("CSV export works for users"),
    "#1855 precedence: the operator outcome owns the AC section; the angle item does not sit beside it",
  );
  const sug = section(r.body, "Suggested additional criteria", "References");
  assert(
    sug.includes("- CSV export works for users"),
    "#1855 precedence: the angle criterion moves under Suggested additional criteria",
  );
}

{
  // Uncapped: 25 outcome bullets all render (the 20-item angle cap is not theirs).
  const ops = Array.from({ length: 25 }, (_, i) => `outcome ${i}`);
  const r = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    dirs(`Done when:\n${ops.map((s) => `- ${s}`).join("\n")}`),
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "References");
  assert(
    ops.every((s) => renders(ac, s)),
    "#1855 uncapped: all 25 operator outcome bullets render",
  );
}

{
  // De-duped among themselves on the normalised key; an angle criterion that
  // shares a key with an outcome bullet does not re-render.
  const r = draftSpec(
    "feature",
    "d",
    [angle("test-surface", "acceptance-criterion", ["the tool registers"])],
    [],
    [],
    [],
    0,
    dirs("Done when:\n- the tool registers\n- the tool registers\n- dryRun never files"),
    [],
  );
  const ac = section(r.body, "Acceptance criteria", "Suggested additional criteria");
  assert(
    (ac.match(/^- the tool registers$/gm) ?? []).length === 1,
    "#1855 dedupe: a repeated outcome bullet renders once",
  );
  const sug = section(r.body, "Suggested additional criteria", "References");
  assert(
    !sug.includes("the tool registers"),
    "#1855 dedupe: an angle criterion sharing a key with an outcome bullet is not re-rendered",
  );
}

{
  // PM decision 5: outcome bullets join the operator-line set the conflict
  // stage judges investigation items against, and a drop is DISCLOSED.
  const r = draftSpec(
    "feature",
    "d",
    [
      angle("test-surface", "edge-case", [
        "the tool never registers on start",
        "a pitfall with no bearing on the outcome",
      ]),
    ],
    [],
    [],
    [],
    0,
    dirs("Done when:\n- the tool registers on start"),
    [],
  );
  assert(
    r.body.includes('conflicts with operator decision "the tool registers on start"'),
    "#1855 conflict stage: an item contradicting an outcome bullet is dropped and disclosed",
  );
}

{
  // AC-3 / PM decision 2: an outcome heading whose block holds NO ITEM AT ALL
  // behaves as if the heading were absent — the existing fallback, the existing
  // failure. (Review round 1: a prose LEAD-IN before bullets is no longer one of
  // these — the lookahead scans the whole block, so those bullets count.)
  const empty = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    dirs("Done when:"),
    [],
  );
  assert(
    !validateDraft("feature", empty.body, 0, { operatorOmitted: [] }).ok,
    "#1855 empty heading: a lead-in with no item still fails validateDraft",
  );
  assert(
    empty.body.includes(AC_FALLBACK),
    "#1855 empty heading: the AC section falls back exactly as before",
  );
}

{
  // #1855 review round 1: the shapes the first-meaningful-line lookahead voided
  // by mistake. Each must now fill the AC section, because the parser's own loop
  // produces the bullet — a lookahead answering "no outcome" while the parser
  // produces an item is the #1855 bug wearing the lookahead's clothes.
  const shapes: [string, string][] = [
    ["Done when: the following must hold\n- the tool registers", "lead-in"],
    ["Done when:\n\n- the tool registers", "blank line"],
    ["Done when:\nBEGIN\n- the tool registers\nEND", "BEGIN fence"],
  ];
  for (const [ctx, label] of shapes) {
    const r = draftSpec("feature", "d", [], [], [], [], 0, dirs(ctx), []);
    const ac = section(r.body, "Acceptance criteria", "References");
    assert(
      renders(ac, "the tool registers"),
      `#1855 ${label} before the bullets: the outcome renders`,
    );
    assert(
      validateDraft("feature", r.body, 0, { operatorOmitted: [] }).ok,
      `#1855 ${label} before the bullets: validateDraft passes`,
    );
  }
}

{
  // PM decision 8: the NEVER CLAIM grammar is unchanged, but an outcome bullet
  // now rendered in the AC section is a GENERATED section — so a forbidden
  // phrase inside it halts rather than hiding under the inventory exemption.
  const ctx = `${OUTCOME_CTX}\nNEVER CLAIM:\n- the tool registers`;
  const withPhrase = draftSpec("feature", "d", [], [], [], [], 0, dirs(ctx), []);
  const v = validateDraft("feature", withPhrase.body, 0, {
    operatorOmitted: [],
    forbiddenPhrases: dirs(ctx).neverClaim,
  });
  assert(
    !v.ok && v.problems.some((p) => p.includes("forbidden phrase")),
    "#1855 never-claim: a NEVER CLAIM phrase inside an outcome bullet halts the draft",
  );
}



// --------------------------------------------- round 2 keeps the outcome ACs

await runRound2Pin(assert, section, renders, parseOperatorDirectives);

// --------------------------------------- the feature test-surface AC charter

{
  // PM decisions 3 + 4: the feature `test-surface` angle is the SOLE chartered
  // emitter of `acceptance-criterion` items and the other two feature prompts
  // forbid the kind. The assertion is made on each angle's OWN TASK CHARTER
  // (the marker string the charter appends), never on the shared
  // PLAN_REPORTER_PROMPT kind menu — which already listed the kind for every
  // angle of every type before this issue, so a "the prompt mentions
  // acceptance-criterion" assertion would pass on the unmodified prompts.
  const prompts = anglePromptsFor(
    "feature",
    "add a latency probe to extension/src/plan-tool.ts",
    [],
    ["plan-tool.ts", "runPlanPipeline"],
  );
  const byName = new Map(prompts.map((p) => [p.name, p.prompt]));
  assert(
    prompts.length === 3 && byName.size === 3,
    `feature angle set is prior-art + interfaces-and-contracts + test-surface (got ${[...byName.keys()].join(", ")})`,
  );
  const chartered = byName.get("test-surface") ?? "";
  assert(
    chartered.includes(FEATURE_AC_CHARTER),
    "charter: the feature test-surface prompt carries the AC-emission charter (charter-unique marker)",
  );
  for (const name of ["prior-art", "interfaces-and-contracts"]) {
    const prompt = byName.get(name) ?? "";
    assert(
      !prompt.includes(FEATURE_AC_CHARTER),
      `charter: the ${name} prompt does NOT carry the AC-emission charter (the marker is charter-unique)`,
    );
    assert(
      prompt.includes(AC_CRITERIA_FORBIDDEN),
      `charter: the ${name} prompt explicitly forbids the acceptance-criterion kind`,
    );
  }
  // The invite and the prohibition are two distinct charter-unique strings: a
  // shared-menu mention can satisfy neither.
  assert(
    FEATURE_AC_CHARTER.includes("ONLY feature angle chartered") &&
      AC_CRITERIA_FORBIDDEN.includes("Do NOT report acceptance-criterion items") &&
      !FEATURE_AC_CHARTER.includes(AC_CRITERIA_FORBIDDEN) &&
      !AC_CRITERIA_FORBIDDEN.includes(FEATURE_AC_CHARTER),
    // The two constants are distinct literals; the guard is that neither text
    // contains the other, so neither assertion can be satisfied by the shared
    // reporter kind menu (which mentions the kind for every angle of every type).
    "charter: the invite and the prohibition are distinct charter-unique strings, not the shared kind menu",
  );

  // The bug type's test-surface angle must NOT gain the charter: this issue is
  // scoped to feature plans.
  const bugPrompts = anglePromptsFor(
    "bug",
    "crash in extension/src/plan-tool.ts when labels are empty",
    [],
    ["plan-tool.ts"],
  );
  const bugTestSurface = bugPrompts.find((p) => p.name === "test-surface")?.prompt ?? "";
  assert(
    bugTestSurface.length > 0 && !bugTestSurface.includes(FEATURE_AC_CHARTER),
    "charter: the bug test-surface prompt is unchanged (no feature AC charter)",
  );
}


// ------------------------------------------- the halt names every source tried

{
  // AC-3: with neither an operator outcome nor an angle criterion the draft
  // still fails — and the failure text has to say so completely. Before #1855
  // it named only "an operator directive", which sent an operator who had
  // written `Done when:` bullets off to add an ACCEPTANCE CRITERIA block
  // carrying the very lines already sitting in their context.
  const r = draftSpec(
    "feature",
    "d",
    [angle("test-surface", "edge-case", ["a pitfall"])],
    [],
    [],
    [],
    0,
    dirs("Some prose with no outcome heading at all"),
    [],
  );
  const v = validateDraft("feature", r.body, 0, { operatorOmitted: [] });
  assert(!v.ok, "AC-3: no outcome and no angle criterion still fails validation");
  const text = v.problems.join(" ");
  assert(
    text.includes("ACCEPTANCE CRITERIA") &&
      text.includes("Done when") &&
      text.includes("Acceptance:") &&
      text.includes("test-surface"),
    `AC-3: the failure text names BOTH operator sources and the chartered angle (got ${text.slice(0, 160)})`,
  );
  assert(
    text.includes("heading with no bullet under it counts as no outcome"),
    "AC-3: the failure text states the empty-heading rule so the operator knows why their heading did not count",
  );

  // The halt detail (what the operator and an external headless caller read)
  // carries the same three-way remedy, not just the directive grammar.
  const halt = draftInvalidHalt({
    type: "feature",
    title: "t",
    spec: r.body,
    priorContext: [],
    problems: v.problems,
    failedAngles: [],
    timings: [],
  });
  const detail = halt.filingFailure?.detail ?? "";
  assert(
    detail.includes("ACCEPTANCE CRITERIA") &&
      detail.includes("Done when:") &&
      detail.includes("Acceptance criteria:"),
    `AC-3: the halt detail names the outcome headings as well as the directive block (got ${detail.slice(0, 200)})`,
  );
  assert(
    halt.filingFailure?.reason === "draft-invalid",
    "AC-3: the halt reason is unchanged (draft-invalid, exit 40)",
  );
}

if (exit === 0) console.log("\n✓ test-plan-ac-outcome: all assertions passed");
process.exit(exit);
