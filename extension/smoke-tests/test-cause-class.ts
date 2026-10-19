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
 * family has a class. The typed Records in work-driver-cause-table.ts make a
 * new cap a compile error; this test is the runtime half, over the published
 * list itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAP_TEMPLATES, FIXED_CAPS, type HeadlessCap } from "../src/headless/caps.ts";
import { failureOf } from "../src/headless/failure.ts";
import { projectIssue } from "../src/headless/result.ts";
import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import {
  causeFor,
  causeLeadChat,
  causeLeadMarkdown,
  causeSafeText,
  scrubDepsHint,
} from "../src/work-driver-cause-render.ts";
import {
  CAUSE_CLASSES,
  FIXED_CAP_CAUSE,
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

const HINT = "dependencies are still missing";
const STALE = "cannot be attributed to a per-workstream defect";
const REPO = "/Users/x/repo";

interface Fixture {
  issue: number;
  title: string;
  expectedClass: string;
  state: WorkState;
}
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "cause-class-parks.json"), "utf8"),
) as Fixture[];

// ---------------------------------------------------------------------------
// 1. Golden: the five measured parks.
for (const fx of fixtures) {
  const cap = fx.state.eventLog
    .map((e) => (e.kind === "cap-hit" ? e.cap : undefined))
    .find(Boolean);
  const verdict = causeFor(fx.state, cap as HeadlessCap);
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

// The #1435 halt names the grant command; the #1557 verdict names no user action.
const f1435 = fixtures.find((f) => f.issue === 1435);
if (f1435) {
  const v = causeFor(f1435.state, "verify-failed:develop");
  assert(
    v?.userAction?.includes("--allow-protected") === true,
    "#1435 action names --allow-protected",
  );
}
const f1557 = fixtures.find((f) => f.issue === 1557);
if (f1557) {
  const v = causeFor(f1557.state, "verify-failed:develop");
  assert(v?.userAction === null, "#1557 (a pi-rukas defect) has no user action");
  assert(
    causeLeadMarkdown(v as NonNullable<typeof v>)
      .join("\n")
      .includes("pi-rukas defect"),
    "#1557 lead says the defect is ours",
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
  scrubDepsHint(hintOnly).includes("FAILED: 1 test(s)"),
  "the verify output after the hint survives the scrub",
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

// ---------------------------------------------------------------------------
// 3. N=1 wording: the classifier's own sentence names the failing line.
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
// 4. Completeness over the published cap list.
for (const cap of FIXED_CAPS) {
  const rule = FIXED_CAP_CAUSE[cap];
  assert(
    rule !== undefined && (CAUSE_CLASSES as readonly string[]).includes(rule.cls),
    `cap ${cap} has a class`,
  );
  if (rule && rule.cls === "pi-rukas")
    assert(rule.action === null, `cap ${cap} (pi-rukas) has no user action`);
}
for (const family of Object.keys(CAP_TEMPLATES)) {
  const rule = TEMPLATE_CAP_CAUSE[family as keyof typeof CAP_TEMPLATES];
  assert(
    rule !== undefined && (CAUSE_CLASSES as readonly string[]).includes(rule.cls),
    `template ${family} has a class`,
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
assert(
  causeVerdictOf(structuredNone, "step-failed:develop", noneFailure)?.causeClass === "pi-rukas",
  "a child that exited with no structured cause is a pi-rukas gap",
);

// ---------------------------------------------------------------------------
// 6. The queue summary states the class; the awaiting-merge hold is not a failure.
const verifyFix = fixtures.find((f) => f.issue === 1064);
if (verifyFix) {
  const v = causeFor(verifyFix.state, "verify-failed:develop");
  const line = causeLeadChat(v as NonNullable<typeof v>).join("\n");
  assert(line.startsWith("Cause: change"), "the chat lead opens with the class");
}
const awaiting = {
  ...bare,
  pipelineState: { ...bare.pipelineState, status: "handoff" },
  eventLog: [
    { kind: "cap-hit", at: 1, cap: "awaiting-human-merge", reviewRound: 0, nextStep: "handoff" },
  ],
} as unknown as WorkState;
const awaitingVerdict = causeVerdictOf(awaiting, "awaiting-human-merge", undefined);
assert(
  awaitingVerdict?.causeClass === undefined && awaitingVerdict.causeReason.includes("hold"),
  "awaiting merge has no class and says it is a hold",
);

// ---------------------------------------------------------------------------
console.log(`\nexit ${exit}`);
process.exit(exit);
