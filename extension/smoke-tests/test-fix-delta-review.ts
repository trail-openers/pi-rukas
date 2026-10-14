#!/usr/bin/env bun
/**
 * A review round that follows a fix pass is shown what the fix pass changed.
 *
 * Measured on one cycle: a lens fix turned `drawMeter(view.meter)` into
 * `drawMeter(meter)` — the DOM tag instead of the view model, so every reading
 * rendered `undefined`. The adversarial re-review and the next lens round were
 * each handed the whole branch diff again and passed it; the next fix developer,
 * reading the code, found it at once. Nothing told the reviewers which lines had
 * moved since they last looked.
 *
 * Both halves drive the REAL step over a real git repository and read the
 * prompt material the reviewer would be given:
 *
 *   - `runLens` twice, with a fix commit pushed in between;
 *   - `runAdversarialFixPass` then `runAdversarial`, with the developer stub
 *     committing the fix.
 *
 * In each, the first review must carry no delta section and the one after the
 * fix must carry it WITH the changed line, alongside the unchanged full diff.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildAdversarialPrompt } from "../src/adversarial-prompts.ts";
import { FIX_DELTA_HEADING, FIX_DELTA_MAX_CHARS, fixDeltaSection } from "../src/fix-delta.ts";
import type { DispatchResult } from "../src/types.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runLens } from "../src/work-driver-lens.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { devCommit, fixState, git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

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
const BRANCH = "feature/issue-1198";
const GOOD = "function draw(view) {\n  const meter = el();\n  drawMeter(view.meter);\n}\n";
const BROKEN = GOOD.replace("drawMeter(view.meter)", "drawMeter(meter)");

// ------------------------------------------------------------ the lens rounds

{
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-fixdelta-"));
  const origPath = process.env.PATH;
  try {
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const stubs = path.join(root, "stubs");
    const g = (args: string[]) => execFileP("git", args, { cwd: repo });
    // runLens persists findings as candidate memories; a smoke test must never
    // reach the developer's real store (same stub as test-round-cap-routes-to-ci).
    mkdirSync(stubs, { recursive: true });
    writeFileSync(path.join(stubs, "vipune"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(stubs, "vipune"), 0o755);
    process.env.PATH = `${stubs}${path.delimiter}${origPath ?? ""}`;
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await g(["config", "user.email", "t@example.com"]);
    await g(["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "base.txt"), "base\n");
    await g(["add", "."]);
    await g(["commit", "-q", "-m", "base"]);
    await g(["remote", "add", "origin", origin]);
    await g(["push", "-q", "-u", "origin", "main"]);
    await g(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await g(["checkout", "-q", "-b", BRANCH]);
    writeFileSync(path.join(repo, "view.js"), GOOD);
    await g(["add", "."]);
    await g(["commit", "-q", "-m", "work"]);
    await g(["push", "-q", "-u", "origin", BRANCH]);
    const head1 = (await g(["rev-parse", "HEAD"])).stdout.trim();

    const seen: Array<{ context: string; diff: string }> = [];
    let verdict: "ISSUES_FOUND" | "REVIEW_INCOMPLETE" = "ISSUES_FOUND";
    const ctx = {
      repoRoot: repo,
      issue: 1198,
      lensReviewFn: async (o: { context?: string; diff?: string }) => {
        seen.push({ context: o.context ?? "", diff: o.diff ?? "" });
        return mkLensSummary({ verdict });
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    } as any;
    const start = {
      issue: 1198,
      eventLog: [{ kind: "adversarial-approved", at: 1, jobId: "adv", rounds: 1 }] as WorkEvent[],
      pipelineState: {
        currentStep: "lens-review",
        lastCompletedStep: "adversarial",
        status: "running",
        reviewRound: 0,
        branchName: BRANCH,
        worktrees: {},
        plumbReports: [],
      },
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    } as any as WorkState;

    const r1 = await runLens(ctx, start, Date.now());
    assert(
      seen.length === 1 && !seen[0]?.context.includes(FIX_DELTA_HEADING),
      "lens round 1: no fix-delta section — nothing was reviewed before it",
    );
    assert(
      r1.pipelineState.lensReviewedHead === head1,
      `lens round 1 records the pushed head it read (got ${r1.pipelineState.lensReviewedHead})`,
    );

    // The lens fix: one token, pushed.
    writeFileSync(path.join(repo, "view.js"), BROKEN);
    await g(["commit", "-qam", "fix(lens): round 1 review findings"]);
    await g(["push", "-q", "origin", BRANCH]);
    const head2 = (await g(["rev-parse", "HEAD"])).stdout.trim();

    // An incomplete round at the new head must not consume the delta.
    verdict = "REVIEW_INCOMPLETE";
    const incomplete = await runLens(ctx, r1, Date.now());
    assert(
      incomplete.pipelineState.lensReviewedHead === head1,
      "an incomplete review does not advance the reviewed head",
    );
    verdict = "ISSUES_FOUND";
    seen.length = 0;
    const r2 = await runLens(ctx, incomplete, Date.now());
    const c2 = seen[0]?.context ?? "";
    assert(
      c2.includes(FIX_DELTA_HEADING),
      "lens round 2: the context carries the fix-delta section",
    );
    assert(
      c2.includes("-  drawMeter(view.meter);") && c2.includes("+  drawMeter(meter);"),
      "lens round 2: the section shows the line the fix changed, before and after",
    );
    assert(
      c2.includes("Review this delta FIRST") && c2.includes("regressions the fix introduced"),
      "lens round 2: the lens is told to read the delta first, for regressions",
    );
    assert(
      (seen[0]?.diff ?? "").includes("+function draw(view) {"),
      "lens round 2: the full branch diff is still what is reviewed",
    );
    assert(r2.pipelineState.lensReviewedHead === head2, "lens round 2 records the new head");

    // A rewritten branch: the previous head is no longer an ancestor — omit.
    writeFileSync(path.join(repo, "view.js"), `${GOOD}// rewritten\n`);
    await g(["commit", "-q", "--amend", "-am", "rewritten"]);
    await g(["push", "-q", "--force", "origin", BRANCH]);
    seen.length = 0;
    await runLens(ctx, r2, Date.now());
    assert(
      seen.length === 1 && !seen[0]?.context.includes(FIX_DELTA_HEADING),
      "a previous head that is not an ancestor yields no section, not a guess",
    );

    // The bound, and the note that says it was applied.
    writeFileSync(path.join(repo, "big.txt"), `${"x".repeat(80)}\n`.repeat(1000));
    await g(["add", "."]);
    await g(["commit", "-q", "-m", "big"]);
    const head4 = (await g(["rev-parse", "HEAD"])).stdout.trim();
    const big = await fixDeltaSection(repo, `${head4}~1`, head4);
    assert(big === "", "a previous head that is not a full SHA is refused");
    const prev = (await g(["rev-parse", "HEAD~1"])).stdout.trim();
    const cut = await fixDeltaSection(repo, prev, head4);
    assert(
      cut.includes("[fix delta truncated:") && cut.length < FIX_DELTA_MAX_CHARS + 1500,
      `an oversized delta is cut and says so (${cut.length} chars)`,
    );
    assert((await fixDeltaSection(repo, head4, head4)) === "", "an unmoved head yields no section");
  } finally {
    process.env.PATH = origPath;
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------- the adversarial re-review

{
  const dir = repoWithFile("fix-delta");
  try {
    const base = git(dir, "rev-parse HEAD").trim();
    devCommit(dir, "a.txt", GOOD);
    const reviewed = git(dir, "rev-parse HEAD").trim();
    const deltas: Array<string | undefined> = [];
    const diffs: string[] = [];
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1198,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        deltas.push(params.fixDelta);
        diffs.push(params.diff ?? "");
        return {
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          text: "",
          toolUses: [],
          ms: 1,
          loopOutcome: "approved",
          adversarialRounds: [
            { round: params.reportRound ?? 1, status: "APPROVED", verdictParsed: true },
          ],
        } as DispatchResult;
      },
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") devCommit(dir, "a.txt", BROKEN);
        return { role: spec.role, ok: true, exitCode: 0, text: "done", toolUses: [], ms: 1 };
      },
    };
    const withBase = (s: WorkState): WorkState => ({
      ...s,
      pipelineState: { ...s.pipelineState, baseSha: base },
    });

    // The first review of the work: nothing preceded it.
    const first = withBase(fixState(dir, []));
    await runAdversarial(ctx, { ...first, eventLog: [] }, Date.now());
    assert(deltas.length === 1 && !deltas[0], "adversarial first review: no fix-delta section");

    const fixed = await runAdversarialFixPass(ctx, first, pendingFixes(first.eventLog), Date.now());
    const applied = fixed.eventLog[fixed.eventLog.length - 1];
    assert(
      applied?.kind === "adversarial-fix-applied" && applied.headBefore === reviewed,
      `the fix pass records the head the review read (tail: ${JSON.stringify(applied)})`,
    );

    deltas.length = 0;
    diffs.length = 0;
    const after = await runAdversarial(ctx, fixed, Date.now());
    const d = deltas[0] ?? "";
    assert(
      d.includes(FIX_DELTA_HEADING) &&
        d.includes("-  drawMeter(view.meter);") &&
        d.includes("+  drawMeter(meter);"),
      "adversarial re-review: handed the fix delta with the changed line",
    );
    assert(
      (diffs[0] ?? "").includes("+function draw(view) {"),
      "adversarial re-review: the full worktree diff is still what is reviewed",
    );
    const prompt = buildAdversarialPrompt({
      diff: diffs[0] ?? "",
      context: "c",
      round: 2,
      maxRounds: 3,
      fixDelta: d,
    });
    assert(
      prompt.includes(FIX_DELTA_HEADING) &&
        prompt.indexOf(FIX_DELTA_HEADING) < prompt.indexOf("\nDiff:\n"),
      "the reviewer prompt places the delta ahead of the full diff",
    );

    // The re-review that follows a LENS fix: the previous head is the branch
    // head the lens round read. Absent, there is no section; present, the same
    // worktree range is shown.
    const lensFixed = (head?: string): WorkState => ({
      ...after,
      pipelineState: {
        ...after.pipelineState,
        lastCompletedStep: "lens-fix",
        lensReviewedHead: head,
      },
    });
    deltas.length = 0;
    await runAdversarial(ctx, lensFixed(), Date.now());
    assert(
      deltas.length === 1 && !deltas[0],
      "a lens-fix re-review with no recorded lens head gets no section",
    );
    deltas.length = 0;
    await runAdversarial(ctx, lensFixed(reviewed), Date.now());
    assert(
      (deltas[0] ?? "").includes("+  drawMeter(meter);"),
      "a lens-fix re-review is handed what the lens fix changed since the lens round's head",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (exit === 0) console.log("\nAll fix-delta review assertions passed.");
process.exit(exit);
