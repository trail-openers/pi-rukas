#!/usr/bin/env bun
/**
 * #1841 — the CONSOLIDATED route reads a `FAIL  <description>` header's indented
 * detail lines, and the harvest's own bounds.
 *
 * Split out of `test-verify-failure-shapes-g-1762.ts` for the 500-line gate
 * (AGENTS.md §12); the shared fixtures live in
 * `lib/verify-failure-shapes-fixtures.ts` so neither half re-types them.
 *
 * The park this closes: a project gate reports a failing check as a header plus
 * prose, and the header alone tells the developer WHICH check went red but not what
 * to change — so the round, once earned, would have dispatched a developer who had
 * to re-run the verify to find out. The per-worktree route is pinned beside the
 * decision itself in `test-work-driver-corrective-decide.ts`; this suite is the same
 * stream arriving as the consolidated run's raw output, the route whose tally
 * harvest was already consolidated-only.
 *
 * Every fixture is synthetic gate output; none of it is this repo's own dialect.
 */

import {
  CORRECTIVE_LINE_MAX,
  CORRECTIVE_MAX_LINES,
  decideCorrectiveRound,
} from "../src/work-driver-corrective-decide.ts";
import type { CorrectiveGateView } from "../src/work-driver-corrective-decide.ts";
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { isNonAssertionLine } from "../src/work-driver-consolidation-classify.ts";
import { detailLooksCredential } from "../src/work-driver-verify-credential-screen.ts";
import {
  HEADER_DETAIL_MAX,
  HEADER_DETAIL_SCAN_MAX,
  HEADER_DETAIL_WITHHELD,
  harvestHeaderDetails,
} from "../src/work-driver-verify-header-detail.ts";
import {
  consolidatedAssertionLines,
  failureEvidence,
} from "../src/work-driver-verify-record.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import {
  CMD,
  FAIL_HEADER,
  FAIL_HEADER_DETAILS,
  FAIL_HEADER_PASSING,
  FAIL_HEADER_STREAM,
  TALLY_LINE,
  TALLY_NAMES,
  WT,
  makeAssert,
} from "./lib/verify-failure-shapes-fixtures.ts";
import { harvestConsolidatedTallies, nameLooksSecret } from "../src/work-driver-verify-tally.ts";

const { assert, failed } = makeAssert();
const NO_EVENTS: WorkEvent[] = [];

/** A consolidated-only gate (no worktree failed on its own). */
function consolidatedGate(raw: string): CorrectiveGateView {
  const failure = "consolidated verify failed";
  return {
    ok: false,
    failures: [failure],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [failure],
      perWorktree: [],
      consolidatedRaw: raw,
    },
  };
}

// ── 1. the header classifies, and its details are evidence ───────────────────
{
  const got = classifyFailureLine(FAIL_HEADER);
  assert(
    got?.shape === "fail-header" && got.namesTest === true,
    `fail-header: the header classifies with namesTest true (got ${JSON.stringify(got)})`,
  );
  const details = harvestHeaderDetails(FAIL_HEADER_STREAM);
  assert(
    details.length === FAIL_HEADER_DETAILS.length &&
      FAIL_HEADER_DETAILS.every((l) => details.includes(l.trim())),
    `harvest: every indented detail line of the header is harvested (got ${JSON.stringify(details)})`,
  );
  assert(
    !FAIL_HEADER_PASSING.some((l) => details.includes(l.trim())),
    `harvest: the ok/skip lines beside the block are not details (got ${JSON.stringify(details)})`,
  );
}

// ── 2. the consolidated route earns the round and gives both ─────────────────
{
  const lines = consolidatedAssertionLines(FAIL_HEADER_STREAM);
  assert(
    lines.includes(FAIL_HEADER),
    `fail-header consolidated: the header is an evidence line (got ${JSON.stringify(lines)})`,
  );
  const d = decideCorrectiveRound(consolidatedGate(FAIL_HEADER_STREAM), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    d.round === true && d.source === "consolidated",
    `fail-header consolidated: the round is earned (got ${JSON.stringify(d)})`,
  );
  if (d.round) {
    const given = d.targets[0]?.lines ?? [];
    assert(
      given.includes(FAIL_HEADER) && FAIL_HEADER_DETAILS.every((l) => given.includes(l.trim())),
      `fail-header consolidated: header and details are both given (got ${JSON.stringify(given)})`,
    );
    assert(
      !FAIL_HEADER_PASSING.some((l) => given.includes(l.trim())),
      `fail-header consolidated: the ok/skip lines are never given (got ${JSON.stringify(given)})`,
    );
    assert(
      given.every((l) => l.length <= CORRECTIVE_LINE_MAX) && given.length <= CORRECTIVE_MAX_LINES,
      "fail-header consolidated: the corrective line bounds hold on this route too",
    );
    // #1841 round 2 (b) — the STORED channel is the assertions alone: this is the
    // list `work-driver-corrective-round.ts` writes to the `corrective-round` event,
    // which is what the fix-pass fence reads back through `correctiveRoundFor` to
    // admit a file. A detail line in it would widen the fence on a gate's prose.
    const recorded = d.targets[0]?.evidence ?? [];
    assert(
      recorded.includes(FAIL_HEADER) &&
        !FAIL_HEADER_DETAILS.some((l) => recorded.includes(l.trim())),
      `fail-header consolidated: the recorded evidence carries no detail line (got ${JSON.stringify(recorded)})`,
    );
  }
}

// ── 2b. #1841 round 2 — credentials under a header never reach the developer ─
// The measured gap: the detail channel kept only `isNonAssertionLine` +
// `redactThenBound`, so a credential NO keyword pattern anchors on — an unprefixed
// base64 PEM body, a bare `Authorization: Basic <b64>`, an `ssh-rsa AAAA…` blob —
// reached the corrective prompt, the `corrective-round` event and the write-fence
// admission evidence verbatim, while the SAME line unindented is refused today by
// the classifier. Every fixture below is ASSEMBLED at runtime from pieces: a
// literal key-shaped string in this file trips GitHub push protection.
{
  const b64 = "B3Nz".repeat(8); // 32 base64 chars; no keyword anchors on it
  const CREDENTIAL_DETAILS = [
    `      private key: -----BEGIN ${"PRIVATE"} KEY----- ${b64}`,
    `      Authorization: Basic ${"VGhpc0lzTm90QVJlYWxLZXk"}`,
    `      ssh-${"rsa"} AAAA${b64}`,
    `      ${b64}`,
  ];
  const tell = b64.slice(0, 16);
  for (const secret of CREDENTIAL_DETAILS) {
    const stream = `${FAIL_HEADER}\n${secret}`;
    const d = decideCorrectiveRound(consolidatedGate(stream), {
      eventLog: NO_EVENTS,
      worktrees: { default: WT },
    });
    const given = d.round ? (d.targets[0]?.lines ?? []) : [];
    const stored = d.round ? (d.targets[0]?.evidence ?? []) : [];
    assert(
      !given.some((l) => l.includes(tell)),
      `secret detail: the base64 body is not given to the developer (${JSON.stringify(secret.trim().slice(0, 32))} got ${JSON.stringify(given)})`,
    );
    assert(
      !stored.some((l) => l.includes(tell)),
      `secret detail: the base64 body is not in the recorded evidence (${JSON.stringify(stored)})`,
    );
    // The header still earns the round — the credential is refused, the diagnosis
    // of the stream is not lost with it.
    assert(
      d.round === true && given.includes(FAIL_HEADER),
      `secret detail: refusing the credential does not refuse the round (${JSON.stringify(d)})`,
    );
    assert(
      detailLooksCredential(secret.trim()) === true,
      `secret detail: the screen itself refuses ${JSON.stringify(secret.trim().slice(0, 32))}`,
    );
  }
  // A bare base64 blob is refused by the HARVEST too, so its text never reaches the
  // detail channel at all — asked where the reader still exposes it. What the
  // harvest returns instead is the one disclosure line (#1841 round 4, d): the walk
  // still stops, and the developer is told output was withheld rather than left to
  // read a cut block as a complete one.
  const bare = harvestHeaderDetails(`${FAIL_HEADER}\n      ${CREDENTIAL_DETAILS[3]}`);
  assert(
    bare.length === 1 && bare[0] === HEADER_DETAIL_WITHHELD,
    `secret detail: a bare base64 blob is not harvested as a detail, only withheld (got ${JSON.stringify(bare)})`,
  );
  assert(
    bare.every((l) => detailLooksCredential(l) === false),
    `secret detail: the withheld marker is not itself credential-shaped (got ${JSON.stringify(bare)})`,
  );
  // ── #1841 round 4 (a) — the opaque-run arm reads RUNS, not the whole line ──
  // The split is what keeps the arm off ordinary prose: a sentence whose words are
  // short has only short runs, however long the line is, and a whole-line regex
  // refused it. What the arm does NOT do any more is excuse a path (#1841 round 5):
  // a long run that merely CARRIES a `/` is refused, so a long absolute path in a
  // detail line is withheld and the disclosure says so. The conjunction that refuses
  // the path is what still refuses the key bodies above, so both halves stay pinned.
  const longPath = ["see", "/home/dev/work/src/some/really/long/path/name/index.tsx"].join(" ");
  assert(
    detailLooksCredential(longPath) === true,
    `opaque run: a long /-joined path is refused, not kept (${JSON.stringify(longPath)})`,
  );
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n      ${longPath}`).join("|") ===
      HEADER_DETAIL_WITHHELD,
    `opaque run: the withheld path leaves only the disclosure behind (got ${JSON.stringify(harvestHeaderDetails(`${FAIL_HEADER}\n      ${longPath}`))})`,
  );
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n      ${longPath}\n      a short reason`).join("|") ===
      HEADER_DETAIL_WITHHELD,
    "opaque run: the block after a withheld path contributes nothing",
  );
  // Padding never stands alone either: a run of `=` is a redaction fill, not a key.
  assert(
    detailLooksCredential(`aligned ${"=".repeat(30)} tail`) === false,
    "opaque run: a run of padding characters is not key material",
  );
  // And a real key body's padding is still part of its run, so the arm still fires.
  assert(
    detailLooksCredential(`token body ${b64}=`) === true,
    "opaque run: a padded base64 body is still refused",
  );
  // ── #1841 round 5 — the punctuation arm is origin/main's arm, with no exemption ──
  // The round-4 fix for the path above narrowed this arm to a run of TWO `+`/`/`, and
  // origin/main's veto for ONE of them went with it: a digit-free base64 body — 24
  // letters, one separator, 24 letters — is exactly that shape, and both callers
  // published it. The revision that then told paths apart by SEGMENT SHAPE let a key
  // body split into two short-enough pieces walk through, so the exemption is deleted
  // and the arm is main's again: ANY `+` or `/` in a long run is refused, paths
  // included. Both callers are ASKED — the tally's own veto reads a name at 24 and the
  // credential screen reads prose at 20, and #1841's defect family is a rule one caller
  // honours and the other does not.
  const half = 24;
  const singleSlash = "a".repeat(half) + "/" + "b".repeat(half);
  const singlePlus = "a".repeat(half) + "+" + "b".repeat(half);
  const absolutePath = "/home/dev/work/src/some/really/long/path/name/index.tsx";
  // Assembled at runtime rather than written as a literal: three base64-shaped pieces
  // joined by `/` is the exact shape the veto exists for, and the suite asks the rule
  // about a run the file itself never spells out.
  const joinedKey = ["a1B2c3D4e5F6g7h8i9", "0J1K2L3M4N5O6P7Q8R", "S9T0U1V2W3X4Y5Z6a7"].join("/");
  const cases = [
    ["a single `/`", singleSlash, true],
    ["a single `+`", singlePlus, true],
    ["a long absolute path", absolutePath, true],
    ["a `/`-joined key body", joinedKey, true],
  ] as Array<[string, string, boolean]>;
  for (const [label, run, refused] of cases) {
    const expectation = refused ? "is refused" : "is kept";
    assert(
      nameLooksSecret(run) === refused,
      `shared rule: the tally veto ${expectation} a long run carrying ${label}`,
    );
    assert(
      detailLooksCredential(`reported ${run}`) === refused,
      `shared rule: the credential screen ${expectation} a long run carrying ${label}`,
    );
    assert(
      harvestConsolidatedTallies(`${TALLY_LINE}\n    ${run}\n    ${TALLY_NAMES[0]}`).length ===
        (refused ? 0 : 1),
      `shared rule: the tally harvest ${refused ? "never names" : "still names"} a run carrying ${label}`,
    );
    assert(
      harvestHeaderDetails(`${FAIL_HEADER}\n      ${run}`).join("|") ===
        (refused ? HEADER_DETAIL_WITHHELD : run),
      `shared rule: the detail channel ${refused ? "withholds" : "still gives"} the ${label} (got ${JSON.stringify(harvestHeaderDetails(`${FAIL_HEADER}\n      ${run}`))})`,
    );
  }
  // A path-shaped run is refused whatever its pieces look like — that IS the round-5
  // decision, so the two shapes that used to mark the boundary between a path and a
  // key now sit on the same side of the rule.
  assert(
    detailLooksCredential(`blob /${"c".repeat(half)}/${"d".repeat(half)}/e`) === true,
    "path shape: a run of long pieces is refused",
  );
  assert(
    detailLooksCredential(`blob /a/b/c/${"e".repeat(half)}+f`) === true,
    "path shape: a run carrying `+` is refused whatever its segments look like",
  );
  assert(
    detailLooksCredential(`blob ${"g".repeat(12)}/${"h".repeat(12)}/${"i".repeat(4)}`) === true,
    "path shape: a long run with no leading `/` is refused",
  );
  // A SHORT path still harvests: the arm asks a run only once it is long, so the
  // ordinary paths a gate cites are unaffected — this is the half that keeps the
  // over-refusal above from becoming a blanket refusal of every path in a stream.
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n    see extension/src/work-driver-verify-tally.ts`).join(
      "|",
    ) === "see extension/src/work-driver-verify-tally.ts",
    "path shape: a path whose runs are all short is still a detail the developer is given",
  );
  // ── #1841 round 4 (b) — the screen is asked BEFORE every other stop in the walk ──
  // "May this line be published" is a PRIOR question to "is this line the header's
  // prose": the classifier, the passing-line judge and the dump bound all END the
  // walk, and once it has ended a line that stopped it is never asked again. Here a
  // credential-shaped line is ALSO a line the shared table claims as a failure — the
  // shape that used to stop the walk with its secret un-screened and undisclosed.
  const pemBody = `-----BEGIN ${"PRIVATE"} KEY----- ${b64}`;
  const bothStops = `${FAIL_HEADER}\n      key material: ${pemBody}\n      ${FAIL_HEADER_DETAILS[0]}`;
  const screened = harvestHeaderDetails(bothStops);
  assert(
    screened.length === 1 && screened[0] === HEADER_DETAIL_WITHHELD,
    `stop order: a credential the table also claims is refused and disclosed, not just stopped (got ${JSON.stringify(screened)})`,
  );
  assert(
    !screened.some((l) => l.includes(b64.slice(0, 16))),
    `stop order: no fragment of that line is published (got ${JSON.stringify(screened)})`,
  );
  // The line beneath the refused one is NOT harvested either — the walk stops, which
  // is what keeps the line beside a refused one from being published on its coattails.
  assert(
    !screened.some((l) => l.includes("24639")),
    "stop order: the block after a refused line contributes nothing",
  );
  // A real `formatExecError` wrapper, indented so it is a candidate, carrying a
  // secret: screened before the #1810 wrapper stop can end the walk past it.
  const wrapperSecret = `  verify command ${"gate.sh"} failed in /w: dump ${b64}`;
  const echoed = harvestHeaderDetails(`${FAIL_HEADER}\n${wrapperSecret}`);
  assert(
    echoed.length === 1 && echoed[0] === HEADER_DETAIL_WITHHELD,
    `wrapper echo: a wrapper carrying a secret is screened, not stopped past (got ${JSON.stringify(echoed)})`,
  );
  assert(
    !echoed.some((l) => l.includes(b64.slice(0, 16))),
    `wrapper echo: no fragment of the wrapper's secret is published (got ${JSON.stringify(echoed)})`,
  );
  // A line that merely QUOTES the harness sentence, indented, is prose (#1810 reads
  // indentation on the raw line): kept when clean, and the screen did not become a
  // general stop that swallows every line carrying the harness's words.
  const echoQuote = `      verify command ${"gate.sh"} failed in /w, the ceiling is over`;
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n${echoQuote}`).length === 1,
    "wrapper echo: an indented quote of the harness sentence is prose, not a wrapper",
  );
  // ── #1841 round 4 (c) — both channels answer the credential question the same way ──
  // The SAME unprefixed blob, indented under a header and unindented as a bare
  // assertion-shaped line, must be refused on both routes. Before this round only
  // the indented route asked the screen, so the unindented one leaked.
  const bareAssertion = `assertion failed on ${b64}`;
  assert(
    consolidatedAssertionLines(`${FAIL_HEADER}\n${bareAssertion}`).every(
      (l) => !l.includes(b64.slice(0, 16)),
    ),
    `assertion channel: the same blob is refused unindented too (got ${JSON.stringify(consolidatedAssertionLines(`${FAIL_HEADER}\n${bareAssertion}`))})`,
  );
  // ── #1841 round 4 (d) — a withheld block is disclosed, and survives to the dev ──
  const withheldRound = decideCorrectiveRound(consolidatedGate(`${FAIL_HEADER}
      ${FAIL_HEADER_DETAILS[0]}
      ${b64}`), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    withheldRound.round === true &&
      (withheldRound.targets[0]?.lines ?? []).includes(HEADER_DETAIL_WITHHELD),
    `withheld: the developer is told output was withheld (got ${JSON.stringify(withheldRound.round ? withheldRound.targets[0]?.lines : withheldRound)})`,
  );
  assert(
    withheldRound.round === true &&
      !(withheldRound.targets[0]?.evidence ?? []).includes(HEADER_DETAIL_WITHHELD),
    `withheld: the disclosure is prompt-only and never stored (got ${JSON.stringify(withheldRound.round ? withheldRound.targets[0]?.evidence : [])})`,
  );
  assert(
    detailLooksCredential(HEADER_DETAIL_WITHHELD) === false &&
      isNonAssertionLine(HEADER_DETAIL_WITHHELD) === false,
    "withheld: the marker passes the two vetoes every kept detail line passes",
  );
  // And beside a `✗` line — the case where the diagnosis prose is dropped as noise:
  // the disclosure is not noise, it is the record that something was refused.
  const markedWithheld = failureEvidence(`✗ b.ts: expected 0, got 1
${FAIL_HEADER}
      ${FAIL_HEADER_DETAILS[0]}
      ${b64}`);
  assert(
    markedWithheld.details.includes(HEADER_DETAIL_WITHHELD),
    `withheld: the marker travels beside a ✗ line instead of being dropped with the prose (got ${JSON.stringify(markedWithheld.details)})`,
  );
  // And the screen does NOT refuse the #1841 fixture's own prose, which carries
  // long digit runs (`24639`, `24576`) — an arm that fired there would silently
  // disable the feature it guards.
  assert(
    FAIL_HEADER_DETAILS.every((l) => detailLooksCredential(l.trim()) === false),
    "secret detail: the real detail lines of the fixture are not credential-shaped",
  );
}

// ── 2c. #1841 round 2 (c) — a missing-module DETAIL still declines the round ─
{
  const stream = `${FAIL_HEADER}\n      Cannot find module \'zod\' from x.ts`;
  const d = decideCorrectiveRound(consolidatedGate(stream), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    d.round === false && d.reason.includes("dependency"),
    `missing-module detail: the round declines and the deps hint stays (${JSON.stringify(d)})`,
  );
  // Positive control beside it: the same header with an ordinary detail earns it.
  const ok = decideCorrectiveRound(consolidatedGate(FAIL_HEADER_STREAM), {
    eventLog: NO_EVENTS,
    worktrees: { default: WT },
  });
  assert(
    ok.round === true,
    `missing-module detail control: an ordinary detail still earns the round (${JSON.stringify(ok)})`,
  );
}

// ── 3. the harvest's own bounds and stopping rules ───────────────────────────
{
  // The count cap mirrors the corrective round's own, so the harvest never builds
  // evidence the reader is certain to slice away. Asserted as an inequality against
  // its OWNER (#1841 round 3, d): `CORRECTIVE_MAX_LINES` is the bound and this cap
  // only mirrors it, so the pair cannot drift past one another silently.
  assert(
    HEADER_DETAIL_MAX <= CORRECTIVE_MAX_LINES,
    `bounds: HEADER_DETAIL_MAX (${HEADER_DETAIL_MAX}) never exceeds CORRECTIVE_MAX_LINES (${CORRECTIVE_MAX_LINES})`,
  );
  const many = harvestHeaderDetails(
    `${FAIL_HEADER}\n${Array.from({ length: 12 }, (_, n) => `    reason ${n}`).join("\n")}`,
  );
  assert(
    many.length === HEADER_DETAIL_MAX,
    `bounds: at most ${HEADER_DETAIL_MAX} detail lines are harvested (got ${many.length})`,
  );
  // Exactly ONE owner per length bound (#1841 round 3, d): the harvest CLIPS
  // nothing. It refuses a line past its dump threshold outright, so no bound in
  // this module can disagree with the two that do apply — the record's
  // `redactThenBound` at `ASSERTION_LINE_MAX` and the corrective round's
  // `CORRECTIVE_LINE_MAX` — and every detail the developer is given is cut by the
  // corrective bound alone, not by a third slice nobody declared.
  const long = harvestHeaderDetails(`${FAIL_HEADER}\n    ${"z".repeat(400)}`);
  assert(
    long.length === 1 && long[0] === HEADER_DETAIL_WITHHELD,
    `bounds: a 400-char dump under a header is refused, not silently clipped — and the refusal is disclosed (got ${JSON.stringify(long.map((l) => l.length))})`,
  );
  // The prose is assembled from words, not one long run: a bare 300-character run
  // of one letter IS the shape the credential screen refuses, and a fixture that
  // tripped it would pin the wrong rule.
  const prose = "the reason line is long ".repeat(15).slice(0, CORRECTIVE_LINE_MAX);
  const kept = harvestHeaderDetails(`${FAIL_HEADER}\n    ${prose}`);
  assert(
    kept.length === 1 && kept[0]?.length === CORRECTIVE_LINE_MAX,
    `bounds: a reason at the corrective bound survives the harvest whole (got ${JSON.stringify(kept.map((l) => l.length))})`,
  );
  const longGiven =
    decideCorrectiveRound(consolidatedGate(`${FAIL_HEADER}\n    ${prose}`), {
      eventLog: NO_EVENTS,
      worktrees: { default: WT },
    }).targets?.[0]?.lines ?? [];
  assert(
    longGiven.some((l) => l.length === CORRECTIVE_LINE_MAX) &&
      longGiven.every((l) => l.length <= CORRECTIVE_LINE_MAX),
    `bounds: the corrective bound is the only clip a kept detail passes (got ${longGiven.map((l) => l.length)})`,
  );
  // The walk cap: a gate that prints a document under one header costs a bounded
  // scan, and the cap is stated rather than inferred from the keep cap.
  assert(
    HEADER_DETAIL_SCAN_MAX > HEADER_DETAIL_MAX,
    `bounds: the walk cap (${HEADER_DETAIL_SCAN_MAX}) is wider than the keep cap (${HEADER_DETAIL_MAX})`,
  );
  const walk = harvestHeaderDetails(
    `${FAIL_HEADER}\n${Array.from({ length: 400 }, (_, n) => `    reason ${n}`).join("\n")}`,
  );
  assert(
    walk.length === HEADER_DETAIL_MAX,
    `bounds: a 400-line block under one header is still bounded (got ${walk.length})`,
  );
  // Indentation is measured on the RAW line: a line at the header's own depth is
  // the next block, not this header's prose, and it stops the walk.
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\nnot indented\n      deeper but after it`).length === 0,
    "bounds: a line no deeper than the header stops the harvest (indentation read untrimmed)",
  );
  // A line the table claims stops the walk too — it is evidence in its own right
  // (a failure) or the next block (a passing tally), not this header's prose.
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n    reason one\n    ok 1 - a passing check\n    x`).join(
      "|",
    ) === "reason one",
    "bounds: a passing line stops the harvest — it is not a detail of the header",
  );
  assert(
    harvestHeaderDetails(`${FAIL_HEADER}\n    ✗ the real assertion`).join("|") === "",
    "bounds: a line the table classifies as a failure stops it — it is evidence on its own, not this header's prose",
  );
  // A stream with no header harvests nothing at all — every existing reader of
  // `assertionLines` is unchanged by this harvest.
  assert(
    harvestHeaderDetails("test.sh: failed checks (2)\n    lint\n    test/b_test.sh").length === 0,
    "no header: the harvest contributes nothing to a stream that has none",
  );
}

process.exit(failed() ? 1 : 0);
