#!/usr/bin/env bun
/**
 * #1064 — an `integration-verify-failed` park says WHICH tests failed.
 *
 * The measured shape is cycle 1064's own state file: the consolidated gate went red on
 * 22 tests, and the cap-hit that parked the cycle carried `evidence: null`. The operator
 * saw a cap name and nothing else — no failing test, no assertion, no log — while the
 * gate had already extracted all three and thrown them away.
 *
 * Three layers, one per place the evidence used to be dropped:
 *   1. the extractor recovers `FAILED:` / `✗` names from the raw stream;
 *   2. the classifier, when its bounded 800-char window elided them, still surfaces the
 *      names from the unclipped text — and `consolidatedFailureMessage` uses them instead
 *      of printing "(no specific assertion could be extracted)" over a run that had named
 *      every failing test;
 *   3. the cap fields the terminal park records: `evidence` / `failures` / `logPaths`,
 *      with the honest shapes preserved (no failures → no fabricated line; a timeout
 *      still says it was killed).
 */

import {
  consolidatedVerifyCapFields,
  consolidatedVerifyEvidenceFields,
  EVIDENCE_TOTAL_MAX,
  FAILURE_LINE_MAX,
  namedFailureLines,
  NAMED_FAILURE_LINES_MAX,
  REASON_MAX,
} from "../src/work-driver-commit-verify-evidence.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "../src/work-driver-consolidation-classify.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 22 named failures, in the shape a bun/vitest summary actually prints: the `FAILED:`
// summary line first, then the per-test `✗` assertions, then noise.
const NAMES = Array.from({ length: 22 }, (_, i) => `driver::test_case_${i + 1}`);
const RAW_FAILURE = [
  "running 22 tests",
  "test driver::test_case_1 ... FAILED",
  "thread 'main' panicked at src/main.rs:10:",
  "assertion failed: left == right",
  ...NAMES.map((n) => `✗ ${n}`),
  "some other chatter".repeat(120),
  `FAILED: ${NAMES.length} test(s) — ${NAMES.slice(0, 6).join(", ")} …`,
].join("\n");

// ---------------------------------------------------------------------------
// 1. The extractor.

const named = namedFailureLines(RAW_FAILURE);
assert(named.length > 0, "#1064: named failures are recovered from the raw stream");
assert(
  named.some((l) => l.includes("FAILED: 22 test(s)")),
  "#1064: the `FAILED: <n> test(s)` summary is one of them",
);
assert(
  NAMES.every((n) => named.some((l) => l.includes(n))),
  "#1064: every `✗` test line survives into the evidence",
);
const namesUpperBound = 40;
assert(
  named.length <= namesUpperBound,
  `#1064: the recovered set is bounded so a cap is not a log dump (got ${named.length})`,
);
assert(namedFailureLines("").length === 0, "#1064: empty text yields no names");
assert(namedFailureLines(undefined).length === 0, "#1064: absent text yields no names");
assert(
  namedFailureLines("ok 12 tests passed").length === 0,
  "#1064: a green stream yields no names (nothing is invented)",
);

// ---------------------------------------------------------------------------
// 2. The classifier + message. The window is what the pre-fix code passed; the FULL text
//    is what #1064 added. The window here is deliberately the tail that names nothing.

const WINDOW = "some other chatter".repeat(40);
const wsIds = ["task-a", "task-b"];

{
  const before = classifyConsolidatedVerifyFailure(2, wsIds, WINDOW, {});
  assert(
    before.assertion.includes("no specific assertion"),
    "baseline: the bounded window alone really does come up empty (this is the defect)",
  );
  const msg = consolidatedFailureMessage(before, "bun test");
  assert(
    msg.includes("no specific assertion"),
    "baseline: with no full text the sentinel stands (absence stays honest)",
  );
}

{
  const after = classifyConsolidatedVerifyFailure(2, wsIds, WINDOW, {}, RAW_FAILURE);
  assert(
    after.namedFailures !== undefined && after.namedFailures.length > 0,
    "#1064: the unclipped stream recovers the names the window elided",
  );
  const msg = consolidatedFailureMessage(after, "bun test");
  // The pre-fix message printed the sentinel here. It now carries the recovered names —
  // bounded, so it is a summary and not the whole log.
  assert(
    (after.namedFailures ?? []).length > 0 &&
      msg.includes("driver::test_case_1") &&
      msg.includes("driver::test_case_22"),
    "#1064: the message names the failing tests the bounded window had elided",
  );
  assert(
    !msg.includes("specific assertion: (no specific assertion"),
    "#1064: the sentinel no longer stands in for the specific-assertion field",
  );
  assert(
    msg.includes("consolidation-created") || msg.includes("task-a"),
    "#1064: the classification and workstream attribution are still in the message",
  );
}

{
  // A per-workstream defect keeps its own attribution, and still gains the names.
  const perWs = classifyConsolidatedVerifyFailure(
    2,
    wsIds,
    WINDOW,
    { "task-b": "FAILED: 3 test(s) — driver::only_b_1, driver::only_b_2, driver::only_b_3" },
    RAW_FAILURE,
  );
  // The window names nothing, so case 2 cannot match on the assertion; the classifier
  // falls through to the combination case. The assertion is POSITIVE here, not the
  // tautology it used to be (`namedFailures === undefined || length > 0` passed whether or
  // not the field existed at all): the full stream names 22 tests, so the field MUST be
  // present and non-empty on this shape too — the per-workstream path that used to lose it
  // is the regression this pins.
  assert(
    perWs.namedFailures !== undefined && perWs.namedFailures.length > 0,
    "#1064: the per-workstream shape never loses the recovered names",
  );
}

// ---------------------------------------------------------------------------
// 3. The cap fields the terminal park writes.

{
  const fields = consolidatedVerifyEvidenceFields({
    cap: "integration-verify-failed",
    reason: "verify failed",
    timedOut: false,
    failures: ["FAILED: 22 test(s)", "✗ driver::test_case_1"],
    logPaths: ["/tmp/verify-1064.log"],
  });
  assert(
    fields !== undefined && fields.verifyEvidence.failures.length === 2,
    "#1064: verifyEvidence.failures carries the gate's own lines",
  );
  assert(
    fields?.verifyEvidence.origin === "outcome-gate",
    "#1064: the origin is structured (`outcome-gate`), not inferred from prose",
  );
  const cap = consolidatedVerifyCapFields({
    cap: "integration-verify-failed",
    reason: "verify failed",
    timedOut: false,
    failures: ["FAILED: 22 test(s)", "✗ driver::test_case_1"],
    logPaths: ["/tmp/verify-1064.log"],
  });
  assert(
    (cap.evidence ?? "").includes("FAILED: 22 test(s)"),
    "#1064: the cap's `evidence` names the failing tests, not just the cap",
  );
  assert(
    (cap.logPaths ?? []).length === 1 && (cap.logPaths ?? [])[0] === "/tmp/verify-1064.log",
    "#1064/#841: the cap points at the persisted raw-output log",
  );
  assert(
    (cap.evidence ?? "").includes("✗ driver::test_case_1"),
    "#1064: the cap carries the extracted `✗` line as well as the summary",
  );
}

{
  // The honest negatives: no failures means no fabricated evidence.
  const empty = consolidatedVerifyEvidenceFields({
    cap: "integration-verify-failed",
    reason: "verify failed",
    timedOut: false,
  });
  // The absence is asserted, not excused: `empty === undefined || …` passed when the field
  // WAS present and populated, which is the shape this test exists to forbid.
  assert(
    empty === undefined,
    "#1064: with no failure lines there is no verifyEvidence at all — nothing is invented",
  );
  const emptyCap = consolidatedVerifyCapFields({
    cap: "integration-verify-failed",
    reason: "verify failed on the consolidated tree",
    timedOut: false,
  });
  assert(
    (emptyCap.evidence ?? "").includes("verify failed on the consolidated tree"),
    "#1064: the reason still stands as the evidence when there are no lines",
  );
  assert(
    emptyCap.logPaths === undefined,
    "#841: no log, no pointer (an empty logPaths is not a broken link)",
  );
}

{
  // A killed run says it was killed — the #1324 shape must survive the #1064 changes.
  const timedOut = consolidatedVerifyCapFields({
    cap: "verify-timeout:commit-pr",
    reason: "verify killed at its bound",
    timedOut: true,
    failures: ["✗ driver::test_case_1"],
  });
  const timedOutEvidence = consolidatedVerifyEvidenceFields({
    cap: "verify-timeout:commit-pr",
    reason: "verify killed at its bound",
    timedOut: true,
    failures: ["✗ driver::test_case_1"],
  });
  assert(
    timedOut.evidence?.includes("killed at its bound") &&
      timedOut.evidence.includes("✗ driver::test_case_1"),
    "#1324/#1064: a run killed at its bound says so AND still carries its extracted lines",
  );
  assert(
    timedOutEvidence?.verifyEvidence.origin === "outcome-gate" &&
      timedOutEvidence.verifyEvidence.failures.length === 1,
    "#1064: a timed-out park records its failure lines in verifyEvidence too",
  );
}

// ---------------------------------------------------------------------------
// 4. #1702 — every string these helpers write goes through the redactor BEFORE the
//    bound. Both surfaces persist (the state file, the handoff comment, the PR body) and
//    both carry text neither the driver nor the operator wrote: the project's verify
//    output, and the forge's refusal, which quotes the content push protection flagged.
//
// The token is assembled from fragments at runtime so this file itself carries no
// credential-shaped literal (the same rule the fixtures follow, and the reason GitHub
// push protection is what refuses these commits in the first place).

const TOKEN = ["gh", "p_", "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v"].join("");
const REDACTED = "[REDACTED]";

{
  // A GH013 refusal that ALSO carries an extra `remote:` line with a token in it — the
  // shape that made this a HIGH: the refusal text is stored and rendered verbatim, and a
  // remote line quoting the flagged secret shipped it into the handoff.
  const gh013WithToken = [
    "remote: error: GH013: Repository rule violations found for refs/heads/feature/x.",
    `remote:   flagged: ${TOKEN} in src/fixtures.ts`,
    "remote:     * Push the commit again to allow the secret: https://github.com/o/r/security/secret_scanning/unblock-secret/3Kvj3Vlk",
  ].join("\n");

  const cap = consolidatedVerifyCapFields({
    cap: "push-refused:commit-pr",
    reason: gh013WithToken,
    pushRefused: true,
  });
  const ev = consolidatedVerifyEvidenceFields({
    cap: "push-refused:commit-pr",
    reason: gh013WithToken,
    pushRefused: true,
  });
  assert(
    !(cap.evidence ?? "").includes(TOKEN) && (cap.evidence ?? "").includes(REDACTED),
    "#1702: the cap's evidence redacts a token on a `remote:` line instead of storing it",
  );
  assert(
    (cap.evidence ?? "").includes("unblock-secret/3Kvj3Vlk"),
    "#1702: the allow-the-secret URL survives the redaction — it IS the operator's action",
  );
  assert(
    (ev?.verifyEvidence.failures ?? []).every((l) => !l.includes(TOKEN)) &&
      (ev?.verifyEvidence.failures ?? []).some((l) => l.includes(REDACTED)),
    "#1702: pipelineState.verifyEvidence.failures carries the redacted line, not the token",
  );
}

{
  // A verify failure line carrying a `api_key=` shape — the project's own output, which an
  // assertion echoes. Both the recovered-lines path and the raw `failures[]` path redact.
  const leaky = [
    "FAILED: 1 test(s) — driver::leaks",
    `✗ expected api_key=${TOKEN} to match config`,
    `  at assertKey (src/config.ts:12) secret=${"s".repeat(6)}${"K".repeat(24)}`,
  ].join("\n");
  const cap = consolidatedVerifyCapFields({
    cap: "integration-verify-failed",
    reason: `verify failed on the consolidated tree\n${leaky}`,
    timedOut: false,
    failures: leaky.split("\n"),
    logPaths: ["/tmp/verify-1702.log"],
  });
  const ev = consolidatedVerifyEvidenceFields({
    cap: "integration-verify-failed",
    reason: "verify failed on the consolidated tree",
    timedOut: false,
    failures: leaky.split("\n"),
    logPaths: ["/tmp/verify-1702.log"],
  });
  assert(
    !(cap.evidence ?? "").includes(TOKEN),
    "#1702: the cap's evidence never carries a credential the verify command printed",
  );
  assert(
    (cap.evidence ?? "").includes("✗ driver::test_case_1".replace("driver::test_case_1", "")) ||
      (cap.evidence ?? "").includes("FAILED: 1 test(s)"),
    "#1702: redaction does not swallow the test names — the evidence still names the failure",
  );
  assert(
    (ev?.verifyEvidence.failures ?? []).every((l) => !l.includes(TOKEN)),
    "#1702: every stored failure line is redacted, not just the first",
  );
}

{
  // The bounds above are STORE-side ceilings, not display caps: the renderers clip again
  // (`evidenceLines`'s 300-char `LINE_MAX` in work-driver-cause-class.ts, `EVIDENCE_MAX`
  // in headless/failure.ts). If a store bound ever dropped BELOW a render bound it would
  // silently truncate evidence the operator was entitled to see, so the store stays the
  // looser of the two. Pinned rather than commented because a tightened constant is exactly
  // the change nobody notices.
  const RENDER_LINE_MAX = 300;
  const RENDER_EVIDENCE_MAX = 2000;
  assert(
    FAILURE_LINE_MAX > RENDER_LINE_MAX && REASON_MAX > RENDER_LINE_MAX,
    "#1702: store-side line bounds stay looser than the renderer's 300-char line clip",
  );
  assert(
    EVIDENCE_TOTAL_MAX >= RENDER_EVIDENCE_MAX,
    "#1702: the store-side evidence bound never truncates below what the headless host is owed",
  );
}

{
  // The named-lines extractor itself: the de-dup runs on the REDACTED line, so two
  // spellings of one assertion that differ only in the credential collapse to one entry.
  const a = `✗ expected token ${TOKEN} to equal`;
  const b = `✗ expected token ${["gh", "p_", "xY9zA1bC2dE3fG4hI5jK6lM"].join("")} to equal`;
  const lines = namedFailureLines([a, b].join("\n"));
  assert(
    lines.every((l) => !l.includes(TOKEN) && !l.includes("xY9zA1bC")),
    "#1702: namedFailureLines redacts the assertion line it recovers",
  );
}

{
  // #1702 — the DEVELOP path, the one the classifier originally read unredacted.
  // `namedFailureLinesFrom` swept the WHOLE unclipped stream with no redaction and the
  // result was joined into `consolidatedFailureMessage`, which the develop/ci gate wrote
  // into the state file and the handoff comment posted to the forge. A failing assertion
  // ECHOES the value it compared, so a token printed by a test shipped to the remote.
  // The token is assembled from fragments at runtime (no credential-shaped literal in
  // this file); it sits OUTSIDE the 800-char window, so only the recovery path can see
  // it — which is exactly the path that used to have no redactor on it.
  const ECHO_TOKEN = ["gh", "p_", "A".repeat(36)].join("");
  const filler = "noise".repeat(400);
  const longStream = [
    `✗ assertion failed: expected config to equal ${ECHO_TOKEN}`,
    filler,
    filler,
    `FAILED: 2 test(s) — driver::echo_a, driver::echo_b`,
  ].join("\n");
  // The window is what the gate's 800-char tail clip would hand the classifier: the
  // END of the stream, which names nothing but the summary.
  const window = longStream.slice(-800);
  assert(
    !window.includes(ECHO_TOKEN),
    "#1702 baseline: the echoed token really is outside the bounded window",
  );
  const verdict = classifyConsolidatedVerifyFailure(1, ["default"], window, {}, longStream);
  const msg = consolidatedFailureMessage(verdict, "bun test");
  assert(
    !msg.includes(ECHO_TOKEN) && msg.includes("[REDACTED]"),
    "#1702: a token echoed outside the window is REDACTED in the message, not shipped",
  );
  assert(
    (verdict.namedFailures ?? []).every((l) => !l.includes(ECHO_TOKEN)),
    "#1702: the structured namedFailures field carries no unredacted echo either",
  );
}

{
  // #1702 — the count cap: 200 `✗` lines must recover AT MOST the cap, and the scan
  // must STOP there (a stream read whole into a `String[]` before clipping was the
  // pre-fix shape; the cap is a stop, not a slice). If importing through the classifier
  // ever bypasses the cap, this is the assertion that catches it.
  const many = Array.from({ length: 200 }, (_, i) => `✗ driver::flood_${i}`).join("\n");
  const recovered = namedFailureLines(many);
  assert(
    recovered.length === NAMED_FAILURE_LINES_MAX && recovered.length <= 40,
    `#1702: a 200-failure stream recovers at most the exported cap (got ${recovered.length})`,
  );
  assert(
    !recovered.some((l) => l.includes("flood_199")),
    "#1702: the scan STOPS at the cap — the tail of the flood is never collected",
  );
  const silentWindow = "chatter".repeat(200);
  const verdict = classifyConsolidatedVerifyFailure(1, ["default"], silentWindow, {}, many);
  assert(
    (verdict.namedFailures ?? []).length === NAMED_FAILURE_LINES_MAX,
    "#1702: the classifier recovery respects the same cap (window names nothing, full stream floods)",
  );
}

process.exit(exit);
