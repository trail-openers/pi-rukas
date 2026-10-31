#!/usr/bin/env bun
/**
 * AGENTS.md §7 is the single authoritative MAST block, and the other sites that
 * cite the paper (arXiv 2503.13657) restate a subset of it — so a figure that
 * silently leaves §7 orphans every pointer, and a pointer that drifts contradicts
 * the block it points at. Nothing enforced either direction until this file.
 *
 * The branch these assertions came from removed statistics attributed to the
 * paper that the paper does not contain. When the citation was collapsed, §7's
 * step-back paragraph became the one place the real figures live.
 *
 * A gate that only asserts "the file mentions 15.7% somewhere" is worthless, and
 * this file's first version was that gate: an adversarial reviewer ran real
 * mutants against it and it passed green on three classes of corruption —
 * a prepended digit (`115.7%` satisfies `includes("15.7%")`), a swapped
 * attribution (ten independent `includes` all stay true while the sentence
 * becomes false), and a seventh citing site nobody registered. The fact table,
 * the mutants and the checker live in `lib/mast-canary-fixtures.ts`; the
 * mutants here are those DEMONSTRATED passes, not hypothetical ones.
 *
 * Two structural rules this version adds:
 *
 *  - Figures are asserted JOINED to their labels, so a true substring next to a
 *    false one proves nothing. A mis-paired figure is the same error class as an
 *    unscoped superlative; the superlative had a positional check, the pairing
 *    had none.
 *  - The site registry is DERIVED from the tree, and every site carries its own
 *    expectation. A hand-maintained list of four files cannot see a fifth, so a
 *    new site carrying the unscoped fabrication passed while the registry stayed
 *    green. Sites that legitimately cite the paper for a narrower claim declare
 *    that claim and are checked against IT, not against one negation shared by
 *    all sites.
 *
 * Asserted in BOTH directions, as `test-review-threshold-quote.ts` does: the
 * real block passes, and each deficiency is CAUGHT. A gate never observed to
 * fail is worthless.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  ARXIV,
  CATEGORY_ORDER,
  DEFECTS,
  FACTS,
  PARA_HEAD,
  SUPERLATIVE,
  UNSCOPED,
  assertMutates,
  checkBlock,
  flatten,
  isStepBackHeading,
  nonCommentText,
  stepBackParagraph,
} from "./lib/mast-canary-fixtures.ts";

const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failures.push(msg);
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SELF = "extension/smoke-tests/test-mast-authoritative-block.ts";
const FIXTURES = "extension/smoke-tests/lib/mast-canary-fixtures.ts";
const AUTHORITATIVE = "AGENTS.md";

/** Read a repository file by name, reporting an unreadable one as a named failure. */
function readRepoFile(file: string): string | undefined {
  try {
    return readFileSync(path.join(REPO_ROOT, file), "utf8");
  } catch (err) {
    assert(
      false,
      `${file} is readable (${(err as Error).message}) — a canary that crashes on a missing file reports nothing about why`,
    );
    return undefined;
  }
}

const agentsMd = readRepoFile(AUTHORITATIVE);
if (agentsMd === undefined) {
  console.error("\nFATAL: AGENTS.md unreadable — the §7 assertions cannot run.");
  process.exit(1);
}

// ------------------------------------------------------- the §7 block, located

// Located by heading token and read to the next blank line, so a reflow of the
// prose cannot narrow the gate. Exactly ONE paragraph may carry the heading:
// reading the first and ignoring the rest lets a copy-pasted duplicate — with
// its own wording — become a second authority the reader cannot distinguish.
const HEADED = agentsMd.split("\n").filter(isStepBackHeading);
assert(
  HEADED.length === 1,
  `exactly one §7 step-back paragraph carries the heading token (got ${HEADED.length}) — a duplicate is an unchecked second authority`,
);
const PARA = stepBackParagraph(agentsMd);
assert(
  PARA !== undefined,
  "§7's step-back paragraph is found — the assertions below are derived from it, so an absence fails loudly rather than vacuously",
);
if (PARA === undefined) {
  console.error(
    "\nFATAL: §7 step-back paragraph not found — every figure assertion below is meaningless.",
  );
  process.exit(1);
}
const BLOCK = PARA;
assert(
  BLOCK.length > 500,
  `the located block is the full paragraph, not a truncated stub (got ${BLOCK.length} chars)`,
);

// ------------------------------------------------------- the facts it must carry

for (const fact of FACTS) {
  assert(BLOCK.includes(fact.token), `§7's MAST block states "${fact.token}" (${fact.why})`);
}

// The superlative and its scope in the SAME clause: "largest single mode" two
// sentences from "FM-1.x" is exactly the unscoped fabrication the branch removed.
{
  const superIndex = BLOCK.indexOf("largest single");
  const scopeIndex = BLOCK.indexOf("FM-1.x");
  assert(
    superIndex >= 0 && scopeIndex >= 0 && Math.abs(superIndex - scopeIndex) < 40,
    `the superlative sits WITH its FM-1.x scope (offsets ${superIndex}/${scopeIndex}) — a drifted scope word reads as a cross-category claim the paper never makes`,
  );
}

// "top-level" belongs to the three category figures and nothing else. The
// branch's founding error was calling FM-1.1 a top-level failure mode.
{
  const hits = BLOCK.split("top-level").length - 1;
  assert(
    hits === 1,
    `"top-level" appears exactly once, against the three category figures (got ${hits}) — a second use promotes a failure mode to a category`,
  );
  const positions = CATEGORY_ORDER.map((c) => BLOCK.indexOf(c));
  const at = BLOCK.indexOf("top-level");
  const afterPrevious = (p: number, i: number): boolean => i === 0 || p > (positions[i - 1] ?? -1);
  assert(
    positions.every((p) => p >= 0) &&
      positions.every(afterPrevious) &&
      positions.every((p) => p > at),
    `the single "top-level" precedes the three category figures IN THE PAPER'S ORDER (top-level@${at}, categories @${positions.join(",")}) — a reordered list reads as a ranking the paper never publishes`,
  );
}

// ------------------------------------------------------------ the sites, derived

/** What a site is chartered to carry, and the figures it must restate. */
interface Site {
  readonly file: string;
  readonly what: string;
  /** Carries the canonical superlative (true) or must not carry either form (false). */
  readonly superlative: boolean;
  /** Phrases this site must contain, each a figure joined to its label. */
  readonly expects: readonly string[];
}

/**
 * Every site's own expectation. The roster is checked against a derived scan
 * below: a citing file absent from this list fails, and so does an entry whose
 * file stopped citing the paper. Legitimate narrower sites (`verify-pr17.ts`
 * says "For context only" and "The gate itself does not rest on those figures";
 * the driver files cite in comments; the PM file cites FM-1.1) pin THEIR claim
 * rather than the superlative.
 */
const SITES: readonly Site[] = [
  {
    file: "agents-base/project-manager.md",
    what: "PM doctrine's step-back citation",
    superlative: true,
    expects: ["The MAST taxonomy (Cemri et al., arXiv 2503.13657) bears this out"],
  },
  {
    file: "extension/src/work-driver-intent.ts",
    what: "the intent resolver's rationale for refusing a bad spec",
    superlative: true,
    expects: ["disobeying the task specification FM-1.1 is 11.8%", "was worth +15.6% task success"],
  },
  {
    file: "extension/src/work-driver-verify-pr17.ts",
    what: "the verification gate's context-only citation",
    superlative: false,
    expects: [
      "Task Verification, 21.3%",
      "was worth +15.6% task success",
      "For context only",
      "The gate itself does not rest",
    ],
  },
  {
    file: "extension/src/work-driver-handoff-markdown.ts",
    what: "the rendered GitHub handoff bullet",
    superlative: true,
    expects: ["(MAST, arXiv 2503.13657"],
  },
  {
    file: "extension/src/work-driver-explain-other.ts",
    what: "the rendered /work-status line",
    superlative: true,
    expects: ["in MAST (arXiv 2503.13657)"],
  },
  {
    file: "extension/smoke-tests/test-intent-resolution.ts",
    what: "the intent-resolution canary's own rationale comment",
    superlative: true,
    expects: ["disobeying the task specification FM-1.1 is 11.8%"],
  },
];

/** Every repository file that names the paper — derived, never hand-listed. */
function discoverCitingFiles(): string[] {
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "tmp",
    ".worktrees",
    "outputs",
    "coverage",
  ]);
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent<string>[];
    try {
      // Without an explicit encoding `withFileTypes` resolves to the
      // buffer-typed overload, so the element type is named here: `entry.name`
      // has to be a string before it reaches path.join and the .endsWith tests.
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name: string = entry.name;
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const relative = rel === "" ? name : `${rel}/${name}`;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && (relative.endsWith(".ts") || relative.endsWith(".md"))) {
        // The detector's own exclusion: `.d.ts` declarations are not sites.
        if (relative.endsWith(".d.ts")) continue;
        try {
          if (readFileSync(full, "utf8").includes(ARXIV)) out.push(relative);
        } catch {
          /* unreadable — not a site, and not this gate's problem */
        }
      }
    }
  };
  walk(REPO_ROOT, "");
  return out.sort();
}

const discovered = discoverCitingFiles().filter((f) => f !== SELF && f !== FIXTURES);
const registered = new Set(SITES.map((s) => s.file));

for (const file of discovered) {
  assert(
    file === AUTHORITATIVE || registered.has(file),
    `${file} cites the paper (${ARXIV}) and is accounted for by the registry — an unregistered site is an unreviewed restatement, which is how a fabricated figure reached a rendered surface in the first place`,
  );
}
for (const site of SITES) {
  assert(
    discovered.includes(site.file),
    `${site.file} is registered AND still cites the paper — a site that stopped citing it is a stale entry that can never fail`,
  );
}

/** A synthetic near-variant, built from the canonical string rather than read from the site. */
const NEAR_VARIANTS: readonly string[] = [
  UNSCOPED, // scope word dropped
  SUPERLATIVE.replace(" at 15.7%", ""), // figure dropped, superlative kept
  SUPERLATIVE.replace("step repetition FM-1.3 at 15.7%", "FM-1.3 step repetition at 15.7%"), // clause order permuted
];

for (const site of SITES) {
  const body = readRepoFile(site.file);
  if (body === undefined) continue;
  const flat = flatten(body);

  for (const phrase of site.expects) {
    assert(
      flat.includes(phrase),
      `${site.file} carries "${phrase}" joined as one phrase (${site.what})`,
    );
  }

  if (site.superlative) {
    assert(
      flat.includes(SUPERLATIVE),
      `${site.file} carries the canonical superlative verbatim (${site.what}) — a near-variant is worse than the original error, because readers compare sites`,
    );
  } else {
    // The site's OWN expectation: a context-only citation is not chartered to
    // rank anything, so either superlative form appearing here is scope creep
    // beyond what that file's own comment claims.
    for (const forbidden of [SUPERLATIVE, UNSCOPED]) {
      assert(
        !flat.includes(forbidden),
        `${site.file} does NOT carry "${forbidden.slice(0, 46)}…" — it declares a narrower claim (${site.what}), and a superlative added here is one its own comment does not support`,
      );
    }
  }

  // Negative control, SYNTHESISED: the checker must accept the canonical
  // sentence and reject a corrupted copy of it. Each variant is built from
  // `SUPERLATIVE`, never read out of the site, so the control judges a text the
  // gate wrote — not a substring test against live content that can never fail.
  // Negative control, SYNTHESISED. Each variant is built from `SUPERLATIVE`,
  // never read out of the site, so the control judges a text the gate wrote —
  // not a substring test against live content that can never fail. A
  // superlative site's variants are all corruptions of the canonical sentence
  // (superlative still present, so it must fail the verbatim check); a narrower
  // site is chartered against ANY superlative form, so it is polluted with the
  // canonical one and the unscoped one (its expectation must now fail).
  const control = site.superlative
    ? { sample: `preamble ${SUPERLATIVE} trailer`, pollutions: NEAR_VARIANTS }
    : { sample: `preamble ${ARXIV} trailer`, pollutions: [SUPERLATIVE, UNSCOPED] };
  for (const variant of control.pollutions) {
    const sample = flatten(control.sample);
    const acceptsCanonical = site.superlative
      ? sample.includes(SUPERLATIVE)
      : ![SUPERLATIVE, UNSCOPED].some((f) => sample.includes(f));
    const polluted = site.superlative
      ? sample.replace(SUPERLATIVE, variant)
      : `${sample} ${variant}`;
    const stillPasses = site.superlative
      ? polluted.includes(SUPERLATIVE)
      : ![SUPERLATIVE, UNSCOPED].some((f) => polluted.includes(f));
    assert(
      acceptsCanonical && polluted !== sample && !stillPasses,
      `${site.file}: the checker accepts the canonical sample then REJECTS it polluted to "${variant.slice(0, 42)}…" (${site.superlative ? "superlative-chartered" : "narrower"} site) — an assertion that cannot fail is not a gate`,
    );
  }

  // The fabricated figure belongs ONLY in the provenance comment that explains
  // why it was removed. In an emitted string it is a lie the reader sees.
  assert(
    !nonCommentText(body).includes("41.77"),
    `${site.file} never prints "41.77" in NON-comment text — the figure this branch removed because the paper does not contain it, and an operator-facing string is not a provenance comment`,
  );
}

// Nothing the reader sees may point at a file the reader cannot open: both
// rendered surfaces emit into contexts with no repository (a GitHub comment,
// an unwrapped `/work-status` line).
for (const file of [
  "extension/src/work-driver-handoff-markdown.ts",
  "extension/src/work-driver-explain-other.ts",
]) {
  const body = readRepoFile(file);
  if (body === undefined) continue;
  const emitted = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .filter((line) => /AGENTS\.md/.test(line));
  assert(
    emitted.length === 0,
    `${file} has no AGENTS.md pointer in a NON-comment line (got ${emitted.length}) — a pointer in an emitted string points at a file its reader cannot open`,
  );
}

// ------------------------------------------- the deficient copy is actually caught

{
  const real = checkBlock(BLOCK);
  assert(
    real.length === 0,
    `the checker passes the real §7 block — so a mutant it rejects below is a defect, not a broken checker (got ${JSON.stringify(real)})`,
  );

  let caught = 0;
  for (const defect of DEFECTS) {
    const mutated = defect.mutate(BLOCK);
    // A mutant that did not mutate is not evidence of anything; and the defect
    // must be absent from the MUTATED text while present in the real one, so
    // "the checker flags some token" is never mistaken for "it flags this one".
    let error = "";
    try {
      assertMutates(defect.name, BLOCK, mutated);
    } catch (err) {
      error = (err as Error).message;
    }
    const hadIt = checkBlock(BLOCK).includes(defect.expectMissing);
    const flagsIt = checkBlock(mutated).includes(defect.expectMissing);
    assert(
      error === "" && !hadIt && flagsIt,
      `canary: the checker CATCHES a §7 block that ${defect.name} (expected to flag "${defect.expectMissing}"${error ? `; ${error}` : ""}, got ${JSON.stringify(checkBlock(mutated))})`,
    );
    if (error === "" && !hadIt && flagsIt) caught++;
  }
  assert(caught === DEFECTS.length, `every §7 mutant caught (${caught}/${DEFECTS.length})`);
}

// The duplicate-authority mutant runs against the FILE: only the exactly-one
// count sees a second heading at all, and the block is read to the blank line so
// a reflow of the prose cannot hide it from either check.
{
  const lines = agentsMd.split("\n");
  const at = lines.findIndex(isStepBackHeading);
  // The corrupt copy strips the scope word from the block's own text, so it
  // stays a real mutation however the prose wraps — replacing a multi-word
  // phrase would no-op on a reflowed file, and a no-op mutant proves nothing.
  const blockLines: number[] = [];
  for (let i = at; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") break;
    blockLines.push(i);
  }
  const scopeLine = blockLines.find((i) => (lines[i] ?? "").includes(" FM-1.x mode"));
  const scopeText = scopeLine === undefined ? undefined : lines[scopeLine];
  const corrupt =
    scopeText === undefined || scopeText === "" ? "" : scopeText.replace(" FM-1.x mode", " mode");
  assert(
    scopeText !== undefined && corrupt !== "" && corrupt !== scopeText,
    "the duplicate-heading mutant is a real mutation (an unchanged copy would prove nothing)",
  );
  const inserted = corrupt === "" ? [] : [corrupt];
  const withDuplicate = [...lines.slice(0, at), ...inserted, ...lines.slice(at)].join("\n");
  const headed = withDuplicate.split("\n").filter(isStepBackHeading);
  const first = stepBackParagraph(withDuplicate);
  assert(
    headed.length === 2 &&
      first !== undefined &&
      checkBlock(first).includes("superlative unscoped"),
    `canary: a SECOND step-back paragraph carrying the unscoped superlative is caught by the exactly-one assertion (found ${headed.length}, first block flags ${JSON.stringify(first ? checkBlock(first).slice(0, 3) : [])}) — reading only the first paragraph let the corrupt copy be the one read, green`,
  );
}

// A site that cites the paper without being registered must fail the gate,
// proven against the real discovery function on the real tree.
{
  const orphan = "extension/src/work-driver-verify-pr17.ts";
  assert(
    discovered.includes(orphan),
    `discovery finds ${orphan} as a site citing the paper (derived, not hand-listed)`,
  );
  const kept = new Set(SITES.filter((s) => s.file !== orphan).map((s) => s.file));
  const unaccounted = discovered.filter((f) => f !== AUTHORITATIVE && !kept.has(f));
  assert(
    unaccounted.length === 1 && unaccounted[0] === orphan,
    `canary: dropping one site from the registry leaves exactly that file UNACCOUNTED-FOR (got ${JSON.stringify(unaccounted)}) — the seventh-site class that passed green while the roster was hand-maintained`,
  );

  // And the unscoped fabrication smuggled into a narrower site: its own
  // expectation must reject it, which one shared generic negation could not do.
  const body = readRepoFile(orphan);
  if (body !== undefined) {
    const clean = flatten(body);
    const smuggled = `${clean} ${UNSCOPED}`;
    assert(
      clean !== smuggled && !clean.includes(UNSCOPED) && smuggled.includes(UNSCOPED),
      `canary: ${orphan}'s narrower-site expectation would REJECT the unscoped superlative if the site added it (absent before, present after) — one generic negation for every site could not tell these apart`,
    );
  }
}

console.log(`\n${failures.length === 0 ? "exit 0" : `${failures.length} failure(s)`}`);
for (const f of failures) console.error(`  - ${f.slice(0, 160)}`);
process.exit(failures.length === 0 ? 0 : 1);
