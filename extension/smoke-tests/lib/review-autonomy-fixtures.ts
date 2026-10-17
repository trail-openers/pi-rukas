/**
 * lens-review-autonomy-fixtures — the shared harness for the #1144 review-
 * autonomy scenarios (`test-review-autonomy.ts`'s #1125 block): a real clone
 * whose PR changes exactly one line, the findings-store seeder that puts a
 * round's findings on the carried path, and the round-capped merge decision.
 *
 * The scenarios drive the REAL `runLensReview` and the REAL merge guard, so
 * what they assert is the pipeline's behaviour, not a mock's. This module holds
 * only the scaffolding (the 500-line gate: the scenarios themselves live in the
 * test file, which already carried the adversarial-tool-path matrix).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillsDirUsable } from "../../src/lens-review-skills.ts";
import type { MergeTarget } from "../../src/merge-target.ts";
import { FINDINGS_FILE } from "../../src/review-findings-store.ts";
import type { LedgerEntry } from "../../src/review-ledger.ts";
import { latestEntry, readLedgerAt } from "../../src/review-ledger.ts";
import { hookDecision } from "../merge-guard-helpers.ts";
import { waitForLedger } from "./wait-for-ledger.ts";

/** A stored row's invariant fields: the test's rows are all open, unmatched,
 * and never resolved — an impossible snippet means the store matches no lens
 * finding to them and never resolves them, so a seeded row is a carried row. */
const SEEDED = {
  anchor: "file",
  lens: "SECURITY",
  snippetHash: "0000000000000000",
  status: "open",
  firstSeen: 1,
  lastSeen: 1,
} as const;

export interface SeedRow {
  severity: string;
  path: string;
  line?: number;
  title: string;
}

/** The findings-store file beside the ledger the review reads and writes —
 * same directory, the store's own filename constant (never a literal). */
export function storeFileOf(ledgerFile: string): string {
  return path.join(path.dirname(ledgerFile), FINDINGS_FILE);
}

/** Replace this branch's stored rows with `rows`, leaving other branches'
 * rows untouched (the store is one file for every branch of the clone). */
export function seedFindings(storeFile: string, branch: string, rows: readonly SeedRow[]): void {
  const onBranch = rows.map((r, i) => ({
    id: (0x1000 + i).toString(16).padStart(8, "0"),
    branch,
    path: r.path,
    titleClass: r.title.toLowerCase(),
    title: r.title,
    severity: r.severity,
    line: r.line,
    ...SEEDED,
  }));
  let others: unknown[] = [];
  try {
    others = (JSON.parse(readFileSync(storeFile, "utf8")).rows as unknown[]).filter(
      (r) => (r as { branch?: string }).branch !== branch,
    );
  } catch (err) {
    // A missing store means this branch's rows are the whole file; anything
    // else (a torn or corrupt file) is a real problem and must not be quietly
    // overwritten by the seed.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  writeFileSync(storeFile, JSON.stringify({ rows: [...others, ...onBranch] }, null, 2), "utf8");
}

/** The branch's latest lens entry — the row the round-cap rule and the merge
 * guard read. `rows` selects which entries a suite counts (default: this
 * branch's lens rows). */
export function latestLensEntry(
  ledgerFile: string,
  branch: string,
  rows: (entries: LedgerEntry[]) => LedgerEntry[] = (entries) =>
    entries.filter((e) => e.kind === "lens" && e.branch === branch),
  read = readLedgerAt,
): LedgerEntry | undefined {
  return latestEntry(rows(read(ledgerFile)), branch, "lens");
}

/** How long `waitForLensRound` waits for the fire-and-forget write to land the
 * row it is looking for. The writer's measured latency is two subprocess hops
 * (a couple of hundred ms on an idle host); this is the headroom for a loaded
 * one, chosen well under the smoke watchdog's per-test bound so a hung writer
 * surfaces as this suite's own assertion, not as a watchdog kill naming the
 * wrong thing. */
const LENS_ROUND_WAIT_MS = 30_000;

/** Wait until the branch's lens entry records round `n`. The ledger write is
 * fire-and-forget (#984), so a scenario reads the entry through this seam
 * rather than racing it.
 *
 * Built on `waitForLedger`'s own predicate seam: the poll returns the ENTRIES it
 * accepted, so the row this helper hands back is the one the poll actually read.
 * The old shape polled through `waitForLedger` and then re-read the file through
 * its own copy of the row lookup — a second reader whose parse errors swallow to
 * `[]`, so a torn or malformed file at the deadline read as "no such round" and
 * the scenario threw its own 'recorded no lens entry' instead of the poll's
 * report of an unreadable ledger. A predicate never satisfied by the deadline
 * returns null (the shared poll's contract), never the stale file.
 *
 * There is no injected `read` any more: the predicate seam is what decides,
 * `waitForLedger` is what reads, and a second reader is precisely the
 * swallowed-parse-error bug the paragraph above describes. A caller that wants
 * different ROWS passes `rows`; a caller that wanted a different READER was
 * asking for a second, weaker read. */
export async function waitForLensRound(
  ledgerFile: string,
  branch: string,
  n: number,
  rows: (entries: LedgerEntry[]) => LedgerEntry[] = (entries) =>
    entries.filter((e) => e.kind === "lens" && e.branch === branch),
): Promise<LedgerEntry | undefined> {
  // One sleep between ticks, and only when the previous check missed: the
  // passing path reads the ledger once and returns (the shared poll's own idiom).
  //
  // #1145 — the sleep is an ASYNC `setTimeout`, and that is load-bearing, not
  // cosmetic. `waitForLedger`'s own wait is `Atomics.wait` on a
  // SharedArrayBuffer, which parks the WHOLE thread for its budget: no timer
  // fires and no I/O callback runs while it waits. The writer this poll is
  // waiting for is the fire-and-forget ledger write, which is itself a chain of
  // ASYNC git subprocess calls (`workingTreePatchId` → `identityBase` →
  // `resolveMainline`). So a long `Atomics.wait` here starves exactly the writer
  // whose file it is watching for: with a 60 s budget the row appeared only at
  // t=60 s, immediately after the wait released — the writer could not run while
  // the poll ran. The pre-#1145 shape (a 200 ms budget, ~500 ms of parked thread
  // across the whole loop) happened to leave the writer enough gaps to finish,
  // which is why this suite is green on a fast host and red on a loaded one.
  //
  // So: `once: true` (one read, never a blocking wait — #1145 round 3 replaced
  // the `budgetMs: 0` that only LOOKED like a single read; see
  // lib/wait-for-ledger.ts) plus the awaited 20 ms tick, which yields to the
  // loop so the writer's git children can run.
  //
  // The bound is a WALL-CLOCK DEADLINE, not an iteration count. The old shape
  // ("500 iterations × 20 ms ≈ 10 s") stated a bound it did not implement:
  // `setTimeout(20)` is a floor, and a loop whose body also does a synchronous
  // file read and parse under load runs each tick slower than 20 ms, so the
  // real ceiling was however long 500 slow ticks take — a number that grows
  // exactly when the host is loaded, which is the condition the wait exists for.
  // A `Date.now()` deadline says the thing it means: this much time, no more.
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const deadlineMs = Date.now() + LENS_ROUND_WAIT_MS;
  const settled = (entries: LedgerEntry[]): boolean => rows(entries).some((e) => e.round === n);
  const rowOf = (entries: LedgerEntry[]): LedgerEntry | undefined =>
    latestEntry(rows(entries), branch, "lens");
  // The pre-check and every tick read the file directly rather than through
  // `readLedgerAt`, which swallows a parse error to `[]`: a torn or malformed
  // file must not read as "no such round" here either.
  const attempt = (): LedgerEntry[] | null =>
    waitForLedger(ledgerFile, { once: true, until: settled });
  const first = attempt();
  const firstRow = first ? rowOf(first) : undefined;
  if (firstRow?.round === n) return firstRow;
  while (Date.now() < deadlineMs) {
    await tick();
    const entries = attempt();
    const row = entries ? rowOf(entries) : undefined;
    if (row?.round === n) return row;
  }
  // Timed out with the predicate never satisfied: null, so the caller's assertion
  // fails on the missing round rather than on whatever older row is on disk.
  return undefined;
}

/**
 * #1144 — pin the installed-skills dir to the REPO's own bundled `skill/` dir
 * for the lifetime of `fn` (the save/restore idiom test-review-tools-refrange.ts
 * uses): on a CI runner `~/.pi/agent/skills` has no `code-review-*` skills, so
 * `buildExpectedRoster` marks every lens blocked and the review verdicts
 * REVIEW_INCOMPLETE before the injected lens child is ever consulted. The
 * scenarios would otherwise pass on a dev host that happens to have the skills
 * installed and fail on CI. Save/restore, and an UNSET prior is restored to
 * unset, so a caller that set the variable itself is not clobbered.
 */
export async function withBundledSkillsDir<T>(fn: () => Promise<T>): Promise<T> {
  // This file lives in extension/smoke-tests/lib/, so ../../../ is the repo
  // root — where the bundled skill/ dir lives. `fileURLToPath` (not
  // `.pathname`, which leaves percent-escapes in a path containing them).
  const pinned = fileURLToPath(new URL("../../../skill", import.meta.url));
  // Pinning a dir the review cannot use would make every lens blocked and the
  // verdict REVIEW_INCOMPLETE — a failure about the fixture, not the pipeline.
  // Ask the same predicate the review asks before pinning it.
  const unusable = skillsDirUsable(pinned);
  if (unusable) throw new Error(`withBundledSkillsDir: refusing to pin ${pinned}: ${unusable}`);
  const prior = process.env.PI_ENSEMBLE_SKILLS_DIR;
  process.env.PI_ENSEMBLE_SKILLS_DIR = pinned;
  try {
    return await fn();
  } finally {
    // An UNSET prior is restored to UNSET. Assigning `undefined` to process.env
    // does not remove the variable — it stores the string "undefined", which
    // `piSkillsDir()` then hands to the roster as a real path (and the next
    // caller's save/restore sees as a set value). `delete` is the only way back.
    // biome-ignore lint/performance/noDelete: delete is the correct "reset to unset"
    if (prior === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = prior;
  }
}

/** The shape the #973 round-cap rule reads: ISSUES_FOUND at the round cap, with
 * the residual-findings disclosure on the PR (the marker is what makes the
 * carried findings visible; without it the guard refuses). `over` lets a caller
 * choose the strict rule's `passed` — the field the guard's strict path scores —
 * so a scenario picks which gate decides. */
export async function roundCapDecision(opts: {
  row: LedgerEntry;
  target: MergeTarget;
  over?: Partial<LedgerEntry>;
}) {
  const { row, target } = opts;
  const adversarial: LedgerEntry = {
    branch: row.branch,
    kind: "adversarial",
    patchId: row.patchId,
    passed: true,
    at: row.at - 1,
    detail: "completed",
  };
  const capped: LedgerEntry = {
    ...row,
    passed: false,
    round: 3,
    detail: "ISSUES_FOUND",
    ...opts.over,
  };
  const oid = row.headSha ?? target.headOid;
  return hookDecision("gh pr merge 12", [adversarial, capped], {
    patchId: row.patchId,
    ghComments: JSON.stringify({
      comments: [
        {
          body: `residuals\n<!-- pi-rukas:lens-residuals branch=${row.branch} patch=${row.patchId} -->`,
        },
      ],
    }),
    fetchedHead: oid,
    target: { ...target, headOid: oid },
  });
}

/** The same merge with NO disclosure comment on the PR — the refusal half of
 * the round-cap rule. */
export async function mergeWithoutDisclosure(opts: {
  row: LedgerEntry;
  target: MergeTarget;
}) {
  const { row, target } = opts;
  const oid = row.headSha ?? target.headOid;
  return hookDecision("gh pr merge 12", [], {
    patchId: row.patchId,
    ghComments: JSON.stringify({ comments: [] }),
    fetchedHead: oid,
    target: { ...target, headOid: oid },
  });
}

/** Commit `files` on a new branch cut from the mainline, then commit one more
 * time with `final` — so the PR's changed lines are exactly the lines `final`
 * adds, and every file present before is out of the range. The scenarios need
 * to know the changed ranges exactly; a helper that "makes a repo" and leaves
 * the range implicit is what makes such a test wrong. */
export function buildPrRepo(
  repoDir: string,
  branch: string,
  files: Record<string, string>,
  final: Record<string, string>,
): void {
  const g = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  g("checkout", "-q", "-b", branch, "main");
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(repoDir, name), content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "branch start");
  for (const [name, content] of Object.entries(final)) {
    writeFileSync(path.join(repoDir, name), content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "the PR's change");
}
