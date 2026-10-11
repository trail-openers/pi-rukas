#!/usr/bin/env bun
/**
 * #1094 — an explore reply with no readable `## Spec` is re-dispatched ONCE.
 *
 * Measured: nessie #1095 explore replies carried a valid `INTENT-VERDICT:` but
 * wrote the legacy `## Workstreams` / `## Prior decisions` / `## Touchpoints`
 * headings instead of `## Spec`, and the cycle parked on the first miss. The
 * fix is one bounded re-dispatch with a preface naming the missing heading, and
 * a prompt that says the `## Spec` requirement last. There is no tolerant
 * parsing of `## Workstreams` as a spec.
 *
 * Covers: the golden fixture, the bold-verdict read, the cap evidence wording,
 * the driver-level dispatch counts (bad→good, bad→bad, failed dispatch), and
 * the prompt canary for both the intent and legacy paths.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMarker } from "../src/reply-markers.ts";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  EXPLORE_RETRY_PREFACE,
  hasIntentVerdictToken,
  noSpecEvidence,
  resolveExploreSpec,
  shouldRetryExplore,
} from "../src/work-driver-explore-dispatch.ts";
import { runExplore } from "../src/work-driver-explore.ts";
import { inlineExplorePrompt } from "../src/work-driver-prompts-early.ts";
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

const FIXTURE = readFileSync(
  path.resolve(import.meta.dirname, "fixtures", "explore-replies", "1095-no-spec.txt"),
  "utf8",
);

// A reply the driver can route on: explicit proceed, a `## Spec` with one
// deliverable (the actionable bar), and an acceptance criterion.
const GOOD_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Add the widget renderer.",
  "",
  "### Deliverables",
  "- D1: add the widget renderer [paths: src/widget.ts]",
  "",
  "### Acceptance criteria",
  "- the widget renders",
  "",
].join("\n");

function result(text: string): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
  };
}

async function freshDir(label: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `explore-spec-retry-${label}-`));
  await mkdir(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
}

/** Run runExplore with a scripted sequence of replies (or throws). */
async function runWith(
  label: string,
  issue: number,
  script: Array<string | Error>,
): Promise<{ state: WorkState; prompts: string[] }> {
  const dir = await freshDir(label);
  try {
    const prompts: string[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue,
      issueBodyFetcherFn: async () => ({ stdout: `title:\tmock #${issue}\n\nmock body` }),
      dispatchFn: async (_pi, spec) => {
        prompts.push(spec.prompt);
        const step = script[prompts.length - 1];
        if (step === undefined) throw new Error("unscripted dispatch");
        if (step instanceof Error) throw step;
        return result(step);
      },
    };
    const state = await runExplore(ctx, initialState(issue, 1_000_000), 1_000_000);
    return { state, prompts };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 1. Golden fixture: verdict present, no `## Spec`.
async function goldenFixture() {
  assert(
    readMarker(FIXTURE, "INTENT-VERDICT", /(proceed-with-assumptions|proceed|park)/) ===
      "proceed-with-assumptions",
    "fixture: bold `**INTENT-VERDICT: proceed-with-assumptions**` is read",
  );
  assert(hasIntentVerdictToken(FIXTURE), "fixture: verdict token is detected");
  assert(
    noSpecEvidence(FIXTURE, false) === "INTENT-VERDICT present but no `## Spec` heading parsed",
    "fixture: evidence names the verdict-present / spec-missing fault",
  );
  assert(
    (await resolveExploreSpec({ repoRoot: await freshDir("guard"), issue: 1095 }, GOOD_REPLY)) !==
      undefined,
    "a reply with a parseable `## Spec` is not lacking one",
  );
  const legacy = "## Workstreams\n- a.ts\n## Prior decisions\nnone";
  assert(
    (await resolveExploreSpec({ repoRoot: await freshDir("legacy"), issue: 1095 }, legacy)) ===
      undefined,
    "legacy `## Workstreams` is NOT tolerated as a spec",
  );
}

// 2. Evidence wording: no verdict vs verdict present, retried or not.
function evidenceWording() {
  assert(
    noSpecEvidence("nothing useful", false) === "no verdict and no spec parsed",
    "no verdict + no spec: the long-standing wording",
  );
  assert(
    noSpecEvidence("nothing useful", true) ===
      "no verdict and no spec parsed (explore re-dispatched once)",
    "retried miss is labelled as retried",
  );
  assert(hasIntentVerdictToken("**INTENT-VERDICT: park**"), "bold park counts as a verdict token");
  assert(!hasIntentVerdictToken("no token here"), "absent token is not a verdict");
}

// 3. Driver: bad then good → exactly 2 dispatches, proceeds, no cap.
async function badThenGood() {
  const { state, prompts } = await runWith("good", 1096, [FIXTURE, GOOD_REPLY]);
  assert(prompts.length === 2, `bad→good: exactly 2 dispatches (got ${prompts.length})`);
  assert(
    prompts[1]?.startsWith(EXPLORE_RETRY_PREFACE) === true &&
      prompts[1]?.includes(prompts[0] ?? "\0") === true,
    "bad→good: retry prompt is the preface plus the original prompt",
  );
  assert(!state.eventLog.some((e) => e.kind === "cap-hit"), "bad→good: no cap-hit");
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed",
    "bad→good: spec routed as proceed",
  );
  const retried = state.eventLog.filter((e) => e.kind === "explore-retried");
  assert(retried.length === 1, "bad→good: one explore-retried event recorded");
  assert(
    retried[0]?.kind === "explore-retried" && retried[0].verdictParsed === true,
    "bad→good: retry event carries the verdict-present flag",
  );
}

// 4. Driver: bad twice → parks after exactly 2 with spec-missing evidence.
async function badTwice() {
  const { state, prompts } = await runWith("bad", 1097, [FIXTURE, FIXTURE]);
  assert(prompts.length === 2, `bad→bad: exactly 2 dispatches (got ${prompts.length})`);
  const cap = state.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "explore-needs-clarification",
    "bad→bad: parks with explore-needs-clarification",
  );
  assert(
    cap?.kind === "cap-hit" &&
      cap.evidence ===
        "INTENT-VERDICT present but no `## Spec` heading parsed (explore re-dispatched once)",
    "bad→bad: evidence names the missing `## Spec` after the retry",
  );
}

// 5. Failed dispatch → no retry; the router owns it.
async function failedDispatch() {
  const { state, prompts } = await runWith("fail", 1098, [new Error("provider timeout")]);
  assert(
    prompts.length === 1,
    `failed dispatch: no re-dispatch (got ${prompts.length} dispatches)`,
  );
  assert(
    !state.eventLog.some((e) => e.kind === "explore-retried"),
    "failed dispatch: no explore-retried event",
  );
  assert(
    state.eventLog.some((e) => e.kind === "dispatch-failed"),
    "failed dispatch: dispatch-failed recorded",
  );
  assert(
    !state.eventLog.some((e) => e.kind === "cap-hit"),
    "failed dispatch: no spec-missing cap-hit",
  );
}

// 6. Prompt canary. Intent path: no legacy headings, ends with the spec rule.
function promptCanary() {
  const MUST =
    "Your reply MUST contain the `INTENT-VERDICT:` line and a `## Spec` block (inline, or in a scratch file you cite); a reply without them is retried once, then the cycle parks.";
  const intent = inlineExplorePrompt(
    [1095],
    "/tmp/scratch",
    [{ issue: 1095, body: "body", truncated: false }],
    true,
  );
  // Heading form only: the intent block may mention `## Workstreams` in prose.
  const headings = intent.split("\n").map((l) => l.trim());
  assert(!headings.includes("## Workstreams"), "intent prompt: no `## Workstreams` heading");
  assert(!headings.includes("## Prior decisions"), "intent prompt: no `## Prior decisions` heading");
  assert(!headings.includes("## Touchpoints"), "intent prompt: no `## Touchpoints` heading");
  const lines = intent.split("\n").filter((l) => l.trim() !== "");
  assert(
    lines[lines.length - 1] === MUST,
    "intent prompt: the `## Spec` requirement is the final line",
  );

  const legacy = inlineExplorePrompt(
    [1095],
    "/tmp/scratch",
    [{ issue: 1095, body: "body", truncated: false }],
    false,
  );
  assert(legacy.includes("## Workstreams"), "legacy prompt: `## Workstreams` still requested");
  assert(
    legacy.includes("## Prior decisions") && legacy.includes("## Touchpoints"),
    "legacy prompt: prior decisions and touchpoints still requested",
  );
  assert(!legacy.includes(MUST), "legacy prompt: no intent-path spec requirement");
}

// 7. The retry predicate, unit-tested directly.
async function shouldRetryCases() {
  const good = await resolveExploreSpec(
    { repoRoot: await freshDir("pred"), issue: 1099 },
    GOOD_REPLY,
  );
  assert(good !== undefined, "predicate fixture: GOOD_REPLY resolves to a spec");
  const base = { useIntent: true, spec: undefined };
  assert(shouldRetryExplore(base), "predicate: intent + no spec → retry");
  assert(!shouldRetryExplore({ ...base, useIntent: false }), "predicate: legacy path never retries");
  assert(!shouldRetryExplore({ ...base, spec: good?.spec }), "predicate: a readable spec does not retry");
}

await goldenFixture();
evidenceWording();
await badThenGood();
await badTwice();
await failedDispatch();
promptCanary();
await shouldRetryCases();

console.log(`\nexit ${exit}`);
process.exit(exit);
