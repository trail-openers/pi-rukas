#!/usr/bin/env bun
/**
 * AC2 (#2027) — the complement of the new arm: a carried row the delta did NOT
 * change keeps today's behaviour (carried, open), and the arm consumes per-
 * commit change evidence rather than the mere existence of a delta.
 *
 * Both halves are constructed so the row reaches the NEW arm and is refused
 * THERE. That distinction is the whole criterion: a row whose cited code still
 * occurs at head is carried by steps 3-4 and would stay green under a mutant
 * that resolves on "a delta happened". Here the cited code is GONE from head,
 * so the only thing standing between the row and retirement is the per-commit
 * test the mutant deletes:
 *
 *   - half 1: the range's commits touched only a file the row does not cite
 *     (its window edit deleted the cited line). No commit changed the cited
 *     line, so the row carries;
 *   - half 2: the same round, but the range could not be read — absence of
 *     change evidence is never a resolution.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type FindingRun,
  readBranchRows,
  recordFindingRunOutcome,
} from "../src/review-findings-store.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROW = {
  lens: "SIMPLICITY",
  severity: "HIGH",
  path: "src/a.ts",
  line: 3,
  title: "Unvalidated export",
} as const;
/** A delta over a file the row does not cite. */
const ELSEWHERE =
  "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-x\n+y\n";

const dir = mkdtempSync(path.join(tmpdir(), "ac2-2027-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { env: gitTestEnv(), encoding: "utf8" }).trim();
try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  // Line 3 is cited; its ±2 window spans the whole file, so the deletion below
  // takes BOTH hashes with it and the row reaches the arm instead of being
  // carried by the survival tests.
  writeFileSync(
    path.join(dir, "src", "a.ts"),
    "// header\nexport const a = 1;\nexport const b = 2;\n// trailing\n",
  );
  writeFileSync(path.join(dir, "src", "other.ts"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feat/x");
  const round = (o: Omit<FindingRun, "cwd" | "branch" | "headSha">) =>
    recordFindingRunOutcome({
      ...o,
      cwd: dir,
      branch: "feat/x",
      headSha: git("rev-parse", "HEAD"),
    });

  const r1 = await round({ findings: [ROW], review: "full" });
  assert(r1.ok === true, `round 1 filed the row (${r1.ok ? "ok" : r1.reason})`);
  const since = git("rev-parse", "HEAD");
  // A commit of the delta edits the top of the cited file (deleting the cited
  // line) and an unrelated file. Its per-commit ranges name line 3 of NEITHER
  // file: the deletion-only hunk maps to line 2, and nothing touches line 3.
  writeFileSync(path.join(dir, "src", "a.ts"), "// header\nexport const a = 1;\n// trailing\n");
  writeFileSync(path.join(dir, "src", "other.ts"), "y\n");
  git("add", "src/a.ts", "src/other.ts");
  git("commit", "-qm", "unrelated");
  assert(
    !git("diff", `${since}..HEAD`, "-U0", "--", "src/a.ts").includes("+export const b = 2"),
    "no commit of the delta rewrote the row's cited line",
  );

  // Half 1 — the round names the range it reviewed, and that range says no
  // commit changed the cited line: today's carry, unchanged.
  const r2 = await round({
    findings: [],
    review: "delta",
    deltaDiff: ELSEWHERE,
    deltaSince: since,
  });
  if (!r2.ok) {
    assert(false, `the delta round recorded (refused: ${r2.reason})`);
    process.exit(1);
  }
  assert(
    r2.resolved.length === 0 && r2.carried.length === 1,
    `a delta whose commits left the cited line alone keeps the row carried (resolved ${
      r2.resolved.map((n) => n.reason).join(",") || "none"
    }, carried ${r2.carried.length})`,
  );
  assert((await readBranchRows(dir, "feat/x"))[0]?.status === "open", "the row stays open on disk");

  // Half 2 — the same row judged by a round whose range could not be read:
  // absence of change evidence is never a resolution.
  const r3 = await round({ findings: [], review: "delta", deltaDiff: ELSEWHERE });
  if (!r3.ok) {
    assert(false, `the range-less round recorded (refused: ${r3.reason})`);
    process.exit(1);
  }
  assert(
    r3.resolved.length === 0 && r3.carried.length === 1,
    `no range evidence, no retirement (resolved ${
      r3.resolved.map((n) => n.reason).join(",") || "none"
    }, carried ${r3.carried.length})`,
  );
  assert(
    (await readBranchRows(dir, "feat/x"))[0]?.status === "open",
    "and the row is still open after the range-less round",
  );
  process.exit(exit);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
