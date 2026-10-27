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

import { parseOperatorDirectives } from "../src/plan-directives.ts";
import { runGate } from "../src/plan-driver-gate.ts";
import { correctiveRedraft } from "../src/plan-driver-redraft.ts";
import { type AngleFindings, draftSpec } from "../src/plan-draft.ts";
import { AC_FALLBACK, validateDraft } from "../src/plan-validate.ts";

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

function angle(name: string, kind: string, texts: string[]): AngleFindings {
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
  // AC-3 / PM decision 2: an outcome heading with no item behaves as if the
  // heading were absent — the existing fallback, the existing failure.
  const empty = draftSpec(
    "feature",
    "d",
    [],
    [],
    [],
    [],
    0,
    dirs("Done when:\nthe following must hold"),
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

{
  // PM decision 6: the outcome source rides on CorrectiveRedraftCtx AND its
  // GateRunArgs mirror. A channel that reached only round 1 would render the
  // operator's `Done when` bullets in the round-1 body and DROP them from the
  // body the gap gate then reviews and the pipeline files — the worst failure
  // shape, because the reviewed spec is not the filed spec.
  //
  // The fixture hands the gate a `directives` object with the outcome channel
  // EMPTY (exactly what a context param carrying only prose produces for a
  // caller that threaded nothing): the ONLY way the re-drafted body can carry
  // the bullets is the threaded `operatorOutcomes` field. Removing that one
  // field from plan-driver-gate.ts's CorrectiveRedraftCtx literal turns the
  // third assertion red — the pin is falsifiable, not decorative.
  const ctx = "Done when:\n- the tool registers\n- dryRun never files";
  const outcomes = parseOperatorDirectives(ctx).operatorOutcomes ?? [];
  assert(outcomes.length === 2, "round 2 fixture: the parser produced the outcome channel")
  const findings = [angle("test-surface", "edge-case", ["a pitfall the operator named"])];
  const bareDirectives = { ...parseOperatorDirectives(ctx), operatorOutcomes: [] };
  let title = "";
  let body = draftSpec(
    "feature",
    "d",
    findings,
    [],
    [],
    [],
    0,
    bareDirectives,
    [],
    undefined,
    undefined,
    outcomes,
  ).body;
  title = "t";

  const run = await runGate({
    dispatch: (async (_pi: unknown, spec: { prompt: string }) => ({
      ok: true,
      // Round 1 is the full GAP DETECTION review and its CRITICAL fires the
      // corrective re-draft; round 2 verifies the carried resolutions.
      text: spec.prompt.includes("SCOPED VERIFICATION")
        ? "VERDICT: READY"
        : "GAP: CRITICAL the criteria do not name the outcome — proposed resolution: the tool registers\nVERDICT: NEEDS_ITERATION",
      toolUses: [],
    })) as never,
    pi: {} as never,
    repoRoot: process.cwd(),
    type: "feature",
    descriptor: "d",
    getBody: () => body,
    setTitleBody: (t, b) => {
      title = t;
      body = b;
    },
    findings,
    inventoryContext: [],
    directives: bareDirectives,
    operatorOutcomes: outcomes,
    openQuestions: [],
    outOfScope: [],
    depth: 0,
    chosenBudget: { maxItemsPerSection: 20, itemClipChars: 400 },
    priorContext: [],
    settled: [],
    timed: ((_phase: string, fn: () => Promise<unknown>) => fn()) as never,
    correctiveRedraft: correctiveRedraft,
  });

  assert(run.halted === false, "round 2: the gate completed (no re-draft throw)");
  assert(title.length > 0, "round 2: the re-draft set the title (it really ran)");
  const ac = section(body, "Acceptance criteria", "References");
  assert(
    renders(ac, "the tool registers") && renders(ac, "dryRun never files"),
    "#1855 threading: the round-2 body renders the same operator outcome bullets as round 1",
  );
  assert(
    validateDraft("feature", body, 0, { operatorOmitted: [] }).ok,
    "#1855 threading: the re-drafted body still passes validateDraft",
  );
}

if (exit === 0) console.log("\n✓ test-plan-ac-outcome: all assertions passed");
process.exit(exit);
