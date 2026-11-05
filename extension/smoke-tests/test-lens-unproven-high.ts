#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 1 of 2: the pure pass and the assembly
 * exit.
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
 *   (a) `capUnprovenHighFinding` / `capUnprovenHighFindings` over a list plus a
 *       recorded-call list, and what `extractFindings` does with the field;
 *   (b) `mergeLensFindings` — the ONE point every lens finding passes on its way
 *       to a ledger row, asserted there and not only at the pure function,
 *       because an exit that dropped the cap call must read red, not green.
 *
 * The child plumbing, the store round and the renderers are half 2
 * (`test-lens-unproven-high-child.ts`); the builders both halves compare against
 * are shared in `lib/unproven-high-harness.ts` so the two files cannot drift.
 *
 * What is NOT capped, and each pinned: CRITICAL keeps every mechanism it had
 * (`hasCritical`, the delta veto, CRITICAL carry); CLAIM_SCAN rows are
 * deterministic lookups, not lens judgements; a row the test-path cap already
 * moved is never re-capped — that cap runs first and wins, so a reproduction
 * cannot rescue a HIGH that cited a test file.
 */

import path from "node:path";
import { extractFindings } from "../src/lens-findings-extract.ts";
import { mergeLensFindings } from "../src/lens-review-merge.ts";
import {
  SEVERITY_RUBRIC,
  capUnprovenHighFinding,
  capUnprovenHighFindings,
} from "../src/lens-severity-rubric.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { buildLensRoster } from "../src/lens-roster.ts";
import { HIGH, PROOF_COMMAND, bash, repro } from "./lib/unproven-high-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO_ROSTER = buildLensRoster(path.resolve(import.meta.dirname, "..", "..", "skill"));
/** The recorded-call list that makes `PROOF_COMMAND` a command the child ran. */
const PROVEN: unknown[] = [bash(PROOF_COMMAND)];
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
// (a, continued) extractFindings carries the evidence field, and refuses a
// malformed one rather than trusting it.
// ---------------------------------------------------------------------------
{
  const call = (arguments_: Record<string, unknown>) => ({
    type: "toolCall",
    name: "report_finding",
    arguments: arguments_,
  });
  const { findings, skipped } = extractFindings(
    [
      call({
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "with evidence",
        reproduction: { command: "bun test x", observed: "1 failure" },
      }),
      call({
        severity: "HIGH",
        path: "src/b.ts",
        title: "malformed evidence",
        reproduction: "bun test x",
      }),
      call({
        severity: "HIGH",
        path: "src/c.ts",
        title: "half evidence",
        reproduction: { command: "bun test x" },
      }),
      call({ severity: "HIGH", path: "src/d.ts", title: "no evidence" }),
    ],
    "SECURITY",
  );
  assert(skipped === 0, "(a) a malformed reproduction does not skip the finding itself");
  assert(findings.length === 4, "(a) every well-formed call is still one finding");
  assert(
    findings[0]?.reproduction?.command === "bun test x" &&
      findings[0]?.reproduction?.observed === "1 failure",
    "(a) a well-formed reproduction survives extraction",
  );
  assert(findings[1]?.reproduction === undefined, "(a) a string reproduction is dropped");
  assert(
    findings[2]?.reproduction === undefined,
    "(a) a reproduction missing `observed` is dropped",
  );
  assert(findings[3]?.reproduction === undefined, "(a) a call with no reproduction has none");
}

// ---------------------------------------------------------------------------
// (a, continued) The rubric tells the child the rule before it calls the tool.
// ---------------------------------------------------------------------------
{
  for (const phrase of [
    "reproduction",
    "command",
    "observed",
    "caps the finding to MEDIUM",
    "A HIGH must name a command you ran",
  ]) {
    assert(
      SEVERITY_RUBRIC.includes(phrase),
      `(a) the rubric names «${phrase}» so the child knows the rule before it calls`,
    );
  }
}

// ---------------------------------------------------------------------------
// (b) The merge exit — the single point every lens finding passes through.
// ---------------------------------------------------------------------------
{
  const calls = [bash("bun test x")];
  const merged = mergeLensFindings(
    [
      HIGH("proven", { path: "src/proven.ts", reproduction: repro("bun test x", "boom") }),
      HIGH("unproven", { path: "src/unproven.ts", reproduction: repro("bun test y", "boom") }),
      HIGH("bare", { path: "src/bare.ts" }),
      HIGH("critical", { path: "src/crit.ts", severity: "CRITICAL" }),
      HIGH("scan", { path: "src/scan.ts", lens: "CLAIM_SCAN" }),
      HIGH("test path", { path: "tests/x.py", reproduction: repro("bun test x", "boom") }),
    ],
    REPO_ROSTER,
    calls,
  );
  const byPath = new Map(merged.map((x) => [x.path, x]));
  assert(merged.length === 6, "(b) the merge kept every finding");
  assert(byPath.get("src/proven.ts")?.severity === "HIGH", "(b) the proven HIGH stays HIGH");
  assert(
    !("severityCapped" in (byPath.get("src/proven.ts") ?? {})),
    "(b) the proven row carries no marker",
  );
  assert(byPath.get("src/unproven.ts")?.severity === "MEDIUM", "(b) the unproven HIGH is capped");
  assert(
    byPath.get("src/unproven.ts")?.severityCapped === "unproven",
    "(b) the capped row says the harness moved it",
  );
  assert(byPath.get("src/bare.ts")?.severity === "MEDIUM", "(b) a HIGH with no evidence is capped");
  assert(
    byPath.get("src/crit.ts")?.severity === "CRITICAL",
    "(b) the merge leaves a CRITICAL alone",
  );
  assert(byPath.get("src/scan.ts")?.severity === "HIGH", "(b) the merge exempts CLAIM_SCAN");
  assert(
    byPath.get("tests/x.py")?.severityCapped === "test-path",
    "(b) the test-path cap wins over the reproduction at the merge exit",
  );

  // The surviving row of a dedup collision decides. CLAIM_SCAN outranks every
  // lens (its precedence is -∞), so the scan row survives and its exemption is
  // what the round is judged by — a colliding lens row's evidence never comes
  // back, because the row it rode on is not in the deduped list.
  const collision = mergeLensFindings(
    [
      HIGH("same", {
        path: "src/same.ts",
        line: 1,
        lens: "SECURITY",
        reproduction: repro("bun test x", "boom"),
      }),
      HIGH("same", { path: "src/same.ts", line: 1, lens: "CLAIM_SCAN" }),
    ],
    REPO_ROSTER,
    calls,
  );
  assert(collision.length === 1, "(b) the collision deduped to one row");
  assert(
    collision[0]?.lens === "CLAIM_SCAN" && collision[0]?.severity === "HIGH",
    "(b) the surviving CLAIM_SCAN row is exempt, so the collision keeps HIGH",
  );
  const bothLens = mergeLensFindings(
    [
      HIGH("same", { path: "src/same.ts", line: 1, lens: "SECURITY" }),
      HIGH("other", { path: "src/other.ts", line: 1, lens: "SIMPLICITY" }),
    ],
    REPO_ROSTER,
    calls,
  );
  assert(
    bothLens.length === 2 &&
      bothLens.every((f) => f.severity === "MEDIUM" && f.severityCapped === "unproven"),
    "(b) two unproven lens rows both cap (no CLAIM_SCAN to exempt them)",
  );

  // Absent and empty recorded-call lists both mean nothing was proven.
  assert(
    mergeLensFindings([HIGH("bare", { path: "src/bare.ts" })], REPO_ROSTER).every(
      (f) => f.severity === "MEDIUM",
    ),
    "(b) no recorded-call list at all → every HIGH caps",
  );
  assert(
    mergeLensFindings([HIGH("bare", { path: "src/bare.ts" })], REPO_ROSTER, []).every(
      (f) => f.severity === "MEDIUM",
    ),
    "(b) an empty recorded-call list caps too",
  );
}

console.log(`\nexit 0`, exit);
