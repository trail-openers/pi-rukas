#!/usr/bin/env bun
/**
 * detectRepeatSeam — unit fixtures.
 *
 * Issue #280, workstream d1. Pure-function tests only (no driver, no I/O).
 *
 * Acceptance criteria covered here:
 *   1. 3 same-lens/same-title findings across 3 files → fires
 *   2. 3 same-lens/same-title findings across 2 files → does not fire
 *   3. 3 different titles → does not fire
 *   4. Title normalisation tolerates file-specific tokens (paths, lines, SHAs)
 */

import { detectRepeatSeam } from "./detect-repeat-seam.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------- imports check
const _named = { detectRepeatSeam };
assert(typeof detectRepeatSeam === "function", "detectRepeatSeam is exported as a function");

// --------------------------------------------------- AC1: fires
{
  console.log("AC1: 3 same-lens/same-title across 3 files → fires");
  const findings = [
    { lens: "SECURITY", title: "Missing input validation in src/auth.rs:42", path: "src/auth.rs" },
    { lens: "SECURITY", title: "Missing input validation in src/api.rs:17", path: "src/api.rs" },
    {
      lens: "SECURITY",
      title: "Missing input validation in src/worker.rs:99",
      path: "src/worker.rs",
    },
  ];
  const signal = detectRepeatSeam(findings);
  assert(signal !== null, "signal fires for 3-file cluster");
  if (signal === null) throw new Error("unreachable");
  assert(signal.fileCount === 3, "fileCount is 3");
  assert(signal.lens === "SECURITY", "lens is SECURITY");
  assert(
    signal.normalisedTitle.startsWith("missing input validation"),
    "title starts with normalised core",
  );
  assert(signal.files.length === 3, "files array has 3 entries");
  assert(
    signal.files.includes("src/auth.rs") &&
      signal.files.includes("src/api.rs") &&
      signal.files.includes("src/worker.rs"),
    "files contain the original paths",
  );
  assert(signal.findings.length === 3, "findings array has all 3 findings");
}

// --------------------------------------------------- AC2: does not fire (2 files)
{
  console.log("AC2: 3 same-lens/same-title across 2 files → does not fire");
  const findings = [
    { lens: "SECURITY", title: "Missing input validation in src/auth.rs", path: "src/auth.rs" },
    { lens: "SECURITY", title: "Missing input validation in src/api.rs", path: "src/api.rs" },
    {
      lens: "SECURITY",
      title: "Missing input validation in src/api.rs (duplicate)",
      path: "src/api.rs",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "no signal for 2-file cluster (below threshold)");
}

// --------------------------------------------------- AC3: does not fire (different titles)
{
  console.log("AC3: 3 different titles → does not fire");
  const findings = [
    { lens: "SECURITY", title: "Missing input validation in src/auth.rs", path: "src/auth.rs" },
    { lens: "SECURITY", title: "Missing null check in src/api.rs", path: "src/api.rs" },
    { lens: "SECURITY", title: "Missing error handling in src/worker.rs", path: "src/worker.rs" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "no signal when titles are different");
}

// --------------------------------------------------- AC4: normalisation tolerates file tokens
{
  console.log("AC4: title normalisation tolerates file-specific tokens");

  // Paths in titles
  const findings1 = [
    {
      lens: "SIMPLICITY",
      title: "Duplicate helper in src/modules/a/b/c.rs",
      path: "src/modules/a/b/c.rs",
    },
    {
      lens: "SIMPLICITY",
      title: "Duplicate helper in src/modules/x/y/z.rs",
      path: "src/modules/x/y/z.rs",
    },
    { lens: "SIMPLICITY", title: "Duplicate helper in src/leaf.rs", path: "src/leaf.rs" },
  ];
  const result1 = detectRepeatSeam(findings1);
  assert(result1 !== null, "paths like src/a/b/c.rs and src/leaf.rs normalise to same cluster");
  if (result1 === null) throw new Error("unreachable");
  assert(
    result1.normalisedTitle.startsWith("duplicate helper"),
    "normalised title starts with 'duplicate helper'",
  );

  // Line numbers in titles
  const findings2 = [
    { lens: "ERROR_HANDLING", title: "Unwrapped .unwrap() on src/foo.rs:42", path: "src/foo.rs" },
    { lens: "ERROR_HANDLING", title: "Unwrapped .unwrap() on src/bar.rs:17", path: "src/bar.rs" },
    { lens: "ERROR_HANDLING", title: "Unwrapped .unwrap() on src/baz.rs:99", path: "src/baz.rs" },
  ];
  const result2 = detectRepeatSeam(findings2);
  assert(result2 !== null, "line numbers in title do not prevent clustering");
  if (result2 === null) throw new Error("unreachable");
  assert(
    result2.normalisedTitle === "unwrapped .unwrap() on <path>:<line>",
    "line numbers normalised",
  );

  // Mixed casing (case-insensitive clustering)
  const findings3 = [
    { lens: "PERFORMANCE", title: "Missing cache in src/A.rs", path: "src/A.rs" },
    { lens: "PERFORMANCE", title: "missing cache in src/b.rs", path: "src/b.rs" },
    { lens: "PERFORMANCE", title: "MISSING CACHE in src/c.rs", path: "src/c.rs" },
  ];
  const result3 = detectRepeatSeam(findings3);
  assert(result3 !== null, "case differences in title do not prevent clustering");
  if (result3 === null) throw new Error("unreachable");
  assert(result3.normalisedTitle.startsWith("missing cache"), "case is normalised to lowercase");
}

// --------------------------------------------------- empty input
{
  console.log("Empty input → null");
  const result = detectRepeatSeam([]);
  assert(result === null, "empty findings returns null");
}

// --------------------------------------------------- multiple clusters: returns first
{
  console.log("Multiple clusters → returns first (by input order)");
  const findings = [
    // Cluster A appears first (finding 0)
    { lens: "SECURITY", title: "Pattern X in src/a.rs", path: "src/a.rs" },
    { lens: "SECURITY", title: "Pattern X in src/b.rs", path: "src/b.rs" },
    { lens: "SECURITY", title: "Pattern X in src/c.rs", path: "src/c.rs" },
    // Cluster B also qualifies (findings 3-5) but is not returned
    { lens: "SIMPLICITY", title: "Pattern Y in src/d.rs", path: "src/d.rs" },
    { lens: "SIMPLICITY", title: "Pattern Y in src/e.rs", path: "src/e.rs" },
    { lens: "SIMPLICITY", title: "Pattern Y in src/f.rs", path: "src/f.rs" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "signal fires");
  if (result === null) throw new Error("unreachable");
  assert(result.lens === "SECURITY", "returns the first cluster (SECURITY, not SIMPLICITY)");
  assert(result.normalisedTitle.startsWith("pattern x"), "normalised title matches first cluster");
}

// --------------------------------------------------- SHAs and quoted strings in titles
{
  console.log("SHAs and quoted references are stripped from titles");
  const findings = [
    {
      lens: "ARCHITECTURE",
      title: "Tight coupling to commit abc1234 in src/mod.rs",
      path: "src/mod.rs",
    },
    {
      lens: "ARCHITECTURE",
      title: "Tight coupling to commit def5678 in src/lib.rs",
      path: "src/lib.rs",
    },
    {
      lens: "ARCHITECTURE",
      title: "Tight coupling to commit 9a8b7c6 in src/util.rs",
      path: "src/util.rs",
    },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "SHAs do not prevent clustering");
  if (result === null) throw new Error("unreachable");
  assert(
    result.normalisedTitle.startsWith("tight coupling to commit <sha>"),
    "SHAs stripped from title",
  );
  assert(!result.normalisedTitle.match(/\b[0-9a-f]{7,}\b/), "no raw SHA in output");
}

// --------------------------------------------------- fewer than 3 files with ≥3 findings each
{
  console.log("≥3 findings across <3 files → does not fire");
  const findings = [
    { lens: "SECURITY", title: "Same issue in src/a.rs", path: "src/a.rs" },
    { lens: "SECURITY", title: "Same issue in src/a.rs (2)", path: "src/a.rs" },
    { lens: "SECURITY", title: "Same issue in src/a.rs (3)", path: "src/a.rs" },
    { lens: "SECURITY", title: "Same issue in src/b.rs", path: "src/b.rs" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result === null, "only 2 distinct files, even with 4 findings");
}

// --------------------------------------------------- mixed lens + same title
{
  console.log("Same title, different lenses → separate clusters");
  const findings = [
    { lens: "SECURITY", title: "Missing validation in src/a.rs", path: "src/a.rs" },
    { lens: "SECURITY", title: "Missing validation in src/b.rs", path: "src/b.rs" },
    { lens: "SECURITY", title: "Missing validation in src/c.rs", path: "src/c.rs" },
    { lens: "SIMPLICITY", title: "Missing validation in src/a.rs", path: "src/a.rs" },
    { lens: "SIMPLICITY", title: "Missing validation in src/b.rs", path: "src/b.rs" },
    { lens: "SIMPLICITY", title: "Missing validation in src/c.rs", path: "src/c.rs" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "fires on first cluster by input order");
  if (result === null) throw new Error("unreachable");
  assert(result.lens === "SECURITY", "returns SECURITY (first in input order)");
}

// --------------------------------------------------- cross-check: path stripping edge cases
{
  console.log("Path normalisation handles edge cases");
  // Deeply nested paths
  const findings = [
    {
      lens: "TYPE_SAFETY",
      title: "Unnecessary type in a/b/c/d/e/f/g.rs",
      path: "a/b/c/d/e/f/g.rs",
    },
    { lens: "TYPE_SAFETY", title: "Unnecessary type in x/y/z.rs", path: "x/y/z.rs" },
    { lens: "TYPE_SAFETY", title: "Unnecessary type in standalone.rs", path: "standalone.rs" },
  ];
  const result = detectRepeatSeam(findings);
  assert(result !== null, "deeply nested and shallow paths still cluster");
}

// --------------------------------------------------- summary
console.log(`\n${exit === 0 ? "✓ All tests passed" : "✗ Some tests failed"}`);
process.exit(exit);
