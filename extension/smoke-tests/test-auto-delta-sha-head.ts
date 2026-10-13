#!/usr/bin/env bun
/**
 * #1128 — the automatic delta base uses the round-cap budget key.
 *
 * A SHA head on a detached checkout names no branch, so the delta lookup
 * used to skip (full review) while the round cap keyed the run on the
 * sole local branch at that commit (lens-budget-key.ts). The delta now
 * reads the same key, so a second SHA-head round gets the delta.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { runLensReview } = await import("../src/lens-review.ts");

const base = mkdtempSync(path.join(os.tmpdir(), "pi-1128-"));
const dir = path.join(base, "repo");
const ledgerFile = path.join(base, "review-ledger.json");
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;

try {
  mkdirSync(dir, { recursive: true });
  await execp("git init -q -b main", { cwd: dir });
  await execp("git config user.email t@t", { cwd: dir });
  await execp("git config user.name T", { cwd: dir });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A", { cwd: dir });
  await execp("git commit -q -m c0", { cwd: dir });
  await execp("git checkout -qb feature/work", { cwd: dir });
  writeFileSync(path.join(dir, "first.txt"), "one\n");
  await execp("git add -A", { cwd: dir });
  await execp("git commit -q -m c1", { cwd: dir });
  const c1 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  writeFileSync(path.join(dir, "second.txt"), "two\n");
  await execp("git add -A", { cwd: dir });
  await execp("git commit -q -m c2", { cwd: dir });
  const c2 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  // Detached checkout: HEAD names no branch; feature/work still points at c2,
  // so the budget key resolves to feature/work (points-at).
  await execp("git checkout -q --detach", { cwd: dir });

  writeFileSync(
    ledgerFile,
    JSON.stringify({
      entries: [
        {
          branch: "feature/work",
          kind: "lens",
          patchId: "p1",
          passed: true,
          at: 1000,
          detail: "APPROVED",
          hasCritical: false,
          headSha: c1,
          round: 1,
        },
      ],
    }),
    "utf8",
  );

  const result = await runLensReview({
    base: "main",
    head: c2,
    cwd: dir,
    lensChildFn: async () =>
      ({
        lens: "SECURITY",
        ok: true,
        ms: 0,
        startMs: Date.now(),
        findings: [],
        attempts: 1,
        blocked: false,
        summary: "clean",
      }) as never,
  });
  const since = (result as { deltaReview?: { since: string } }).deltaReview?.since;
  assert(since === c1, `SHA-head second round gets the delta since c1 (got ${since ?? "none — full review"})`);
} finally {
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
