#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 1 of 3: the pure pass.
 *
 * Field evidence (several PRs on one day): a six-lens round on a ~780-line diff
 * reported 138 findings, 2 HIGH; one asked for behaviour the issue put out of
 * scope, the other claimed a verdict-forgery path the adversarial reviewer
 * refuted by running ~16,000 crafted inputs through the real parsers. Each fix
 * round produced new unproven HIGHs, so the review never converged and a correct
 * PR needed an operator. AGENTS.md §7: a gate checks executed evidence, never a
 * child's claim.
 *
 * The rule: a lens HIGH blocks only with a `reproduction` the harness can check
 * — a `command` that equals (whitespace collapsed, both sides) a `bash` call the
 * SAME lens child is recorded as having made, and a non-empty `observed`.
 * Anything else is capped to MEDIUM with `severityCapped: "unproven"`, kept and
 * rendered, with only its blocking power changed. `observed` is a gate, never
 * content: no renderer prints it.
 *
 * This half asserts the rule where the rule is written:
 *   (a) `capUnprovenHighFinding` / `capUnprovenHighFindings` over a per-child
 *       evidence surface, and what `extractFindings` does with the field.
 *
 * The merge exit — the one point every lens finding passes on its way to a
 * ledger row — is half 1b (`test-lens-unproven-high-fanin.ts`), asserted there
 * as well because an exit that dropped the cap call must read red, not green.
 * The child plumbing, the store round and the renderers are half 2
 * (`test-lens-unproven-high-child.ts`). The builders all three compare against
 * are shared in `lib/unproven-high-harness.ts` so they cannot drift.
 *
 * What is NOT capped, and each pinned: CRITICAL keeps every mechanism it had
 * (`hasCritical`, the delta veto, CRITICAL carry); CLAIM_SCAN rows are
 * deterministic lookups, not lens judgements; a row the test-path cap already
 * moved is never re-capped — that cap runs first and wins, so a reproduction
 * cannot rescue a HIGH that cited a test file.
 */

import { extractFindings } from "../src/lens-findings-extract.ts";
import {
  SEVERITY_RUBRIC,
  capUnprovenHighFinding,
  capUnprovenHighFindings,
} from "../src/lens-severity-rubric.ts";
import type { Finding } from "../src/lens-review-types.ts";
import {
  HIGH,
  PROOF_COMMAND,
  bash,
  createAssert,
  repro,
  toolResult,
} from "./lib/unproven-high-harness.ts";

const { assert, failures } = createAssert();

/** The recorded-call list that makes `PROOF_COMMAND` a command the child ran.
 * #2040 review: a call is a REQUEST — the result is what records that it ran,
 * so every fixture that proves a command now carries its successful result too. */
const PROVEN: unknown[] = [bash(PROOF_COMMAND), toolResult(`call-${PROOF_COMMAND}`, false)];
// ---------------------------------------------------------------------------
// (a) The pure pass.
// ---------------------------------------------------------------------------
{
  const kept = capUnprovenHighFinding(
    HIGH("proof", { reproduction: repro("bun test x", "1 fail") }),
    [bash("bun test x")],
  );
  assert(kept.severity === "HIGH", "(a) a HIGH whose command the child ran keeps HIGH");
  assert(
    !Object.keys(kept).includes("severityCapped"),
    "(a) an evidence-backed HIGH carries no marker",
  );

  const never = capUnprovenHighFinding(
    HIGH("proof", { reproduction: repro("bun test x", "boom") }),
    [bash("ls")],
  );
  assert(never.severity === "MEDIUM", "(a) a HIGH whose command the child never ran → MEDIUM");
  assert(never.severityCapped === "unproven", "(a) an unproven HIGH carries the marker");

  const none = capUnprovenHighFinding(HIGH("no evidence"), [bash("ls")]);
  assert(none.severity === "MEDIUM", "(a) a HIGH with no reproduction at all → MEDIUM");
  assert(none.severityCapped === "unproven", "(a) the no-reproduction row carries the marker");

  const blank = capUnprovenHighFinding(
    HIGH("empty output", { reproduction: repro("bun test x", "   ") }),
    [bash("bun test x")],
  );
  assert(blank.severity === "MEDIUM", "(a) empty `observed` is not evidence → MEDIUM");
  assert(blank.severityCapped === "unproven", "(a) the empty-observed row carries the marker");

  const emptyCommand = capUnprovenHighFinding(
    HIGH("no command", { reproduction: { command: "   ", observed: "boom" } }),
    [bash("   ")],
  );
  assert(
    emptyCommand.severity === "MEDIUM",
    "(a) an empty `command` is not evidence → MEDIUM (nothing was run)",
  );

  const critical = capUnprovenHighFinding(
    HIGH("critical", { severity: "CRITICAL", reproduction: repro("bun test x", "boom") }),
    [],
  );
  assert(critical.severity === "CRITICAL", "(a) a CRITICAL with no reproduction stays CRITICAL");
  assert(
    !Object.keys(critical).includes("severityCapped"),
    "(a) an uncapped row has no severityCapped key at all",
  );
  assert(
    capUnprovenHighFinding(HIGH("c2", { severity: "CRITICAL" }), []).severity === "CRITICAL",
    "(a) a CRITICAL with no reproduction and no tool calls stays CRITICAL",
  );

  for (const severity of ["MEDIUM", "LOW"] as const) {
    const low = capUnprovenHighFinding(HIGH("sub", { severity }), []);
    assert(
      low.severity === severity && !Object.keys(low).includes("severityCapped"),
      `(a) a native ${severity} is untouched and carries no marker`,
    );
  }

  const input = HIGH("immutable", { reproduction: repro("bun test x", "boom") });
  const moved = capUnprovenHighFinding(input, []);
  assert(input.severity === "HIGH", "(a) the input finding is not mutated");
  assert(moved.severity === "MEDIUM", "(a) the returned row is the capped one");
  assert(
    input.title === "immutable" && input.path === "src/a.ts",
    "(a) capping moves only the severity, never the row's identity",
  );

  // The match is the command itself, whitespace-normalised on BOTH sides: the
  // child's call and its claim are two separate renderings of one command.
  const SPACED = "  bun   test \tx  ";
  const spaced = capUnprovenHighFinding(
    HIGH("spaced", { reproduction: repro(SPACED, "boom") }),
    [bash("bun test x")],
  );
  assert(spaced.severity === "HIGH", "(a) whitespace is collapsed on the claimed command");
  const spacedCall = capUnprovenHighFinding(
    HIGH("spaced2", { reproduction: repro("bun test x", "boom") }),
    [bash(SPACED)],
  );
  assert(spacedCall.severity === "HIGH", "(a) whitespace is collapsed on the recorded call");

  const substring = capUnprovenHighFinding(
    HIGH("substring", { reproduction: repro("bun test", "boom") }),
    [bash("bun test x --reporter=junit")],
  );
  assert(
    substring.severity === "MEDIUM",
    "(a) a claim that is only a prefix of a recorded call is not evidence",
  );
  const claimedSplice = capUnprovenHighFinding(
    HIGH("splice", { reproduction: repro("bun test x; rm -rf /", "boom") }),
    [bash("bun test x")],
  );
  assert(
    claimedSplice.severity === "MEDIUM",
    "(a) a claim carrying an extra command the child did not run is not evidence",
  );

  // Only the SAME lens child's calls count, and only `bash` calls.
  const otherTool = capUnprovenHighFinding(
    HIGH("wrong tool", { reproduction: repro("bun test x", "boom") }),
    [{ type: "toolCall", name: "read", arguments: { command: "bun test x" } }],
  );
  assert(otherTool.severity === "MEDIUM", "(a) a non-bash call carrying `command` is not evidence");
  const noCalls = capUnprovenHighFinding(
    HIGH("no calls", { reproduction: repro("bun test x", "boom") }),
    [],
  );
  assert(noCalls.severity === "MEDIUM", "(a) no recorded tool calls at all → MEDIUM");

  // CLAIM_SCAN is exempt: deterministic grep lookup, not a lens judgement.
  const scan = capUnprovenHighFinding(HIGH("scan", { lens: "CLAIM_SCAN" }), []);
  assert(scan.severity === "HIGH", "(a) a CLAIM_SCAN HIGH is not capped");
  assert(!Object.keys(scan).includes("severityCapped"), "(a) the scan row carries no marker");

  // The test-path cap runs FIRST and wins: such a row never reaches this pass.
  const already = capUnprovenHighFinding(
    HIGH("test row", {
      path: "tests/x.py",
      severity: "MEDIUM",
      severityCapped: "test-path",
      reproduction: repro("bun test x", "boom"),
    }),
    [bash("bun test x")],
  );
  assert(
    already.severityCapped === "test-path" && already.severity === "MEDIUM",
    "(a) a test-path-capped row is never re-capped",
  );
  // The pure pass is the UNPROVEN rule only: it does not know a test path from
  // a source path. The ordering claim — test-path first, and a row it moved is
  // never re-capped — belongs to `capFindings`, and is asserted at the merge
  // exit below (which is the surface the round is judged by).
  assert(
    capUnprovenHighFinding(HIGH("test high pure", { path: "tests/x.py" }), []).severity ===
      "MEDIUM",
    "(a) the pure pass knows only its own rule — a test-path HIGH caps as unproven here",
  );

  // A REQUEST IS NOT A RUN (#2040 review, adversarial ISSUE 2). `toolUses` is
  // what the child asked for; `toolResults` is what Pi accepted (types.ts).
  // The pair is joined by `toolCallId`, and only a result carrying
  // `isError === false` proves the command ran — a refused or failing bash call
  // is the opposite of a reproduction: it is evidence the command did NOT work.
  const refused = capUnprovenHighFinding(
    HIGH("refused", { reproduction: repro("bun test x", "boom") }),
    [bash("bun test x", "c1"), toolResult("c1", true)],
  );
  assert(
    refused.severity === "MEDIUM",
    "(a) a bash call whose result is an error does not prove a HIGH — a refused call is not a run",
  );
  assert(
    refused.severityCapped === "unproven",
    "(a) the error-result row carries the unproven marker",
  );
  const halfProved = capUnprovenHighFinding(
    HIGH("one refused one ok", { reproduction: repro("bun test x", "boom") }),
    [
      bash("bun test x", "bad"),
      toolResult("bad", true),
      bash("bun test x", "good"),
      toolResult("good", false),
    ],
  );
  assert(
    halfProved.severity === "HIGH",
    "(a) one successful call of the same command is enough — a refusal does not veto its sibling",
  );
  const unmatchedResult = capUnprovenHighFinding(
    HIGH("unjoined", { reproduction: repro("bun test x", "boom") }),
    [bash("bun test x", "c1"), toolResult("other-call", false)],
  );
  assert(
    unmatchedResult.severity === "MEDIUM",
    "(a) a success whose toolCallId matches no call proves nothing about this one",
  );
  const noResults = capUnprovenHighFinding(
    HIGH("no results recorded", { reproduction: repro("bun test x", "boom") }),
    [bash("bun test x", "c1")],
  );
  assert(
    noResults.severity === "HIGH",
    "(a) a child whose session recorded no results at all is not held to a ledger it never had",
  );
  const allBadResults = capUnprovenHighFinding(
    HIGH("results for other tools only", { reproduction: repro("bun test x", "boom") }),
    [bash("bun test x", "c1"), { toolCallId: "r2", toolName: "read", isError: false, text: "" }],
  );
  assert(
    allBadResults.severity === "HIGH",
    "(a) results recorded for OTHER tools leave the ledger empty, not failed",
  );
  const garbageResults = capUnprovenHighFinding(
    HIGH("garbage results", { reproduction: repro("bun test x", "boom") }),
    [null, bash("bun test x", "c1"), "string", 7, undefined],
  );
  assert(
    garbageResults.severity === "HIGH",
    "(a) malformed entries that are no record at all never become a refusal (nor a crash)",
  );
  const errorAndGarbage = capUnprovenHighFinding(
    HIGH("error among garbage", { reproduction: repro("bun test x", "boom") }),
    [bash("bun test x", "c1"), null, "string", { toolCallId: "c1", isError: true }],
  );
  assert(
    errorAndGarbage.severity === "MEDIUM",
    "(a) a refusal is still read through a list carrying garbage entries",
  );

  // A row already carrying a cap marker is NOT skipped by this pass (#2040
  // review, lens HIGH). A stored or carried row can arrive as HIGH while
  // claiming some other marker, and honouring that marker is how a row keeps
  // blocking on a cap the harness never applied to it this round. Only
  // `"test-path"` — the cap that genuinely runs FIRST, in the same pass —
  // short-circuits. The pair below is the SAME row except for the marker
  // spelling, so the first cannot be passing for the reason the second fails.
  const claimedTestPath = capUnprovenHighFinding(
    HIGH("stored test-path", {
      severity: "HIGH",
      path: "src/a.ts",
      severityCapped: "test-path",
      reproduction: repro("bun test x", "boom"),
    }),
    [bash("bun test x", "c1"), toolResult("c1", false)],
  );
  assert(
    claimedTestPath.severity === "HIGH",
    "(a) a row the test-path cap moved is still HIGH here — that cap runs first and wins",
  );
  const claimedOther = capUnprovenHighFinding(
    HIGH("stored marker", {
      severity: "HIGH",
      path: "src/a.ts",
      severityCapped: "because-i-said-so" as never,
      reproduction: repro("bun test x", "boom"),
    }),
    [bash("bun test x", "c1"), toolResult("c1", false)],
  );
  assert(
    claimedOther.severity === "HIGH",
    "(a) an unrecognized marker is not the test-path cap, so the same evidence still keeps HIGH",
  );
  const forgedCapUnproven = capUnprovenHighFinding(
    HIGH("forged unproven", { severity: "HIGH", severityCapped: "unproven" }),
    [],
  );
  assert(
    forgedCapUnproven.severity === "MEDIUM",
    "(a) a HIGH carrying a stored `unproven` marker is RE-CHECKED, so a carried row cannot stay HIGH unproven",
  );
  const forgedTestPathOnHigh = capUnprovenHighFinding(
    HIGH("forged test-path", {
      severity: "HIGH",
      path: "src/normal.ts",
      severityCapped: "test-path",
    }),
    [],
  );
  assert(
    forgedTestPathOnHigh.severity === "HIGH",
    "(a) this pass honours the test-path marker alone — the test-path rule itself belongs to the other cap",
  );

  // CLAIM_SCAN rows stay exempt whatever else is true of them: a scan row the
  // unproven pass capped would mean the cap now moves rows the other cap
  // deliberately exempts. The pair is the same row except for `lens`, so the
  // exemption cannot be passing for the reason the lens row caps.
  const scanWithMarker = capUnprovenHighFinding(
    HIGH("scan", { lens: "CLAIM_SCAN", severityCapped: "unproven" }),
    [],
  );
  assert(
    scanWithMarker.severity === "HIGH",
    "(a) a CLAIM_SCAN row is exempt even carrying a cap marker",
  );

  // The pass sorts like its sibling: rows move between severity levels, and
  // every report reads this array's order. `aaa.ts` sorts FIRST pre-cap (path
  // breaks the tie at equal severity), so if the pass did not re-sort a row the
  // round no longer calls HIGH would still sit above the native one.
  const list = capUnprovenHighFindings(
    [
      HIGH("capped", { path: "aaa.ts" }),
      HIGH("native", {
        path: "zzz.ts",
        reproduction: repro("bun test x", "1 failure"),
      }),
    ],
    [bash("bun test x")],
  );
  assert(
    list.map((x) => `${x.title}/${x.severity}`).join(",") === "native/HIGH,capped/MEDIUM",
    `(a) the pass re-sorts after moving rows between levels (got ${list.map((x) => `${x.title}/${x.severity}`).join(", ")})`,
  );

  // A toolUses array carrying garbage entries is not a crash and not evidence.
  const garbage = capUnprovenHighFinding(
    HIGH("garbage", { reproduction: repro("bun test x", "boom") }),
    [null, "string", 7, { name: "bash" }, { name: "bash", arguments: null }],
  );
  assert(garbage.severity === "MEDIUM", "(a) malformed tool-use entries never become evidence");
}

// ---------------------------------------------------------------------------
// (a, continued) The evidence surface is PER CHILD, not round-wide (#2040
// review, adversarial ISSUE 1). One lens running a command is not evidence for
// a finding another lens reported: the pool is keyed by the child that made the
// calls, so the row's `lens` picks which child's calls may prove it.
// ---------------------------------------------------------------------------
{
  const SECURITY = "SECURITY";
  const SIMPLICITY = "SIMPLICITY";
  const perChild = new Map<string, unknown[]>([
    [SECURITY, [bash("bun test security", "sa"), toolResult("sa", false)]],
    [SIMPLICITY, [bash("bun test simplicity", "si"), toolResult("si", false)]],
  ]);
  const rows = [
    HIGH("security proven", {
      lens: SECURITY,
      path: "src/sec.ts",
      reproduction: repro("bun test security", "boom"),
    }),
    HIGH("borrowed proof", {
      lens: SIMPLICITY,
      path: "src/sim.ts",
      reproduction: repro("bun test security", "boom"),
    }),
    HIGH("scan", { lens: "CLAIM_SCAN", path: "src/scan.ts" }),
  ];
  const capped = capUnprovenHighFindings(rows, perChild);
  const byPath = new Map(capped.map((x) => [x.path, x]));
  assert(
    byPath.get("src/sec.ts")?.severity === "HIGH",
    "(a) a HIGH is proven by its OWN child's call",
  );
  assert(
    byPath.get("src/sim.ts")?.severity === "MEDIUM",
    "(a) a HIGH whose command only ANOTHER lens's child ran is capped",
  );
  assert(
    byPath.get("src/sim.ts")?.severityCapped === "unproven",
    "(a) the borrowed-proof row says the harness moved it",
  );
  assert(
    byPath.get("src/scan.ts")?.severity === "HIGH",
    "(a) a CLAIM_SCAN row stays exempt from the per-child match",
  );
  // A row from a child the round recorded no calls for is judged against an
  // empty list — which caps, exactly as a child that ran nothing.
  const noEntry = capUnprovenHighFindings(
    [
      HIGH("unknown lens", {
        lens: "PERFORMANCE",
        path: "src/p.ts",
        reproduction: repro("bun test security", "boom"),
      }),
    ],
    perChild,
  );
  assert(
    noEntry[0]?.severity === "MEDIUM",
    "(a) a row whose lens recorded no calls at all has no evidence, whoever ran what",
  );
  // A list (the shape the blocked exit and every pre-#2040 caller passes) is
  // matched against EVERY row: it is one undifferentiated evidence pool, and
  // reading it per child would invent an attribution the caller never made.
  const flat = [bash("bun test security", "sa"), toolResult("sa", false)];
  const flatCapped = capUnprovenHighFindings(rows, flat);
  assert(
    flatCapped.every((x) => x.severity === "HIGH"),
    "(a) a plain call list still proves every HIGH it holds the command for",
  );
}

// ---------------------------------------------------------------------------

console.log(`\nexit 0`, failures());
process.exit(failures());
