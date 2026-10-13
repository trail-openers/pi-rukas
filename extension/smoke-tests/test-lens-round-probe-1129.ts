#!/usr/bin/env bun
/**
 * #1129 review — the round probe and the in-lock round clamp.
 *
 *   - the probe reads the SAME ledger key the writer and the #1127 budget use:
 *     three reviews on a detached (no branch) head are rounds 1, 2, 3 and the
 *     round budget refuses the 4th (before this fix every such run probed as
 *     round 1, so the budget never advanced);
 *   - the stored round is a hint clamped to the round implied by the latest
 *     entry re-read under the ledger lock: two writes that both probed the same
 *     prior round store N+1 and N+2.
 *
 * Lenses are stubbed (lensChildFn); the ledger is private to this test.
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

const root = mkdtempSync(path.join(tmpdir(), "lens-round-probe-"));
const ledgerFile = path.join(root, "review-ledger.json");
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
process.env.PI_ENSEMBLE_SKILLS_DIR = new URL("../../skill", import.meta.url).pathname;
process.env.HOME = mkdtempSync(path.join(tmpdir(), "lens-round-probe-home-"));
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
const remote = path.join(root, "remote.git");
execSync(`git init -q --bare -b main ${remote}`);
git(`remote add origin ${remote}`);
git("push -q origin feature/x:main");
git("fetch -q origin");
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
git('commit -qam "feature"');
git("checkout -q --detach");
// A commit no branch names, so the budget key is detached:<sha> (not feature/x).
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
git('commit -qam "detached"');
const sha = git("rev-parse HEAD").trim();
const detachedKey = `detached:${sha}`;

const { admitLensRound } = await import("../src/lens-round-cap.ts");
const { runLensReview } = await import("../src/lens-review.ts");
const { appendLedgerEntry, readLedgerAt } = await import("../src/review-ledger.ts");
const { bumpLensRound } = await import("../src/review-ledger-round.ts");
const { execp } = await import("../src/lens-exec.ts");
const { LENS_PREFIX } = await import("../src/lens-review-format.ts");

const DIFF = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n";
const stubLens = async (req: { lens: { name: string } }) => ({
  lens: req.lens.name,
  ok: true,
  ms: 1,
  startMs: Date.now(),
  findings: [],
  // A zero-finding lens must still show it reviewed (lensProducedEvidence).
  summary: "Reviewed the change; no findings.",
  attempts: 1,
});
void LENS_PREFIX;

// -------- 1. three reviews on a detached head: rounds 1, 2, 3; the 4th is refused
const storedRounds: unknown[] = [];
const latestRound = () =>
  readLedgerAt(ledgerFile)
    .filter((e) => e.branch === detachedKey)
    .sort((a, b) => a.at - b.at)
    .at(-1)?.round;
for (let i = 1; i <= 3; i++) {
  const adm = await admitLensRound({ cwd: repo, head: sha });
  if (!adm.admitted) {
    assert(false, `review ${i} on the detached head is admitted`);
    break;
  }
  const writes: Promise<unknown>[] = [];
  const summary = await runLensReview({
    cwd: repo,
    head: sha,
    diff: DIFF,
    ledgerKey: adm.key,
    lensChildFn: stubLens as never,
    onLedgerWrite: (p) => writes.push(p),
  });
  await Promise.all(writes);
  storedRounds.push(latestRound());
  await adm.release();
  assert(
    summary.verdict === "APPROVED",
    `review ${i} on the detached head is APPROVED (got ${summary.verdict}: ${JSON.stringify(summary.lenses.map((l) => [l.lens, l.ok, l.blocked, l.parseError]))})`,
  );
}
assert(
  JSON.stringify(storedRounds) === JSON.stringify([1, 2, 3]),
  `three reviews on a detached head record rounds 1,2,3 (got ${JSON.stringify(storedRounds)})`,
);
const fourth = await admitLensRound({ cwd: repo, head: sha });
assert(
  !fourth.admitted && fourth.refusal.verdict === "ROUND_CAP_REACHED",
  "the round budget refuses the 4th review on the detached head",
);

// -------- 2. the stored round is clamped to the latest entry inside the lock
const fresh = path.join(root, "clamp-ledger.json");
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = fresh;
const base = {
  branch: "clamp",
  kind: "lens" as const,
  patchId: "p",
  passed: false,
  at: 1,
  detail: "ISSUES_FOUND",
  hasCritical: false,
};
// Both writers probed the same prior round (1), so each carries the hint 2.
const seedEntry = { ...base, at: 1, round: 1 };
await appendLedgerEntry(seedEntry, execp, root);
const roundOf = () =>
  readLedgerAt(fresh)
    .filter((e) => e.branch === "clamp")
    .sort((a, b) => a.at - b.at)
    .at(-1)?.round;
await appendLedgerEntry({ ...base, at: 2, round: 2 }, execp, root);
const storedA = roundOf();
await appendLedgerEntry({ ...base, at: 3, round: 2 }, execp, root);
const storedB = roundOf();
assert(
  storedA === 2 && storedB === 3,
  `two writes that probed the same prior round store N+1 then N+2 (got ${storedA}, ${storedB})`,
);

// The pure derivation: a hint below the implied round is raised; a hint above is kept.
const prev = { ...base, at: 1, round: 4 };
assert(
  bumpLensRound({ ...base, at: 2, round: 2 }, [prev]).round === 5,
  "a stale hint (2) after round 4 stores 5",
);
assert(
  bumpLensRound({ ...base, at: 2, round: 9 }, [prev]).round === 9,
  "a hint above the implied round is kept",
);
assert(
  bumpLensRound({ ...base, at: 2 }, [prev]).round === 5,
  "no hint → derived from the latest entry",
);
assert(!existsSync(`${fresh}.corrupt`), "no corrupt sidecar was produced");

process.exit(exit);
