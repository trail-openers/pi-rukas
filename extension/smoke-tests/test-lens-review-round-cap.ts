#!/usr/bin/env bun
/**
 * #1127 — the tool-side lens round budget of `dispatch_lens_review`.
 *
 * Covers (the acceptance criteria):
 *   - round 4 is refused with ROUND_CAP_REACHED (no lens dispatched, nothing
 *     recorded), through the registered tool's execute;
 *   - a CRITICAL finding open in the latest recorded round allows one more
 *     round;
 *   - `overrideCap: true` bypasses the budget and is recorded on the ledger
 *     entry the run writes;
 *   - the counter survives a fresh read of the ledger file (a new session);
 *   - an unreadable ledger fails closed; PI_ENSEMBLE_LENS_ROUND_CAP parses
 *     with the driver's MAX_REVIEW_ROUNDS as the fallback.
 *
 * No live spawn: setupSpawnGuard() forbids it, and the only lens-running path
 * (section 4) injects a stub child through `lensChildFn`.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "lens-round-cap-"));
const ledgerFile = path.join(root, "review-ledger.json");
// The override short-circuits git for the ledger path (see ledgerPathFor), so
// the ledger is private to this test and never touches the real clone's.
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
process.env.PI_ENSEMBLE_SKILLS_DIR = path.join(root, "no-skills");
mkdirSync(path.join(root, "no-skills"), { recursive: true });
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const repo = path.join(root, "repo");
mkdirSync(repo);
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: "pipe" }).toString();
git("init -q -b feature/x");
git("config user.email t@example.com");
git("config user.name t");
writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add -A");
git('commit -q -m "base"');
// A remote with a mainline, and a feature commit on top, so the ledger writer
// can compute a patch id (workingTreePatchId needs <remote>/<mainline>).
const remote = path.join(root, "remote.git");
// `-b main` pins the bare remote's HEAD to the mainline pushed below. Without
// it the remote HEAD follows the host's init.defaultBranch (`master` on CI), so
// `git fetch` cannot set origin/HEAD and mainline detection fails.
execSync(`git init -q --bare -b main ${remote}`);
git(`remote add origin ${remote}`);
git("push -q origin feature/x:main");
git("fetch -q origin");
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
git('commit -qam "feature"');

const { admitLensRound, evaluateRoundBudget, lensRoundCap, readRecordedLens } = await import(
  "../src/lens-round-cap.ts"
);
const { bumpLensRound } = await import("../src/review-ledger-round.ts");
const { MAX_REVIEW_ROUNDS } = await import("../src/work-driver-context.ts");
const { registerLensReviewTool } = await import("../src/lens-review-tool.ts");
const { runLensReview } = await import("../src/lens-review.ts");

type Entry = Record<string, unknown>;
const seed = (entries: Entry[]) => writeFileSync(ledgerFile, JSON.stringify({ entries }));
const readEntries = (): Entry[] =>
  existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")).entries : [];
const lensRow = (extra: Entry): Entry => ({
  branch: "feature/x",
  kind: "lens",
  patchId: "p1",
  passed: false,
  at: Date.now(),
  detail: "ISSUES_FOUND",
  hasCritical: false,
  ...extra,
});

// ---------------------------------------------------- 1. cap parsing (env)
assert(MAX_REVIEW_ROUNDS === 3, "the driver's MAX_REVIEW_ROUNDS is 3 (the default source)");
assert(lensRoundCap({}) === MAX_REVIEW_ROUNDS, "unset PI_ENSEMBLE_LENS_ROUND_CAP → driver default");
assert(lensRoundCap({ PI_ENSEMBLE_LENS_ROUND_CAP: "5" }) === 5, "a positive integer overrides");
for (const bad of ["", "abc", "0", "-2", "2.5", "NaN"]) {
  assert(
    lensRoundCap({ PI_ENSEMBLE_LENS_ROUND_CAP: bad }) === MAX_REVIEW_ROUNDS,
    `invalid value ${JSON.stringify(bad)} falls back to the default`,
  );
}

// ------------------------------------------------ 2. pure budget decisions
type LedgerEntryT = import("../src/review-ledger.ts").LedgerEntry;
const at = (round?: number, hasCritical?: boolean) =>
  ({
    branch: "b",
    kind: "lens",
    patchId: "p",
    passed: false,
    at: 1,
    ...(round !== undefined ? { round } : {}),
    ...(hasCritical !== undefined ? { hasCritical } : {}),
  }) as import("../src/review-ledger.ts").LedgerEntry;
assert(evaluateRoundBudget(undefined, 3).nextRound === 1, "no recorded round → next is 1");
assert(evaluateRoundBudget(at(2), 3).allowed, "round 3 (next of 2) is allowed");
const r4 = evaluateRoundBudget(at(3), 3);
assert(!r4.allowed && r4.nextRound === 4, "round 4 is refused at the default cap");
assert(evaluateRoundBudget(at(3, true), 3).allowed, "CRITICAL open in round 3 allows round 4");
assert(!evaluateRoundBudget(at(4, true), 3).allowed, "CRITICAL allows exactly one extra round");
assert(
  evaluateRoundBudget(at(undefined), 3).nextRound === 2,
  "a legacy entry (no round) is round 1",
);
assert(evaluateRoundBudget(at(4), 5).allowed, "a raised cap admits round 5");

// #1127 review — an incomplete streak at the cap refuses, a shorter one does not
const streak = (n: number, round = 2) => ({ ...at(round), incompleteRuns: n }) as LedgerEntryT;
assert(!evaluateRoundBudget(streak(3), 3).allowed, "3 consecutive incomplete runs at cap 3 refuse");
assert(evaluateRoundBudget(streak(2), 3).allowed, "2 consecutive incomplete runs at cap 3 allow");
assert(
  evaluateRoundBudget(streak(3), 3).streakCapped && !evaluateRoundBudget(at(2), 3).streakCapped,
  "the streak refusal is reported as the streak, not the round",
);

// #1127 review — an incomplete run carries the round and grows the streak;
// a completed run resets it
const lensEntry = (detail: string, extra: Partial<LedgerEntryT> = {}) =>
  ({ branch: "b", kind: "lens", patchId: "p", passed: false, at: 2, detail, ...extra }) as LedgerEntryT;
const prior = at(2) as LedgerEntryT;
const inc1 = bumpLensRound(lensEntry("REVIEW_INCOMPLETE"), [prior]);
assert(inc1.round === 2 && inc1.incompleteRuns === 1, "an incomplete run keeps round 2, streak 1");
const inc2 = bumpLensRound(lensEntry("REVIEW_INCOMPLETE", { at: 3 }), [{ ...prior, ...inc1, at: 2 }]);
assert(inc2.round === 2 && inc2.incompleteRuns === 2, "a second incomplete run grows the streak to 2");
const done = bumpLensRound(lensEntry("ISSUES_FOUND", { at: 4 }), [{ ...prior, ...inc2, at: 3 }]);
assert(done.round === 3 && done.incompleteRuns === 0, "a completed run advances to round 3 and resets the streak");

// ------------------------------------- 3. the registered tool, round 4 refused
type Captured = { text?: string };
const sent: string[] = [];
const tools: { execute: (id: string, raw: unknown) => Promise<unknown> }[] = [];
const tool = () => tools[0] as { execute: (id: string, raw: unknown) => Promise<unknown> };
registerLensReviewTool({
  registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]),
  sendUserMessage: (msg: unknown) => {
    sent.push(typeof msg === "string" ? msg : JSON.stringify(msg));
  },
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

seed([lensRow({ round: 3, at: 1000 })]);
const before = readEntries().length;
const before2 = sent.length;
const res = (await tool().execute("t1", { cwd: repo })) as Captured;
assert(
  JSON.stringify(res).includes("Dispatched async lens review"),
  "the tool returns a job handle (the refusal is produced inside the job)",
);
await waitFor(() => sent.length > before2);
const report = sent.slice(before2).join("\n");
assert(report.includes("ROUND_CAP_REACHED"), "round 4 is refused with ROUND_CAP_REACHED");
assert(
  report.split("No lens was dispatched").length - 1 === 1,
  "the refusal note is reported once (not appended a second time)",
);
assert(
  /Last recorded round: 3 — verdict ISSUES_FOUND/.test(report),
  "the refusal names the last round's verdict",
);
assert(/CRITICAL in that round: not open/.test(report), "the refusal says CRITICAL is not open");
assert(/Residuals marker: /.test(report), "the refusal reports the residuals marker status");
assert(readEntries().length === before, "a refused run records nothing (no round consumed)");

// ----------------------------------------- 4. CRITICAL open allows round 4
seed([lensRow({ round: 3, hasCritical: true, at: 1000 })]);
const adm4 = await admitLensRound({ cwd: repo });
assert(adm4.admitted, "CRITICAL open in round 3 lets the gate pass (round 4)");
if (adm4.admitted) adm4.release();

// ---------------------- 5. overrideCap bypasses and is recorded on the entry
seed([lensRow({ round: 3, at: 1000 })]);
const overridden = await admitLensRound({ cwd: repo, overrideCap: true });
assert(overridden.admitted, "overrideCap: true bypasses the round budget");
if (overridden.admitted) overridden.release();
const summary = await runLensReview({
  cwd: repo,
  diff: "diff --git a/a.txt b/a.txt\n+two\n",
  branch: "feature/x",
  overrideCap: true,
  lensChildFn: (async () => {
    throw new Error("no lens child may spawn in this test");
  }) as never,
});
assert(summary.verdict !== ("ROUND_CAP_REACHED" as string), "the overridden run is reviewed");
await waitFor(() => readEntries().some((e) => e.at !== 1000));
const written = readEntries().find((e) => e.at !== 1000);
assert(
  written?.overrideCap === true,
  "the overridden run's ledger entry records overrideCap: true",
);

// -------------------------- 6. the counter survives a fresh read (new session)
seed([lensRow({ round: 2, at: 1000 })]);
const fresh = await readRecordedLens(repo, "feature/x");
assert(fresh.ok && fresh.latest?.round === 2, "a fresh read of the ledger recovers round 2");
const gated = await admitLensRound({ cwd: repo });
assert(gated.admitted, "round 3 is still allowed after a fresh read");
if (gated.admitted) gated.release();

// ------------------------------------------- 7. unreadable ledger fails closed
writeFileSync(ledgerFile, "{not json");
const unreadable = await admitLensRound({ cwd: repo });
assert(
  !unreadable.admitted &&
    unreadable.refusal.verdict === "ROUND_CAP_REACHED" &&
    /unreadable/.test(unreadable.refusal.note ?? ""),
  "an unreadable ledger refuses fail closed (no unlimited rounds)",
);
writeFileSync(ledgerFile, JSON.stringify({ entries: "nope" }));
const shaped = await admitLensRound({ cwd: repo });
assert(!shaped.admitted, "a ledger without an entries array refuses");

// -------------- 8. streak, in-flight, no-branch
seed([lensRow({ round: 2, incompleteRuns: 3, at: 1000 })]);
const streakRun = await admitLensRound({ cwd: repo });
assert(
  !streakRun.admitted && /consecutive run\(s\) ended REVIEW_INCOMPLETE/.test(streakRun.refusal.note ?? ""),
  "three consecutive incomplete runs refuse the next run even with rounds left",
);

seed([lensRow({ round: 2, at: 1000 })]);
const first = await admitLensRound({ cwd: repo });
const second = await admitLensRound({ cwd: repo });
assert(first.admitted && !second.admitted, "a concurrent call in this process cannot claim the same round");
if (first.admitted) first.release();
const third = await admitLensRound({ cwd: repo });
assert(third.admitted, "after the first run settles its slot is free again");
if (third.admitted) third.release();

const noBranch = await admitLensRound({ cwd: root });
assert(
  !noBranch.admitted && /no branch could be resolved/.test(noBranch.refusal.note ?? ""),
  "a run with no resolvable branch is refused (not run unbudgeted)",
);
const bypass = await admitLensRound({ cwd: root, overrideCap: true });
assert(bypass.admitted, "overrideCap admits a run with no resolvable branch");
if (bypass.admitted) bypass.release();

process.exit(exit);
