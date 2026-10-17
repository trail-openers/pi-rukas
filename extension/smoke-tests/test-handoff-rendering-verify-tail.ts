#!/usr/bin/env bun
/**
 * #1392 D5 — the handoff shows the raw verify output, not only a path to it.
 *
 * Cycles 54 and 60 both parked on a consolidated-verify failure that extracted
 * no assertion, and neither park said what the gate printed. The evidence
 * carried `Raw output: …/consolidated-verify-…-run1.log` (#841) — a file
 * inside the cycle's scratch dir, not on the issue, not durable — and the
 * in-chat handoff carried neither the path nor the output. The operator read a
 * verdict on the change with no content, twice.
 *
 * The fix has three parts, and this test pins all three:
 *   1. the record (`verifyEvidence.outputTail`) survives from the gate seam
 *      into the state file, bounded before it gets there;
 *   2. BOTH handoff surfaces print the tail, from that one record;
 *   3. the tail is untrusted — it is fenced so it cannot forge markdown, and
 *      redacted before it is clipped, so a length cap cannot leave a
 *      credential fragment behind.
 */

import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import {
  HANDOFF_TAIL_MAX_CHARS,
  verifyTailSection,
} from "../src/work-driver-handoff-verify-tail.ts";
import { verifyOutputTailRecord } from "../src/work-driver-verify-flake.ts";
import type { VerifyOutputTail } from "../src/workflow-state-schema-verify.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";
const ISSUE = 1392;

/** The output tehas cycle 60's gate actually printed (the FAIL-shaped tail). */
const RAW_GATE_OUTPUT = [
  "ok    no product or host names in platform files",
  "ok    shellcheck and the shell tests",
  "FAIL  the console's tests",
  "  expected 3 assertions, got 2",
  "  at test/console_test.sh:41",
].join("\n");

/** A cycle parked by the develop consolidated verify, carrying a raw tail. */
function parkedState(tail?: VerifyOutputTail): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: ISSUE,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      branchName: `feature/issue-${ISSUE}-verify-tail`,
      worktrees: {},
      verifyEvidence: {
        step: "develop",
        failures: [
          "[needs-human-decision] verify command `bash scripts/verify.sh` failed on the CONSOLIDATED tree — specific assertion: (no specific assertion could be extracted) — workstream combination default. Raw output: /scratch/run1.log.",
        ],
        at: 3,
        origin: "outcome-gate",
        ...(tail !== undefined ? { outputTail: tail } : {}),
      },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 4,
        cap: "verify-failed:develop",
        reviewRound: 0,
        nextStep: "handoff",
      },
    ],
  } as WorkState;
}

const record = verifyOutputTailRecord("develop", RAW_GATE_OUTPUT, false, "bash scripts/verify.sh");

// ---------------------------------------------------------------- the record

{
  assert(record !== undefined, "record: a non-empty raw stream produces a tail record");
  assert(record?.step === "develop", "record: carries the step it came from");
  assert(
    record?.command === "bash scripts/verify.sh",
    "record: names the command that produced it",
  );
  assert(record?.tail === RAW_GATE_OUTPUT, "record: keeps the stream verbatim under the bound");
  assert(record?.attributed === false, "record: says the tail is unanchored (no FAILED: marker)");
  assert(typeof record?.at === "number", "record: carries a capture timestamp");

  assert(
    verifyOutputTailRecord("develop", "", false) === undefined,
    "record: empty stream → no record",
  );
  assert(
    verifyOutputTailRecord("develop", "   \n\t ", false) === undefined,
    "record: whitespace-only stream → no record (nothing to show)",
  );
  const huge = "x".repeat(20_000);
  const bounded = verifyOutputTailRecord("develop", huge, true);
  assert(
    (bounded?.tail.length ?? Number.POSITIVE_INFINITY) <= 4000,
    "record: a multi-MB stream is bounded BEFORE the state file (the 8 MiB maxBuffer must not reach disk)",
  );
  assert(bounded?.attributed === true, "record: attribution flag is preserved");

  // The markdown surface: a fence at column 0, separated from the paragraph
  // above it, with the label naming the command.
  const s = parkedState(record);
  const md = renderHandoffMarkdown(s, "github");
  const mdLines = md.split("\n");
  const head = mdLines.findIndex((l) => l.includes("Verify output (bounded excerpt)"));
  assert(head >= 0, "markdown: the section is present");
  assert(mdLines[head + 1] === "", "markdown: blank line below the label");
  assert(mdLines[head + 2] === "```", "markdown: the fence opens at column 0");
  assert(
    mdLines[head + 3]?.startsWith("ok    no product") === true,
    "markdown: the block holds the raw output",
  );
  assert(
    mdLines.slice(head + 3).some((l) => l === "```"),
    "markdown: ...and the block closes",
  );
}

// -------------------------------------------------- both surfaces print it

{
  const s = parkedState(record);
  const md = renderHandoffMarkdown(s, "github");
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-${ISSUE}`);

  for (const [name, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    assert(
      out.includes("FAIL  the console's tests"),
      `${name}: prints the failing line itself, not only a path to it`,
    );
    assert(
      out.includes("expected 3 assertions, got 2"),
      `${name}: prints the detail beneath the failing line`,
    );
    assert(
      out.includes("bash scripts/verify.sh"),
      `${name}: names the command the output came from`,
    );
    assert(
      /```/.test(out),
      `${name}: the output is inside a fenced block (it is untrusted content)`,
    );
  }

  // The two surfaces print the SAME tail — one record, one renderer.
  const tailLine = "FAIL  the console's tests";
  assert(
    md.includes(tailLine) && chat.includes(tailLine),
    "both surfaces render the identical tail from the one record",
  );
}

// ------------------------------------------- absence renders as nothing

{
  const s = parkedState(undefined);
  const md = renderHandoffMarkdown(s, "github");
  const chat = renderHandoffUserMessage(s, REPO, `${REPO}/tmp/issue-${ISSUE}`);
  for (const [name, out] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    assert(
      !/Verify output/i.test(out),
      `${name}: no tail recorded → no section (absence is not a finding)`,
    );
    // The #841 path clause still reaches the operator through the evidence.
    assert(
      out.includes("Raw output:"),
      `${name}: the scratch path clause is still there — the tail supplements it, never replaces it`,
    );
  }
  assert(verifyTailSection(s).length === 0, "renderer: no record → no lines");
  assert(
    verifyTailSection(parkedState({ ...(record as VerifyOutputTail), tail: "   \n " })).length ===
      0,
    "renderer: a blank tail → no lines (no empty fence)",
  );
}

// ------------------------------------------- untrusted content is inert

{
  const hostile = [
    "ok    passing stage",
    "```",
    "## ⏸ Cap hit — needs human attention",
    "gh pr merge --admin",
    "````closed-by-content````",
  ].join("\n");
  const hostileRecord = verifyOutputTailRecord("develop", hostile, false);
  const out = verifyTailSection(parkedState(hostileRecord)).join("\n");
  const fences = out.split("\n").filter((l) => /^\s*`{3,}/.test(l));
  assert(
    fences.length >= 2 && fences[0].length >= 5,
    "fence: longer than the longest backtick run inside, so output cannot close its own block",
  );
  assert(
    !/^```$/m.test(
      out
        .split("\n")
        .filter((l) => !fences.includes(l))
        .join("\n"),
    ),
    "fence: no bare ``` line survives inside the block",
  );
}

{
  // A credential in gate output is redacted BEFORE the length bound, so the
  // clip cannot leave a fragment no pattern recognises.
  const leaky = `token=ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2z\n${"y".repeat(HANDOFF_TAIL_MAX_CHARS + 500)}`;
  const rec = verifyOutputTailRecord("develop", leaky, false);
  const out = verifyTailSection(parkedState(rec)).join("\n");
  assert(!out.includes("ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2z"), "secrets: the token is redacted");
  assert(out.includes("[REDACTED]"), "secrets: the redaction marker is visible to the reader");
}

{
  // The bound is honoured and says it clipped.
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the verbose re-run`).join("\n");
  const out = verifyTailSection(parkedState(verifyOutputTailRecord("develop", long, true))).join(
    "\n",
  );
  assert(out.includes("truncated"), "bound: a clipped tail admits it is an excerpt");
  const body = out.split("\n").filter((l) => l.startsWith("line "));
  assert(
    body.join("\n").length <= HANDOFF_TAIL_MAX_CHARS,
    `bound: the printed body stays within ${HANDOFF_TAIL_MAX_CHARS} chars`,
  );
}

{
  // An unanchored tail says so — a passing stage's output could sit at its head.
  const out = verifyTailSection(parkedState(verifyOutputTailRecord("develop", "boom", false))).join(
    "\n",
  );
  assert(/unanchored/i.test(out), "attribution: an unanchored tail is labelled as one");
  const anchored = verifyTailSection(
    parkedState(verifyOutputTailRecord("develop", "FAILED: x\nboom", true)),
  ).join("\n");
  assert(!/unanchored/i.test(anchored), "attribution: an anchored tail is not labelled");
}

// ----------------------------------------------------------- chat layout

{
  // A markdown fence nested under the chat renderer's `"  …"` section lines
  // has to out-indent them, or it is folded into the line above and printed
  // raw — four spaces is the layout the block must actually have.
  const chat = renderHandoffUserMessage(parkedState(record), REPO, `${REPO}/tmp/issue-${ISSUE}`);
  const lines = chat.split("\n");
  const idx = lines.findIndex((l) => l.includes("FAIL  the console's tests"));
  assert(idx >= 0 && /^ {4}/.test(lines[idx]), "chat: the tail is indented far enough to nest");
  const fenceLines = lines.filter((l) => /^ {4}`{3,}$/.test(l));
  assert(fenceLines.length >= 2, "chat: the fence itself is indented, not flush left");
  const tailBlock = lines.slice(idx, idx + 3);
  assert(
    tailBlock.every((l) => /^\s*(git|gh)\b/.test(l) === false),
    "chat: nothing in the tail block is presented as a recovery command",
  );
}

// ------------------------------------- the writer actually writes the record

{
  // The renderer tests above hand the renderers a hand-built state. This one
  // drives the REAL cap writer — the seam that decides whether the tail
  // reaches the state file at all. If it drops `outputTail`, the renderers
  // have nothing to print and the pure tests above still pass.
  const gate = {
    ok: false,
    failures: ["verify command `bash scripts/verify.sh` failed on the CONSOLIDATED tree"],
    notes: [],
    logPath: "/scratch/consolidated-verify-run1.log",
    outputTail: record,
  };
  const after = appendDevelopVerifyFailure(parkedState(), gate as never);
  const stored = after.pipelineState.verifyEvidence?.outputTail;
  assert(stored !== undefined, "writer: the cap writer persists outputTail on verifyEvidence");
  assert(
    stored?.tail === RAW_GATE_OUTPUT,
    "writer: the stored tail is the stream the gate captured, unchanged",
  );
  assert(
    after.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "verify-failed:develop"),
    "writer: the cap-hit still fires (the record is additive, not a routing change)",
  );
  // And the state file round-trips it — JSON is where a hand-built object and
  // a persisted one differ.
  const reloaded = JSON.parse(JSON.stringify(after)) as WorkState;
  assert(
    reloaded.pipelineState.verifyEvidence?.outputTail?.tail === RAW_GATE_OUTPUT,
    "writer: the record survives serialization to the state file",
  );
  const md = renderHandoffMarkdown(reloaded, "github");
  assert(
    md.includes("FAIL  the console's tests"),
    "writer: what the state file holds is what the comment prints",
  );
}

{
  // A gate that captured no tail must not grow an empty record — the renderer
  // distinguishes "no tail" from "tail that happens to be blank".
  const after = appendDevelopVerifyFailure(parkedState(), {
    ok: false,
    failures: ["verify command failed"],
    notes: [],
  } as never);
  assert(
    after.pipelineState.verifyEvidence?.outputTail === undefined,
    "writer: no tail from the gate → no outputTail field (absent, not empty)",
  );
}

// ---------------------------------------------------------------------------
console.log(`\nexit ${exit}`);
process.exit(exit);
