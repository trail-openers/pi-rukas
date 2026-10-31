#!/usr/bin/env bun
/**
 * AGENTS.md §7 is the single authoritative MAST block four other sites point
 * at, so a figure that silently leaves it orphans four pointers.
 *
 * This branch removed statistics attributed to the MAST taxonomy (Cemri et
 * al., arXiv 2503.13657) that the paper does not contain. When the citation
 * was collapsed, AGENTS.md §7's step-back paragraph became the one place the
 * real figures live; `agents-base/project-manager.md`, `work-driver-intent.ts`,
 * `work-driver-verify-pr17.ts` and the two rendered surfaces (`work-driver-
 * handoff-markdown.ts`, `work-driver-explain-other.ts`) all restate a subset
 * of it. Nothing enforced that the authoritative block still carries them.
 *
 * A gate that only asserts "the file mentions 15.7% somewhere" is worthless —
 * it stays green when the figure moves to an unrelated paragraph and §7 loses
 * it. So the scope is the §7 STEP-BACK PARAGRAPH specifically (identified by
 * its heading token, not by line number, so a reflow of the file does not
 * break the canary), and the assertion is on the facts it must contain.
 *
 * The FM-1.x scoping word is asserted TOGETHER with the superlative. That
 * scoping is the actual content of this branch: the paper's three top-level
 * categories are System Design Issues / Inter-Agent Misalignment / Task
 * Verification, and FM-1.3 at 15.7% is the largest mode only WITHIN FM-1.x —
 * the paper makes no cross-category ranking. A block that keeps "largest
 * single mode… 15.7%" while dropping "FM-1.x" has reverted to the fabrication
 * this branch removed, and must fail here.
 *
 * Asserted in BOTH directions, as `test-review-threshold-quote.ts` does: the
 * real §7 block contains everything it must, and a deliberately-deficient
 * copy of it is CAUGHT. A gate never observed to fail is worthless.
 */

import fs from "node:fs/promises";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const agentsMd = await fs.readFile(
  path.resolve(import.meta.dirname, "..", "..", "AGENTS.md"),
  "utf8",
);

/** The §7 step-back paragraph — the authoritative MAST block. */
function stepBackParagraph(text: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith("**Theme-clustered cap-hits get a step-back**"));
}

const PARA = stepBackParagraph(agentsMd);
assert(
  PARA !== undefined,
  "§7's step-back paragraph is found in AGENTS.md — the assertions below are derived from it, so an absence is this file failing, not passing vacuously",
);
// The paragraph must be a paragraph, not a stub: it is the whole taxonomy
// citation in one line, so a truncation looks like a hit to a token search.
assert(
  (PARA ?? "").length > 500,
  `the located line is the full paragraph, not a truncated stub (got ${(PARA ?? "").length} chars)`,
);

// Every figure the four pointing sites restate, and the two qualifiers that
// make them true. Spelled out individually so a failure names the figure lost.
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ["arXiv 2503.13657", "the paper is named by id, so a reader can reach the primary source"],
  ["System Design Issues 41.8%", "top-level category figure"],
  ["Inter-Agent Misalignment 36.9%", "top-level category figure"],
  ["Task Verification 21.3%", "top-level category figure"],
  ["FM-1.1", "FM-1 failure mode id"],
  ["11.8%", "FM-1.1 disobeying the task specification figure"],
  ["FM-1.2", "FM-1 failure mode id"],
  ["1.5%", "FM-1.2 disobeying the agent role figure"],
  ["FM-1.3", "FM-1 failure mode id"],
  ["15.7%", "FM-1.3 step repetition figure"],
  ["FM-1.4", "FM-1 failure mode id"],
  ["2.8", "FM-1.4 context loss figure"],
  ["FM-1.5", "FM-1 failure mode id"],
  ["12.4%", "FM-1.5 not recognising completion figure"],
  ["+15.6%", "the best orchestration-layer intervention's task-success gain"],
  ["objective-verification", "what that intervention actually was"],
  ["Appendix H", "where the paper's own limitation is stated"],
  ["top-level", "the word that scopes the three CATEGORY figures"],
  ["FM-1.x", "the word that scopes the superlative to the FM-1.x list"],
  ["largest single", "the superlative, scoped by FM-1.x above"],
];

for (const [token, why] of REQUIRED) {
  assert((PARA ?? "").includes(token), `§7's MAST block contains "${token}" (${why})`);
}

// --------------------------------------------- the two directions are distinct

// The superlative and its scope must be in the SAME clause, not merely both
// present in the paragraph — "largest single mode" two sentences from "FM-1.x"
// is exactly the unscoped fabrication the branch removed.
{
  const superIndex = (PARA ?? "").indexOf("largest single");
  const scopeIndex = (PARA ?? "").indexOf("FM-1.x");
  assert(
    superIndex >= 0 && scopeIndex >= 0 && Math.abs(superIndex - scopeIndex) < 40,
    `the superlative sits WITH its FM-1.x scope (offsets ${superIndex}/${scopeIndex}) — a superlative the scope word has drifted away from reads as a cross-category claim the paper never makes`,
  );
}

// "top-level" must belong to the three category figures and nothing else. The
// branch's founding error was calling FM-1.1 a top-level failure mode.
{
  const topLevelHits = (PARA ?? "").split("top-level").length - 1;
  assert(
    topLevelHits === 1,
    `"top-level" appears exactly once in the block, against the three category figures (got ${topLevelHits}) — more than one means a failure mode has been promoted to a category`,
  );
  const categories = ["System Design Issues", "Inter-Agent Misalignment", "Task Verification"];
  const firstCategory = (PARA ?? "").indexOf(categories[0]);
  const lastCategory = (PARA ?? "").indexOf("Task Verification");
  const topLevelIndex = (PARA ?? "").indexOf("top-level");
  assert(
    topLevelIndex >= 0 && topLevelIndex <= firstCategory + 40 && topLevelIndex < lastCategory,
    `the single "top-level" sits with the category list (top-level@${topLevelIndex}, categories @${firstCategory}..${lastCategory})`,
  );
}

// The one canonical grammar for the FM-1.3 superlative. Every site restating
// it uses these words; the point of the branch is that readers compare sites.
const SUPERLATIVE = "the largest single FM-1.x mode is step repetition FM-1.3 at 15.7%";

/**
 * A near-variant of the canonical superlative for this site — the wording the
 * site carried before this branch collapsed the variants. Returned so the
 * caller can assert the checker rejects it; `undefined` where the site has no
 * historical near-variant to test against.
 */
function nearVariant(file: string, body: string): string | undefined {
  const flat = body.replace(/^[ \t]*\*[ ]?/gm, "").replace(/\s+/g, " ");
  // The variant the site itself used, if it is still present in any form, is
  // the one worth negating; otherwise fall back to the generic unscope.
  for (const candidate of [
    "step repetition FM-1.3 is the largest FM-1.x mode at 15.7%",
    "within its FM-1.x list step repetition FM-1.3 is the largest mode at 15.7%",
    "the largest single failure mode within the FM-1.x list is step repetition FM-1.3 at 15.7%",
    "the largest single mode is step repetition FM-1.3 at 15.7%",
  ]) {
    if (flat.includes(candidate)) return candidate;
  }
  void file;
  return SUPERLATIVE.replace(" FM-1.x mode", " mode");
}

// ------------------------------------ the other sites must not contradict §7

// The block is authoritative only if the sites pointing at it say the same
// thing. Checked here rather than in each site's own test, because the failure
// this guards is drift BETWEEN them, which no single-site test can see.
{
  const root = path.resolve(import.meta.dirname, "..", "..");
  const siblings: ReadonlyArray<readonly [string, string, string]> = [
    ["agents-base/project-manager.md", SUPERLATIVE, "PM doctrine's step-back citation"],
    ["extension/src/work-driver-intent.ts", SUPERLATIVE, "intent resolver's rationale"],
    ["extension/src/work-driver-handoff-markdown.ts", SUPERLATIVE, "the rendered GitHub handoff bullet"],
    ["extension/src/work-driver-explain-other.ts", SUPERLATIVE, "the rendered /work-status line"],
  ];
  for (const [file, canonical, what] of siblings) {
    const body = await fs.readFile(path.join(root, file), "utf8");
    // Comments wrap at ~80 columns and jsdoc blocks repeat a `*` on every
    // line, so a canonical phrase normally spans several lines. Compare on
    // whitespace-collapsed, bullet-stripped text: what is checked is that the
    // WORDS are canonical, not where the wrap or the `*` falls.
    const flat = body.replace(/^[ \t]*\*[ ]?/gm, "").replace(/\s+/g, " ");
    // The same both-directions discipline as the §7 mutants: a substring test
    // that can never fail is not a gate. One near-variant per site — the shapes
    // this branch actually collapsed — must be rejected.
    const negation = nearVariant(file, body);
    assert(
      negation === undefined || !flat.includes(negation),
      `${file}: the checker REJECTS the near-variant "${(negation ?? "(n/a)").slice(0, 52)}…" — an assertion that cannot fail is not a gate`,
    );
    assert(
      flat.includes(canonical),
      `${file} carries the canonical superlative verbatim (${what}) — a near-variant is worse than the original error, because readers compare sites`,
    );
  }
}

// Nothing the reader sees may point at a file the reader cannot open. Both
// surfaces emit into contexts with no repository: a GitHub issue comment, and
// an unwrapped `/work-status` line.
{
  const root = path.resolve(import.meta.dirname, "..", "..");
  for (const file of [
    "extension/src/work-driver-handoff-markdown.ts",
    "extension/src/work-driver-explain-other.ts",
  ]) {
    const body = await fs.readFile(path.join(root, file), "utf8");
    const emitted = body
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .filter((line) => /AGENTS\.md/.test(line));
    assert(
      emitted.length === 0,
      `${file} has no AGENTS.md pointer in a NON-comment line (got ${emitted.length}) — a pointer in an emitted string is a pointer to a file its reader has no way to open`,
    );
  }
}

// ---------------------------------------- the deficient fixture is actually caught

// A canary nobody watched fail is a canary nobody trusts. Each mutant below is
// a regression this branch has already lived through, applied to a COPY of the
// real paragraph; the checker must reject every one.
type Defect = readonly [string, string, string];
const DEFECTS: readonly Defect[] = [
  [
    "drops a top-level category figure",
    (p) => p.replace("Inter-Agent Misalignment 36.9%", "Inter-Agent Misalignment"),
    "Inter-Agent Misalignment 36.9%",
  ],
  [
    "drops an FM-1 figure",
    (p) => p.replace("12.4%", ""),
    "12.4%",
  ],
  [
    "drops the completion-recognition mode entirely",
    (p) => p.replace("not recognising completion FM-1.5 is 12.4%, ", ""),
    "FM-1.5",
  ],
  [
    "drops the context-loss mode entirely",
    (p) => p.replace("context loss FM-1.4 is 2.80% and ", ""),
    "FM-1.4",
  ],
  [
    "drops the intervention figure",
    (p) => p.replace("+15.6%", ""),
    "+15.6%",
  ],
  [
    "drops the Appendix H limitation",
    (p) => p.replace(/Appendix H states that tactical approaches get only limited results/, "and it helps"),
    "Appendix H",
  ],
  [
    "unscopes the superlative (the fabrication this branch removed)",
    (p) => p.replace("the largest single FM-1.x mode is step repetition FM-1.3 at 15.7%", "the largest single mode is step repetition FM-1.3 at 15.7%"),
    "FM-1.x",
  ],
  [
    "promotes an FM-1.x mode to top-level",
    (p) => p.replace("the largest single FM-1.x mode is step repetition FM-1.3", "a top-level failure mode, step repetition FM-1.3"),
    "top-level",
  ],
  [
    "invents a figure the paper does not carry",
    (p) => p.replace("context loss FM-1.4 is 2.80%", "context loss FM-1.4 is 41.77%"),
    "2.8",
  ],
  [
    "deletes the whole block",
    () => "**Theme-clustered cap-hits get a step-back**: PM dispatches one `@explore`.",
    "arXiv 2503.13657",
  ],
];

function checkBlock(text: string, para: string | undefined): string[] {
  const misses: string[] = [];
  if (para === undefined) return ["block not found"];
  if (para.length <= 500) misses.push("block truncated");
  for (const [token] of REQUIRED) if (!para.includes(token)) misses.push(token);
  const superIndex = para.indexOf("largest single");
  const scopeIndex = para.indexOf("FM-1.x");
  if (!(superIndex >= 0 && scopeIndex >= 0 && Math.abs(superIndex - scopeIndex) < 40))
    misses.push("superlative unscoped");
  if (para.split("top-level").length - 1 !== 1) misses.push("top-level");
  void text;
  return misses;
}

{
  // Sanity: the checker must PASS on the real block. Without this, every
  // "caught" below could be a checker that always says no.
  assert(
    checkBlock(agentsMd, PARA).length === 0,
    "the checker passes the real §7 block — so a mutant it rejects below is a real defect, not a broken checker",
  );
  let caught = 0;
  for (const [name, mutate, expectMissing] of DEFECTS) {
    const mutated = mutate(PARA ?? "");
    const misses = checkBlock(agentsMd, mutated);
    const detected = misses.length > 0 && misses.includes(expectMissing);
    assert(
      detected,
      `canary: the checker CATCHES a §7 block that ${name} (expected to flag "${expectMissing}", got ${JSON.stringify(misses)})`,
    );
    if (detected) caught++;
  }
  assert(caught === DEFECTS.length, `every mutant caught (${caught}/${DEFECTS.length})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
