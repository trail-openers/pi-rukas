/**
 * #1219 — a handoff with a pull request, driven through the
 * in-process forge fallback (the ops dispatch failed):
 *
 *   1. the comment is posted to the PR NUMBER, never the issue number (an
 *      issue number handed to the PR-comment seam fails every attempt);
 *   2. a PR label that could not be applied is never reported as applied
 *      because the issue label landed;
 *   3. a comment that could not be posted is named in the operator message,
 *      with the manual command, even when the label landed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runHandoff } from "../src/work-driver-handoff.ts";
import { cappedState, fakePi, mkFakeForge } from "./lib/handoff-provenance-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 46;
const PR = 77;

/** The incident's forge: PR comments resolve only for a real PR number; the
 *  PR label write is refused (token scope); the issue label write works. */
function incidentForge(opts: { prLabelWorks: boolean; prCommentWorks: boolean }) {
  const issueLabels: string[] = [];
  const prLabels: string[] = [];
  const { forge, calls } = mkFakeForge({ issueLabels, prLabels });
  const f = forge as unknown as Record<string, unknown>;
  f.prComments = async () => [];
  f.prComment = async (n: number) => {
    calls.push({ method: "prComment", args: [n] });
    if (n !== PR || !opts.prCommentWorks) {
      throw new Error(`Could not resolve to a PullRequest with the number of ${n}.`);
    }
    return `https://github.com/acme/widget/pull/${n}#issuecomment-9001`;
  };
  f.labelAdd = async (target: "issue" | "mr", n: number, name: string) => {
    calls.push({ method: "labelAdd", args: [target, n, name] });
    if (target === "mr") {
      if (!opts.prLabelWorks) throw new Error("token has not been granted the required scopes");
      prLabels.push(name);
    } else {
      issueLabels.push(name);
    }
  };
  return { forge, calls };
}

async function run(opts: { prLabelWorks: boolean; prCommentWorks: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-pr-target-"));
  process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS = "0";
  try {
    const { forge, calls } = incidentForge(opts);
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: ISSUE,
      dispatchFn: async () => {
        throw new Error("ops dispatch failed (simulated)");
      },
      forge,
    };
    const next = await runHandoff(ctx, cappedState(ISSUE, PR), Date.now());
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    const msg = renderHandoffUserMessage(next, dir, `${dir}/tmp/issue-${ISSUE}`);
    return { emitted: emitted?.kind === "handoff-emitted" ? emitted : undefined, calls, msg };
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_POST_RETRY_BACKOFF_MS;
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1 + 2 — the incident: PR comment seam, PR label refused, issue label fine.
{
  const { emitted, calls } = await run({ prLabelWorks: false, prCommentWorks: true });
  const commentTargets = calls.filter((c) => c.method === "prComment").map((c) => c.args[0]);
  assert(commentTargets.length === 1, "the comment is posted once (no retries burnt on a wrong id)");
  assert(commentTargets[0] === PR, `the comment goes to PR #${PR}, not issue #${ISSUE}`);
  assert(
    emitted?.commentUrl === `https://github.com/acme/widget/pull/${PR}#issuecomment-9001`,
    "the PR comment URL is recorded",
  );
  assert(emitted?.issueLabelApplied === true, "the issue label is recorded applied");
  assert(emitted?.prLabelApplied === false, "the refused PR label is recorded NOT applied");
  assert(
    emitted?.labelApplied === false,
    "labelApplied is false when the PR label failed — the issue label does not vouch for it",
  );
}

// Both targets labelled → labelApplied is true (the fix does not over-correct).
{
  const { emitted } = await run({ prLabelWorks: true, prCommentWorks: true });
  assert(
    emitted?.labelApplied === true &&
      emitted.issueLabelApplied === true &&
      emitted.prLabelApplied === true,
    "both labels applied → labelApplied true",
  );
}

// 3 — the comment cannot be posted but both labels land: the message says so.
{
  const { emitted, msg } = await run({ prLabelWorks: true, prCommentWorks: false });
  assert(emitted?.commentUrl === undefined, "an unposted comment records no URL");
  assert(emitted?.labelApplied === true, "fixture: the labels landed");
  assert(msg.includes("comment NOT posted"), "the operator message names the missing comment");
  assert(
    msg.includes(`gh pr comment ${PR} --body-file`),
    "the manual command targets the PR number",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
