/**
 * Shared git-repo fixture for the automatic-delta smoke tests (#973 / #1128).
 *
 * `mkRepo` builds `origin/main → c0`, `feature/work → c0 → c1 → c2`;
 * `mergeMainFixture` adds `merge main` on top. Lives in lib/ so the
 * test-auto-delta-*.ts files can share it WITHOUT executing each other's
 * test bodies. Intentionally NOT named `test-*.ts` — the smoke-tests glob
 * must not self-execute this file.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const execp = promisify(exec);

// --- repo fixture: origin/main → c0, feature/work → c0 → c1 → c2 ---
export async function mkRepo(): Promise<{
  dir: string;
  c0: string;
  c1: string;
  c2: string;
  ledgerFile: string;
}> {
  const base = mkdtempSync(path.join(os.tmpdir(), "pi-973-"));
  const dir = path.join(base, "repo");
  mkdirSync(dir, { recursive: true });
  const ledgerFile = path.join(base, "review-ledger.json");
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  await execp("git init -q -b main", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m c0", { cwd: dir, shell: "/bin/bash" });
  const c0 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  await execp("git checkout -qb feature/work", { cwd: dir });
  writeFileSync(path.join(dir, "first.txt"), "one\n");
  await execp("git add first.txt && git commit -q -m c1", { cwd: dir, shell: "/bin/bash" });
  const c1 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  writeFileSync(path.join(dir, "second.txt"), "two\n");
  await execp("git add second.txt && git commit -q -m c2", { cwd: dir, shell: "/bin/bash" });
  const c2 = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  return { dir, c0, c1, c2, ledgerFile };
}

export function writeLedger(file: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}

export function cleanup(dir: string, ledgerFile: string): void {
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
  rmSync(dir, { recursive: true, force: true });
  try {
    rmSync(path.dirname(ledgerFile), { recursive: true, force: true });
  } catch {}
}

// (#1128) Merging main into the branch after the last reviewed head must NOT
// put main's hunks in the delta. Fixture: main advances with main-only.txt,
// the branch merges it (H = merge), and the last lens round reviewed c2.
export async function mergeMainFixture(): Promise<
  Awaited<ReturnType<typeof mkRepo>> & { merge: string }
> {
  const r = await mkRepo();
  await execp(
    "git checkout -q main && echo main-only > main-only.txt && git add -A && git commit -q -m m1",
    {
      cwd: r.dir,
      shell: "/bin/bash",
    },
  );
  await execp("git checkout -q feature/work && git merge -q -m merge-main main", {
    cwd: r.dir,
    shell: "/bin/bash",
  });
  const merge = (await execp("git rev-parse HEAD", { cwd: r.dir })).stdout.trim();
  return { ...r, merge };
}
