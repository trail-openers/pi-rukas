#!/usr/bin/env bun
/**
 * #638 deliverable 3 (task-b) — the reference-kind grounding contract and
 * the REF_RE prose-fallback honesty, unit-tested in isolation.
 *
 * The `reference` kind was fabricatable on an empty repo: its definition
 * ("a file/pattern already in the work area") admitted no honest value, so
 * the model invented paths — through TWO independent channels:
 *
 *   1. the two definitional copies (the report_plan_item TypeBox schema in
 *      plan-reporter.ts and the shared PLAN_REPORTER_PROMPT "Kind meanings"
 *      block in plan-angles.ts, which every angle task text composes) —
 *      both must now state the grounding constraint (existence confirmed by
 *      a live tool call in this session) and the honest-absence carve-out,
 *      and both must agree;
 *   2. draftSpec's REF_RE prose fallback — when an angle emitted zero
 *      structured reference items, every path-shaped token in its prose
 *      rendered with the suffix "existing pattern or affected surface;
 *      verify before editing", labelling invented paths as real code. The
 *      fallback survives (it is the DEFAULT path for an honest greenfield
 *      angle) but no longer attributes existence.
 *
 * No dispatch stubs: this suite drives the exported seams directly
 * (REFERENCE_KIND_DEFS, anglePromptsFor, draftSpec, extractPlanItems).
 */

import { anglePromptsFor } from "../src/plan-angles.ts";
import { PROSE_REF_SUFFIX, draftSpec, extractPlanItems } from "../src/plan-draft.ts";
import type { AngleFindings } from "../src/plan-draft.ts";
import { PLAN_ITEM_KINDS, REFERENCE_KIND_DEFS } from "../src/plan-reporter.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };

function findingsFor(
  name: string,
  text: string,
  items: { kind: string; text: string }[],
): AngleFindings[] {
  return [
    {
      name,
      ok: true,
      text,
      toolUses: extractPlanItems(
        items.map((i) => ({ name: "report_plan_item", arguments: { kind: i.kind, text: i.text } })),
        name,
      ),
    },
  ];
}

function referencesSection(body: string): string {
  const start = body.indexOf("## References");
  const end = body.indexOf("## Test surface");
  return body.slice(start, end);
}

// --------------------------------------------------- Channel 1: the two definitional copies agree and are grounded
{
  // The definition is non-empty and names the live-evidence requirement —
  // existence confirmed by a tool call that ACTUALLY RETURNED the path.
  assert(
    REFERENCE_KIND_DEFS.reference.length > 80,
    "ref-def: the shared definition is substantial",
  );
  assert(
    /codebase_memory_search_code/.test(REFERENCE_KIND_DEFS.reference),
    "ref-def: the definition names codebase_memory_search_code as grounding evidence",
  );
  assert(
    /actually returned/i.test(REFERENCE_KIND_DEFS.reference),
    "ref-def: the definition requires the search to have ACTUALLY returned the path",
  );
  assert(
    /guessed in prose/i.test(REFERENCE_KIND_DEFS.reference),
    "ref-def: the definition forbids a path merely named or guessed in prose",
  );
  assert(
    /exactly ONE reference item stating what you searched/i.test(REFERENCE_KIND_DEFS.reference),
    "ref-def: the definition allows absence as exactly one honest item",
  );
  // The old framing is gone from the shared constant.
  assert(
    !REFERENCE_KIND_DEFS.reference.includes("already exists and is in the work area"),
    "ref-def: the old framing ('already exists and is in the work area') is gone",
  );

  // Copy A — the TypeBox schema: the kind description string must CONTAIN
  // the shared definition verbatim (it is composed into the union's
  // description), and the definition must name the kind itself.
  assert(
    REFERENCE_KIND_DEFS.reference.startsWith("reference ("),
    "ref-def: the shared constant names the 'reference' kind",
  );

  // Copy B — PLAN_REPORTER_PROMPT "Kind meanings": every angle prompt
  // composes it, so one angle prompt's text pins the whole constant.
  const bugAngles = anglePromptsFor("bug", "a tool crashes on a stale verdict", [], []);
  const anyPrompt = bugAngles[0]?.prompt ?? "";
  assert(
    anyPrompt.includes(REFERENCE_KIND_DEFS.reference),
    "lockstep: the angle prompt (PLAN_REPORTER_PROMPT copy) contains the shared definition VERBATIM",
  );

  // The per-angle task text carries its OWN grounding instruction (the third
  // site the ticket names) — present independently of the shared kind
  // definition, so the child cannot see the constraint in only one place.
  assert(
    /GROUNDING: a `reference` kind item is ONLY a path your live tool calls/.test(anyPrompt),
    "per-angle: the task text carries its own grounding instruction for reference items",
  );
  assert(
    anyPrompt.toLowerCase().includes("never invent or guess a path"),
    "per-angle: the grounding instruction forbids inventing or guessing a path",
  );

  // The per-angle task texts that NAME the references deliverable must not
  // smuggle the existence framing — the affected-code angle asks for "affected[]
  // + references", which is a deliverable name, not a definition.
  const affected = bugAngles.find((a) => a.name === "affected-code");
  assert(affected !== undefined, "angle: affected-code is dispatched for a bug");
  assert(
    !/existing pattern or affected surface/i.test(affected?.prompt ?? ""),
    "angle: the affected-code task text does not label references as 'existing pattern or affected surface'",
  );
  assert(
    !/(?:a file[/.]pattern already in the work area)/i.test(anyPrompt),
    "lockstep: the old PLAN_REPORTER_PROMPT framing ('already in the work area') is gone",
  );

  // The kind list itself is untouched (no new kind added by the fix).
  assert(PLAN_ITEM_KINDS.includes("reference"), "kinds: 'reference' is still a plan item kind");
  assert(PLAN_ITEM_KINDS.length === 6, "kinds: the kind list has not grown (no seventh kind)");
}

// --------------------------------------------------- Channel 2: the REF_RE prose fallback no longer attributes existence
{
  // (1) THE FABRICATION the ticket describes: an angle with ZERO structured
  //     reference items whose prose names path-shaped tokens (the greenfield
  //     shape — the angle invents candidate file names). Those tokens must
  //     NOT render with the old "existing pattern or affected surface"
  //     label, and must render with the honest to-be-created flag.
  const fabricated = findingsFor(
    "affected-code",
    "I would add extension/src/foo/bar.ts for the retry logic, plus extension/src/baz.ts for the config.",
    [],
  );
  const { body } = draftSpec(
    "bug",
    "a tool crashes on a stale verdict",
    fabricated,
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const refs = referencesSection(body);
  assert(
    refs.includes("extension/src/foo/bar.ts"),
    "fallback: the prose path token is still rendered (the scan survives)",
  );
  assert(
    refs.includes("extension/src/baz.ts"),
    "fallback: the second prose path token is rendered",
  );
  assert(
    !refs.includes("existing pattern or affected surface"),
    "fallback: the old 'existing pattern or affected surface' label is GONE",
  );
  assert(refs.includes(PROSE_REF_SUFFIX), "fallback: the honest to-be-created suffix is rendered");
  assert(
    /NOT confirmed to exist/i.test(refs),
    "fallback: the suffix flags the path as NOT confirmed to exist",
  );

  // (2) Structured reference items take precedence (existing behaviour —
  //     pinned so the fallback never shadows a genuine structured report).
  const structured = findingsFor(
    "affected-code",
    "I would add extension/src/invented.ts but the real seam is elsewhere.",
    [{ kind: "reference", text: "extension/src/plan-driver.ts — the gap-gate loop seam" }],
  );
  const structuredBody = draftSpec(
    "bug",
    "a tool crashes on a stale verdict",
    structured,
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  ).body;
  const structuredRefs = referencesSection(structuredBody);
  assert(
    structuredRefs.includes("extension/src/plan-driver.ts — the gap-gate loop seam"),
    "precedence: structured reference items render verbatim",
  );
  assert(
    !structuredRefs.includes("extension/src/invented.ts"),
    "precedence: the prose scan does NOT fire when structured references exist",
  );
  assert(
    !structuredRefs.includes(PROSE_REF_SUFFIX),
    "precedence: the prose suffix is absent when structured refs exist",
  );

  // (3) The honest-absence case: zero structured references AND zero
  //     path-shaped tokens in the prose renders the single honest fallback
  //     line (the search instruction), not fabricated entries.
  const honestAbsence = findingsFor(
    "affected-code",
    "Nothing exists yet; the descriptor names no code.",
    [],
  );
  const { body: absenceBody } = draftSpec(
    "bug",
    "a tool crashes",
    honestAbsence,
    [],
    [],
    [],
    0,
    NO_DIRS,
    [],
  );
  const absenceRefs = referencesSection(absenceBody);
  assert(
    absenceRefs.includes(
      "run `codebase_memory_search_code` over the descriptor's identifiers during /work",
    ),
    "absence: zero references + no path tokens renders the honest search-instruction fallback",
  );
  assert(
    !absenceRefs.includes(PROSE_REF_SUFFIX),
    "absence: no prose-ref suffix when no path tokens exist",
  );

  // (4) Canary: the old shape WOULD have been caught.
  const oldSuffix = "existing pattern or affected surface; verify before editing";
  assert(
    referencesSection(draftSpec("bug", "x", fabricated, [], [], [], 0, NO_DIRS, []).body).includes(
      oldSuffix,
    ) === false,
    "canary: re-rendering the fabrication with the live code does NOT produce the old label",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
