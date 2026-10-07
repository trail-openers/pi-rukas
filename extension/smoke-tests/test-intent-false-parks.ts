#!/usr/bin/env bun
/**
 * The intent gate must not park work the resolver approved.
 *
 * Measured over the 13 real resolver replies on this host — the only artifacts
 * `parseNormalisedSpec` actually consumes — **7 of 13 (54%) had the resolver say
 * `proceed` or `proceed-with-assumptions` and the gate flip them to
 * `park` / underspecified.** Two causes, both mine, both shipped in v0.12.39-40:
 *
 * 1. `blockingQuestions` (5 of the 7). I applied it to the PROCEED path for the
 *    first time in #443. Before that it had exactly one call site, inside
 *    `specIsComplete`, where it prices *overturning* a park. Pricing a decision
 *    the same as overturning one is the same mistake I already made with
 *    acceptance criteria in that PR — two existing tests caught that conjunct
 *    and nothing caught this one. `proceed-with-assumptions` exists precisely
 *    for a spec that has open questions and defensible answers.
 *
 * 2. `bullets()` matching only `^[-*]\s+` (2 of the 7). A numbered list is
 *    invisible to it, and it backs FOUR spec fields — deliverables,
 *    acceptanceCriteria, evidence and openQuestions. So a numbered spec cannot
 *    even self-rescue via #397's "a complete spec refutes underspecified" path:
 *    it parks, and parks again on retry. That is the double-park shape seen on
 *    nessie #662, whose handoff said "does not say enough to build from" while
 *    quoting its own resolver saying "the intent is clear, no contradictions".
 *
 * Note the theory this replaces: the field diagnosis was that the resolver needs
 * a literal `D{N}:` prefix. It does not — `parseDeliverables` falls back to
 * `d${i+1}` when no id matches. Hours of issue-reformatting were spent on that,
 * and 0 of 40 real issue bodies would have been fixed by it.
 */

import {
  parseNormalisedSpec,
  reconcileVerdict,
  specIsActionable,
  specIsComplete,
} from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One spec, rendered with either list marker. */
const spec = (marker: "dash" | "numbered") => {
  const li = (i: number, text: string) => (marker === "dash" ? `- ${text}` : `${i}. ${text}`);
  return [
    "INTENT-VERDICT: proceed",
    "",
    "## Spec",
    "",
    "### Intent",
    "Make inert cron no-ops visible in production logs.",
    "",
    "### Deliverables",
    li(1, "**Circuit-breaker skip log** — emit INFO SKIPPED [paths: src/cron/mod.rs]"),
    li(2, "**Sweep guard skip log** — emit INFO with reason [paths: src/cron/mod.rs]"),
    "",
    "### Acceptance criteria",
    li(1, "A skipped sweep logs at INFO, not DEBUG"),
    "",
    "### Evidence",
    li(1, "confirmed: all five locations exist as described"),
    "",
    "### Open questions",
    li(1, "None blocking. All 5 locations are identified and verified."),
  ].join("\n");
};

// ------------------------------- a numbered list is a list

{
  const dash = parseNormalisedSpec(spec("dash"));
  const numbered = parseNormalisedSpec(spec("numbered"));

  assert(dash !== undefined && numbered !== undefined, "both forms parse to a spec");
  assert(
    numbered?.deliverables.length === 2,
    `canary: a NUMBERED deliverables list is read (got ${numbered?.deliverables.length}) — it read 0, and the gate parked the cycle`,
  );
  assert(
    numbered?.deliverables.length === dash?.deliverables.length,
    "...identically to the dash form",
  );

  // The gap empties four fields, which is why a numbered spec could not
  // self-rescue through #397's complete-spec refutation either.
  assert(
    numbered?.acceptanceCriteria.length === dash?.acceptanceCriteria.length &&
      numbered?.evidence.length === dash?.evidence.length &&
      numbered?.openQuestions.length === dash?.openQuestions.length,
    "canary: acceptanceCriteria, evidence and openQuestions all read too — the gap emptied four fields, not one",
  );
  assert(
    numbered?.deliverables[0]?.paths.includes("src/cron/mod.rs") === true,
    "...and `[paths: ...]` still parses inside a numbered entry",
  );
}

{
  // Ids already fall back — the `D{N}:` theory was wrong, and pinning that
  // stops the next investigation re-deriving it.
  const s = parseNormalisedSpec(spec("numbered"));
  assert(
    (s?.deliverables[0]?.id.length ?? 0) > 0 && (s?.deliverables[1]?.id.length ?? 0) > 0,
    "canary: deliverables without a `D{N}:` prefix still get ids — the prefix was never required",
  );
}

// --------------------- open questions do not price a decision

{
  const withBlocking = {
    intent: "Add the retry ceiling check",
    deliverables: [{ id: "d1", description: "warn at startup", paths: ["src/a.ts"] }],
    acceptanceCriteria: [],
    evidence: [],
    assumptions: [],
    openQuestions: [{ text: "Which config file wins?", blocking: true }],
    verdict: "proceed",
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  } as any;

  assert(
    specIsActionable(withBlocking),
    "canary: a blocking open question no longer parks a `proceed` — it accounted for 5 of the 7 false parks",
  );
  assert(
    !specIsComplete(withBlocking),
    "...while specIsComplete still refuses it, because overturning a park is a higher bar than making a decision",
  );
}

{
  // The gate must still be able to fail, or this is #328's "gate that cannot
  // fail" in a new place. Deliverables remain the bar.
  const noDeliverables = {
    intent: "do something",
    deliverables: [],
    acceptanceCriteria: ["it works"],
    evidence: [],
    assumptions: [],
    openQuestions: [],
    verdict: "proceed",
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
  assert(
    !specIsActionable(noDeliverables),
    "canary: a spec that names nothing to build still parks — the gate keeps its teeth",
  );
}

// ------------------------------- the whole path, end to end

{
  // The #662 shape: resolver says proceed, numbered deliverables, a
  // "None blocking" open question. It parked twice in the field.
  const parsed = parseNormalisedSpec(spec("numbered"));
  assert(parsed !== undefined, "the #662-shaped reply parses");
  if (parsed) {
    const reconciled = reconcileVerdict(parsed);
    assert(
      reconciled.verdict !== "park",
      `canary: the #662-shaped reply PROCEEDS (got "${reconciled.verdict}") — it parked twice, and the handoff blamed the issue`,
    );
    assert(reconciled.parkReason === undefined, "...with no park reason attached");
  }
}

// ============ #996: blockingQuestions "none"-placeholder matrix ============
//
// The #984 bug: the resolver's open-question bullet was
// `- (none — the residual-gap MEDIUM items are resolved by the acceptance
// criteria above; the LOW items are implementer details)` — a parenthesised
// "none" with a long dash-explanation. `blockingQuestions` must see through
// leading parens (and any mix of whitespace, bold, and backtick markers)
// to the "none" / "n/a" token.
//
// This matrix tests the ACTUAL production function via `specIsComplete`
// (which calls `blockingQuestions` internally) — NOT an inline regex copy —
// so the test stays honest if the implementation changes.
//
// A spec that is complete except for its open-questions field: if the open
// questions are placeholders, `specIsComplete` must return true. If they are
// genuine questions, `specIsComplete` must return false.

{
  /** Build a spec that is complete (intent, deliverables, AC, confirmed evidence)
   *  but whose open-questions field contains the given question texts. */
  const withOpenQuestions = (questions: string[]): string => {
    const qLines = questions.length > 0 ? questions.map((q) => `- ${q}`).join("\n") : "(empty)";
    return [
      "INTENT-VERDICT: proceed",
      "",
      "## Spec",
      "",
      "### Intent",
      "Do the thing in src/a.ts.",
      "",
      "### Deliverables",
      "- d1: change it [paths: src/a.ts]",
      "",
      "### Acceptance criteria",
      "- it works",
      "",
      "### Evidence",
      "- the change is correct — src/a.ts:1 — **confirmed**",
      "",
      "### Open questions",
      qLines,
      "",
    ].join("\n");
  };

  const nonBlocking = [
    "(none)",
    "None",
    "(none — long explanation text)",
    "N/A",
    "**None**",
    "**None** — the mechanism is confirmed",
    "(None blocking.)",
    "No open questions",
    "Nothing blocking",
    "(none — the residual-gap MEDIUM items are resolved by the acceptance criteria above; the LOW items are implementer details)",
    "None blocking.",
    "None blocking. All 5 locations are identified and verified.",
  ];

  for (const q of nonBlocking) {
    const parsed = parseNormalisedSpec(withOpenQuestions([q]));
    assert(parsed !== undefined, `placeholder matrix: "${q.slice(0, 50)}…" reply parses`);
    if (parsed) {
      assert(
        specIsComplete(parsed),
        `placeholder matrix: "${q.slice(0, 50)}…" is NON-blocking (specIsComplete=true)`,
      );
    }
  }

  const blocking = [
    "Which non-nullable type?",
    "Which config file wins?",
    "How should we handle edge X?",
    // #996 adversarial review: genuine questions beginning with "No"/"Nothing"
    // must remain blocking. The pre-fix regex discounted these as placeholders,
    // letting the #397 override flip a real park to proceed-with-assumptions.
    "No single owner for X; who decides?",
    "Nothing in the issue says which config wins.",
    "No tests currently cover the rollback path; add one?",
    "(none of the endpoints are idempotent; patch which first?)",
  ];

  for (const q of blocking) {
    const parsed = parseNormalisedSpec(withOpenQuestions([q]));
    assert(parsed !== undefined, `blocking matrix: "${q}" reply parses`);
    if (parsed) {
      assert(
        !specIsComplete(parsed),
        `blocking matrix: "${q}" is still BLOCKING (specIsComplete=false) — the word "none" mid-sentence or a genuine question must not be discounted`,
      );
    }
  }
}

// ============ #996: #378 pin — no verdict + incomplete spec still parks ===
//
// The #397 override (a complete spec refuting an `underspecified` park) must
// stay narrow. Three shapes of incomplete spec — no evidence at all, evidence
// without a confirmed row, and no deliverables — must still park when the
// resolver omitted its verdict token. The driver may not build from a spec
// that is not grounded, and this is what keeps "silence is not permission"
// true on the proceed side of the fence.

{
  const noEvidence = parseNormalisedSpec(
    [
      "## Spec",
      "",
      "### Intent",
      "Do the thing.",
      "",
      "### Deliverables",
      "- d1: do it [paths: src/a.ts]",
      "",
      "### Acceptance criteria",
      "- it works",
      "",
    ].join("\n"),
  );
  assert(noEvidence !== undefined, "#378 pin: no-evidence reply parses to a spec");
  if (noEvidence) {
    assert(
      noEvidence.verdict === "park" && noEvidence.parkReasonSource === "default",
      "#378 pin: no verdict token → the #378 default park",
    );
    assert(!specIsComplete(noEvidence), "#378 pin: no evidence → specIsComplete is false");
    const reconciled = reconcileVerdict(noEvidence);
    assert(
      reconciled.verdict === "park",
      "#378 pin: no-verdict + NO EVIDENCE still parks — the override does not fire without confirmed grounding",
    );
  }

  const unverifiedEvidence = parseNormalisedSpec(
    [
      "## Spec",
      "",
      "### Intent",
      "Do the thing.",
      "",
      "### Deliverables",
      "- d1: do it [paths: src/a.ts]",
      "",
      "### Acceptance criteria",
      "- it works",
      "",
      "### Evidence",
      "- the claim — src/a.ts:1 — unverifiable",
      "",
    ].join("\n"),
  );
  assert(unverifiedEvidence !== undefined, "#378 pin: unverified-evidence reply parses to a spec");
  if (unverifiedEvidence) {
    assert(
      unverifiedEvidence.evidence.some((e) => e.verdict === "unverifiable"),
      "#378 pin: the row parses as unverifiable (not accidentally confirmed)",
    );
    const reconciled = reconcileVerdict(unverifiedEvidence);
    assert(
      reconciled.verdict === "park",
      "#378 pin: no-verdict + UNVERIFIED evidence still parks — only confirmed rows count",
    );
  }

  const noDeliverables = parseNormalisedSpec(
    [
      "## Spec",
      "",
      "### Intent",
      "Do the thing.",
      "",
      "### Acceptance criteria",
      "- it works",
      "",
      "### Evidence",
      "- the claim — src/a.ts:1 — confirmed",
      "",
    ].join("\n"),
  );
  assert(noDeliverables !== undefined, "#378 pin: no-deliverables reply parses to a spec");
  if (noDeliverables) {
    assert(
      noDeliverables.deliverables.length === 0,
      "#378 pin: zero deliverables parsed (the spec names nothing to build)",
    );
    const reconciled = reconcileVerdict(noDeliverables);
    assert(
      reconciled.verdict === "park",
      "#378 pin: no-verdict + NO DELIVERABLES still parks — confirmed evidence alone is not a spec",
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
