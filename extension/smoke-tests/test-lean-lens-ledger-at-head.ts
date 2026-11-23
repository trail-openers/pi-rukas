#!/usr/bin/env bun
/**
 * lean's six-lens round is recorded on the review ledger, keyed to the head it reviewed.
 *
 * The step hands the review layer `cwd = repoRoot`, a run checkout parked at the base
 * commit while the branch lives in `.worktrees/lean-7`. A ledger identity computed from
 * that checkout's working tree is an empty diff, so the round the step ran was never
 * recorded. The row's identity has always been the reviewed commit's — the one the
 * merge guard recomputes — and the row is read back through the round cap's own
 * reader. The knob that used to switch that off is retired: its off arm was this bug.
 *
 * Real temp repos; only the six lens children are stubbed, through the lean seam's own
 * `lensChildFn`. The engine is the real `runLensReview`, wrapped only to await its
 * fire-and-forget ledger write on the layer's own seam.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { reviewDeps } from "../src/lean/review-deps.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { runLensReview } from "../src/lens-review.ts";
import { readRecordedLens } from "../src/lens-round-cap.ts";
import { committedIdentity } from "../src/review-patch-identity.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { cleanupRoots, git, makeRepo, setup } from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();
const BRANCH = "lean/issue-7";

const cleanChild = async (a: { lens: { name: string } }): Promise<LensRunResult> => ({
  lens: a.lens.name as LensRunResult["lens"],
  ok: true,
  ms: 0,
  startMs: Date.now(),
  findings: [],
  attempts: 1,
  blocked: false,
  summary: "clean",
});

/**
 * One lean round through the real seam and layer; what landed and what was warned.
 * `again` re-runs the full wave at a descendant head from a detached run checkout, the
 * shape whose budget key resolves to the lean branch and so finds the first row.
 */
async function round(again = false) {
  const { repoRoot, baseSha } = makeRepo();
  let head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "lean-ledger-at-head-"));
  const ledger = path.join(dir, "review-ledger.json");
  writeFileSync(ledger, '{"entries":[]}', "utf8");
  const saved = { ...process.env };
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledger;
  process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(import.meta.dirname, "..", "..", "skill");
  const warned: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    warned.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const deps = reviewDeps(false);
    deps.lensChildFn = cleanChild as never;
    const pending: Promise<unknown>[] = [];
    deps.lensEngine = ((o: Parameters<typeof runLensReview>[0]) =>
      runLensReview({ ...o, onLedgerWrite: (p) => void pending.push(p) })) as never;
    const full = () =>
      deps.lens({
        base: baseSha,
        head,
        branch: BRANCH,
        cwd: repoRoot,
        wave: "full",
        pr: undefined,
        context: "lean round",
        evidence: undefined,
        extraFindings: [],
        headless: false,
        budget: { opts: {}, fired: () => undefined },
        threshold: "HIGH",
      });
    if (again) git(repoRoot, "checkout", "-q", "--detach");
    let lens = await full();
    await Promise.all(pending);
    if (again) {
      const wt = path.join(repoRoot, ".worktrees", "lean-7");
      writeFileSync(path.join(wt, "fix.ts"), "export const g = 2;\n", "utf8");
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "fix: the fixer's commit");
      head = git(wt, "rev-parse", "HEAD");
      lens = await full();
      await Promise.all(pending);
    }
    const recorded = await readRecordedLens(repoRoot, BRANCH);
    const guard = await committedIdentity(execp, repoRoot, head, "origin/main");
    const warn = warned.filter((l) => l.includes("WARN")).join("");
    return { head, recorded, guard, warn, lens };
  } finally {
    process.stderr.write = write;
    process.env = saved;
  }
}

// ── the round is recorded, bound to the commit the merge guard checks
{
  const r = await round();
  const row = r.recorded.ok ? r.recorded.latest : undefined;
  assert(row !== undefined, `the lean round left a lens row (${r.warn.trim() || "no warn"})`);
  assert(
    row?.patchId !== undefined && row.patchId === r.guard.patchId,
    `and its patch id is the reviewed head's, as the merge guard recomputes it (${String(row?.patchId)} vs ${String(r.guard.patchId)})`,
  );
  assert(
    row?.headSha === r.head,
    `the row names the head it reviewed (${String(row?.headSha)})`,
  );
  assert(!r.warn.includes("ledger write skipped"), `no skip was warned (${r.warn.trim()})`);
}

// ── a second full wave at a descendant head: still the whole branch, not a delta
{
  const r = await round(true);
  assert(
    r.lens.deltaReview === undefined && r.lens.noReview !== true,
    `the second full wave reviewed the whole branch (${JSON.stringify(r.lens.deltaReview)})`,
  );
}

cleanupRoots();
process.exit(failures());
