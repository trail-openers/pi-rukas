#!/usr/bin/env bun
/**
 * #819 round-3 — the `plan-spec-mismatch` handoff recipe renders UNTRUSTED
 * evidence inside a ```bash fence.
 *
 * The cap's evidence is composed from the issue's own deliverable text and the
 * planner's reply (`planSpecMismatchReason` concatenates deliverable ids and
 * declared paths), so a hostile issue body — or a planner that echoed one —
 * reaches the handoff verbatim. Both renderers put every step line inside one
 * bash block, so an escaped newline does not just look wrong: it ENDS the
 * fence, and the remainder of the string is then markdown the operator's client
 * renders (or, on a client that copies a fence wholesale, a command block to
 * paste). Backticks are the quieter half of the same defect — an inline code
 * span opened inside a comment line swallows the lines after it.
 *
 * What this pins, in order:
 *  1. evidence carrying a newline + a fence closer + `rm -rf ~` renders as ONE
 *     comment line inside a single intact fence, and the injected command is
 *     not a line of the fence's contents.
 *  2. C0 controls and every renderer's line terminator (\r, U+2028, U+2029,
 *     U+0085) collapse; a backtick never survives; the result is one line.
 *  3. the primitives are the consolidation note's, exported rather than copied
 *     — one rule for untrusted text, not a per-site invention.
 *  4. the round-2 properties of the recipe survive sanitising (the runnable
 *     `glab api` line, and the env-var line that must stay a comment).
 */

import { LINE_TERMINATORS, dropC0Controls } from "../src/work-driver-consolidation-note.ts";
import { planSpecMismatchSteps } from "../src/work-driver-handoff-recovery-plan.ts";
import { recoveryCommandsChat } from "../src/work-driver-handoff-recovery.chat.ts";
import { recoveryCommandsMarkdown } from "../src/work-driver-handoff-recovery.md.ts";
import { recoveryStepsForCap } from "../src/work-driver-handoff-recovery.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FENCE_OPEN = "```bash";
const FENCE_CLOSE = "```";

/** The payload: a fence closer, then a command, then another closer. */
const INJECTED = [
  "no workstream declares d1 (src/a.ts)",
  FENCE_CLOSE,
  "rm -rf ~",
  FENCE_CLOSE,
].join("\n");

function stateWithEvidence(evidence: string): WorkState {
  const base = initialState(819, 1);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      status: "handoff",
      currentStep: "handoff",
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 1,
        cap: "plan-spec-mismatch",
        reviewRound: 0,
        nextStep: "handoff",
        evidence,
      },
    ],
  };
}

/** Every line strictly between the first fence opener and its closer. */
function fenceLines(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (!inside && l.trim() === FENCE_OPEN) {
      inside = true;
      continue;
    }
    if (inside && l.trim() === FENCE_CLOSE) break;
    if (inside) out.push(l);
  }
  return out;
}

function fenceMarkers(lines: string[]): number {
  return lines.filter((l) => l.trim() === FENCE_CLOSE || l.trim() === FENCE_OPEN).length;
}

// --------------------------- 1. the injection stays inside one intact fence

// --------------------------- 1. the injection stays inside one intact fence

{
  const rendered = recoveryCommandsMarkdown(stateWithEvidence(INJECTED), "github");
  const inside = fenceLines(rendered);
  assert(inside.length > 0, "markdown: the recipe rendered inside a bash fence");
  assert(
    fenceMarkers(rendered) === 2,
    `markdown: exactly one bash fence in the rendered block (got ${fenceMarkers(rendered)} markers)`,
  );
  assert(
    inside.every((l) => l.trim() !== FENCE_CLOSE),
    "markdown: no line inside the fence is a fence closer (the fence is intact)",
  );
  const payload = inside.filter((l) => l.includes("rm -rf"));
  assert(payload.length === 1, `markdown: the payload is exactly ONE line (got ${payload.length})`);
  assert(
    payload.every((l) => l.trimStart().startsWith("#")),
    "markdown: that line is a comment, not a command the operator could paste",
  );
  assert(
    inside.some((l) => l.trim() === "/work 819 --restart"),
    "markdown: the recipe's own restart line is still a runnable command",
  );
}

{
  // The chat surface has no fence (it indents commands under a comment), so
  // the invariant there is the one that matters for a terminal: the payload is
  // one line and it is a comment, so nothing lands at column 0 as a command.
  const rendered = recoveryCommandsChat(
    stateWithEvidence(INJECTED),
    "/repo",
    "/repo/tmp/issue-819",
    "github",
  );
  const payload = rendered.filter((l) => l.includes("rm -rf"));
  assert(payload.length === 1, `chat: the payload is exactly ONE line (got ${payload.length})`);
  assert(
    payload.every((l) => l.trimStart().startsWith("#")),
    "chat: that line is a comment, not a command",
  );
  assert(
    rendered.some((l) => l.trim() === "/work 819 --restart"),
    "chat: the recipe's own restart line is still a runnable command",
  );
}

// ------------------ 2. controls, terminators and backticks never survive

{
  const TAB = String.fromCharCode(9);
  const BEL = String.fromCharCode(7);
  const NUL = String.fromCharCode(0);
  const BQ = String.fromCharCode(96);
  const nasty = [
    "delim " + BQ + BQ + "here" + BQ + "tail" + BEL + "end",
    "cr" + String.fromCharCode(13) + "here",
    "sep" + String.fromCharCode(0x2028) + "here",
    "par" + String.fromCharCode(0x2029) + "here",
    "nel" + String.fromCharCode(0x85) + "here",
    "nul" + NUL + "here",
    "tab" + TAB + "here",
  ].join("\n");
  const steps = planSpecMismatchSteps(stateWithEvidence(nasty), 819, "github");
  const allCommentLines = steps.flatMap((s) => s.comment);
  assert(
    allCommentLines.every((l) => !l.includes(BQ)),
    "no comment line carries a backtick (no inline code span can open inside the fence)",
  );
  // A scanner, not a regex with a literal control character in its class.
  const hasControl = (l: string): boolean => {
    for (let i = 0; i < l.length; i++) {
      const c = l.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  };
  assert(
    allCommentLines.every((l) => !hasControl(l)),
    "no comment line carries a C0 control or DEL",
  );
  const TERMINATORS = /[\r\n\u2028\u2029\u0085]/;
  assert(
    allCommentLines.every((l) => !TERMINATORS.test(l)),
    "no comment line carries a line terminator of any flavour",
  );
  assert(
    allCommentLines.every((l) => !l.includes("tab" + TAB + "h")),
    "a TAB is a C0 control and goes too",
  );
  // The sanitiser is the consolidation note's rule, not a copy of it.
  const manual = dropC0Controls(nasty.replace(LINE_TERMINATORS, " ")).replaceAll(BQ, "'");
  const renderedEvidence = allCommentLines.find((l) => l.includes("delim")) ?? "";
  assert(
    manual.split("\n").length === 1 && renderedEvidence.includes(manual.slice(0, 12)),
    `the payload collapses exactly as the exported primitives do (${JSON.stringify(renderedEvidence.slice(0, 60))})`,
  );
}

// --------- 3. an absent cap still renders the recipe (sanitise is not a gate)

{
  const steps = planSpecMismatchSteps(initialState(819, 1), 819, "gitlab");
  assert(
    steps.length === 4,
    `a state with no plan-spec-mismatch cap still renders the four-step recipe (got ${steps.length})`,
  );
  assert(
    steps.every((s) => s.section === "plan-spec-mismatch"),
    "every step is tagged to its cap section",
  );
  assert(
    steps[0]?.comment.some((c) => c.includes("(no detail recorded)")) === true,
    "an absent cap falls back to the honest placeholder evidence and does not throw",
  );
}

// --------- 4. the round-2 properties of the recipe survive sanitising

{
  const gh = recoveryStepsForCap(stateWithEvidence(INJECTED), "github").steps;
  const gl = recoveryStepsForCap(stateWithEvidence(INJECTED), "gitlab").steps;
  const ghLines = gh.flatMap((s) => s.lines);
  const glLines = gl.flatMap((s) => s.lines);
  assert(
    !glLines.some((l) => l.includes("glab issue edit")),
    "gitlab: no `glab issue edit` (still no such subcommand)",
  );
  assert(
    glLines.some((l) => l.includes("glab api -X PUT") && l.includes("projects/:id/issues/819")),
    "gitlab: the issue edit still goes through `glab api -X PUT`",
  );
  assert(
    ghLines.some((l) => l.startsWith("#") && l.includes("PI_ENSEMBLE_PLAN_QUALITY=0")),
    "github: the env-var line is still a comment, not a shell prefix",
  );
  assert(
    ghLines.some((l) => l === "/work 819 --restart"),
    "github: the restart is still its own runnable line",
  );
  assert(
    gh.some((s) => s.comment.some((c) => c.includes("rm -rf") && !c.includes("\n"))),
    "the sanitised payload reaches the comment lines (it is not silently dropped)",
  );
}

console.log(
  exit === 0 ? "\nAll #819 round-3 recovery-sanitising assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
