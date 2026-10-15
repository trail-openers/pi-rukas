#!/usr/bin/env bun
/**
 * #1305 — the merge guard compares the identity the review ledger records.
 *
 * Real git throughout (temp repo, bare origin, origin/HEAD set): passing
 * adversarial + lens entries are recorded through the REAL writers, the
 * REAL guard decides, and only the forge (`gh`) is stubbed.
 *
 *   1. main advances with an unrelated commit, no rebase → the guard allows
 *      the merge. Before #1305 the guard's two-dot `base..head` identity
 *      changed here and every review read as "stale".
 *   2. the branch itself gains a commit after the review → refused as stale.
 *   3. after main moved, the residual marker the poster writes carries the
 *      guard's identity: the #973 round-cap path allows the merge on it.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { writeLensLedgerEntry } from "../src/lens-ledger.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { LensReviewSummary } from "../src/lens-review.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import { latestEntry, readLedgerFile } from "../src/review-ledger.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { ledgerFile, setupRepo } from "./lib/review-ledger-test-helpers.ts";

process.env.PI_ENSEMBLE_FORGE = "github";
delete process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
delete process.env.PI_ENSEMBLE_LENS_ROUND_CAP;
delete process.env.PI_ENSEMBLE_LENS_ROUND_CAP_MERGE;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BRANCH = "feature/x";
const sh = (repo: string, cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** Real git for every non-`gh` command; `gh` answers from the PR fixture. */
function forgeExec(repo: string, pr: { comments: string[] }) {
  return async (cmd0: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    if (cmd0 !== "gh" && !cmd0.startsWith("gh ")) {
      const stdout = o?.argv
        ? execFileSync(cmd0, o.argv, { cwd: repo, encoding: "utf8", stdio: "pipe" })
        : execSync(cmd0, { cwd: repo, encoding: "utf8", stdio: "pipe" });
      return { stdout };
    }
    const cmd = commandOf(cmd0, o);
    if (cmd.includes("--json comments")) {
      return { stdout: JSON.stringify({ comments: pr.comments.map((body) => ({ body })) }) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: BRANCH, baseRefName: "dev" }) };
    }
    if (cmd.includes("pr view 12")) {
      return {
        stdout: JSON.stringify({
          headRefName: BRANCH,
          headRefOid: sh(repo, `git rev-parse origin/${BRANCH}`),
          baseRefName: "dev",
          author: { login: "dev-user" },
          labels: [],
        }),
      };
    }
    const bodyFile = /--body-file (\S+)/.exec(cmd)?.[1];
    if (cmd.includes("pr comment 12") && bodyFile) {
      pr.comments.push(readFileSync(bodyFile.replace(/^'|'$/g, ""), "utf8"));
      return { stdout: "" };
    }
    throw new Error(`unexpected gh call: ${cmd}`);
  };
}

/** Drive the real guard from inside `repo` (it reads the ledger via cwd). */
async function guard(repo: string, pr: { comments: string[] }) {
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  registerMergeGuard(
    { on: (n: string, fn: typeof handler) => n === "tool_call" && (handler = fn) } as never,
    { execFn: forgeExec(repo, pr) },
  );
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const r = (await handler?.({ toolName: "bash", input: { command: "gh pr merge 12" } }, {})) as
      | { block?: boolean; reason?: string }
      | undefined;
    return { block: r?.block === true, reason: r?.reason ?? "" };
  } finally {
    process.chdir(prev);
  }
}

/** The latest entry of `kind` on file (none while the ledger does not exist yet). */
function latest(repo: string, kind: "adversarial" | "lens") {
  const file = ledgerFile(repo);
  return existsSync(file) ? latestEntry(readLedgerFile(file).entries, BRANCH, kind) : undefined;
}

/** Record a passing adversarial review through the real (fire-and-forget) writer. */
async function recordAdversarial(repo: string) {
  const before = latest(repo, "adversarial");
  writeAdversarialLedgerEntry({ ok: true, loopOutcome: "approved" } as never, {
    workCwd: repo,
    branch: BRANCH,
  });
  for (let i = 0; i < 300; i++) {
    const now = latest(repo, "adversarial");
    if (now && now.at !== before?.at) return now;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the adversarial ledger entry never appeared");
}

/** Advance origin/dev with an unrelated commit; the branch is NOT rebased. */
function advanceMain(repo: string) {
  sh(repo, "git checkout -q dev");
  sh(repo, "echo other > other.txt && git add other.txt && git commit -qm unrelated");
  sh(repo, "git push -q origin dev");
  sh(repo, `git checkout -q ${BRANCH}`);
}

const twoDot = (repo: string) =>
  sh(repo, `git diff origin/dev..origin/${BRANCH} | git patch-id --stable`).split(/\s+/)[0];

// ------------------------------- 1 + 2: main moves (allowed), branch moves (stale)
{
  const { repo } = setupRepo();
  try {
    const pr = { comments: [] as string[] };
    const adv = await recordAdversarial(repo);
    const lens = await writeLensLedgerEntry("APPROVED", "MEDIUM", repo, BRANCH);
    assert(lens.recorded, "the real lens writer recorded a passing entry");
    assert(
      (await guard(repo, pr)).block === false,
      "baseline: reviewed branch, main unmoved → allowed",
    );

    advanceMain(repo);
    assert(
      twoDot(repo) !== adv.patchId,
      "main moved: the old two-dot identity no longer equals the recorded one (the #1305 trap)",
    );
    const moved = await guard(repo, pr);
    assert(moved.block === false, `main moved, branch unchanged → still allowed (${moved.reason})`);

    sh(repo, "echo more >> change.txt && git commit -qam more && git push -q origin feature/x");
    const changed = await guard(repo, pr);
    assert(changed.block === true, "the branch gained a commit after review → refused");
    assert(
      /adversarial review is stale/.test(changed.reason),
      "…naming the stale adversarial review",
    );

    await recordAdversarial(repo);
    assert(
      (await guard(repo, pr)).block === false,
      "a re-review on the new content restores passage (old identity: no silent pass)",
    );
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

// ------------------------------- 3: the marker and the guard agree after main moved
{
  const { repo } = setupRepo();
  try {
    const pr = { comments: [] as string[] };
    await recordAdversarial(repo);
    const head = sh(repo, `git rev-parse origin/${BRANCH}`);
    for (let i = 0; i < 3; i++) {
      await writeLensLedgerEntry("ISSUES_FOUND", "MEDIUM", repo, BRANCH, false, head);
    }
    advanceMain(repo);
    const refused = await guard(repo, pr);
    assert(refused.block === true, "round-capped lens with no disclosure → refused");

    const summary: LensReviewSummary = {
      verdict: "ISSUES_FOUND",
      totalFindings: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0 },
      lenses: [],
      findings: [
        { severity: "MEDIUM", path: "change.txt", line: 1, title: "t", lens: "SIMPLICITY" },
      ] as never,
    };
    const note = await postLensResidualDisclosure({
      summary,
      branch: BRANCH,
      pr: 12,
      cwd: repo,
      execFn: forgeExec(repo, pr) as never,
    });
    assert(note === "" && pr.comments.length === 1, `the marker was posted (${note})`);
    const adv = latest(repo, "adversarial");
    const markerPatch = /patch=(\S+) -->/.exec(pr.comments[0] ?? "")?.[1];
    assert(
      markerPatch === adv?.patchId,
      "the marker's patch= equals the recorded merge-base identity",
    );
    const allowed = await guard(repo, pr);
    assert(
      allowed.block === false,
      `marker + guard agree after main moved → allowed (${allowed.reason})`,
    );

    pr.comments[0] = (pr.comments[0] ?? "").replace(/patch=\S+ -->/, `patch=${twoDot(repo)} -->`);
    const stale = await guard(repo, pr);
    assert(
      stale.block === true,
      "a marker carrying the old two-dot identity no longer matches → refused",
    );
  } finally {
    rmSync(path.dirname(repo), { recursive: true, force: true });
  }
}

process.exit(exit);
