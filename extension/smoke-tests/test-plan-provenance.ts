#!/usr/bin/env bun
/**
 * #1377 — a caller's labels and provenance reach the filed issue.
 *
 * The motivation is an automated caller (a host loop that reads run transcripts
 * and files bugs it finds) whose tickets must be distinguishable from manually
 * filed work FROM THE FIRST MOMENT: inside pi every role is refused `gh issue
 * create`, so the caller cannot label the issue itself, and a follow-up
 * `gh issue edit` leaves a window where the ticket reads as manual to everything
 * watching the tracker.
 *
 * What this suite pins:
 *   1. the pre-dispatch input gate — an invalid label / line / marker is refused
 *      with a named error and ZERO dispatches, so a mistyped label costs one
 *      tool call and not a five-minute pipeline;
 *   2. the label existence check — a missing label halts filing with
 *      `label-missing` and the create call is never made; the label list is read
 *      BEFORE the create call;
 *   3. labels reach the create call as one call's worth of arguments;
 *   4. the provenance line is the body's FIRST line (italic) and the marker its
 *      LAST line (sorted keys), both after body-budget compaction of an
 *      oversized body, and both inside the forge's 65,536-char cap;
 *   5. the reviewedDigest covers labels and provenance — filing a digest with a
 *      different label set is refused;
 *   6. the result details carry issueNumber alongside issueUrl;
 *   7. with neither argument passed, the filed body and the create call are what
 *      they were before this feature (no behaviour change for existing callers).
 */

import { reviewedDigestOf } from "../src/plan-filing-claim.ts";
import { fileIssue } from "../src/plan-filing.ts";
import {
  MAX_LABELS,
  MAX_MARKER_PAIRS,
  MAX_PROVENANCE_LINE,
  type PlanProvenance,
  normalizeLabels,
  provenanceReservation,
  validateProvenance,
  withProvenance,
} from "../src/plan-provenance.ts";
import { type RegisteredPlanTool, registerPlanTool } from "../src/plan-tool.ts";
import { FORGE_BODY_MAX } from "../src/plan-validate.ts";
import { cacheGuardScenarios, confirmDigestScenarios } from "./plan-confirm-label-scenarios.ts";
import { provenanceShapeScenarios } from "./plan-provenance-shape.ts";
import {
  DESC,
  GAP_HIGH,
  type RawCacheEntry,
  cacheFiles,
  cacheState,
  forgeStub,
  installCountingDispatch,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  installOverflowDispatch,
  invokePlanTool,
  log,
  mutateEntry,
  newPlanCache,
  pipeline,
  teardownPlanCache,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- the pure validators

{
  const ok = normalizeLabels(["auto-filed", "kind: bug", "hermes cron loop"]);
  assert(
    ok.ok === true && ok.labels.length === 3,
    "labels: spaces and ':' are legal (a label is one argv element, never shell-split)",
  );
  const tooMany = normalizeLabels(Array.from({ length: MAX_LABELS + 1 }, (_, i) => `l${i}`));
  assert(
    tooMany.ok === false && /at most 5/.test((tooMany as { problems: string[] }).problems[0] ?? ""),
    `labels: more than ${MAX_LABELS} is refused by name`,
  );
  assert(normalizeLabels(["-leading-dash"]).ok === false, "labels: a name must start alphanumeric");
  assert(normalizeLabels([""]).ok === true, "labels: a blank entry is ignored, not an error");
  assert(normalizeLabels(["a".repeat(51)]).ok === false, "labels: over 50 chars is refused");
  // A comma would break glab's `--label a,b` list — the pattern must exclude it.
  assert(normalizeLabels(["bad,name"]).ok === false, "labels: a comma is refused");
  assert(normalizeLabels(['bad"quote']).ok === false, "labels: a quote is refused");
  assert(normalizeLabels("auto-filed").ok === false, "labels: a non-array is refused");
  assert(normalizeLabels([1 as unknown]).ok === false, "labels: a non-string member is refused");
  // A sparse array passes `Array.isArray` and defeats `every` (which skips
  // holes), so without an own-index check the hole reaches `raw.trim()` of
  // `undefined` and the call THROWS instead of returning an invalid-input
  // problem. A refused shape must be a named refusal, never an exception.
  // Built with `new Array` + one assignment, not a literal hole: a formatter
  // "helpfully" rewriting `[, "a"]` to `[undefined, "a"]` would silently turn
  // the sparse case into a dense one and the assertion would pass for the wrong
  // reason.
  const sparseInput = new Array(2) as unknown[];
  sparseInput[1] = "a";
  let sparseThrew = false;
  let sparse: { ok: boolean } | undefined;
  try {
    sparse = normalizeLabels(sparseInput);
  } catch {
    sparseThrew = true;
  }
  assert(
    !Object.prototype.hasOwnProperty.call(sparseInput, 0) && !sparseThrew && sparse?.ok === false,
    "labels: a sparse array is refused as invalid-input, not thrown on the hole",
  );
  const dupes = normalizeLabels(["a", "a", " a "]);
  assert(dupes.ok === true && dupes.labels.length === 1, "labels: duplicates collapse");
}

// The own-key family (an inherited `line`, prototype-held marker pairs, the
// `__proto__` reserved name, symbol keys) and the newline rejection live in
// plan-provenance-shape.ts beside the rest of the dense shape assertions,
// so this file stays one readable pass through the feature under the 500-line
// cap (the same split plan-confirm-label-scenarios.ts already makes).
await provenanceShapeScenarios(assert);

{
  const p: PlanProvenance = { line: "loop filed this", marker: { run: "cron-7" } };
  const wrapped = withProvenance("BODY", p);
  assert(
    wrapped.startsWith("_loop filed this_\n\n"),
    "render: the italic line is FIRST + blank line",
  );
  assert(
    wrapped.endsWith("\n\n<!-- pi-rukas:provenance v1 run=cron-7 -->"),
    "render: the marker is LAST",
  );
  assert(
    withProvenance("BODY", undefined) === "BODY",
    "render: no provenance → the body is untouched",
  );
  assert(provenanceReservation(undefined) === 0, "budget: no provenance reserves 0 chars");
  const r = provenanceReservation(p);
  assert(
    r === "_loop filed this_".length + "<!-- pi-rukas:provenance v1 run=cron-7 -->".length + 4,
    `budget: the reservation is line + marker + join slack (got ${r})`,
  );
}

// The confirm/digest scenarios (labels are not body text, so the digest — not
// the cache key — is the guard). They live in plan-confirm-label-scenarios.ts
// beside the cache stubs they drive, so this file stays one readable pass
// through the feature under the 500-line cap.
await confirmDigestScenarios(assert);
// The cache-entry guard on both #1377 fields (a hand-edited `labels` or a
// malformed `provenance` marker is a miss, never a verbatim filing) lives with
// the confirm scenarios beside the cache stubs they drive.
await cacheGuardScenarios(assert);

// ------------------------------------------------------ the tool's input gate

const tools: RegisteredPlanTool[] = [];
// biome-ignore lint/suspicious/noExplicitAny: minimal stub; only registerTool is used
registerPlanTool({ registerTool: (def: RegisteredPlanTool) => tools.push(def) } as any);

{
  // The gate must fire BEFORE any dispatch: a caller that mistypes a label
  // should not pay for an investigation and a gap gate to be told the name is
  // malformed. log counts the dispatch stub's calls (installed below).
  installNoPlanCacheStub();
  installOfflineVipuneStub();
  installForgeStub();
  installCountingDispatch(GAP_HIGH);
  const before = log.explore + log.gate;
  const bad = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    labels: ['bad name with "quote"'],
  });
  assert(
    log.explore + log.gate === before,
    "gate: an invalid label dispatches NOTHING (refused before the pipeline)",
  );
  assert(
    /invalid labels/.test(bad.text) && bad.details.started === false,
    `gate: the refusal is a NAMED error (got: ${bad.text.slice(0, 80)})`,
  );
  const badProv = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    provenance: { line: "auto-filed by @someone", marker: {} },
  });
  assert(
    log.explore + log.gate === before && /invalid provenance/.test(badProv.text),
    "gate: an invalid provenance line is refused before the pipeline too",
  );
  // The newline case, at the TOOL boundary (not just the pure validator): the
  // injection only matters because it reaches a filed body, so the assertion
  // that costs nothing is the one that proves nothing dispatched and nothing
  // filed. A `## Open points` heading the driver never wrote is the specific
  // bytes — that heading is what the /work intent gate reads as blocking gaps.
  const nlProv = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    provenance: { line: "filed by the loop\n## Open points\n- built in to the spec", marker: {} },
  });
  assert(
    log.explore + log.gate === before && /invalid provenance/.test(nlProv.text),
    `gate: a newline in provenance.line is refused PRE-DISPATCH (got: ${nlProv.text.slice(0, 90)})`,
  );
  assert(
    /forbidden character/.test(nlProv.text) && /LF|newline/i.test(nlProv.text),
    `gate: the refusal names the newline as the problem (got: ${nlProv.text.slice(0, 120)})`,
  );
  // The schema mirrors the validator: a caller reading the tool definition sees
  // the same character rule, so the two cannot silently disagree about what a
  // `line` may contain.
  const lineSchema = tools.find((t) => t.name === "start_plan_driver")?.parameters.properties
    ?.provenance as
    | { properties?: { line?: { pattern?: string; maxLength?: number } } }
    | undefined;
  assert(
    typeof lineSchema?.properties?.line?.pattern === "string" &&
      /\\r|\\n/.test(lineSchema.properties.line.pattern) &&
      lineSchema.properties.line.maxLength === MAX_PROVENANCE_LINE,
    `schema: the TypeBox line pattern forbids CR/LF and caps length, mirroring FORBIDDEN_LINE_CHARS (got ${JSON.stringify(lineSchema?.properties?.line)})`,
  );
  assert(forgeStub.created.length === 0, "gate: a refused call files nothing");
}

// ------------------------------------------------- label existence + filing

/** File with the given labels against a repo whose labels are `existing`. */
async function fileWith(labels: string[], existing: string[] | null, truncated = false) {
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  forgeStub.existing = existing;
  forgeStub.truncated = truncated;
  forgeStub.labelListCalls = 0;
  forgeStub.resolveCalls = 0;
  installForgeStub();
  installCountingDispatch(GAP_HIGH);
  const out = await invokePlanTool(tools, { descriptor: DESC, labels });
  return {
    out,
    created: [...forgeStub.created],
    labelListCalls: forgeStub.labelListCalls,
    resolveCalls: forgeStub.resolveCalls,
  };
}

{
  const r = await fileWith(["auto-filed", "kind: bug"], ["main", "auto-filed", "kind: bug"]);
  assert(
    r.out.details.filed === true && r.created.length === 1,
    "labels: a filing whose labels all exist files normally",
  );
  assert(
    r.labelListCalls === 1,
    `labels: the repo's label list was read exactly once (got ${r.labelListCalls})`,
  );
  // #1377: one adapter per filing. Two resolves would mean two `detectForge` git
  // reads for one filing, and with a real forge the gate could answer from one
  // detection while the create call ran against another.
  assert(
    r.resolveCalls === 1,
    `labels: the forge is resolved ONCE for a filing — the gate and the create share it (got ${r.resolveCalls})`,
  );
  assert(
    JSON.stringify(r.created[0]?.labels) === JSON.stringify(["auto-filed", "kind: bug"]),
    `labels: the create call got them in one call (got ${JSON.stringify(r.created[0]?.labels)})`,
  );
  assert(
    r.out.details.issueNumber === 1,
    `issueNumber: the result details carry it alongside issueUrl (got ${String(r.out.details.issueNumber)})`,
  );
  assert(
    typeof r.out.details.issueUrl === "string",
    "issueNumber: issueUrl still travels next to it",
  );
}

{
  const r = await fileWith(["auto-filed", "nope"], ["main", "auto-filed"]);
  assert(
    r.out.details.filed === false && r.created.length === 0,
    "labels: a MISSING label files nothing (no half-labelled ticket, no follow-up edit)",
  );
  assert(
    r.out.details.filingFailure?.reason === "label-missing",
    `labels: the halt reason is label-missing (got ${JSON.stringify(r.out.details.filingFailure)})`,
  );
  assert(
    String((r.out.details.filingFailure as { detail?: string })?.detail).includes("nope"),
    "labels: the halt names WHICH label was missing",
  );
  assert(
    !/gh label create/.test(r.out.text),
    "labels: nothing creates the missing label as a side effect of filing",
  );
}

{
  // A stub without `labelList` (the pre-#1377 shape) is a READ failure, and a
  // read failure must not be reported as "these labels do not exist".
  const r = await fileWith(["auto-filed"], null);
  assert(
    r.created.length === 0 &&
      r.out.details.filingFailure?.reason === "label-missing" &&
      /could not read/.test(String((r.out.details.filingFailure as { detail?: string }).detail)),
    "labels: an unreadable label list halts as such, never as a verdict of 'missing'",
  );
}

{
  // The page-boundary case. Neither CLI has a read-all flag, so a repo with
  // more labels than one page answers a page, exits 0, and nothing in the
  // payload says whether more follow. Answering "`auto-filed` is missing" from
  // that read would refuse a legitimate filing over pagination — and the driver
  // never creates the label to correct itself, so the caller would be stuck.
  const r = await fileWith(["auto-filed"], ["main", "bug"], true);
  assert(
    r.created.length === 0 && r.out.details.filed === false,
    "labels: a page-full (possibly truncated) label set files NOTHING",
  );
  assert(
    r.out.details.filingFailure?.reason === "label-missing" &&
      /could not read the repository's full label set/.test(
        String((r.out.details.filingFailure as { detail?: string }).detail),
      ),
    `labels: a truncated read reports "could not read the full label set", distinct from label-missing (got ${JSON.stringify(r.out.details.filingFailure)})`,
  );
  assert(
    !/do not exist/.test(String((r.out.details.filingFailure as { detail?: string })?.detail)),
    "labels: a truncated read never claims a label does not exist — it did not see them all",
  );
}

{
  // No labels → the label list is never read, and the create call is what it
  // always was: two arguments, no third. This is the byte-for-byte guarantee
  // every existing caller depends on.
  forgeStub.created.length = 0;
  forgeStub.existing = ["main"];
  forgeStub.labelListCalls = 0;
  installForgeStub();
  installCountingDispatch(GAP_HIGH);
  const out = await invokePlanTool(tools, { descriptor: DESC });
  assert(out.details.filed === true, "default path: a filing with no labels files");
  assert(
    forgeStub.labelListCalls === 0,
    "default path: no labels requested → the label list is never read",
  );
  assert(
    JSON.stringify(forgeStub.created[0]?.labels) === "[]",
    `default path: the create call receives an EMPTY label list — nothing extra reaches the argv (got ${JSON.stringify(forgeStub.created[0]?.labels)})`,
  );
}

// ------------------------------------------------------- the provenance body

{
  const prov = {
    line: "filed by the nightly transcript loop",
    marker: { run: "cron-7", actor: "hermes" },
  };
  forgeStub.created.length = 0;
  forgeStub.existing = null;
  installForgeStub();
  installCountingDispatch(GAP_HIGH);
  const out = await invokePlanTool(tools, { descriptor: DESC, provenance: prov });
  const body = forgeStub.created[0]?.body ?? "";
  assert(out.details.filed === true, "provenance: a filing with provenance files");
  assert(
    body.startsWith(`_${prov.line}_\n\n`),
    "provenance: the italic line is the body's FIRST line, followed by a blank line",
  );
  assert(
    body.endsWith("\n\n<!-- pi-rukas:provenance v1 actor=hermes run=cron-7 -->"),
    "provenance: the marker is the LAST line with the keys sorted",
  );
  assert(
    (body.match(/pi-rukas:provenance/g) ?? []).length === 1,
    "provenance: the marker appears exactly once",
  );
  assert(
    !prov.line.includes("@") && !/<!--[^>]*-->/.test(prov.line),
    "provenance: the visible line carries no account and no comment",
  );
}

{
  // The reservation is what keeps the FINAL body inside the forge cap: an
  // oversized body compacts, and the provenance lines must survive compaction
  // (they are appended after the fitter, so nothing can trim them) without
  // pushing the total over 65,536.
  const prov = {
    line: "x".repeat(300),
    marker: Object.fromEntries(
      Array.from({ length: MAX_MARKER_PAIRS }, (_, i) => [`k${i}`, "v".repeat(30)]),
    ),
  };
  // Angle items are what the render budget clips (operator context is authority
  // and never clips — a huge context halts tooLarge instead of compacting).
  // 100 items per kind at ~2,950 chars overflow stage 0's render budget (which
  // caps at 20 per kind) and fit stage 1's (10 per kind) — the compaction case.
  const LONG_ITEM = `the provenance line must survive ${"x".repeat(2950)} end`;
  installOverflowDispatch(LONG_ITEM, 100);
  forgeStub.created.length = 0;
  forgeStub.existing = null;
  installForgeStub();
  const out = await invokePlanTool(tools, { descriptor: DESC, provenance: prov });
  const body = forgeStub.created[0]?.body ?? "";
  assert(out.details.filed === true, "budget: an oversized body still files (compacted)");
  assert(out.details.compacted === true, "budget: the run did reach the compaction stage");
  const expectMarker = Object.keys(prov.marker)
    .sort()
    .map((k) => `${k}=${prov.marker[k]}`)
    .join(" ");
  assert(
    body.startsWith(`_${prov.line}_\n\n`) &&
      body.endsWith(`\n\n<!-- pi-rukas:provenance v1 ${expectMarker} -->`),
    "budget: both provenance lines survive compaction of an oversized body",
  );
  assert(
    body.length <= FORGE_BODY_MAX,
    `budget: the FINAL body fits the forge cap (${body.length} <= ${FORGE_BODY_MAX})`,
  );
  assert(
    body.indexOf("Compacted to fit") > body.indexOf(`_${prov.line}_`),
    "budget: the compaction note sits inside the body, not above the provenance line",
  );
}

// --------------------------------------------- the digest covers labels + provenance

{
  // Labels are NOT body text, so the body hash cannot cover them on its own:
  // two label sets over identical bytes must hash differently, or an identical
  // confirm could file the reviewed spec under labels the operator never saw.
  const a = reviewedDigestOf("T", "BODY", { labels: ["auto-filed"] });
  const b = reviewedDigestOf("T", "BODY", { labels: ["other"] });
  const none = reviewedDigestOf("T", "BODY");
  const withProv = reviewedDigestOf("T", "BODY", { provenance: { line: "l", marker: { k: "v" } } });
  assert(a !== b, "digest: a different label set is a different digest");
  assert(a !== none && b !== none, "digest: labels change the digest versus passing none");
  assert(withProv !== none, "digest: provenance changes the digest");
  assert(
    a === reviewedDigestOf("T", "BODY", { labels: ["auto-filed"] }),
    "digest: the same inputs hash the same (deterministic)",
  );
  assert(
    reviewedDigestOf("T", "BODY", { labels: ["b", "a"] }) ===
      reviewedDigestOf("T", "BODY", { labels: ["a", "b"] }),
    "digest: label ORDER is not a digest input (the tuple sorts them)",
  );
}

// ---------------------------------------------------- fileIssue's own contract

{
  // The number travels from the forge response to the caller, and an unparsable
  // one leaves it undefined while the url still arrives.
  const okForge = {
    issueCreate: () =>
      Promise.resolve({ url: "https://github.com/acme/widget/issues/42", number: 42 }),
  } as never;
  const ok = await fileIssue("t", "b", () => Promise.resolve(okForge), { labels: ["a"] });
  assert(
    ok.url?.endsWith("/issues/42") && ok.number === 42,
    "fileIssue: number comes from the forge",
  );
  const noNumber = { issueCreate: () => Promise.resolve({ url: "https://x/issues/7" }) } as never;
  const partial = await fileIssue("t", "b", () => Promise.resolve(noNumber));
  assert(
    partial.url?.endsWith("/issues/7") && partial.number === undefined,
    "fileIssue: a response with no number keeps the url and omits the number",
  );
  const empty = await fileIssue("t", "b", () => Promise.resolve(undefined));
  assert(
    empty.failure?.reason === "forge-unresolved",
    "fileIssue: an unresolved forge still discriminates",
  );
}

// ------------------------------------------------------------- teardown

await teardownPlanCache();

console.log(`\nexit ${exit}`);
process.exit(exit);
