#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 1b of 3: the merge exit.
 *
 * The pure rule lives in `test-lens-unproven-high.ts` and asserts itself where
 * it is written. This file asserts the SAME rule at the one point every lens
 * finding passes on its way to a ledger row — the merge — because an exit that
 * dropped the cap call must read red here, not only at the pure function. The
 * second group pins the stronger form: the exit forwards the PER-CHILD evidence
 * surface unchanged, so a map cannot be quietly flattened to a pooled list at
 * the exit the round is actually judged by.
 *
 * The shared builders come from `lib/unproven-high-harness.ts` so the three
 * files cannot drift apart on what a reproduction or a `bash` call is.
 */

import path from "node:path";
import { mergeLensFindings } from "../src/lens-review-merge.ts";
import { buildLensRoster } from "../src/lens-roster.ts";
import { HIGH, bash, createAssert, repro, toolResult } from "./lib/unproven-high-harness.ts";

const { assert, failures } = createAssert();
const REPO_ROSTER = buildLensRoster(path.resolve(import.meta.dirname, "..", "..", "skill"));

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

// ---------------------------------------------------------------------------
// (b, continued) The merge exit forwards the PER-CHILD evidence surface
// unchanged (#2040 review, adversarial ISSUE 1). `mergeLensFindings` is the one
// point every lens finding passes, so if it flattened the map to a pooled list
// the per-child rule would be dead at the exit the round is actually judged by,
// while every assertion above still passed.
// ---------------------------------------------------------------------------
{
  const perChild = new Map<string, unknown[]>([
    ["SECURITY", [bash("bun test security", "sa"), toolResult("sa", false)]],
    ["SIMPLICITY", [bash("bun test simplicity", "si"), toolResult("si", false)]],
  ]);
  const merged = mergeLensFindings(
    [
      HIGH("sec", {
        lens: "SECURITY",
        path: "src/sec.ts",
        reproduction: repro("bun test security", "boom"),
      }),
      HIGH("borrowed", {
        lens: "SIMPLICITY",
        path: "src/sim.ts",
        reproduction: repro("bun test security", "boom"),
      }),
      HIGH("bare", { lens: "SECURITY", path: "src/bare.ts" }),
      HIGH("scan", { lens: "CLAIM_SCAN", path: "src/scan.ts" }),
    ],
    REPO_ROSTER,
    perChild,
  );
  const byPath = new Map(merged.map((x) => [x.path, x]));
  assert(merged.length === 4, "(b) the per-child merge kept every finding");
  assert(
    byPath.get("src/sec.ts")?.severity === "HIGH",
    "(b) the merge judges a row by its own child's calls",
  );
  assert(
    byPath.get("src/sim.ts")?.severity === "MEDIUM",
    "(b) the merge caps a HIGH whose command only another lens's child ran",
  );
  assert(
    byPath.get("src/bare.ts")?.severity === "MEDIUM",
    "(b) the merge caps a HIGH with no claim at all",
  );
  assert(
    byPath.get("src/scan.ts")?.severity === "HIGH",
    "(b) the merge still exempts a CLAIM_SCAN row from the per-child match",
  );
}

console.log(`\nexit %d`, failures());
process.exit(failures());
