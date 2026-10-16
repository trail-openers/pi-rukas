#!/usr/bin/env bun
/**
 * #1140 (file level) + #1125 decision 1 (line level) — a finding blocks only
 * when its cited line is inside the PR's changed lines.
 *
 * Lens children are injected (`lensChildFn`), so no Pi child is spawned. A
 * temp clone has `main` (src/a.ts, src/other.ts) and `feat/x`, which changes
 * ONE line of src/a.ts — line 11, appended after ten untouched lines. The
 * round's findings are SEEDED into the findings store (`seed`) so the carried
 * list handed to the split is exact: a finding reaches the verdict through the
 * store, and the split is what is under test.
 *   1. an in-range HIGH and a CRITICAL outside the changed lines, neither
 *      re-reported: the verdict is ISSUES_FOUND on the HIGH alone, `bySeverity`
 *      counts no CRITICAL, the ledger entry says hasCritical: false, and the
 *      summary lists the CRITICAL under "Advisory (outside this PR's diff)";
 *   2. the same round again with the code unchanged: both rows stay carried and
 *      advisory — a re-review does not resurrect them into the verdict;
 *   3. the control: a CRITICAL ON the changed line decides the verdict and
 *      sets hasCritical (#1143's invariant, kept at line level);
 *   4. an unreadable changed-line list keeps every finding blocking
 *      (CRITICAL_ISSUES_FOUND) and the summary says why;
 *   5. a finding with no path blocks; a line-less finding blocks only on a
 *      changed file; a finding on an untouched line of a CHANGED file is
 *      advisory; the PR residual disclosure lists the advisory rows; the store
 *      rows are unchanged.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADVISORY_HEADING, splitAdvisory } from "../src/lens-review-advisory.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { renderSummary, runLensReview } from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import { commandOf } from "./lib/argv-shell.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "lens-advisory-"));
const repo = path.join(root, "repo");
const skills = path.join(root, "skills");
const ledgerDir = path.join(root, "ledger");
const ledgerFile = path.join(ledgerDir, "review-ledger.json");
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(ledgerDir);
let prec = 10;
for (const l of LENS_ROSTER) {
  mkdirSync(path.join(skills, l.skill), { recursive: true });
  writeFileSync(
    path.join(skills, l.skill, "SKILL.md"),
    `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
  );
  prec += 10;
}
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
sh("git init -q -b main");
sh("git config user.email dev@example.com");
sh("git config user.name dev");
const lines = (n: number, tag: string) =>
  `${Array.from({ length: n }, (_, i) => `// ${tag} ${i + 1}`).join("\n")}\n`;
writeFileSync(path.join(repo, "src", "a.ts"), lines(10, "a"));
writeFileSync(path.join(repo, "src", "other.ts"), lines(10, "other"));
sh("git add -A");
sh("git commit -qm base");
// A remote mainline, so the ledger writer can compute a patch id.
execSync(`git init -q --bare -b main ${path.join(root, "remote.git")}`);
sh(`git remote add origin ${path.join(root, "remote.git")}`);
sh("git push -q origin main");
sh("git fetch -q origin");
sh("git checkout -q -b feat/x");
// The one changed line is line 11; lines 1-10 of this file are untouched.
writeFileSync(path.join(repo, "src", "a.ts"), `${lines(10, "a")}// changed\n`);
sh("git commit -qam change");
const HEAD_SHA = sh("git rev-parse HEAD");

type Raw = { severity: string; path: string; line: number; title: string };
// The round's reported findings, seeded straight into the findings store as
// `open` rows the round does not re-report: `recordFindingRunOutcome` carries
// every one of them forward, so the list `splitAdvisory` receives is exactly
// `seed`. Nothing about the split depends on how a row got there, and seeding
// keeps the round's findings deterministic.
let seed: Raw[] = [];
// The lens's own findings for the round (the fresh half of the reported list).
let report: Raw[] = [];
const stubLens = async (args: { lens: { name: string } }): Promise<LensRunResult> =>
  ({
    lens: args.lens.name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    summary: "reviewed the diff",
    findings:
      args.lens.name === LENS_ROSTER[0]?.name
        ? report.map((f) => ({ lens: args.lens.name, ...f }))
        : [],
  }) as unknown as LensRunResult;

/** The store rows beside the ledger the review reads and writes. */
const storeFile = path.join(ledgerDir, "review-findings.json");
/** Every row the test seeds shares: an impossible snippet, so the store never
 * matches a lens finding to it and never resolves it (a snippet found nowhere
 * at head keeps a row carried, `line-past-eof` excepted). */
const ROW = {
  anchor: "file",
  snippetHash: "0000000000000000",
  status: "open",
  firstSeen: 1,
  lastSeen: 1,
} as const;
/** Replace the branch's stored rows, leaving every other branch's untouched. */
const seedStore = (rows: Raw[]) => {
  const rowsOnBranch = rows.map((r, i) => ({
    id: (0x1000 + i).toString(16).padStart(8, "0"),
    branch: "feat/x",
    path: r.path,
    titleClass: r.title.toLowerCase(),
    title: r.title,
    severity: r.severity,
    lens: "SECURITY",
    line: r.line,
    ...ROW,
  }));
  let others: unknown[] = [];
  try {
    others = (JSON.parse(readFileSync(storeFile, "utf8")).rows as unknown[]).filter(
      (r) => (r as { branch?: string }).branch !== "feat/x",
    );
  } catch {
    // no store yet
  }
  writeFileSync(storeFile, JSON.stringify({ rows: [...others, ...rowsOnBranch] }, null, 2), "utf8");
};

const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8,3 +8,4 @@\n // a 8\n // a 9\n // a 10\n+// changed";
const common = {
  cwd: repo,
  branch: "feat/x",
  head: "feat/x",
  diff: DIFF,
  lensChildFn: stubLens as never,
};
const latestLensEntry = (): Record<string, unknown> | undefined => {
  const entries = JSON.parse(readFileSync(ledgerFile, "utf8")).entries as Record<string, unknown>[];
  return entries.filter((e) => e.kind === "lens").at(-1);
};
/** Wait until the branch's lens entry records round `n` (one lens row per branch). */
const waitForRound = async (n: number) => {
  for (let i = 0; i < 250; i++) {
    try {
      if (latestLensEntry()?.round === n) return;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  // 1. An in-range HIGH (carried by the store) and a CRITICAL on a file the PR
  // never touches (the #1133 phantom-row shape). The split is what is under
  // test: the CRITICAL is advisory, so it neither decides the verdict nor sets
  // `hasCritical`.
  seed = [{ severity: "CRITICAL", path: "src/other.ts", line: 5, title: "phantom critical" }];
  seedStore(seed);
  // The in-range HIGH is a fresh finding from the lens, so the store cannot
  // carry it — fresh findings never pass through the advisory split at all.
  report = [{ severity: "HIGH", path: "src/a.ts", line: 11, title: "in-range problem" }];
  const r1 = await runLensReview({ ...common, base: "main" });
  assert(
    r1.verdict === "ISSUES_FOUND",
    `round 1: the in-range HIGH decides the verdict, the out-of-range CRITICAL does not (got ${r1.verdict})`,
  );
  assert(
    r1.findings.length === 1 && r1.findings[0]?.path === "src/a.ts",
    "round 1: only the in-range finding is counted in the reported findings",
  );
  assert(
    r1.advisory?.length === 1 && r1.advisory[0]?.path === "src/other.ts",
    "round 1: the finding outside the changed lines is listed as advisory",
  );
  assert(r1.bySeverity.CRITICAL === 0, "round 1: the advisory CRITICAL is not counted");
  await waitForRound(1);
  assert(
    latestLensEntry()?.hasCritical === false,
    "round 1: the ledger entry records hasCritical: false",
  );
  const text = renderSummary(r1, 4);
  assert(
    text.includes(ADVISORY_HEADING) && text.includes("phantom critical"),
    "round 1: the summary lists the advisory row under its heading",
  );
  const rowsAfter = await readBranchRows(repo, "feat/x");
  assert(
    rowsAfter.length === 2 && rowsAfter.every((r) => r.status === "open"),
    "the store rows are unchanged (no deletion, no status change)",
  );

  // 2. The next round sees the same code: the lens re-reports the in-range HIGH
  // and the store carries the out-of-range CRITICAL forward (its cited code is
  // unchanged, so #1130's rule does not resolve it). The verdict is unchanged —
  // an out-of-range finding never re-enters it, round after round.
  seed = [{ severity: "CRITICAL", path: "src/other.ts", line: 5, title: "phantom critical" }];
  seedStore(seed);
  const r2 = await runLensReview({ ...common, base: "main" });
  assert(
    r2.verdict === "ISSUES_FOUND" && r2.findings.length === 1,
    `round 2: the carried rows do not re-enter the verdict (got ${r2.verdict})`,
  );
  assert(
    r2.advisory?.length === 1 && r2.advisory[0]?.path === "src/other.ts",
    "round 2: the out-of-range row is still carried and still advisory",
  );
  assert(r2.bySeverity.CRITICAL === 0, "round 2: the advisory CRITICAL is not counted");

  // 3. The control: a CRITICAL ON a changed line still blocks and still sets
  // hasCritical — the advisory tier never swallows a finding whose code the PR
  // actually touched (#1143's invariant, held at line level).
  seed = [{ severity: "CRITICAL", path: "src/a.ts", line: 11, title: "changed-line critical" }];
  seedStore(seed);
  await waitForRound(2);
  const rControl = await runLensReview({ ...common, base: "main" });
  assert(
    rControl.verdict === "CRITICAL_ISSUES_FOUND",
    `control: the in-range CRITICAL decides the verdict (got ${rControl.verdict})`,
  );
  assert(
    rControl.findings.some((f) => f.title === "changed-line critical"),
    "control: the in-range finding is a reported (blocking) finding",
  );
  await waitForRound(3);
  assert(
    latestLensEntry()?.hasCritical === true,
    "control: an in-range CRITICAL sets hasCritical on the ledger entry",
  );

  // 4. An unreadable changed-line list keeps every finding blocking (fail closed).
  const r4 = await runLensReview({ ...common, base: "no-such-ref" });
  assert(
    r4.verdict === "CRITICAL_ISSUES_FOUND" && !r4.advisory,
    "an unreadable changed-line list keeps every finding blocking (today's behaviour)",
  );
  assert(
    /changed lines could not be read/.test(r4.memoryNote ?? ""),
    "…and the summary says the ranges could not be read",
  );

  // 5a. A finding with no path stays blocking; a line-less finding blocks only
  // on a changed file; and nothing reported means no git read and no note.
  const asFinding = (f: Record<string, unknown>): never => f as never;
  const split = await splitAdvisory(
    [
      asFinding({ lens: "SECURITY", severity: "CRITICAL", path: "", title: "no path" }),
      asFinding({ lens: "SECURITY", severity: "LOW", path: "src/a.ts", title: "file-level" }),
      asFinding({
        lens: "ARCHITECTURE",
        severity: "LOW",
        path: "src/other.ts",
        title: "file-level untouched",
      }),
    ],
    repo,
    "main",
    HEAD_SHA,
    true,
  );
  assert(
    split.blocking.length === 2 && split.fields.advisory?.length === 1,
    "a finding with no path blocks, and a line-less finding on a changed file blocks",
  );
  assert(
    split.fields.advisory?.[0]?.path === "src/other.ts",
    "a line-less finding on a file the PR does not change is advisory",
  );
  const none = await splitAdvisory([], repo, "no-such-ref", undefined, true);
  assert(
    none.blocking.length === 0 && !none.fields.memoryNote,
    "no reported findings → no git read and no note",
  );

  // 5a-bis. No range to speak of (a `full` review, or a run whose head never
  // resolved): the split discounts NOTHING and says nothing — the discount is
  // earned by a range that was read, never assumed. The same out-of-range
  // finding that 5b calls advisory here blocks.
  const noRange = await splitAdvisory(
    [asFinding({ lens: "SIMPLICITY", severity: "MEDIUM", path: "src/a.ts", line: 3 })],
    repo,
    "main",
    undefined,
    false,
  );
  assert(
    noRange.blocking.length === 1 && !noRange.fields.advisory && !noRange.fields.memoryNote,
    "with no readable range nothing is discounted and no note is emitted",
  );

  // 5b. A line-bearing finding is placed by its line alone, never by its file:
  // a changed file contributes its changed LINES, so a finding on an untouched
  // line of that file is advisory.
  const untouchedLine = await splitAdvisory(
    [asFinding({ lens: "SIMPLICITY", severity: "MEDIUM", path: "src/a.ts", line: 3 })],
    repo,
    "main",
    HEAD_SHA,
    true,
  );
  assert(
    untouchedLine.blocking.length === 0 && untouchedLine.fields.advisory?.length === 1,
    "a finding on an untouched line of a CHANGED file is advisory",
  );

  // 5c. A changed-file listing that is empty (a bad ref pair) is unreadable,
  // not "nothing changed": the split fails closed with a note.
  const closed = await splitAdvisory(
    [asFinding({ lens: "SECURITY", severity: "HIGH", path: "src/a.ts", line: 11 })],
    repo,
    "no-such-ref",
    HEAD_SHA,
    true,
  );
  assert(
    closed.blocking.length === 1 &&
      /changed lines could not be read/.test(closed.fields.memoryNote ?? ""),
    "an unreadable range blocks everything and says why",
  );

  // 4b. The PR residual disclosure lists the advisory rows.
  process.env.PI_ENSEMBLE_FORGE = "github";
  let body = "";
  const execFn = async (cmd0: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const cmd = commandOf(cmd0, o);
    if (cmd.includes("pr list --state open --head feat/x")) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: "feat/x", baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      const file = /--body-file\s+'?([^'\s]+)'?/.exec(cmd)?.[1] ?? "";
      body = readFileSync(file, "utf8");
      return { stdout: "" };
    }
    if (cmd.includes("symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.includes("git merge-base")) return { stdout: "mb0000\n" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git config --get remote")) return { stdout: "git@github.com:o/r.git\n" };
    return { stdout: "" };
  };
  await postLensResidualDisclosure({ summary: r2, branch: "feat/x", cwd: repo, execFn });
  assert(
    body.includes(ADVISORY_HEADING) && body.includes("src/other.ts:5"),
    "the PR residual disclosure lists the advisory row under its heading",
  );
  assert(body.includes("pi-rukas:lens-residuals"), "the disclosure marker is unchanged");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
