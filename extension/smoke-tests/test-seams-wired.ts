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
 * wire it.
 *
 * The allowlist is the point. It turns "this is dead" from something nobody
 * notices into a number that has to shrink, and shipping a new export without
 * either wiring it or declaring it becomes a failure rather than a habit.
 *
 * Generalised from the vipune-only version after the pattern recurred a third
 * time: `retry-config-check.ts` was written, tested, wired — and the wiring was
 * then reverted by a stray `git checkout`, leaving a module that passed its own
 * suite while doing nothing. One seam is an incident; three is a class.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");

interface Seam {
  file: string;
  /** Exports with no production caller yet, each naming the issue that will wire it. */
  pending: Record<string, string>;
  /**
   * Exports that exist for testability: called from inside their own module,
   * exported so the pure core can be asserted directly. Legitimate, but only
   * while a test actually calls them — an entry here whose test disappears is
   * dead code wearing a label, so each one is checked against the suite.
   */
  testOnly?: Record<string, string>;
  /**
   * A symbol known to be wired today. If this stops being imported the seam has
   * lost its production reachability — exactly the state this file exists to
   * make visible.
   */
  canary: { symbol: string; importer: string };
}

const SEAMS: Seam[] = [
  {
    file: "vipune.ts",
    pending: {
      // NOT planned for a caller. #394 calibrated `selectResults` as floor AND
      // agreement, and a later 940-observation sweep showed the floor costs
      // recall for nothing on this corpus (files-hit 22/24 -> 8/24, zero false
      // positives removed). The develop read applies the agreement bit directly.
      // Kept because the rule is correct for the question it was calibrated on.
      selectResults: "superseded for the develop leg — see memory-brief.ts",
      SIM_FLOOR: "superseded for the develop leg — read only by selectResults",
      readDoctrineFromDisk:
        "#407 — superseded by readDoctrineAtBase; kept for callers outside the driver",
      // Consumed inside the seam by functions that are themselves unwired, so
      // these reach production only once those do.
      looksLikeSecret: "#422 — called by vipuneAdd inside the seam",
      searchArgv: "#422 — called by vipuneSearch (and by the offline argv gate)",
    },
    canary: { symbol: "vipuneChildEnv", importer: "spawn.ts" },
  },
  {
    // Shipped in v0.12.32 with no caller at all. `/audit` is now that caller
    // (memory-panel.ts), so it is enforced from here on.
    file: "memory-stats.ts",
    pending: {},
    testOnly: {
      renderMemoryStats: "the /audit panel renders its own framing; this is the raw dump",
      defaultDbPath: "resolved inside readMemoryStats; asserted directly",
    },
    canary: { symbol: "readMemoryStats", importer: "memory-panel.ts" },
  },
  {
    file: "retry-config-check.ts",
    pending: {},
    testOnly: {
      judgeRetryConfig: "the pure verdict, called by checkRetryConfig; asserted directly",
      checkRetryConfig: "file-reading wrapper, called by warnIfRetryConfigTooLow",
      PI_DEFAULT_MAX_RETRY_DELAY_MS: "asserted equal to the threshold, so it cannot drift",
      SAFE_MAX_RETRY_DELAY_MS: "asserted equal to Pi's default, so it cannot drift",
    },
    canary: { symbol: "warnIfRetryConfigTooLow", importer: "index.ts" },
  },
  {
    // #524 shipped the whole src/agents-md/ core wired by nothing — the prose
    // command body told PM to shell out to a host-relative path that does not
    // exist outside this repo. #526's agents-md-tool.ts is the in-process
    // delivery; this canary pins the shared import line so the core cannot
    // ship unwired a third time.
    file: "agents-md/agents-md.ts",
    pending: {},
    testOnly: {
      fileState: "the pure state classifier, asserted directly",
      runAgentsMd: "script-mode CLI entry (process.exit); the tool calls the verbs directly",
      runWrap: "the no-markers wrap I/O shell, called only by updateAgent within this module",
    },
    canary: { symbol: "createAgent", importer: "agents-md-tool.ts" },
  },
  {
    // #543 F3a — the crash-resume re-attach seam ships as default-off
    // infrastructure. `resolveReattach` / `reattachArgs` / `reattachPrompt`
    // have no production caller yet (the resume step does not record
    // `transcriptPath` on `dispatch-started`); they are wired when the
    // resume path learns to re-attach a surviving session instead of
    // re-dispatching. Flag default-off (PI_ENSEMBLE_SESSION_REATTACH=0),
    // so the seam is inert on every real cycle until then.
    file: "work-driver-resume.ts",
    pending: {
      resolveReattach: "#543 F3a — the crash-resume path will call it",
      reattachArgs: "#543 F3a — the crash-resume path will call it",
      reattachPrompt: "#543 F3a — the crash-resume path will call it",
    },
    testOnly: {
      // #543 F3a — the re-attach floor + fan-out guard + the write-ahead
      // dispatch markers ship with no production caller yet (the crash-resume
      // path re-dispatches for now); exercised by test-session-reattach.ts /
      // test-resume.ts.
      sessionReattachEnabled: "#543 F3a — flag reader; test-asserted only",
      FAN_OUT_STEPS: "#543 F3a — re-attach exclusion set; test-asserted only",
      REATTACH_GRANT_FLOOR_MS: "#543 F3a — re-attach grant floor; test-asserted only",
      mintJobId: "resume plumbing — jobId minting; exercised by test-resume.ts",
      markDispatchStarted:
        "resume plumbing — write-ahead dispatch-started; exercised by test-resume.ts",
    },
    canary: { symbol: "beginDispatch", importer: "work-driver-explore.ts" },
  },
];

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
const testFiles = readdirSync(TESTS)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => stripComments(readFileSync(path.join(TESTS, f), "utf8")));

const allFiles = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, text: stripComments(readFileSync(path.join(SRC, f), "utf8")) }));

for (const seam of SEAMS) {
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
      !production.some((f) => new RegExp(`\\b${name}\\b`).test(f.text)),
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

  const pendingCount = Object.keys(seam.pending).filter((n) => exported.includes(n)).length;
  if (pendingCount) console.log(`  … ${pendingCount} export(s) still awaiting a caller`);
}

// ------------------------------------ nothing else is quietly shipping dead

{
  // A module whose ONLY importer is a smoke test is the exact shape all three
  // seams above had when they shipped. Report any such module, so the next one
  // is noticed at the gate rather than three releases later.
  const declared = new Set(SEAMS.map((s) => s.file));
  const orphans: string[] = [];
  for (const f of allFiles) {
    if (declared.has(f.name) || f.name === "index.ts" || f.name === "types.ts") continue;
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
// Every explore smoke test injects `ctx.issueBodyFetcherFn`, so the default the
// driver actually ships with is exercised by none of them. That is the same
// blind spot this file exists for: a refactor swapping the default for a
// fetcher without `timeout:` would restore the unbounded `gh issue view` that
// killed cycle #700, and the whole suite would still pass.
{
  const explore = readFileSync(path.join(SRC, "work-driver-explore.ts"), "utf8");
  assert(
    /ctx\.issueBodyFetcherFn \?\? fetchIssueBodyViaGh/.test(explore),
    "runExplore's fetch default is fetchIssueBodyViaGh — the fetcher that carries a deadline",
  );
  assert(
    /export function fetchIssueBodyViaGh[\s\S]{0,400}?timeout: ISSUE_BODY_TIMEOUT_MS/.test(explore),
    "...and that fetcher sets a per-attempt timeout, so no unbounded gh call reaches production",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
