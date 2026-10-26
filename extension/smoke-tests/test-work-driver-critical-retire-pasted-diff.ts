#!/usr/bin/env bun
/**
 * #1832 — the same retirement, driven on the /work lens step's OWN arguments.
 *
 * The sibling (`test-work-driver-critical-retire.ts`) proves the retirement
 * through `runLensReview`'s base/head path. That is NOT what the driver sends:
 * `runLens` hands the review a PASTED `diff` string — the integrated branch
 * diff it read itself via `readAllMergedDiffs` (`origin/<mainline>...origin/
 * <branch>`, three-dot) — and passes no `base`/`head`/`since`/`full` at all.
 * `resolveReviewDiff`'s first arm returns that text before the automatic-delta
 * decision, so on the driver's arguments every round is a FULL review by
 * construction and its `reviewKind` is `full`: the milestone-1 fate rule alone
 * is what retires a fixed CRITICAL in /work. The forced-full veto governs
 * `dispatch_lens_review`'s automatic delta, which no /work round takes.
 *
 * So this case pins the shape rather than the veto:
 *   - the wrapper captures the arguments `runLens` itself built (it forwards
 *     them verbatim; only the lens CHILD spawner is stubbed), and they are the
 *     driver's: a non-empty pasted `diff`, `base`/`head`/`since`/`full` all
 *     absent, the branch named, and `cwd` the lens worktree (== repoRoot here,
 *     where the integrated branch ref actually lives);
 *   - round 1 files a line-bearing CRITICAL, whose cited line and ±2-line
 *     window are both in that pasted diff;
 *   - round 2's commit deletes the cited code, the diff `runLens` reads has
 *     neither the line nor its window, no lens reports a CRITICAL, and the
 *     driver-observed round carries NO CRITICAL at all: no finding, no verdict,
 *     `hasCritical: false` on the ledger row, and the row resolved `code-gone`.
 *
 * The delta marker is asserted NEGATIVE: on a pasted diff there is no delta to
 * veto, so `deltaReview` stays absent (the marker belongs to the sibling's
 * computed-range shape).
 *
 * Isolation follows the sibling exactly: a real clone with an origin, a stub
 * `vipune` on PATH, a captured `gh`, a private `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * (which pins BOTH the review ledger and the findings file out of this clone),
 * and an installed skill per lens so the roster is complete.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runLensReview } from "../src/lens-review.ts";
import type { LensLedgerOutcome } from "../src/lens-ledger.ts";
import { setLedgerCriticalSectionHookForTests } from "../src/review-ledger-lock.ts";
import { latestEntry, readLedgerFileSafe } from "../src/review-ledger-read.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import { runLens } from "../src/work-driver-lens.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execFileP = promisify(execFile);
const BRANCH = "feature/issue-1832-pasted";
/** The line round 1's CRITICAL cites — deleted (with its window) before round 2. */
const SECRET = "const TOKEN = redactToken(host, port);";
/** The three lines around it, so neither the line nor its ±2 window survives. */
const WINDOW = ["// the credential the CRITICAL cites", SECRET, "boot(server, TOKEN);"];

function fileWith(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

type StubFinding = {
  severity: string;
  path: string;
  line?: number;
  title: string;
  description?: string;
};

const CRITICAL_REPORT: StubFinding[] = [
  {
    severity: "CRITICAL",
    path: "src/view.js",
    line: 3,
    title: "Credential material assembled and passed to the server",
    description: `Line 3 builds a secret from host and port and hands it to boot(): ${SECRET}`,
  },
];

/** What `runLens` handed the review, captured by the wrapper verbatim. */
type ReviewArgs = Parameters<typeof runLensReview>[0];

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-critretire-paste-"));
  const origPath = process.env.PATH;
  const origLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  const origSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
  const origAgent = process.env.PI_AGENT_DIR;
  try {
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const stubs = path.join(root, "stubs");
    const ledgerDir = path.join(root, "ledger");
    const skills = path.join(root, "skills");
    const git = (args: string[]) => execFileP("git", args, { cwd: repo });

    mkdirSync(stubs, { recursive: true });
    writeFileSync(path.join(stubs, "vipune"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(stubs, "vipune"), 0o755);
    process.env.PATH = `${stubs}${path.delimiter}${origPath ?? ""}`;
    mkdirSync(ledgerDir, { recursive: true });
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
    const agentDir = path.join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_AGENT_DIR = agentDir;

    const { LENS_ROSTER } = await import("../src/lens-roster.ts");
    let prec = 10;
    for (const l of LENS_ROSTER) {
      mkdirSync(path.join(skills, l.skill), { recursive: true });
      writeFileSync(
        path.join(skills, l.skill, "SKILL.md"),
        `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
      );
      prec += 10;
    }
    process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "base.txt"), "base\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "base"]);
    await git(["remote", "add", "origin", origin]);
    await git(["push", "-q", "-u", "origin", "main"]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(["checkout", "-q", "-b", BRANCH]);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(
      path.join(repo, "src", "view.js"),
      fileWith(["function draw(view) {", ...WINDOW, "  drawMeter(view.meter);", "}"]),
    );
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "work"]);
    await git(["push", "-q", "-u", "origin", BRANCH]);

    let reportNow: StubFinding[] = [];
    const stubLens = async (args: { lens: { name: string } }) => {
      const first = args.lens.name === LENS_ROSTER[0]?.name;
      const reported = first ? reportNow : [];
      return {
        lens: args.lens.name,
        ok: true,
        ms: 1,
        startMs: Date.now(),
        attempts: 1,
        blocked: false,
        summary: "reviewed the diff",
        findings: reported.map((f) => ({ lens: args.lens.name, ...f })),
      };
    };

    const ghCalls: string[] = [];
    const rounds: Array<Awaited<ReturnType<typeof runLensReview>>> = [];
    const argsSeen: ReviewArgs[] = [];
    const ledgerRows: Array<{ round?: number; hasCritical?: boolean; detail?: string }> = [];
    /**
     * The ledger write is fire-and-forget, so the test needs its own settle
     * signal: `onLedgerWrite` (the #984 seam) hands back the write's promise and
     * `runLensReview` does NOT await it before returning the summary.
     *
     * The row cannot simply be read back. `appendLedgerEntry` dedupes to ONE row
     * per (branch, kind) and `dedupeLatest` breaks its tie on `e.at >= prev.at`,
     * which keeps the row the file already held; both rounds' `at: Date.now()`
     * land in the same millisecond on a fast clone, so round 2's row loses to
     * round 1's and the visible file says "CRITICAL" forever — a test artefact,
     * not a product bug (round 2 really is recorded; the previous round's row
     * settles before the next round starts). The fix is to make the two rounds
     * distinguishable rather than to race the clock: the #1071 critical-section
     * hook runs INSIDE that window, where the test advances a private clock that
     * `Date.now` delegates to, so every timestamp this case produces moves
     * forward exactly one second at a time and each round's row is the newest.
     */
    let clock = Date.now();
    const realNow = Date.now;
    Date.now = () => clock;
    setLedgerCriticalSectionHookForTests(() => {
      clock += 1000;
    });

    const ctx = {
      repoRoot: repo,
      issue: 1832,
      host: { sendUserMessage: () => {} },
      // The driver's ONLY lens seam. It forwards `runLens`'s own arguments to
      // the real `runLensReview` UNCHANGED — the pasted `diff` included, which
      // is the whole point of this case — and stubs only `lensChildFn`.
      lensReviewFn: async (o: ReviewArgs) => {
        argsSeen.push(o);
        let write: Promise<LensLedgerOutcome> | undefined;
        const s = await runLensReview({
          ...o,
          lensChildFn: stubLens,
          onLedgerWrite: (p) => {
            write = p;
          },
        });
        rounds.push(s);
        // Settle this round's write, then read the row the file now shows: with
        // distinct `at`s this round's row is the newest, so the ledger's own
        // reader (the one the merge guard uses) picks it.
        await write;
        const latest = latestEntry(
          readLedgerFileSafe(process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE as string).entries,
          BRANCH,
          "lens",
        );
        ledgerRows.push({
          round: latest?.round,
          hasCritical: latest?.hasCritical,
          detail: latest?.detail,
        });
        return s;
      },
      verifyExecFn: async (cmd: string, opts?: { argv?: string[] }) => {
        if (/^gh\b/.test(commandOf(cmd, opts))) {
          ghCalls.push(cmd);
          return { stdout: "https://example.test/pull/1#issuecomment-1\n" };
        }
        return realExec(cmd, opts);
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    } as any;

    const state0 = {
      issue: 1832,
      eventLog: [{ kind: "adversarial-approved", at: 1, jobId: "adv", rounds: 1 }] as WorkEvent[],
      pipelineState: {
        currentStep: "lens-review",
        lastCompletedStep: "adversarial",
        status: "running",
        reviewRound: 0,
        branchName: BRANCH,
        prNumber: 1,
        // No worktree: `lensWorktree` falls back to repoRoot, which is where the
        // integrated branch ref lives — so the driver's reads (evidence, claim
        // scan, comments block) all see origin/<branch>.
        worktrees: {},
        plumbReports: [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    } as any as WorkState;

    // ---- round 1: the lens files a CRITICAL against the pasted diff ----
    reportNow = CRITICAL_REPORT;
    const s1 = await runLens(ctx, state0, Date.now());
    const a1 = argsSeen[0];
    const r1 = rounds[0];
    assert(a1 !== undefined && r1 !== undefined, "round 1 reached the review through runLens");
    // THE assertion this file exists for: the driver's own arguments.
    assert(
      typeof a1?.diff === "string" && a1.diff.length > 0,
      "runLens hands the review a NON-EMPTY PASTED diff (the integrated branch diff)",
    );
    assert(
      a1?.base === undefined && a1?.head === undefined && a1?.since === undefined &&
        a1?.full === undefined,
      `the driver passes no base/head/since/full — no ref range anywhere (got ${JSON.stringify([a1?.base, a1?.head, a1?.since, a1?.full])})`,
    );
    assert(a1?.branch === BRANCH, `the round names the cycle's branch (got ${a1?.branch})`);
    assert(a1?.cwd === repo, "cwd is the lens worktree (repoRoot when no worktree is recorded)");
    assert(
      a1?.pr === 1,
      `the disclosure target is the cycle's PR (got ${JSON.stringify(a1?.pr)})`,
    );
    // The cited line and its ±2 window are both in the text the lenses got.
    assert(
      (a1?.diff ?? "").includes(SECRET.replace(/\s+/g, " ").trim()) &&
        WINDOW.every((l) => (a1?.diff ?? "").includes(l.replace(/\s+/g, " ").trim())),
      "the pasted diff carries the cited line AND its ±2-line window",
    );
    assert(
      r1?.verdict === "CRITICAL_ISSUES_FOUND",
      `round 1 verdict is CRITICAL_ISSUES_FOUND (got ${r1?.verdict})`,
    );
    const rows1 = await readBranchRows(repo, BRANCH);
    const row = rows1.find((r) => r.severity === "CRITICAL");
    assert(
      row?.status === "open" && row.line !== undefined && row.lineHash !== undefined,
      "round 1 recorded an OPEN line-bearing CRITICAL row with a line hash",
    );
    // On a pasted diff the delta decision is never reached, so there is nothing
    // for the #1832 veto to mark: the marker belongs to the computed-range shape.
    assert(
      r1?.deltaReview === undefined,
      `round 1 is a plain full review — no delta, no forced marker (got ${JSON.stringify(r1?.deltaReview)})`,
    );
    assert(
      ledgerRows[0]?.round === 1 && ledgerRows[0]?.hasCritical === true,
      `round 1's ledger row has hasCritical: true (got ${JSON.stringify(ledgerRows[0])})`,
    );

    // The fix: the cited line AND its window are deleted from the branch.
    writeFileSync(
      path.join(repo, "src", "view.js"),
      fileWith(["function draw(view) {", "  drawMeter(view.meter);", "}"]),
    );
    await git(["commit", "-qam", "fix(lens): remove the assembled credential"]);
    await git(["push", "-q", "origin", BRANCH]);

    // ---- round 2: same arguments, cited code gone, nothing to file ----
    reportNow = [];
    const s2 = await runLens(ctx, s1, Date.now());
    const a2 = argsSeen[1];
    const r2 = rounds[1];
    assert(a2 !== undefined && r2 !== undefined, "round 2 reached the review through runLens");
    assert(
      typeof a2?.diff === "string" && a2.diff.length > 0,
      "round 2 also ran on a pasted diff read afresh by the driver",
    );
    assert(
      a2?.base === undefined && a2?.head === undefined && a2?.since === undefined &&
        a2?.full === undefined,
      "round 2 passes no base/head/since/full either",
    );
    assert(
      !(a2?.diff ?? "").includes(SECRET.replace(/\s+/g, " ").trim()) &&
        !WINDOW.some((l) => (a2?.diff ?? "").includes(l.replace(/\s+/g, " ").trim())),
      "round 2's pasted diff contains NEITHER the cited line NOR its ±2-line window",
    );
    assert(
      r2?.verdict !== undefined && r2.verdict !== "CRITICAL_ISSUES_FOUND",
      `round 2 verdict is NOT CRITICAL_ISSUES_FOUND (got ${r2?.verdict})`,
    );
    assert(
      !(r2?.findings ?? []).some((f) => f.severity === "CRITICAL"),
      "round 2 reports no CRITICAL finding at all",
    );
    assert(
      r2?.deltaReview === undefined,
      `round 2 stayed a full review on the driver's arguments — no delta (got ${JSON.stringify(r2?.deltaReview)})`,
    );
    const rows2 = await readBranchRows(repo, BRANCH);
    const row2 = rows2.find((r) => r.severity === "CRITICAL");
    assert(
      row2?.status === "resolved" && row2.resolvedReason === "code-gone",
      `the retired row resolved as code-gone on the FULL round (got ${row2?.status}/${row2?.resolvedReason})`,
    );
    assert(
      (r2?.resolved ?? []).some((n) => n.reason === "code-gone" && n.title === CRITICAL_REPORT[0].title),
      "the round's own summary reports the retirement under resolved/code-gone",
    );
    assert(
      ledgerRows.length === 2 && ledgerRows[1]?.round === 2 && ledgerRows[1]?.hasCritical === false,
      `round 2's ledger row has hasCritical: false (got ${JSON.stringify(ledgerRows[1])})`,
    );
    assert(
      s2.eventLog.some((e) => e.kind === "dispatch-completed" && e.step === "lens-review"),
      "round 2 completed as a driver dispatch (the round is recorded, not skipped)",
    );
    assert(
      s2.pipelineState.reviewRound === 2,
      `the driver counted two lens rounds (got ${s2.pipelineState.reviewRound})`,
    );
  } finally {
    process.env.PATH = origPath;
    if (origLedger === undefined) process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = undefined;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = origLedger;
    if (origSkills === undefined) process.env.PI_ENSEMBLE_SKILLS_DIR = undefined;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = origSkills;
    if (origAgent === undefined) process.env.PI_AGENT_DIR = undefined;
    else process.env.PI_AGENT_DIR = origAgent;
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
process.exit(exit);
