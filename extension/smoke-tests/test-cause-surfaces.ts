#!/usr/bin/env bun
/**
 * #1675 — every surface prints the same cause. The verdict is computed once
 * (causeForCycle) and scrubbed at its producer, so the headless JSON, the chat
 * message, the markdown body and the queue line agree on the text, and that
 * text carries no control characters, no dependency hint the output does not
 * support, and no unescaped markdown from untrusted output.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectIssue } from "../src/headless/result.ts";
import { causeForCycle, causeSafeText, queueCauseAction } from "../src/work-driver-cause-render.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Narrows to the value, failing the run when it is absent. */
function assertDefined<T>(v: T | undefined, msg: string): asserts v is T {
  assert(v !== undefined, msg);
  if (v === undefined) throw new Error(`missing: ${msg}`);
}

const REPO = "/REPO";
const ESC = "\u001b";
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "cause-class-parks.json"), "utf8"),
) as { issue: number; state: WorkState }[];
const fx1064 = fixtures.find((f) => f.issue === 1064);
assertDefined(fx1064, "fixture #1064 is present");

// 1. JSON and chat agree, and neither carries a control sequence, for a dirty verify line.
{
  const dirty = structuredClone(fx1064.state);
  const evidence = dirty.pipelineState.verifyEvidence;
  assertDefined(evidence, "the fixture carries verify evidence");
  evidence.failures = [`✗ ${ESC}[31mtimeout${ESC}[0m: the consolidated run exceeded its bound`];
  const headless = projectIssue(dirty, "state.json");
  const chat = renderHandoffUserMessage(dirty, REPO, `${REPO}/tmp/issue-1064`);
  const md = renderHandoffMarkdown(dirty);
  const verdict = causeForCycle(dirty);
  assertDefined(verdict, "a verdict for the dirty state");
  assert(
    headless.causeReason === verdict.causeReason,
    "JSON causeReason is the verdict's scrubbed reason",
  );
  assert(
    chat.includes(`Cause: change — ${headless.causeReason}`),
    "the chat lead carries the JSON reason verbatim",
  );
  assert(
    (headless.causeEvidence ?? []).every((e) => chat.includes(`  evidence: ${e}`)),
    "every JSON evidence line appears verbatim in chat",
  );
  assert(
    md.includes(`### Cause: **change** — ${headless.causeReason}`),
    "the markdown heading carries the JSON reason verbatim",
  );
  assert(
    !(headless.causeReason ?? "").includes(ESC) &&
      !(headless.causeEvidence ?? []).some((e) => e.includes(ESC)),
    "no control sequence reaches the JSON result",
  );
  assert(!chat.includes(ESC) && !md.includes(ESC), "no control sequence reaches chat or markdown");
  assert(
    headless.causeReason ===
      "the verify command failed: ✗ timeout: the consolidated run exceeded its bound",
    "the reason is the scrubbed assertion line",
  );
  assert(
    queueCauseAction(verdict).startsWith(`change: ${headless.causeReason}`),
    "the queue line carries the same reason",
  );
}

// 2. The control scrub: ANSI sequences and C0 controls go; tabs and newlines become spaces.
assert(
  causeSafeText(`${ESC}[31mred${ESC}[0m\u0007 ok\tthere\nnext`) === "red ok there next",
  "ANSI sequences and control characters are stripped from explanations",
);

// 3. An internal error still produces a handoff verdict, naming the error as evidence.
{
  const broken = structuredClone(fx1064.state);
  Object.defineProperty(broken.pipelineState, "verifyEvidence", {
    get() {
      throw new Error("corrupt verify evidence");
    },
    enumerable: true,
    configurable: true,
  });
  const verdict = causeForCycle(broken);
  assert(
    verdict?.causeClass === "pi-rukas" &&
      verdict.causeReason === "the cause could not be classified (internal error)",
    "a verdict that cannot be computed is a named pi-rukas verdict, not a dropped handoff",
  );
  assert(
    verdict?.causeEvidence.some((e) => e.includes("corrupt verify evidence")) === true,
    "the internal error is the verdict's evidence",
  );
  assert(verdict?.userAction === null, "an internal error has no user action (the defect is ours)");
}

// 4. The concrete grant command is in the lead, above the collapsed host-local block.
{
  const fx1435 = fixtures.find((f) => f.issue === 1435);
  assertDefined(fx1435, "fixture #1435 is present");
  const md = renderHandoffMarkdown(fx1435.state);
  const cmd = "/work 1435 --restart --allow-protected";
  const at = md.indexOf(cmd);
  const details = md.indexOf("<details>");
  assert(at >= 0, "the #1435 markdown names the concrete grant command");
  assert(details < 0 || at < details, "the grant command sits above the collapsed recovery block");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
