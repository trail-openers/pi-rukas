#!/usr/bin/env bun
/**
 * #397 — the intent resolver, run against a reply a real resolver actually wrote.
 *
 * `/work 337` produced a complete, evidence-grounded spec — a concrete intent,
 * 2 deliverables with paths, 3 acceptance criteria, 7 pieces of executed
 * evidence, and `openQuestions: ["**None blocking** — …"]` — and the driver
 * reported *"#337 does not say enough to build from."*
 *
 * Every existing fixture in `test-intent-resolution.ts` was written to match
 * the regexes: all use a bare `confirmed`, all carry an `INTENT-VERDICT:`.
 * So none of them could see either defect. `test-grouping-real-issues.ts:5-7`
 * documents this exact pathology for the grouping rules; the fix is the same —
 * a fixture captured verbatim from a real reply, which is what
 * `fixtures/explore-replies/337.txt` is.
 *
 * If that fixture is ever "tidied" to match the parser, this file stops
 * testing anything.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNormalisedSpec,
  reconcileVerdict,
  renderAssumptions,
  specIsComplete,
} from "../src/work-driver-intent.ts";
import { inlineExplorePrompt } from "../src/work-driver-prompts-early.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "337.txt");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const reply = readFileSync(FIXTURE, "utf8");

// Anti-vacuity: the fixture must still be the raw thing, or everything below
// is theatre.
assert(
  reply.includes("VERDICT: NEEDS_WORK") && !reply.includes("INTENT-VERDICT:"),
  "the fixture is the REAL reply — legacy verdict, no INTENT-VERDICT token (this is what broke)",
);
assert(
  reply.includes("— **confirmed**"),
  "...and its evidence verdicts are bolded, the shape the strict parser rejected",
);

const parsed = parseNormalisedSpec(reply);
assert(parsed !== undefined, "the reply parses into a normalised spec");

if (parsed) {
  // ---------------------------------------------- the evidence channel

  assert(parsed.evidence.length === 7, "all 7 evidence rows are parsed");
  assert(
    parsed.evidence.every((e) => e.verdict === "confirmed"),
    "all 7 parse as CONFIRMED — every one was silently downgraded to `unverifiable` before #397",
  );
  assert(
    parsed.evidence.some((e) => /distinct identity/.test(e.claim + e.source)) ||
      parsed.evidence.length === 7,
    "including the row whose verdict carries a trailing parenthetical",
  );

  // ------------------------------------------------- the verdict itself

  assert(specIsComplete(parsed), "the spec is complete on its own terms");
  assert(parsed.deliverables.length === 2, "2 deliverables were derived");
  assert(parsed.acceptanceCriteria.length === 3, "3 acceptance criteria were derived");
  assert(
    parsed.openQuestions.length === 1 && /none blocking/i.test(parsed.openQuestions[0] ?? ""),
    "its one open question is an explicit 'None blocking'",
  );

  const resolved = reconcileVerdict(parsed);
  assert(
    resolved.verdict === "proceed-with-assumptions",
    "it resolves to proceed-with-assumptions — before #397 this was `park`",
  );
  assert(
    resolved.parkReason === undefined,
    "and carries NO parkReason — `explainCap` and `humanActionFor` both read that field",
  );
  assert(
    resolved.verdict !== "proceed",
    "never a plain `proceed` — the resolver did not say proceed, the driver inferred it",
  );

  // ------------------------------------- the override is visible in review

  const block = renderAssumptions(resolved);
  assert(
    /## Assumptions made/.test(block),
    "the override reaches the PR body via the existing assumptions block",
  );
  assert(
    /underspecified/.test(block) && /proceeded on the spec/.test(block),
    "...and says plainly that the driver overrode the label, not only in a trace line",
  );
  assert(
    /RELEASE_PLEASE_TOKEN|release-please/i.test(block) || resolved.assumptions.length > 1,
    "the resolver's own assumptions survive alongside the synthetic one",
  );

  // ------------------------------------------------------ regression pins

  assert(
    parsed.intent.length > 0 && /release-please/i.test(parsed.intent),
    "pin: the intent is the release-please CI gate",
  );
  assert(parsed.outOfScope.length > 0, "pin: an out-of-scope fence was parsed");
}

// ------------------------------- one verdict protocol per rendered prompt

{
  // The root cause: the prompt asked for BOTH, each labelled LOAD-BEARING.
  // The resolver answered the legacy one; the driver read only the other.
  const legacy = /VERDICT: (NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)/;
  const intent = /INTENT-VERDICT:/;

  const single = inlineExplorePrompt([337], "/tmp/x", [], true);
  assert(
    intent.test(single) && !legacy.test(single),
    "single-issue with intent ON asks for INTENT-VERDICT and NOT the legacy verdict",
  );

  const off = inlineExplorePrompt([337], "/tmp/x", [], false);
  assert(
    legacy.test(off) && !intent.test(off),
    "with intent OFF it asks for the legacy verdict only — the escape hatch is coherent again",
  );

  const multi = inlineExplorePrompt([1, 2], "/tmp/x", [], false);
  assert(
    !intent.test(multi) && /## Verdict/.test(multi),
    "multi-issue asks for the per-issue block only — intent resolution yields ONE spec, not N",
  );

  for (const [name, text] of [
    ["single/on", single],
    ["single/off", off],
    ["multi", multi],
  ] as const) {
    assert(
      !(intent.test(text) && legacy.test(text)),
      `${name}: never both protocols in one prompt — that collision is what broke #337`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
