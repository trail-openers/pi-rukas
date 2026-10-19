#!/usr/bin/env bun
/**
 * #1675 — every park says WHY, and whether the user can act.
 *
 * Golden: the five measured parks (#1557, #1064, #1579, #1439, #1435) are
 * built from their real state files (fixtures/cause-class-parks.json) and
 * must classify as the operator decided. None of them may render the
 * "dependencies are still missing" hint, and no single-workstream render may
 * carry the "cannot be attributed to a per-workstream defect" wording.
 *
 * Completeness: every published cap (headless/caps.ts) and every template
 * family has a class, except the merge hold, which has none by design. The
 * typed Records in work-driver-cause-table.ts make a new cap a compile error;
 * this test is the runtime half, over the published list itself.
 *
 * The surfaces (JSON, chat, markdown, queue) are checked for identical text in
 * test-cause-surfaces.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAP_TEMPLATES, FIXED_CAPS } from "../src/headless/caps.ts";
import { failureOf } from "../src/headless/failure.ts";
import { projectIssue } from "../src/headless/result.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import { causeForCycle } from "../src/work-driver-cause-for.ts";
import { causeLeadChat, causeLeadMarkdown } from "../src/work-driver-cause-render.ts";
import { causeSafeText, scrubDepsHint } from "../src/work-driver-cause-scrub.ts";
import {
  CAUSE_CLASSES,
  type CauseClass,
  FIXED_CAP_CAUSE,
  HOST_ACTION,
  KIND_CLASS,
  TEMPLATE_CAP_CAUSE,
} from "../src/work-driver-cause-table.ts";
import { classifyConsolidatedVerifyFailure } from "../src/work-driver-consolidation-classify.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Narrows to the value, failing the run (not silently skipping) when it is absent. */
function assertDefined<T>(v: T | undefined, msg: string): asserts v is T {
  assert(v !== undefined, msg);
  if (v === undefined) throw new Error(`missing: ${msg}`);
}

const HINT = "dependencies are still missing";
const STALE = "cannot be attributed to a per-workstream defect";
const REPO = "/REPO";

interface Fixture {
  issue: number;
  title: string;
  expectedClass: CauseClass;
  state: WorkState;
}
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "cause-class-parks.json"), "utf8"),
) as Fixture[];

function fixtureFor(issue: number): Fixture {
  const fx = fixtures.find((f) => f.issue === issue);
  assertDefined(fx, `fixture #${issue} is present`);
  return fx;
}

/** A handoff state whose last cap is `cap`, with the verify evidence `failures`. */
function verifyState(failures: string[]): WorkState {
  return {
    issue: 9,
    schemaVersion: 1,
    resumable: false,
    createdAt: 1,
    updatedAt: 3,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "develop",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      verifyEvidence: { step: "develop", failures, at: 1, origin: "outcome-gate" },
    },
    eventLog: [
      { kind: "cap-hit", at: 2, cap: "verify-failed:develop", reviewRound: 0, nextStep: "handoff" },
    ],
  } as unknown as WorkState;
}

// ---------------------------------------------------------------------------
// 1. Golden: the five measured parks.
for (const fx of fixtures) {
  const verdict = causeForCycle(fx.state);
  assert(
    verdict?.causeClass === fx.expectedClass,
    `#${fx.issue} classifies as ${fx.expectedClass} (${fx.title})`,
  );
  assert(
    (verdict?.causeReason ?? "").length > 0 && !(verdict?.causeReason ?? "").includes("\n"),
    `#${fx.issue} carries one plain reason sentence`,
  );
  const md = renderHandoffMarkdown(fx.state);
  const chat = renderHandoffUserMessage(fx.state, REPO, `${REPO}/tmp/issue-${fx.issue}`);
  // The cause lead sits directly above the chat's "Why" line: the envelope stays first (#580).
  assert(
    verdict !== undefined && chat.includes(`${causeLeadChat(verdict).join("\n")}\nWhy: `),
    `#${fx.issue} chat message carries its cause lead directly above the Why line`,
  );
  assert(
    !md.includes(HINT) && !chat.includes(HINT),
    `#${fx.issue} renders no "${HINT}" hint on any surface`,
  );
  assert(
    !md.includes(STALE) && !chat.includes(STALE),
    `#${fx.issue} renders no N=1 attribution wording`,
  );
  const leadIndex = md.indexOf("### Cause:");
  const recoveryIndex = md.indexOf("Host-local recovery commands");
  assert(
    leadIndex >= 0 && (recoveryIndex < 0 || leadIndex < recoveryIndex),
    `#${fx.issue} leads with the cause, recovery after it`,
  );
  assert(
    md.includes(`### Cause: **${fx.expectedClass}**`),
    `#${fx.issue} markdown carries the cause lead for ${fx.expectedClass}`,
  );
  assert(md.includes("**What you can do:**"), `#${fx.issue} says what the user can do`);
  const headless = projectIssue(fx.state, "state.json");
  assert(
    verdict?.causeClass === headless.causeClass,
    `#${fx.issue} headless class matches the rendered class`,
  );
  assert(
    headless.causeClass === fx.expectedClass,
    `#${fx.issue} headless result carries causeClass ${fx.expectedClass}`,
  );
  assert(
    headless.failure?.kind !== undefined,
    `#${fx.issue} failure.kind is still published alongside the cause`,
  );
}

// #1435: the protected-path halt names the grant, and the concrete command is in the lead.
{
  const f1435 = fixtureFor(1435);
  const v = causeForCycle(f1435.state);
  assert(
    v?.userAction?.includes("--allow-protected") === true,
    "#1435 action names --allow-protected",
  );
  const md = renderHandoffMarkdown(f1435.state);
  assert(
    md.includes("`/work 1435 --restart --allow-protected .pi/verify-cmd`"),
    "#1435 markdown carries the concrete grant command as written",
  );
}

// #1557: the developer stopped on a question, so the operator answers it. Not a pi-rukas defect.
{
  const f1557 = fixtureFor(1557);
  const v = causeForCycle(f1557.state);
  assert(v?.causeClass === "issue", "#1557 is an issue park: the developer asked a question");
  assert(
    v?.userAction ===
      "answer the question in the issue (or edit the issue), then re-run `/work 1557`",
    "#1557 action says to answer the question and re-run",
  );
  assert(
    v?.causeEvidence[0]?.startsWith("question:") === true,
    "#1557 evidence is the plumb question line",
  );
  assertDefined(v, "#1557 verdict exists");
  assert(
    causeLeadMarkdown(v).join("\n").includes("could not act on the issue as written"),
    "#1557 lead says the developer could not act on the issue as written",
  );
}

// #1064 keeps its change class and the chat lead opens with it.
// (The lead's text is the table's, so the golden check above is what pins it.)
{
  const v = causeForCycle(fixtureFor(1064).state);
  assertDefined(v, "#1064 verdict exists");
  assert(
    causeLeadChat(v).join("\n").startsWith("Cause: change"),
    "the chat lead opens with the class",
  );
}

// ---------------------------------------------------------------------------
// 2. The dependency hint: shown only when a dependency signature is on an extracted line.
const hintOnly =
  "verify command `x` failed in /w — provisioning ran via `.pi/worktree-setup` (hook succeeded) but dependencies are still missing; the hook may not install all needed packages: FAILED: 1 test(s) — a.ts\n✗ a.ts: assertion failed";
assert(
  !scrubDepsHint(hintOnly).includes(HINT),
  "hint removed when no extracted line carries a dependency signature",
);
assert(
  scrubDepsHint(hintOnly).includes("✗ a.ts: assertion failed"),
  "the extracted failing check on the next line survives the scrub",
);
// A worktree problem string with `: ` in it: the hint still ends at its line, with no fragment.
const hintWithColon =
  "verify command `x` failed in /w — provisioning ran via `.pi/worktree-setup` (hook succeeded) but dependencies are still missing; the hook may not install all needed packages (zod: not found): FAILED: 1 test(s)\n✗ a.ts: assertion failed";
assert(
  scrubDepsHint(hintWithColon) === "verify command `x` failed in /w\n✗ a.ts: assertion failed",
  "a hint whose problem contains `: ` is removed to its line end, with no fragment",
);
assert(
  !scrubDepsHint(hintWithColon).includes("not found"),
  "no fragment of the problem text survives the scrub",
);
const hintSupported =
  "verify command `x` failed in /w — provisioning ran via `.pi/worktree-setup` (hook succeeded) but dependencies are still missing; the hook may not install all needed packages: FAILED: 1 test(s)\n✗ Cannot find module 'zod' from src/a.ts";
assert(
  scrubDepsHint(hintSupported).includes(HINT),
  "hint kept when an extracted line is a dependency signature",
);
assert(
  causeSafeText("the verify command failed: ✗ x") === "the verify command failed: ✗ x",
  "unrelated text passes the scrub unchanged",
);

// A dependency the worktree lacks, on a line that is not a failing check, is the worktree's.
{
  const v = causeVerdictOf(
    verifyState(["error: Cannot find package 'zod'\n✗ timeout: the run exceeded its bound"]),
    "verify-failed:develop",
    undefined,
  );
  assert(v?.causeClass === "environment", "a missing package beside a ✗ check is environment");
  assert(
    v?.causeEvidence.includes("error: Cannot find package 'zod'") === true,
    "the zod line is in the evidence",
  );
  assert(
    v?.userAction?.startsWith("install the project dependencies in the worktree") === true,
    "the environment action says to install the dependencies",
  );
}

// The kind mapping: a process or crashed child is the host's, with the host action.
assert(KIND_CLASS.process === "environment", "a process failure kind is environment");
assert(KIND_CLASS.crashed === "environment", "a crashed failure kind is environment");
assert(KIND_CLASS.driver === "pi-rukas", "a driver failure kind stays pi-rukas");

// A dependency signature that IS the failing check stays the change's (#1673 rule).
{
  const v = causeVerdictOf(
    verifyState(["✗ Cannot find module 'zod' from src/a.ts"]),
    "verify-failed:develop",
    undefined,
  );
  assert(v?.causeClass === "change", "a dependency line that is the failing check stays change");
}

// ---------------------------------------------------------------------------
// 3. The reason is built from the same redacted, bounded line as the evidence.
{
  const token = "ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY2zA4bC6d";
  const v = causeVerdictOf(
    verifyState([`✗ auth: the token ${token} was rejected`]),
    "verify-failed:develop",
    undefined,
  );
  assert(
    !(v?.causeReason ?? "").includes(token),
    "a token in an assertion never reaches the reason",
  );
  assert(
    !(v?.causeEvidence ?? []).join("\n").includes(token),
    "a token in an assertion never reaches the evidence",
  );
}

// ---------------------------------------------------------------------------
// 4. Completeness over the published cap list.
for (const cap of FIXED_CAPS) {
  const rule = FIXED_CAP_CAUSE[cap];
  if (cap === "awaiting-human-merge") {
    assert(rule.cls === null, `cap ${cap} is the merge hold: no class by design`);
    continue;
  }
  assert(
    rule !== undefined &&
      rule.cls !== null &&
      (CAUSE_CLASSES as readonly string[]).includes(rule.cls),
    `cap ${cap} has a class`,
  );
  if (rule && rule.cls === "pi-rukas")
    assert(rule.action === null, `cap ${cap} (pi-rukas) has no user action`);
}
for (const family of Object.keys(CAP_TEMPLATES)) {
  const rule = TEMPLATE_CAP_CAUSE[family as keyof typeof CAP_TEMPLATES];
  assert(
    rule !== undefined &&
      rule.cls !== null &&
      (CAUSE_CLASSES as readonly string[]).includes(rule.cls),
    `template ${family} has a class`,
  );
}
// step-failed with no structured cause is the host's (process kind), not a driver gap.
// develop-child-crash: a host that suspended is the host's, not the driver's.
{
  const rule = FIXED_CAP_CAUSE["develop-child-crash"];
  assert(rule.cls === "environment", "develop-child-crash is an environment cause");
  assert(rule.reason.includes("host suspending"), "develop-child-crash names the host suspending");
  assert(
    (rule.action ?? "").includes("caffeinate -dimsu"),
    "develop-child-crash action names caffeinate -dimsu",
  );
}
// A verdict is produced for every published cap on a bare state (no failure).
const bare = {
  issue: 1,
  schemaVersion: 1,
  resumable: false,
  createdAt: 1,
  updatedAt: 2,
  pipelineState: {
    status: "handoff",
    currentStep: "handoff",
    lastCompletedStep: "plan",
    reviewRound: 0,
    ciRetryCount: 0,
    inFlightJobIds: [],
  },
  eventLog: [],
} as unknown as WorkState;
let unclassified = 0;
for (const cap of FIXED_CAPS) {
  const v = causeVerdictOf(bare, cap, undefined);
  if (v === undefined || (v.causeClass === undefined && cap !== "awaiting-human-merge"))
    unclassified++;
}
for (const family of Object.keys(CAP_TEMPLATES)) {
  const cap =
    CAP_TEMPLATES[family as keyof typeof CAP_TEMPLATES] === "count"
      ? `${family}:3`
      : `${family}:develop`;
  const v = causeVerdictOf(bare, cap, undefined);
  if (v === undefined || v.causeClass === undefined) unclassified++;
}
assert(unclassified === 0, "every published cap and template family classifies on a bare state");
assert(
  causeVerdictOf(bare, "a-cap-nobody-published", undefined)?.causeClass === "pi-rukas",
  "an unknown cap is a pi-rukas gap, never silently a class",
);

// ---------------------------------------------------------------------------
// 5. Failure kind decides the class for kind-driven caps; the kind itself is unchanged.
function stateWithDispatch(event: Record<string, unknown>): WorkState {
  return {
    issue: 7,
    schemaVersion: 1,
    resumable: false,
    createdAt: 1,
    updatedAt: 4,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "plan",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
    },
    eventLog: [
      { kind: "step-started", at: 1, step: "develop" },
      {
        kind: "dispatch-failed",
        at: 2,
        step: "develop",
        role: "developer",
        label: "developer",
        ok: false,
        ...event,
      },
      { kind: "cap-hit", at: 3, cap: "step-failed:develop", reviewRound: 0, nextStep: "handoff" },
    ] as WorkEvent[],
  } as unknown as WorkState;
}
const providerDown = stateWithDispatch({
  killCause: "",
  providerMessage: "529 overloaded",
  errorTail: "",
  ms: 1,
});
const providerFailure = failureOf(providerDown, "step-failed:develop", "develop");
assert(
  providerFailure?.kind === "process" || providerFailure?.kind === "provider",
  "a dispatch failure keeps its published failure.kind",
);
const structuredNone = stateWithDispatch({ exitCode: 1, ms: 1 });
const noneFailure = failureOf(structuredNone, "step-failed:develop", "develop");
const noneVerdict = causeVerdictOf(structuredNone, "step-failed:develop", noneFailure);
assert(
  noneVerdict?.causeClass === "environment",
  "a child that exited with no structured cause is environment (the host), not a driver gap",
);
assert(
  noneVerdict?.userAction === HOST_ACTION.replaceAll("{issue}", "7"),
  "that child's action names the host (caffeinate) and the re-run, with the issue filled in",
);

// ---------------------------------------------------------------------------
// 6. Lead text, the awaiting-merge hold, and the markdown heading.
{
  const head = causeLeadMarkdown({
    causeClass: "change",
    causeReason: "see [link](http://x) and <b>!",
    causeEvidence: [],
    userAction: null,
  })[0];
  assert(
    head === "### Cause: **change** — see \\[link\\]\\(http://x\\) and \\<b\\>\\!",
    "untrusted reason text is escaped in the markdown heading",
  );
}

const awaiting = {
  ...bare,
  pipelineState: { ...bare.pipelineState, status: "handoff" },
  eventLog: [
    { kind: "cap-hit", at: 1, cap: "awaiting-human-merge", reviewRound: 0, nextStep: "handoff" },
  ],
} as unknown as WorkState;
const awaitingVerdict = causeVerdictOf(awaiting, "awaiting-human-merge", undefined);
assertDefined(awaitingVerdict, "an awaiting-merge verdict exists");
assert(
  awaitingVerdict.causeClass === undefined && awaitingVerdict.causeReason.includes("hold"),
  "awaiting merge has no class and says it is a hold",
);
assert(
  awaitingVerdict.causeReason === FIXED_CAP_CAUSE["awaiting-human-merge"].reason,
  "awaiting merge reads its text from the table entry",
);

// The classifier's own N=1 sentences name the failing line, never the attribution wording.
const n1Line = classifyConsolidatedVerifyFailure(1, ["default"], "✗ widget renders twice", {});
assert(
  n1Line.reason === "the verify command failed: ✗ widget renders twice",
  "N=1 reason names the extracted failing line",
);
const n1None = classifyConsolidatedVerifyFailure(1, ["default"], "something happened", {});
assert(
  n1None.reason ===
    "the verify command failed and no specific failing line could be extracted — see the raw output",
  "N=1 reason with no extracted line says so",
);
assert(
  !n1Line.reason.includes(STALE) && !n1None.reason.includes(STALE),
  "N=1 reasons never use the attribution wording",
);

// ---------------------------------------------------------------------------
console.log(`\nexit ${exit}`);
process.exit(exit);
