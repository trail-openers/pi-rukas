#!/usr/bin/env bun
/**
 * #1029 — the residual-oo gate.
 *
 * After the `oo` command wrapper is retired, no file in the repo may still
 * PRESCRIBE or DEPEND on it: not the allowlist (agents.json), not the install
 * machinery (build.sh, install.sh, install-preflight.sh, the sandbox image),
 * not the operator docs (README, CONTRIBUTING, AGENTS.md, troubleshooting),
 * not the role/agent/workflow prompts (agents-base, modules, pi-prompts), and
 * not the extension source. A naive `/oo/` substring scan is wrong (it matches
 * "too", "loop", "root", "group", "foo", …); this gate uses word boundaries so
 * only the standalone token `oo` — used as a command prefix or a named
 * mechanism — is flagged.
 *
 * Patterns flagged (any match = failure, unless the file is in the exemption
 * list below):
 *
 *   - `oo` followed by a known runner subcommand:
 *       oo (git|gh|glab|npm|cargo|bun|pnpm|yarn|pytest|go|uv|npx|ruff|
 *          recall|help|patterns|learn|forget|init|version)
 *   - `"oo `  (an allowlist/JSON key that begins `oo `)
 *   - `double-o` (the cargo package name of the retired binary)
 *   - `MIN_OO`, `oo_preflight`, `oo-rewrite`, `oo-command-runner`, `OO_BIN`,
 *     `OO_VER_OVERRIDE` (the install/version/guard/module symbols this ticket
 *     deletes)
 *
 * Exemptions (the ONLY allowed residual mentions). These are files that must
 * NAME the removed mechanism in order to ASSERT IT IS GONE — a negative gate.
 * Three forms, all asserted non-stale below: SENTRY files (a whole file
 * marked with a sentinel comment), LINE-ANCHORED files (only lines containing
 * an exact anchor are skipped), and PATH-EXEMPTED data files (JSON fixtures
 * that cannot hold a comment, exempted by path with a recorded reason).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The word-boundary prescription/dependence patterns. Each is anchored on a
// non-word char before `oo` (or the symbol's own prefix) so `too`/`loop`/
// `group`/`foo` never match. The runner list matches the allowlist + the
// oo-binary subcommands this ticket deletes.
const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: "oo <runner>",
    re:
      /(?<![\w-])oo\s+(?:git|gh|glab|npm|cargo|bun|pnpm|yarn|pytest|go|uv|npx|ruff|recall|help|patterns|learn|forget|init|version)\b/g,
  },
  // The standalone token: `too`/`loop`/`group`/`foo` never match (lookarounds
  // on both sides); backtick-wrapped mentions ("`oo` prefix") and bare prose
  // mentions ("oo is retired") are caught. The runner pattern owns `oo <runner>`;
  // this catches everything else that names the binary.
  { name: "oo (standalone)", re: /(?<![\w-])oo(?![\w-])/g },
  { name: '"oo ', re: /"oo /g },
  { name: "double-o", re: /(?<![\w-])double-o(?![\w-])/g },
  { name: "MIN_OO", re: /MIN_OO/g },
  { name: "oo_preflight", re: /oo_preflight/g },
  { name: "oo-rewrite", re: /oo-rewrite/g },
  { name: "oo-command-runner", re: /oo-command-runner/g },
  { name: "OO_BIN", re: /OO_BIN/g },
  { name: "OO_VER_OVERRIDE", re: /OO_VER_OVERRIDE/g },
];

// Directories / files in the acceptance scope. Relative to ROOT.
const SCAN_ROOTS = [
  "agents.json",
  "build.sh",
  "install.sh",
  "install-preflight.sh",
  ".devcontainer/Dockerfile",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "modules",
  "agents-base",
  "pi-prompts",
  "docs",
  "extension/src",
  "extension/smoke-tests",
];

// Never scan CHANGELOG.md (explicitly out of scope for the retirement), and
// never scan this test file itself (it must be able to name the patterns).
const NEVER_SCAN = new Set([path.join("docs", "CHANGELOG.md"), "CHANGELOG.md"]);
const SELF = path.join("extension", "smoke-tests", "test-oo-residue.ts");

// Whole-file exemption marker. A test file that must name the retired
// mechanism in many places (to prove the gate catches it) carries this line
// instead of a long anchor list; the gate asserts the sentry is present in
// every file that carries it, so removing the sentry re-arms the scan rather
// than rotting silently.
const SENTRY =
  "// oo-residue:exempt — this file names the retired oo mechanism to assert its absence";

// Line-anchored exemptions: file (relative path) → exact substrings. A line
// in one of these files is skipped ONLY when it contains one of the anchors;
// any other line is scanned. Kept for files that need only one or two exempt
// lines. Each anchor is asserted to still be present below, so a stale
// exemption fails loudly.
//
//   - fixtures/issues/341.json is a VERBATIM copy of the historical GitHub
//     issue body the merge-guard tests load; it is data about a past
//     allowlist state, not a prescription, and must not be reworded.
const EXEMPT: Record<string, string[]> = {
  "extension/smoke-tests/fixtures/issues/341.json": [
    "blanket allow",
    "blanket oo gh api*",
  ],
};

// Path-exempted data files that cannot hold a comment (JSON fixtures): exempt
// the whole file by path, with the reason recorded here so the exemption is
// visible. The gate asserts each file still exists and its data is still
// there.
const EXEMPT_REASON: Record<string, { reason: string; evidence: string[] }> = {
  "extension/smoke-tests/fixtures/agents-json-removed-oo-entries.json": {
    reason:
      "frozen parity fixture: lists every removed `oo …` allow key as data about the removal; test-agents-json-no-oo.ts matches the `oo ` prefix of its entries to prove bare-coverage. JSON cannot hold a sentry comment, so it is exempted by path.",
    evidence: ['"oo '],
  },
};

function collectFiles(abs: string, rel: string): string[] {
  const st = statSync(abs);
  if (st.isDirectory()) {
    const out: string[] = [];
    for (const name of readdirSync(abs)) {
      out.push(...collectFiles(path.join(abs, name), path.join(rel, name)));
    }
    return out;
  }
  const p = rel;
  if (NEVER_SCAN.has(p) || p === SELF) return [];
  // Only text sources we care about; skip binary/lock noise.
  const ext = path.extname(p);
  if ([".lock", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bin", ".db"].includes(ext)) return [];
  return [p];
}

const allFiles: string[] = [];
for (const root of SCAN_ROOTS) {
  allFiles.push(...collectFiles(path.join(ROOT, root), root));
}

// Dedup (a file listed under a single root once is enough).
const files = Array.from(new Set(allFiles));

// Whole-file exemption: the `oo-residue:exempt` sentinel ONLY applies to files
// under extension/smoke-tests/ (where a test legitimately names the retired
// mechanism to assert its absence). The same sentinel in any other path (docs,
// source, prompts) must NOT exempt the file.
function isFileExempt(rel: string, text: string): boolean {
  return text.includes("oo-residue:exempt") && rel.startsWith("extension/smoke-tests/");
}

function scanFile(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    // An I/O failure is not a content violation — report it as such so the
    // operator does not chase a phantom `oo` prescription.
    return [`${rel}: could not be read (I/O error)`];
  }
  const lines = text.split("\n");
  const violations: string[] = [];
  const lineAnchors = EXEMPT[rel] ?? [];
  const pathExempt = rel in EXEMPT_REASON;
  const fileExempt = isFileExempt(rel, text);
  const lineIsExempt = (line: string) =>
    line.includes("oo-residue:exempt") || lineAnchors.some((s) => line.includes(s));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fileExempt || pathExempt || lineIsExempt(line)) continue;
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        violations.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
        break; // one violation per line is enough
      }
    }
  }
  return violations;
}

const allViolations: string[] = [];
let ioErrors = 0;
for (const rel of files) {
  for (const v of scanFile(rel)) {
    if (v.endsWith("could not be read (I/O error)")) ioErrors++;
    allViolations.push(v);
  }
}

assert(
  allViolations.length === 0,
  `no file prescribes or depends on the retired oo mechanism (${allViolations.length} hit(s) across ${files.length} files)`,
);
if (allViolations.length) {
  console.error(allViolations.join("\n"));
}
if (ioErrors > 0) {
  console.error(`  ${ioErrors} file(s) could not be read — these are I/O errors, not content violations`);
}

// Assert the exemptions are not stale.
//
// Line-anchored: every anchor must still be present in its file. A missing
// anchor means the negative gate was rewritten away and the exemption is now
// covering nothing.
for (const [rel, subs] of Object.entries(EXEMPT)) {
  const abs = path.join(ROOT, rel);
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    assert(false, `exemption file could not be read (I/O error): ${rel}`);
    continue;
  }
  for (const s of subs) {
    assert(text.includes(s), `exemption anchor still present in ${rel}: ${JSON.stringify(s)}`);
  }
}
// Sentry files: every file that carries the `oo-residue:exempt` marker must
// carry the full sentry line intact. Removing the sentry from a file re-arms
// the scan (its residual mentions become violations again) — that is the
// intended behaviour, so the sentry itself is asserted here.
{
  const sentryFiles: string[] = [];
  for (const rel of files) {
    let text = "";
    try {
      text = readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    if (text.includes("oo-residue:exempt")) sentryFiles.push(rel);
  }
  for (const rel of sentryFiles) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    assert(text.includes(SENTRY), `sentry line intact in ${rel}`);
  }
  assert(
    sentryFiles.length > 0,
    `at least one sentry-exempt file exists (found ${sentryFiles.length})`,
  );
}
// Canary: the `oo-residue:exempt` sentinel is scoped to extension/smoke-tests/.
// The same marker in a file outside that directory must NOT exempt it — the
// file is still scanned and its residual `oo` mentions are still reported.
{
  const violations = scanText("docs/x.md", `\n${"oo-residue:exempt"}\nRun the suite with \`oo cargo test\`.\n`);
  assert(
    violations.length > 0,
    `canary: the sentinel in a non-smoke-test path (docs/x.md) does NOT exempt the file (got ${violations.length} hit(s))`,
  );
  const exemptViolations = scanText(
    "extension/smoke-tests/other-test.ts",
    `\n${SENTRY}\nRun the suite with \`oo cargo test\`.\n`,
  );
  assert(
    exemptViolations.length === 0,
    "canary: the sentinel in a smoke-test path DOES exempt the file",
  );
}

// Path-exempted data files must exist and still carry their evidence data.
for (const [rel, { reason, evidence }] of Object.entries(EXEMPT_REASON)) {
  let text = "";
  try {
    text = readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    assert(false, `path-exempt file could not be read (I/O error): ${rel} (${reason})`);
    continue;
  }
  for (const s of evidence) {
    assert(text.includes(s), `path-exempt evidence still present in ${rel}: ${JSON.stringify(s)}`);
  }
}

// Shared line-by-line scan over in-memory text (same pattern set as
// scanFile, no exemptions except the whole-file sentinel). Lets canaries
// exercise the scan without touching the filesystem.
function scanText(rel: string, text: string): string[] {
  const lines = text.split("\n");
  const violations: string[] = [];
  const fileExempt = isFileExempt(rel, text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fileExempt) continue;
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        violations.push(`${rel}:${i + 1} [${name}] ${line.trim().slice(0, 120)}`);
        break; // one violation per line is enough
      }
    }
  }
  return violations;
}

// Canary: an in-memory line that prescribes oo MUST be flagged. One helper
// is shared by every canary so a canary cannot drift onto a different pattern
// set than the scan itself.
function anyPatternMatches(line: string): boolean {
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(line)) return true;
  }
  return false;
}
{
  assert(
    anyPatternMatches("Run the suite with `oo cargo test` to keep the report short."),
    "canary: a prescriptive `oo cargo test` line IS flagged",
  );
  assert(
    !anyPatternMatches("Run the suite with `git log` to see the recent commits."),
    "canary: a bare `git log` line is NOT flagged (word boundary holds)",
  );

  // Standalone-token canary: a prose mention of the `oo` binary (no runner)
  // must be caught — the SAME regex object the scan uses, so the canary and
  // the scan cannot diverge.
  const standalone = PATTERNS.find((p) => p.name === "oo (standalone)")!;
  standalone.re.lastIndex = 0;
  assert(
    standalone.re.test("`oo` is gone"),
    "canary: the standalone pattern itself flags a backticked `oo`",
  );
  standalone.re.lastIndex = 0;
  assert(
    standalone.re.test("The `oo` prefix is retired; run the runner bare."),
    "canary: a standalone `oo` prose mention IS flagged",
  );
  standalone.re.lastIndex = 0;
  assert(
    !standalone.re.test("too many loops in the group"),
    "canary: the standalone pattern does NOT flag too/loop/group",
  );

  // Standalone-token negative: `too` / `loop` / `foo` are NOT flagged.
  for (const word of ["too", "loop", "foo", "group"]) {
    assert(!anyPatternMatches(word), `canary: '${word}' is NOT flagged (lookarounds hold)`);
  }
}

console.log(exit === 0 ? "\nAll oo-residue checks passed." : "\nFAILED");
process.exit(exit);
