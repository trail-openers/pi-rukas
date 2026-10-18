#!/usr/bin/env bun
/**
 * #1392 — a consolidated-verify park carries content, not only a path.
 *
 * Cycles 54 and 60 parked naming no assertion and no baseline result: the
 * commit-pr `integration-verify-failed` cap had no `evidence` and no
 * `verifyEvidence`, the develop seam dropped the baseline probe's answer, and
 * neither handoff surface showed a line of the failing run's output. Pinned
 * here (test-handoff-rendering.ts sits at the 500-line cap):
 *
 *   - the commit-pr halt carries `evidence` + `verifyEvidence` on a code failure;
 *   - an unprobed commit-pr park states the baseline verdict;
 *   - the develop park records the baseline note and the log's tail;
 *   - both renderers show the tail fenced and REDACTED, and a stale record
 *     under an unrelated cap is not shown.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { commitPrVerifyHalt } from "../src/work-driver-commit-lock.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import { verifyOutputTail } from "../src/work-driver-verify-output-tail.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const tmp = mkdtempSync(path.join(tmpdir(), "verify-park-evidence-"));

function baseState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 1392,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: "feature/issue-1392",
    },
    eventLog: [],
  } as WorkState;
}

// --- the writer: redact before bound, start at a line
{
  const raw = `${"filler line\n".repeat(600)}token=${SECRET}\nFAIL  the console's tests\n`;
  const tail = verifyOutputTail(raw) ?? "";
  assert(tail.length > 0 && tail.length <= 3000, "the tail is bounded");
  assert(!tail.includes(SECRET), "the tail carries no secret");
  assert(tail.endsWith("FAIL  the console's tests"), "the tail keeps the end of the run");
  assert(tail.startsWith("filler line"), "a clipped tail starts at a line boundary");
}

// --- commit-pr: an unprobed park states the baseline verdict
{
  const repo = mkdtempSync(path.join(tmp, "repo-"));
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
    if (String(cmd).startsWith("git ")) return { stdout: "" };
    const e = new Error("Command failed") as Error & { stdout?: string; stderr?: string };
    e.stdout = "ok    shellcheck\nFAIL  the console's tests\n";
    e.stderr = "";
    throw e;
  };
  const r = await runCommitPrConsolidatedVerify(execFn, {
    verifyCmd: "bash scripts/verify.sh",
    repoRoot: repo,
    workstreamCount: 1,
    workstreamIds: ["default"],
    timeoutMs: 60_000,
  });
  assert(r.ok === false, "commit-pr: the failing gate fails");
  if (r.ok === false) {
    assert(
      r.classifiedMessage.includes("specific assertion: FAIL  the console's tests"),
      `commit-pr: the gate's FAIL line is the assertion (${r.classifiedMessage.slice(0, 160)})`,
    );
    assert(
      /baseline: not probed — no base commit/.test(r.classifiedMessage),
      "commit-pr: the park states that the baseline was not probed, and why",
    );
  }
}

// --- commit-pr halt: evidence + verifyEvidence on a code failure
{
  const reason = "[needs-human-decision] verify failed — baseline: unknown";
  const s = commitPrVerifyHalt(baseState(), reason, { outputTail: `FAIL x\nkey=${SECRET}` });
  const cap = s.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "integration-verify-failed" && cap.evidence === reason,
    "commit-pr halt: integration-verify-failed carries evidence",
  );
  const ev = s.pipelineState.verifyEvidence;
  assert(
    ev?.step === "commit-pr" && ev.failures[0] === reason && ev.outputTail !== undefined,
    "commit-pr halt: verifyEvidence records the failure and the tail",
  );
  for (const [name, out] of [
    ["markdown", renderHandoffMarkdown(s, tmp)],
    ["chat", renderHandoffUserMessage(s, tmp, `${tmp}/scratch`)],
  ] as const) {
    assert(out.includes("FAIL x"), `${name}: the tail's content is rendered`);
    assert(!out.includes(SECRET), `${name}: no secret survives into the rendered body`);
  }
  const timed = commitPrVerifyHalt(baseState(), "killed at bound", { timedOut: true });
  const tcap = timed.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    tcap?.kind === "cap-hit" && tcap.cap === "verify-timeout:commit-pr",
    "commit-pr halt: a killed run still parks as a timeout",
  );
}

// --- develop: the baseline note and the log tail are recorded
{
  const log = path.join(tmp, "consolidated-verify-run1.log");
  writeFileSync(log, "ok    a\nFAIL  b\n```\n## injected heading\n```\n");
  const gate = {
    ok: false,
    failures: ["[needs-human-decision] verify command `x` failed on the CONSOLIDATED tree"],
    notes: ["baseline verify passed — `x` exits 0 on a clean checkout of the base commit abc"],
    logPath: log,
  } as unknown as Parameters<typeof appendDevelopVerifyFailure>[1];
  const s = appendDevelopVerifyFailure(baseState(), gate);
  const ev = s.pipelineState.verifyEvidence;
  assert(ev?.baseline?.startsWith("baseline verify passed") === true, "develop: baseline recorded");
  assert(ev?.outputTail?.includes("FAIL  b") === true, "develop: the log's tail is recorded");
  const md = renderHandoffMarkdown(s, tmp);
  assert(md.includes("Baseline: baseline verify passed"), "markdown: the baseline is rendered");
  assert(md.includes("````text"), "markdown: the fence outgrows the output's own backticks");

  // A later, unrelated cap does not resurface the stale verify record.
  s.eventLog.push({
    kind: "cap-hit",
    at: 9,
    cap: "intent-park",
    reviewRound: 0,
    nextStep: "handoff",
  });
  assert(
    !renderHandoffMarkdown(s, tmp).includes("### Verify output"),
    "stale evidence is not shown",
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
