#!/usr/bin/env bun
/**
 * What each round of the loop is allowed to know.
 *
 * Measured on lantern #664's five real spawns, the information flow was:
 *
 *   round 1 reviewer  — the diff, plus a one-sentence context
 *   round 1 fixer     — the reviewer's *entire reply* as "findings", including
 *                       mid-task narration ("Now let me do a deep adversarial
 *                       trace"). No diff. No issue. Nothing else.
 *   round 2 reviewer  — **the round-1 diff again**, unchanged
 *   round 2 fixer     — round-2 findings only; round-1 findings absent
 *   round 3 reviewer  — **the round-1 diff again**
 *
 * `fetchDiff` ran once, before the loop (`work-driver-adversarial.ts:147`), and
 * `adversarial.ts` re-sent that same string every round. The reviewer noticed
 * by itself: *"The diff's original bugs … were already fixed in the working
 * tree."* It recovered by reading the live worktree — which is why each round
 * found new ground rather than repeating — but that made every round an
 * unanchored fresh review with no notion of what had changed since it last
 * looked, and no way to see that its earlier objections were addressed.
 *
 * And nobody in three rounds saw the issue, so #664's explicit requirement
 * ("must reuse `parse_assumptions` at src/synthesizer/parsing.rs:42-61") went
 * unflagged while a low-probability edge case killed the cycle. That is #278.
 */

import { buildAdversarialPrompt, buildFixPrompt } from "../src/adversarial-prompts.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = `## Bug: agenda-generator fabricates assumption IDs

Hard constraint: must reuse parse_assumptions at src/synthesizer/parsing.rs:42-61
rather than writing a second parser.`;

// ------------------------------------------------- the reviewer sees the spec

{
  const prompt = buildAdversarialPrompt({
    diff: "diff --git a/src/cron/agenda/mod.rs\n+fn extract() {}",
    context: "/work issue #664: gating diff before commit (Step 5).",
    issueBody: ISSUE,
    round: 1,
    maxRounds: 3,
  });

  assert(
    prompt.includes("parse_assumptions at src/synthesizer/parsing.rs:42-61"),
    "canary: the reviewer is given the issue's hard constraint — three rounds missed it because none of them could see it (#278)",
  );
  assert(prompt.includes("extract()"), "...alongside the diff it is reviewing");
  assert(
    prompt.includes("MINOR_OBSERVATIONS"),
    "...and the full four-verdict menu, matching agents-base",
  );

  // A cycle with no cached issue body must still produce a working prompt.
  const noIssue = buildAdversarialPrompt({
    diff: "diff --git a/x b/x",
    context: "ctx",
    round: 1,
    maxRounds: 3,
  });
  assert(!noIssue.includes("undefined"), "an absent issue body leaves no 'undefined' in the prompt");
  assert(noIssue.includes("diff --git"), "...and the diff still reaches the reviewer");
}

// ------------------------------------- the reviewer knows what round it is on

{
  const r1 = buildAdversarialPrompt({ diff: "d", context: "c", round: 1, maxRounds: 3 });
  const r3 = buildAdversarialPrompt({ diff: "d", context: "c", round: 3, maxRounds: 3 });
  assert(r1 !== r3, "the round number reaches the reviewer");
  assert(r3.includes("3 of 3"), "...as 'N of M'");
}

// ----------------------------------------------- the fixer gets what it needs

{
  const prompt = buildFixPrompt({
    findings: "1. extract_metadata false-match on ' | assumption:' — sanitize.rs:127",
    context: "/work issue #664: gating diff before commit (Step 5).",
    diff: "diff --git a/src/cron/agenda/sanitize.rs\n+fn extract_metadata() {}",
    issueBody: ISSUE,
    priorFindings: ["Round 1: sanitize_line splits on the first pipe — question corruption"],
    round: 2,
  });

  assert(
    prompt.includes("extract_metadata false-match"),
    "the fixer gets this round's findings",
  );
  assert(
    prompt.includes("diff --git a/src/cron/agenda/sanitize.rs"),
    "canary: the fixer gets the DIFF — measured absent from both of #664's real fix prompts",
  );
  assert(
    prompt.includes("parse_assumptions"),
    "canary: the fixer gets the issue, so it cannot 'fix' a finding by violating the spec",
  );
  assert(
    prompt.includes("splits on the first pipe"),
    "canary: the fixer sees PRIOR rounds — measured absent, so round 3 could undo round 1",
  );
  assert(
    /already addressed|do not re-?open|prior round/i.test(prompt),
    "...and is told what prior findings are for, rather than being handed them bare",
  );
}

{
  // Round 1 has no prior findings and must not grow an empty section.
  const first = buildFixPrompt({
    findings: "f",
    context: "c",
    diff: "d",
    round: 1,
    priorFindings: [],
  });
  assert(
    !/prior round/i.test(first),
    "round 1's fix prompt carries no empty 'prior rounds' section",
  );
  assert(first.includes("f"), "...but still carries its findings");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
