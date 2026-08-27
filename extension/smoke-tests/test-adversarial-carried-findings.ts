#!/usr/bin/env bun
/**
 * Passing a finding on is not the same as discarding it.
 *
 * Only `CRITICAL_ISSUES_FOUND` blocks the commit now — `ISSUES_FOUND` and
 * `MINOR_OBSERVATIONS` are documented as non-blocking, so a cycle carrying them
 * proceeds to a PR. That relaxation is only defensible if what was found still
 * reaches a human and still reaches the gate that applies the project's
 * severity threshold. Otherwise it is a rubber stamp with extra steps, and this
 * repo already has #328 on that subject: a gate that cannot fail is not a gate.
 *
 * So: the findings ride on the `adversarial-approved` event, into the PR body
 * and into the six-lens review's context.
 */

import { carriedAdversarialFindings, renderCarriedFindings } from "../src/adversarial-findings.ts";
import { inlineCommitPrPrompt } from "../src/work-driver-prompts-late.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const approved = (findings?: string, at = 1): WorkEvent =>
  ({
    kind: "adversarial-approved",
    at,
    jobId: `j${at}`,
    rounds: 3,
    ...(findings ? { findings } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any as WorkEvent;

const FINDING = "extract_metadata false-match on ' | assumption:' — sanitize.rs:127";

// ------------------------------------------------------------- reading them

{
  assert(
    carriedAdversarialFindings([approved(FINDING)]) === FINDING,
    "findings on a passed gate are readable",
  );
  assert(
    carriedAdversarialFindings([approved()]) === undefined,
    "a clean APPROVED carries nothing",
  );
  assert(
    carriedAdversarialFindings([approved("   ")]) === undefined,
    "whitespace-only findings are nothing, not something",
  );
  assert(carriedAdversarialFindings([]) === undefined, "an empty log is safe");
  assert(
    carriedAdversarialFindings([{ kind: "branch-completed" } as unknown as WorkEvent]) ===
      undefined,
    "a log with no adversarial event is safe",
  );
}

{
  // A cycle that loops through lens-fix runs adversarial more than once. Only
  // the latest pass describes the diff as it now stands.
  const log = [approved("stale finding from the first pass", 1), approved(FINDING, 2)];
  assert(
    carriedAdversarialFindings(log) === FINDING,
    "canary: the LATEST pass wins — an earlier round's findings must not resurface after a lens-fix",
  );
  // ...and a later clean pass clears them.
  assert(
    carriedAdversarialFindings([approved(FINDING, 1), approved(undefined, 2)]) === undefined,
    "a later clean pass clears the earlier findings rather than leaving them stuck",
  );
}

// ------------------------------------------------------------ rendering them

{
  const rendered = renderCarriedFindings(FINDING);
  assert(rendered.includes(FINDING), "the PR section contains the finding");
  assert(
    /did not\s+block/i.test(rendered),
    "...and says plainly that it did not block, so a reader is not alarmed by a passing PR",
  );
  assert(
    rendered.includes("CRITICAL_ISSUES_FOUND"),
    "...and names what would have blocked, so the bar is legible",
  );
  assert(
    renderCarriedFindings(undefined) === "",
    "canary: nothing to say renders NOTHING — a clean cycle's PR body is unchanged",
  );
  assert(renderCarriedFindings("  ") === "", "...whitespace too");
}

// ------------------------------------------------------------ testing both paths produce the section

{
  // Test fallback path — inlineCommitPrPrompt extracts findings from eventLog
  const scratchDir = "/tmp/issue-455";
  const prompt = inlineCommitPrPrompt(
    [455], // issues
    [], // droppedIssues
    {}, // worktrees
    {}, // workstreams
    "main", // branchName
    undefined, // normalisedSpec
    [approved(FINDING)], // eventLog — carries the adversarial findings
    scratchDir, // scratchDirAbs
  );
  
  // Verify the fallback prompt includes the carried findings section
  assert(
    prompt.includes("## Adversarial review"),
    "fallback prompt includes carried findings section header",
  );
  assert(
    prompt.includes(FINDING),
    "fallback prompt includes the carried finding text",
  );
  assert(
    /did not\s+block/i.test(prompt),
    "fallback prompt says findings did not block",
  );
  assert(
    prompt.includes("CRITICAL_ISSUES_FOUND"),
    "fallback prompt names what would have blocked",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
