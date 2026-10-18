#!/usr/bin/env bun
/**
 * #1561 — an intent park carries its reason and the resolver's decisive
 * evidence in the headless result's `failure.message` (which a host copies
 * into its own record), not only in the handoff prose.
 *
 *   - the message names the park reason and the PR / commit the park rests on
 *   - a cited PR's state is READ from the forge, never taken from prose
 *   - a park resting on an OPEN PR says it is awaiting review and names it,
 *     and the handoff no longer tells the reader to close the issue
 *   - an unreadable PR state is said to be unread, not guessed
 *
 * Offline: the explore dispatch and the forge are fakes.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_INTENT = "1";
const ISSUE = 247;

function reply(reason: string, evidence: string[], rationale: string): string {
  return [
    "INTENT-VERDICT: park",
    `PARK-REASON: ${reason}`,
    "",
    "## Spec",
    "",
    "### Intent",
    "Add the widget renderer.",
    "",
    "### Evidence",
    ...evidence,
    "",
    "## Rationale",
    rationale,
    "",
  ].join("\n");
}

type PrState = "OPEN" | "MERGED" | "CLOSED" | "throw";

async function park(text: string, prs: Record<number, PrState> = {}): Promise<WorkState> {
  const dir = mkdtempSync(path.join(tmpdir(), "park-reason-1561-"));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  const forge = {
    prView: async (n: number) => {
      const st = prs[n];
      if (st === undefined || st === "throw") throw new Error(`gh: no PR ${n}`);
      return { number: n, state: st, isDraft: false };
    },
  } as unknown as Forge;
  const ctx: DriverContext = {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: dir,
    issue: ISSUE,
    forge,
    issueBodyFetcherFn: async () => ({ stdout: `title:\tmock #${ISSUE}\n\nadd the widget` }),
    verifyExecFn: async () => ({ stdout: "" }),
    dispatchFn: async (_pi, spec) =>
      ({
        role: spec.role,
        ok: true,
        text,
        toolUses: [],
        ms: 10,
        exitCode: 0,
        transcriptPath: "/tmp/stub-transcript.json",
      }) as DispatchResult,
  };
  try {
    const s = await runExplore(ctx, initialState(ISSUE, Date.now()), Date.now());
    return { ...s, pipelineState: { ...s.pipelineState, status: "handoff" } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. #247's shape: the park rests on an open, unreviewed PR.
{
  const s = await park(
    reply(
      "already-implemented",
      ["- PR #334 implements every Done-when item — gh pr view 334 — confirmed"],
      "PR #334 is a complete, gated, mergeable implementation, sitting unreviewed.",
    ),
    { 334: "OPEN" },
  );
  const f = projectIssue(s, "f").failure;
  const msg = f?.message ?? "";
  assert(s.eventLog.at(-1)?.kind === "cap-hit", "the cycle parks at the intent gate");
  assert(/already-implemented/.test(msg), `message names the park reason (${msg})`);
  assert(/PR #334/.test(msg), "message names the PR the park rests on");
  assert(/awaiting review/i.test(msg), "an open PR is said to be awaiting review");
  assert(!/\bclose\b/i.test(msg.replace(/close #247 once/i, "")), "message does not say close it");
  const why = explainCap("intent-park", s);
  assert(!/Close it if you agree/.test(why), "the handoff no longer says close it if you agree");
  assert(/PR #334/.test(why) && /awaiting review/i.test(why), "the handoff names the open PR");
}

// 2. #301's shape: the work is on main at a commit.
{
  const s = await park(
    reply(
      "already-implemented",
      ["- the widget renderer exists on main — git log 58c2bf4 — confirmed"],
      "Implemented by 58c2bf4.",
    ),
  );
  const msg = projectIssue(s, "f").failure?.message ?? "";
  assert(/already-implemented/.test(msg), `commit park names its reason (${msg})`);
  assert(/58c2bf4/.test(msg), "commit park names the commit");
  assert(!/awaiting review/i.test(msg), "no PR, no awaiting-review claim");
}

// 3. A merged PR is reported with its state, not as awaiting review.
{
  const s = await park(
    reply("already-implemented", ["- merged in PR #12 — gh pr view 12 — confirmed"], "Done."),
    { 12: "MERGED" },
  );
  const msg = projectIssue(s, "f").failure?.message ?? "";
  assert(/PR #12 \(MERGED\)/.test(msg), `a merged PR carries its state (${msg})`);
  assert(!/awaiting review/i.test(msg), "a merged PR is not awaiting review");
  assert(/Close it if you agree/.test(explainCap("intent-park", s)), "merged: wording unchanged");
}

// 4. An unreadable PR state is said to be unread, not guessed.
{
  const s = await park(
    reply("already-implemented", ["- PR #99 does it — gh pr view 99 — confirmed"], "See PR #99."),
    { 99: "throw" },
  );
  const msg = projectIssue(s, "f").failure?.message ?? "";
  assert(/PR #99 \(state not read\)/.test(msg), `an unread state is named as such (${msg})`);
  assert(!/awaiting review/i.test(msg), "an unread state is not called awaiting review");
}

// 5. A reason with no PR or commit still carries the decisive claim.
{
  const s = await park(
    reply(
      "contradicted-by-code",
      ["- the counters are separate — src/step-router.ts:192 — contradicted"],
      "The issue is stale.",
    ),
  );
  const f = projectIssue(s, "f").failure;
  const msg = f?.message ?? "";
  assert(/contradicted-by-code/.test(msg), `contradicted park names its reason (${msg})`);
  assert(/the counters are separate/.test(msg), "message carries the contradicting claim");
  assert(/src\/step-router\.ts:192/.test(f?.evidence ?? ""), "evidence carries the source");
}

process.exit(exit);
