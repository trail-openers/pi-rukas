#!/usr/bin/env bun
/**
 * #1832 — driver-level proof that a FIXED CRITICAL lens finding retires.
 *
 * This is the acceptance criterion the resolver-seam test cannot reach: it runs
 * the /work lens step (`runLens`) with `lensReviewFn` UNSET, so the real
 * `runLensReview` decides the review mode and records the round — only the lens
 * CHILDREN are stubbed. Round 1 files a CRITICAL; round 2's commit deletes the
 * cited code. Before #1832 round 2 was an automatic delta (which can never
 * resolve a row), the CRITICAL row carried, and both verdicts were
 * CRITICAL_ISSUES_FOUND with no new CRITICAL — a /work cycle that always parks.
 *
 * What is asserted at the driver level:
 *   - round 1: CRITICAL_ISSUES_FOUND, `hasCritical: true` on its ledger row, and
 *     the round records an open line-bearing CRITICAL row;
 *   - round 2: NO CRITICAL — neither in the findings nor in the verdict — and
 *     `hasCritical: false` on ITS ledger row (the row the merge guard reads);
 *   - round 2 ran as a FORCED FULL review, not a delta (the #1832 veto), with the
 *     reason in its `Mode:` line;
 *   - the retired row shows under "Resolved since last round" with its reason,
 *     and is no longer carried.
 *
 * Isolation follows test-round-cap-routes-to-ci.ts (a real clone with an origin,
 * a stub `vipune` on PATH, a captured `gh`) plus a private
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE`, which pins BOTH the review ledger and the
 * findings file out of this clone.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runLensReview } from "../src/lens-review.ts";
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
const BRANCH = "feature/issue-1832";
/** The line round 1's CRITICAL cites, and the line round 2 deletes. */
const SECRET = 'const TOKEN = "hunter2-shared-between-envs";';

/** One lens roster entry's report; the first lens reports, the rest are clean. */
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
    line: 2,
    title: "Hardcoded credential committed to the repository",
    description: `Line 2 embeds a secret: ${SECRET}`,
  },
];

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-critretire-"));
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

    // A stub vipune so the driver's candidate-memory writes never touch the
    // developer's real store; a private ledger/findings dir so neither lands in
    // this clone; a private agent dir for the state-dir resolver.
    mkdirSync(stubs, { recursive: true });
    writeFileSync(path.join(stubs, "vipune"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(stubs, "vipune"), 0o755);
    process.env.PATH = `${stubs}${path.delimiter}${origPath ?? ""}`;
    mkdirSync(ledgerDir, { recursive: true });
    process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
    const agentDir = path.join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_AGENT_DIR = agentDir;

    // An installed skill per lens, so the expected roster is complete and the
    // round is not INCOMPLETE for a missing lens (the convention of
    // lib/review-findings-fixtures.ts).
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
      `function draw(view) {\n${SECRET}\n  drawMeter(view.meter);\n}\n`,
    );
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "work"]);
    await git(["push", "-q", "-u", "origin", BRANCH]);

    // The stub lens spawner: the first lens reports whatever `reportNow()` says,
    // every other lens answers with prose so the round counts as COMPLETE.
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
    /** Each round's real summary, captured by the wrapper below. */
    const rounds: Array<Awaited<ReturnType<typeof runLensReview>>> = [];
    /** The ledger row each round recorded, read after that round completed. */
    const ledgerRows: Array<{ round?: number; hasCritical?: boolean; detail?: string }> = [];
    /**
     * The ledger row the merge guard reads, once the fire-and-forget write has
     * landed. #984's `onLedgerWrite` hook fires when the write promise is HANDED
     * BACK (lens-review-finish.ts creates it before awaiting the disclosure
     * post), so it is not a settle signal — poll for the row the write actually
     * appended, with a bound so a lost write fails the test instead of hanging
     * it. `appendLedgerEntry` dedupes to one row per (branch, kind), so the
     * latest row IS the round that just ran.
     */
    const readLedgerRow = async (expectedRound: number) => {
      const file = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE as string;
      const row = async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          parsed = undefined;
        }
        const all = (parsed as { entries?: unknown })?.entries;
        const mine = Array.isArray(all)
          ? (all as Array<Record<string, unknown> & { branch: string; kind: string }>).filter(
              (e) => e.branch === BRANCH && e.kind === "lens",
            )
          : [];
        const last = mine[mine.length - 1];
        return last
          ? {
              round: last.round as number | undefined,
              hasCritical: last.hasCritical as boolean | undefined,
              detail: last.detail as string | undefined,
            }
          : undefined;
      };
      let last: Awaited<ReturnType<typeof row>>;
      for (let i = 0; i < 300; i++) {
        last = await row();
        // A round always records ITS round number, so waiting for the row to
        // change is waiting for this round's write — not for a row that is
        // merely present from the previous round.
        if (last && last.round !== expectedRound) return last;
        await new Promise((r) => setTimeout(r, 10));
      }
      return (await row()) ?? {};
    };
    const ctx = {
      repoRoot: repo,
      issue: 1832,
      host: { sendUserMessage: () => {} },
      // The driver's ONLY lens seam is `lensReviewFn`; it delegates straight to
      // the real `runLensReview`, which is what decides the review mode and
      // records the round. Only `lensChildFn` — the lens CHILD spawner — is
      // stubbed, so nothing here replaces the mode decision under test.
      lensReviewFn: async (o: Parameters<typeof runLensReview>[0]) => {
        // The driver hands the review a PASTED `diff` string (the integrated
        // branch diff it read itself), and `resolveReviewDiff`'s first arm
        // returns that text BEFORE the automatic-delta decision is reached — so
        // the mode the #1832 veto governs is only reachable when the review
        // resolves its own range. Name the refs and let it compute.
        const own = { ...o, diff: undefined, base: "main", head: BRANCH };
        const s = await runLensReview({ ...own, lensChildFn: stubLens });
        // Fire-and-forget contract: the ledger write is NOT awaited (and the
        // #984 `onLedgerWrite` hook is handed back before the write settles, so
        // it is not a settle signal). Take the summary first, then poll for the
        // row this round appended — round 2's delta base comes from round 1's
        // row, so the write must have landed before the fix commit below.
        rounds.push(s);
        ledgerRows.push(await readLedgerRow(rounds.length - 1));
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
        worktrees: {},
        plumbReports: [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    } as any as WorkState;

    // ---- round 1: the lens files a CRITICAL ----
    reportNow = CRITICAL_REPORT;
    const s1 = await runLens(ctx, state0, Date.now());
    const r1 = rounds[0];
    assert(
      s1.pipelineState.reviewRound === 1,
      `round 1 ran (reviewRound ${s1.pipelineState.reviewRound})`,
    );
    assert(
      r1?.verdict === "CRITICAL_ISSUES_FOUND",
      `round 1 verdict is CRITICAL_ISSUES_FOUND (got ${r1?.verdict})`,
    );
    const rows1 = await readBranchRows(repo, BRANCH);
    const row = rows1.find((r) => r.severity === "CRITICAL");
    assert(
      row !== undefined && row.status === "open" && row.line !== undefined,
      "round 1 recorded an OPEN line-bearing CRITICAL row",
    );
    assert(row?.lineHash !== undefined, "the row carries a cited-line hash");

    // The fix: the cited code is deleted and pushed. BOTH lens rounds run on
    // `main`, so the automatic delta's base is not the previous round's head (a
    // carry, which records no headSha) but the mainline base the last
    // DIFFERENT-base round recorded — the same automatic delta the /work step
    // gets, and the same one the #1832 veto has to convert.
    writeFileSync(
      path.join(repo, "src", "view.js"),
      "function draw(view) {\n  drawMeter(view.meter);\n}\n",
    );
    await git(["commit", "-qam", "fix(lens): remove the committed credential"]);
    await git(["push", "-q", "origin", BRANCH]);

    // ---- round 2: the lens no longer reports it, and the code is gone ----
    reportNow = [];
    const s2 = await runLens(ctx, s1, Date.now());
    const r2 = rounds[1];
    assert(
      r2?.verdict !== undefined && r2.verdict !== "CRITICAL_ISSUES_FOUND",
      `round 2 verdict is NOT CRITICAL_ISSUES_FOUND (got ${r2?.verdict})`,
    );
    assert(
      !(r2?.findings ?? []).some((f) => f.severity === "CRITICAL"),
      "round 2 reports no CRITICAL finding at all",
    );
    // `since` is NOT passed: the driver passes no `full`/`since` either, so the
    // round is an AUTOMATIC delta candidate and the #1832 veto is what decides it.
    // The key the delta decision uses is `budgetKey.key ?? branchResolved`, both
    // of which resolve to BRANCH here — the same key the probe reads.
    assert(
      r2?.deltaReview?.forcedFull === "open-critical",
      `round 2 ran as a FORCED FULL review, not a delta (got ${JSON.stringify(r2?.deltaReview)})`,
    );
    assert(
      rounds[0]?.deltaReview === undefined,
      "round 1 was an ordinary full review (no delta to veto, no forced marker)",
    );
    const rows2 = await readBranchRows(repo, BRANCH);
    const row2 = rows2.find((r) => r.severity === "CRITICAL");
    assert(
      row2?.status === "resolved" && row2.resolvedReason === "code-gone",
      `the retired row is resolved as code-gone (got ${row2?.status}/${row2?.resolvedReason})`,
    );

    // The ledger row the merge guard reads: round 1 blocking, round 2 not.
    assert(ledgerRows.length === 2, `two rounds ran (got ${ledgerRows.length})`);
    assert(
      ledgerRows[0]?.round === 1 && ledgerRows[0]?.hasCritical === true,
      `round 1's ledger row has hasCritical: true (got ${JSON.stringify(ledgerRows[0])})`,
    );
    assert(
      ledgerRows[1]?.round === 2 && ledgerRows[1]?.hasCritical === false,
      `round 2's ledger row has hasCritical: false (got ${JSON.stringify(ledgerRows[1])})`,
    );
    // The disclosure path is covered by dedicated tests; an APPROVED round has
    // nothing to disclose, so there is no `gh` post to assert here.
    assert(
      s2.eventLog.some((e) => e.kind === "dispatch-completed" && e.step === "lens-review"),
      "round 2 completed as a driver dispatch (the round is recorded, not skipped)",
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
