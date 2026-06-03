#!/usr/bin/env bun
/**
 * Pure unit test for the six-pass review pipeline:
 *   - extractFindings (consume report_finding tool_use blocks)
 *   - dedupeFindings (precedence merge)
 *   - computeVerdict (severity → verdict mapping)
 *
 * No Pi spawns — just exercises the synthesis logic.
 */

import {
  computeVerdict,
  dedupeFindings,
  extractFindings,
  type Finding,
  type LensName,
} from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mk(
  lens: LensName,
  severity: Finding["severity"],
  filePath: string,
  line: number,
  title: string,
): Finding {
  return { lens, severity, path: filePath, line, title, description: "", suggestion: "" };
}

// 1. Empty input → APPROVED
assert(computeVerdict([]) === "APPROVED", "no findings → APPROVED");

// 2. LOW only → APPROVED
assert(
  computeVerdict([mk("SIMPLICITY", "LOW", "a.ts", 1, "trivial")]) === "APPROVED",
  "LOW only → APPROVED (matches opencode contract)",
);

// 3. MEDIUM → ISSUES_FOUND
assert(
  computeVerdict([mk("ARCHITECTURE", "MEDIUM", "a.ts", 1, "x")]) === "ISSUES_FOUND",
  "MEDIUM → ISSUES_FOUND (MEDIUM blocks merge in opencode contract)",
);

// 4. HIGH → ISSUES_FOUND
assert(
  computeVerdict([mk("SECURITY", "HIGH", "a.ts", 1, "x")]) === "ISSUES_FOUND",
  "HIGH → ISSUES_FOUND",
);

// 5. CRITICAL → CRITICAL_ISSUES_FOUND
assert(
  computeVerdict([
    mk("SECURITY", "CRITICAL", "a.ts", 1, "x"),
    mk("PERFORMANCE", "MEDIUM", "b.ts", 1, "y"),
  ]) === "CRITICAL_ISSUES_FOUND",
  "any CRITICAL → CRITICAL_ISSUES_FOUND (wins over MEDIUM)",
);

// 6. Dedup: SECURITY beats SIMPLICITY for same (path, line, title)
{
  const sec = mk("SECURITY", "HIGH", "src/auth.ts", 42, "unsafe input");
  const simp = mk("SIMPLICITY", "LOW", "src/auth.ts", 42, "Unsafe input");
  const merged = dedupeFindings([simp, sec]);
  assert(merged.length === 1, "duplicate (path,line,title) collapses to 1");
  assert(merged[0]?.lens === "SECURITY", "precedence keeps SECURITY over SIMPLICITY");
  assert(merged[0]?.severity === "HIGH", "kept the SECURITY entry's severity (HIGH)");
}

// 7. Dedup: SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY
{
  const same = (lens: LensName) => mk(lens, "MEDIUM", "x.ts", 0, "Some issue");
  const merged = dedupeFindings([
    same("SIMPLICITY"),
    same("ARCHITECTURE"),
    same("PERFORMANCE"),
    same("TYPE_SAFETY"),
    same("ERROR_HANDLING"),
    same("SECURITY"),
  ]);
  assert(merged.length === 1, "six identical findings collapse to 1");
  assert(merged[0]?.lens === "SECURITY", "SECURITY wins the full precedence chain");
}

// 8. Different lines → distinct findings
{
  const merged = dedupeFindings([
    mk("SECURITY", "HIGH", "a.ts", 1, "leak"),
    mk("SECURITY", "HIGH", "a.ts", 2, "leak"),
  ]);
  assert(merged.length === 2, "same file/title at different lines stay distinct");
}

// 9. Different titles → distinct findings
{
  const merged = dedupeFindings([
    mk("SECURITY", "HIGH", "a.ts", 1, "leak A"),
    mk("ERROR_HANDLING", "MEDIUM", "a.ts", 1, "leak B"),
  ]);
  assert(merged.length === 2, "same path/line different titles stay distinct");
}

// 10. Title normalisation: trailing punctuation + case-insensitive
{
  const merged = dedupeFindings([
    mk("SECURITY", "HIGH", "a.ts", 1, "SQL injection."),
    mk("ARCHITECTURE", "MEDIUM", "a.ts", 1, "sql injection"),
  ]);
  assert(merged.length === 1, "title is case-insensitive + trailing-punctuation-insensitive");
  assert(merged[0]?.lens === "SECURITY", "kept SECURITY in title-normalised match");
}

// 11. Findings are sorted by severity (CRITICAL first)
{
  const merged = dedupeFindings([
    mk("SIMPLICITY", "LOW", "z.ts", 1, "z"),
    mk("SECURITY", "CRITICAL", "a.ts", 1, "a"),
    mk("PERFORMANCE", "MEDIUM", "b.ts", 1, "b"),
    mk("ERROR_HANDLING", "HIGH", "c.ts", 1, "c"),
  ]);
  assert(merged[0]?.severity === "CRITICAL", "first finding is CRITICAL");
  assert(merged[1]?.severity === "HIGH", "second is HIGH");
  assert(merged[2]?.severity === "MEDIUM", "third is MEDIUM");
  assert(merged[3]?.severity === "LOW", "fourth is LOW");
}

// 12. extractFindings: parses report_finding tool_use blocks
{
  const toolUses = [
    {
      type: "toolCall",
      name: "report_finding",
      arguments: {
        severity: "HIGH",
        path: "src/auth.ts",
        line: 42,
        title: "SQL injection",
        description: "Concatenated user input.",
        suggestion: "Use prepared statements.",
      },
    },
    {
      type: "toolCall",
      name: "report_finding",
      arguments: { severity: "low", path: "./util.ts", title: "Magic number" },
    },
    // unrelated tool_use should be ignored
    { type: "toolCall", name: "bash", arguments: { command: "ls" } },
  ];
  const { findings, skipped } = extractFindings(toolUses, "SECURITY");
  assert(findings.length === 2, "two report_finding calls extracted, bash ignored");
  assert(skipped === 0, "no malformed calls skipped");
  assert(findings[0]?.severity === "HIGH", "first severity HIGH");
  assert(findings[1]?.severity === "LOW", "lowercase 'low' normalised to LOW");
  assert(findings[1]?.path === "util.ts", "leading './' stripped from path");
  assert(findings[1]?.line === 0, "missing line defaults to 0");
  assert(findings[0]?.lens === "SECURITY", "lens stamped from caller");
}

// 13. extractFindings: skips malformed calls (bad severity, missing path/title)
{
  const toolUses = [
    {
      type: "toolCall",
      name: "report_finding",
      arguments: { severity: "URGENT", path: "x.ts", title: "x" }, // bad severity
    },
    {
      type: "toolCall",
      name: "report_finding",
      arguments: { severity: "HIGH", title: "no path" }, // missing path
    },
    {
      type: "toolCall",
      name: "report_finding",
      arguments: { severity: "HIGH", path: "a.ts" }, // missing title
    },
    {
      type: "toolCall",
      name: "report_finding",
      arguments: { severity: "HIGH", path: "a.ts", title: "good" }, // valid
    },
  ];
  const { findings, skipped } = extractFindings(toolUses, "SECURITY");
  assert(findings.length === 1, "only the one well-formed call is kept");
  assert(skipped === 3, "three malformed calls counted as skipped");
}

// 14. extractFindings: handles non-object tool_use entries gracefully
{
  const toolUses = [null, "string", undefined, 42, { name: "report_finding" }];
  const { findings, skipped } = extractFindings(toolUses, "SECURITY");
  assert(findings.length === 0, "garbage tool_use entries produce zero findings");
  assert(skipped === 0, "no skipped counter for entries missing 'input' entirely");
}

// ---------------------------------------------------------------------------
// Per-lens retry + REVIEW_INCOMPLETE verdict (#3)
// ---------------------------------------------------------------------------

import type { LensRunResult } from "../src/lens-review.ts";

function lensResult(
  lens: "SECURITY" | "ERROR_HANDLING" | "TYPE_SAFETY" | "PERFORMANCE" | "ARCHITECTURE" | "SIMPLICITY",
  opts: { ok: boolean; attempts: number; blocked: boolean; findings?: typeof mk extends (...a: never[]) => infer F ? F[] : never },
): LensRunResult {
  return {
    lens,
    ok: opts.ok,
    ms: 1000,
    findings: opts.findings ?? [],
    attempts: opts.attempts,
    blocked: opts.blocked,
  };
}

// 15. Verdict precedence: any blocked lens → REVIEW_INCOMPLETE (even with no
//     findings on the lenses that did complete).
{
  const lenses: LensRunResult[] = [
    lensResult("SECURITY", { ok: false, attempts: 4, blocked: true }),
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
    lensResult("TYPE_SAFETY", { ok: true, attempts: 1, blocked: false }),
    lensResult("PERFORMANCE", { ok: true, attempts: 1, blocked: false }),
    lensResult("ARCHITECTURE", { ok: true, attempts: 1, blocked: false }),
    lensResult("SIMPLICITY", { ok: true, attempts: 1, blocked: false }),
  ];
  assert(
    computeVerdict([], lenses) === "REVIEW_INCOMPLETE",
    "blocked lens with no findings → REVIEW_INCOMPLETE",
  );
}

// 16. Verdict precedence: blocked beats CRITICAL — we won't claim CRITICAL
//     when a lens didn't actually run; the review is incomplete first.
{
  const lenses: LensRunResult[] = [
    lensResult("ERROR_HANDLING", { ok: false, attempts: 4, blocked: true }),
    lensResult("SECURITY", { ok: true, attempts: 1, blocked: false }),
  ];
  const findings = [mk("SECURITY", "CRITICAL", "a.ts", 1, "RCE")];
  assert(
    computeVerdict(findings, lenses) === "REVIEW_INCOMPLETE",
    "blocked lens preempts CRITICAL verdict (review is incomplete first)",
  );
}

// 17. Verdict precedence: all lenses complete + CRITICAL → CRITICAL_ISSUES_FOUND.
{
  const lenses: LensRunResult[] = [
    lensResult("SECURITY", { ok: true, attempts: 1, blocked: false }),
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
  ];
  const findings = [mk("SECURITY", "CRITICAL", "a.ts", 1, "RCE")];
  assert(
    computeVerdict(findings, lenses) === "CRITICAL_ISSUES_FOUND",
    "no blocked + CRITICAL → CRITICAL_ISSUES_FOUND (pre-#3 behaviour preserved)",
  );
}

// 18. Verdict precedence: succeeded-with-retries does NOT block. Retries are
//     informational; the lens did complete and contribute findings.
{
  const lenses: LensRunResult[] = [
    lensResult("SECURITY", { ok: true, attempts: 3, blocked: false }), // succeeded on retry
    lensResult("ERROR_HANDLING", { ok: true, attempts: 1, blocked: false }),
  ];
  assert(
    computeVerdict([], lenses) === "APPROVED",
    "successful retries don't trigger REVIEW_INCOMPLETE — only blocked=true does",
  );
}

// 19. Backwards compat: computeVerdict still works without the lensResults arg.
//     Pre-#3 callers (and pure verdict-from-findings tests) keep working.
{
  assert(
    computeVerdict([mk("SECURITY", "CRITICAL", "a.ts", 1, "x")]) === "CRITICAL_ISSUES_FOUND",
    "computeVerdict(findings) without lensResults still resolves CRITICAL",
  );
  assert(
    computeVerdict([], undefined) === "APPROVED",
    "computeVerdict(findings, undefined) explicit-undefined → APPROVED",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
