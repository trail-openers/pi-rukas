#!/usr/bin/env bun
/**
 * #1127 — the round budget's ledger keys and failure handling (companion to
 * test-lens-review-round-cap.ts, split for the 500-line gate).
 *
 * Covers:
 *   - every run is keyed: a bare SHA head is budgeted under detached:<SHA>; a
 *     detached head whose commit sits on one branch counts against that branch;
 *     a head with no commit is refused (no unbudgeted path remains);
 *   - the env cap (not the caller's env) governs an admitted run;
 *   - a corrupt `round` or `incompleteRuns` refuses and names the field;
 *   - a round whose ledger write did not land is reported and never reused;
 *   - a ledger write with no patch id reports not-recorded at warn level.
 *
 * No live spawn: nothing here dispatches a lens.
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

// -------- 12. #1127 — every run is budgeted; no branchless path is unbudgeted
// A detached commit that no branch names: budgeted under detached:<head SHA>.
git("checkout -q --detach");
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
git('commit -qam "detached"');
const detachedSha = git("rev-parse HEAD").trim();
const shaKey = `detached:${detachedSha}`;
seed([]);
const shaFirst = await admitLensRound({ cwd: repo, head: detachedSha });
assert(
  shaFirst.admitted && shaFirst.key === shaKey && /detached head commit/.test(shaFirst.note ?? ""),
  "a bare SHA head is budgeted under detached:<head SHA>, and the summary names the key",
);
if (shaFirst.admitted) await shaFirst.release();
seed([lensRow({ branch: shaKey, round: 3, at: 1000 })]);
const sha4 = await admitLensRound({ cwd: repo, head: detachedSha });
assert(
  !sha4.admitted && sha4.refusal.verdict === "ROUND_CAP_REACHED",
  "a SHA head is budgeted: the 4th run under its key is refused",
);
const shaWide = await admitLensRound({
  cwd: repo,
  head: detachedSha,
  env: { PI_ENSEMBLE_LENS_ROUND_CAP: "5" },
});
assert(
  shaWide.admitted && shaWide.round === 4,
  "the env cap is the one applied to the keyed run (round 4 under a cap of 5)",
);
if (shaWide.admitted) await shaWide.release();
const noKey = await admitLensRound({ cwd: root });
assert(
  !noKey.admitted && /could not be keyed/.test(noKey.refusal.note ?? ""),
  "a run with no budget key is refused fail closed (no unbudgeted path)",
);

// A detached head whose commit sits on exactly one branch counts against it.
git("checkout -q --detach feature/x");
seed([]);
const onBranch = await admitLensRound({ cwd: repo });
assert(
  onBranch.admitted &&
    onBranch.key === "feature/x" &&
    /one local branch at the head commit/.test(onBranch.note ?? ""),
  "a detached head on one branch is keyed on that branch",
);
if (onBranch.admitted) await onBranch.release();
seed([lensRow({ round: 3, at: 1000 })]);
const onBranch4 = await admitLensRound({ cwd: repo });
assert(
  !onBranch4.admitted && onBranch4.refusal.verdict === "ROUND_CAP_REACHED",
  "the detached run counts against the branch: the 4th is refused",
);

// -------- 13. #1127 — a corrupt counter fails closed and names its field
const bad = (extra: Partial<LedgerEntryT>) =>
  evaluateRoundBudget({ ...at(2), ...extra } as unknown as LedgerEntryT, 3);
assert(
  !bad({ round: "2" as unknown as number }).allowed &&
    bad({ round: "2" as unknown as number }).corrupt?.field === "round",
  'a string round ("2") refuses and names the round field',
);
assert(
  !bad({ round: -1 }).allowed && bad({ round: -1 }).corrupt?.field === "round",
  "a negative round (-1) refuses and names the round field",
);
assert(
  !bad({ incompleteRuns: -1 }).allowed &&
    bad({ incompleteRuns: -1 }).corrupt?.field === "incompleteRuns",
  "a negative incompleteRuns refuses and names that field",
);
seed([lensRow({ round: "2" as unknown as number, at: 1000 })]);
const corruptRun = await admitLensRound({ cwd: repo });
assert(
  !corruptRun.admitted &&
    /the `round` field .* not a non-negative integer/.test(corruptRun.refusal.note ?? ""),
  "a corrupt ledger round refuses the run through admission, naming the field",
);

// -------- 14. #1127 — a round whose ledger write did not land is never reused
git(`checkout -q --detach ${detachedSha}`);
seed([]);
const failedRun = await admitLensRound({ cwd: repo, head: detachedSha });
if (failedRun.admitted) {
  const failedNote = await failedRun.release(
    Promise.resolve({ recorded: false, reason: "disk full" }),
  );
  assert(
    /round 1 was not recorded: disk full/.test(failedNote ?? ""),
    "an unrecorded round is reported with its number and reason",
  );
}
const afterFailed = await admitLensRound({ cwd: repo, head: detachedSha });
assert(
  afterFailed.admitted && afterFailed.round === 2,
  "the next run is not handed the unrecorded round (round 2 follows the unrecorded round 1)",
);
if (afterFailed.admitted) await afterFailed.release();

// The ledger writer traces a skipped write at warn level and reports it.
const warnings: string[] = [];
const origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array) => {
  warnings.push(String(chunk));
  return true;
}) as typeof process.stderr.write;
const { writeLensLedgerEntry } = await import("../src/lens-ledger.ts");
const skipped = await (async () => {
  try {
    return await writeLensLedgerEntry("APPROVED", "MEDIUM", root, "feature/x");
  } finally {
    process.stderr.write = origStderr;
  }
})();
assert(
  skipped.recorded === false && warnings.some((w) => /WARN .*no patch id/.test(w)),
  "a ledger write with no patch id reports not-recorded and traces at warn level",
);

process.exit(exit);
