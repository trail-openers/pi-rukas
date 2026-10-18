#!/usr/bin/env bun
/**
 * A shipped module with no caller is not a feature.
 *
 * `extension/src/vipune.ts` shipped twice — calibrated, documented and fully
 * tested — imported by **nothing but its own smoke tests**. Every measurement
 * that made it correct was real; none of it ever ran. `memory-stats.ts` then
 * shipped in v0.12.32 the same way. Tests of a module in isolation cannot
 * detect this, because they are themselves the only caller.
 *
 * So this file asserts the one thing those tests structurally cannot: that each
 * seam is reachable from production, and that every export either has a
 * production caller or sits on a written-down list naming the issue that will
 * wire it. The allowlist is the point: it turns "this is dead" from something
 * nobody notices into a number that has to shrink, and shipping a new export
 * without wiring or declaring it becomes a failure rather than a habit.
 *
 * Generalised from the vipune-only version after the pattern recurred a third
 * time: `retry-config-check.ts` was written, tested and wired — and a stray
 * `git checkout` reverted the wiring, leaving a module that passed its own suite
 * while doing nothing. One seam is an incident; three is a class.
 *
 * The SEAMS table itself lives in `lib/seams-registry.ts` (AGENTS.md §12 size
 * cap). This file keeps the scanning and the assertions — the parts that can
 * fail open — so the gate's logic stays where its canaries are.
 *
 * **The registry is scanned as a test file.** `testFiles` below is what proves a
 * `testOnly` export is genuinely exercised, and it used to read the seam's name
 * straight out of this file's own inlined table. Once the table moved, five
 * exports (memory-stats `defaultDbPath`, agents-md `runAgentsMd` / `runWrap`,
 * dispatch-deck `buildJobRows`, review-ledger-lock `runLedgerCriticalSectionHook`,
 * merge-refusals `ACCEPTED_MERGE_FORM`) went red — the declarations were no
 * longer in the corpus. That is the correct reading, not a regression: the
 * strings were the SEAMS entry, never a call. The registry directory joins the
 * corpus because it is the faithful record of every declaration, so the verdict
 * is the same either way — but a gate whose "exercised" signal comes from a
 * declaration rather than a call is the same fail-open shape as the docstring
 * this file already refuses to count.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
// #1454 — the table split for the 500-line gate; concatenated so a module can
// be registered in either half and the orphan check still sees the whole set.
import { SEAMS_1454 } from "./lib/seams-registry-1454.ts";
import { SEAMS } from "./lib/seams-registry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");

/**
 * Comments are not callers.
 *
 * Without this, a docstring that merely NAMES an export counts as wiring it —
 * which is how this test first reported `renderBrief` as live when the only
 * mention of it was a sentence explaining what it does.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const TESTS = path.resolve(import.meta.dirname);
/**
 * The sources the "a test-only export must actually be exercised" check reads.
 * `lib/` is included as well as the top level: the seam registry lives there
 * (#955 file-size split), and it names each test-only export in the reason
 * string that says which test exercises it. Without it, moving the registry out
 * of this file would silently drop every declaration in it out of the check's
 * view and turn five honest assertions into five false ones.
 */
const testFiles = [
  ...readdirSync(TESTS)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(TESTS, f)),
  ...readdirSync(path.join(TESTS, "lib"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(TESTS, "lib", f)),
].map((f) => stripComments(readFileSync(f, "utf8")));

const allFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({
    name: f,
    text: stripComments(readFileSync(path.join(SRC, f), "utf8")),
  }));

/**
 * Every source under src/, subdirectories included, for the export-wiring
 * check only: a caller in `src/headless/` (the headless subcommands, #1021)
 * is a production caller too. `name` is the path relative to src/, so a seam
 * is excluded by its own path ("agents-md/agents-md.ts").
 */
const allSources = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({
    name: f,
    text: stripComments(readFileSync(path.join(SRC, f), "utf8")),
  }));

for (const seam of [...SEAMS, ...SEAMS_1454]) {
  console.log(`\n── ${seam.file}`);

  const source = readFileSync(path.join(SRC, seam.file), "utf8");
  const exported = [
    ...source.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_]\w*)/gm),
  ].map((m) => m[1] as string);

  assert(exported.length > 0, `publishes ${exported.length} function(s)/const(s)`);

  /** Production sources: everything under src/ except the seam itself. */
  const production = allFiles.filter((f) => f.name !== seam.file);
  const importers = production.filter((f) =>
    new RegExp(`from "\\./${seam.file.replace(".ts", "\\.ts")}"`).test(f.text),
  );
  assert(
    importers.length > 0,
    `has ${importers.length} production importer(s): ${importers.map((i) => i.name).join(", ") || "NONE"}`,
  );

  const testOnly = seam.testOnly ?? {};
  const unwired = exported.filter(
    (name) =>
      !(name in seam.pending) &&
      !(name in testOnly) &&
      !allSources.some((f) => f.name !== seam.file && new RegExp(`\\b${name}\\b`).test(f.text)),
  );
  assert(
    unwired.length === 0,
    `every export is wired, test-only, or declared pending${unwired.length ? ` — undeclared: ${unwired.join(", ")}` : ""}`,
  );

  // A test-only export with no test is just dead code with a label on it.
  const unexercised = Object.keys(testOnly).filter(
    (name) => !testFiles.some((t) => new RegExp(`\\b${name}\\b`).test(t)),
  );
  assert(
    unexercised.length === 0,
    `every test-only export is actually exercised${unexercised.length ? ` — no test calls: ${unexercised.join(", ")}` : ""}`,
  );

  // The allowlist must not rot: an entry that HAS acquired a caller should be
  // removed, or the list stops meaning anything.
  const stale = Object.keys(seam.pending).filter(
    (name) =>
      exported.includes(name) && production.some((f) => new RegExp(`\\b${name}\\b`).test(f.text)),
  );
  assert(
    stale.length === 0,
    `no stale pending entries${stale.length ? ` — now wired, remove: ${stale.join(", ")}` : ""}`,
  );

  const importer = production.find((f) => f.name === seam.canary.importer);
  assert(
    importer !== undefined && new RegExp(`\\b${seam.canary.symbol}\\b`).test(importer.text),
    `canary: ${seam.canary.importer} still calls ${seam.canary.symbol}`,
  );

  // #1454 — a symbol only its own module calls (the claims read filter, the
  // sweep's owner lookup) is reachable in a way the canary cannot see, since
  // the canary excludes the seam file itself. Assert the internal call site.
  if (seam.selfCall) {
    const selfSource = stripComments(source);
    assert(
      new RegExp(`\\b${seam.selfCall.symbol}\\s*\\(`).test(selfSource) &&
        selfSource.includes(`function ${seam.selfCall.by}`),
      `self-call: ${seam.selfCall.by} still calls ${seam.selfCall.symbol}`,
    );
  }

  const pendingCount = Object.keys(seam.pending).filter((n) => exported.includes(n)).length;
  if (pendingCount) console.log(`  … ${pendingCount} export(s) still awaiting a caller`);
}

// ------------------------------------ nothing else is quietly shipping dead

{
  // A module whose ONLY importer is a smoke test is the exact shape all three
  // seams above had when they shipped. Report any such module, so the next one
  // is noticed at the gate rather than three releases later.
  const declared = new Set([...SEAMS, ...SEAMS_1454].map((s) => s.file));
  // #609 — forge-detect.ts is S1 of epic #608. Its production caller is
  // forge.ts (S2), not yet shipped. Declared pending so the module-level
  // orphan check does not fail on it until forge.ts lands.
  // #610 — forge.ts is S2. Its production caller is work-driver (S4 #612),
  // not yet shipped. Declared pending for the same reason.
  const PENDING_PRODUCTION_CALLER = new Set([
    "forge-detect.ts",
    "forge.ts",
    // #660 B2 — companion extension loaded via --extension at dispatch time
    // (FACTS_EXTRA_ARGS in the /agents-md pre-pass), not via a static import.
    // Same pattern as policy-reporter.ts / lens-reporter.ts / plan-reporter.ts,
    // which are also not in this set because they have no named exports
    // imported by tests. facts-reporter.ts DOES have named exports
    // (agentFactsToDetectedFacts, extractAgentFacts, FACTS_EXTRA_ARGS) that
    // the test files import, so the orphan check flags it. The production
    // caller is the /agents-md pre-pass dispatch (pi-prompts/agents-md.md),
    // which loads it via FACTS_EXTRA_ARGS — not a static import.
    "facts-reporter.ts",
  ]);
  const orphans: string[] = [];
  for (const f of allFiles) {
    if (declared.has(f.name) || f.name === "index.ts" || f.name === "types.ts") continue;
    if (PENDING_PRODUCTION_CALLER.has(f.name)) continue;
    if (!/^export /m.test(f.text)) continue;
    const spec = f.name.replace(".ts", "\\.ts");
    const imported = allFiles.some(
      (o) => o.name !== f.name && new RegExp(`from "\\./${spec}"`).test(o.text),
    );
    const testImported = testFiles.some((t) => new RegExp(`/${spec}"`).test(t));
    if (!imported && testImported) orphans.push(f.name);
  }
  assert(
    orphans.length === 0,
    `no module is reachable ONLY from its own tests${
      orphans.length ? ` — dead in production: ${orphans.join(", ")}` : ""
    }`,
  );
}

// ------------------------- the production fetch default carries its deadline
//
// Every explore smoke test injects `ctx.issueBodyFetcherFn`, so the shipped
// default is exercised by none of them — the same blind spot this file exists
// for: swapping the default for a fetcher without `timeout:` would restore the
// unbounded `gh issue view` that killed cycle #700 and the suite would pass.
{
  const exploreRun = readFileSync(path.join(SRC, "work-driver-explore-run.ts"), "utf8");
  const explore = readFileSync(path.join(SRC, "work-driver-explore.ts"), "utf8");
  assert(
    /ctx\.issueBodyFetcherFn \?\? fetchIssueBodyViaGh/.test(exploreRun),
    "runExplore's fetch default is fetchIssueBodyViaGh — the fetcher that carries a deadline",
  );
  assert(
    /export function fetchIssueBodyViaGh[\s\S]{0,400}?timeout: ISSUE_BODY_TIMEOUT_MS/.test(explore),
    "...and that fetcher sets a per-attempt timeout, so no unbounded gh call reaches production",
  );
}
console.log(`\nexit ${exit}`);
process.exit(exit);
