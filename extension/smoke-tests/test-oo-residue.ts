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
 * Exemption list (the ONLY allowed residual mentions). These are files that
 * must NAME the removed mechanism in order to ASSERT IT IS GONE — a negative
 * gate. Each entry is keyed by file + exact substring and is asserted to still
 * be present, so a stale exemption (the anchor line is rewritten away) fails
 * the gate rather than rotting silently.
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

// The allowed residuals: file (relative path) → exact substring that MUST
// still be present on an exempt line. A line in an exempt file is skipped
// ONLY when it contains one of the file's exempt substrings; any line
// without a matching anchor is still scanned. Each anchor is asserted to
// still be present at the bottom, so a stale exemption fails loudly.
//
//   - the parity fixture (test-agents-json-no-oo.ts) lists every removed
//     `oo …` allow key as data about the removal — it must name the token
//     to prove bare-coverage; the test file's canaries inject an `oo` key
//     and match the `oo ` prefix of the fixture entries.
//   - test-built-prompts.ts carries the doc-sweep that asserts no prompt
//     still prescribes `oo <runner>`; its canary fixture + regex-comment
//     lines + the `oo-command-runner` negative assertion must name the token.
//   - fixtures/issues/341.json is a VERBATIM copy of the historical GitHub
//     issue body the merge-guard tests load; it is data about a past
//     allowlist state, not a prescription, and must not be reworded.
const EXEMPT: Record<string, string[]> = {
  "extension/smoke-tests/fixtures/agents-json-removed-oo-entries.json": [
    '"oo ',
  ],
  "extension/smoke-tests/test-agents-json-no-oo.ts": [
    "oo git log *",
    'startsWith("oo ")',
    "drop \"oo \"",
    "`oo` retirement",
    "`oo X …` entry",
    "an `oo` entry with no bare",
    "`oo <subcommand>`",
    "fake `oo` key",
    "retired `oo` binary",
    "a fake `oo` key",
    "removed-oo-entries.json",
    "begins with `oo `",
    "`oo` prefix is gone",
    "begin with `oo ` (word",
    "OO_PREFIX_RE",
    "zero bash keys begin",
    "removed `oo` entry",
    "the fixture is non-trivial",
    "166 removed oo-prefixed",
    "every listed entry is `oo …`",
    "keeps a bare equivalent",
  ],
  "extension/smoke-tests/test-built-prompts.ts": [
    "oo cargo test",
    "oo bun test",
    "oo-command-runner",
    'command-prefix wrapper: "oo git"',
    '"oo npm", "oo bun"',
    '`oo`-prefixed',
    "`oo` prefix",
    "prescriptive `oo`-prefixed",
    "prescriptive `oo`-prefix",
    "`oo` used as a command-prefix",
    "no oo command-prefix",
    "still prescribe oo command prefix",
    "oo sweep canary",
    "oo-prefix",
    "oo\\s+",
  ],
  "extension/smoke-tests/fixtures/issues/341.json": [
    "blanket allow",
    "blanket oo gh api*",
  ],
  "extension/smoke-tests/test-permission-guard.ts": ["oo-wrapped"],
  "extension/smoke-tests/test-do-prompt.ts": [
    "vipune, oo, cd",
    "no `oo` — retired",
  ],
  "extension/smoke-tests/test-preflight-forge-loop.ts": [
    "contains the oo entry",
    "no `oo` — retired",
  ],
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

// Build a "is this line exempt" predicate per file. A line is exempt only if it
// contains one of the file's exempt substrings AND (for the fixture) the whole
// file is in EXEMPT_FILES.
function isExemptFile(rel: string): boolean {
  return rel in EXEMPT;
}

function scanFile(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return [`${rel}: unreadable`];
  }
  const lines = text.split("\n");
  const violations: string[] = [];
  const fileExempt = isExemptFile(rel);
  const exemptSubs = EXEMPT[rel] ?? [];
  const lineIsExempt = (line: string) =>
    exemptSubs.length > 0 && exemptSubs.some((s) => line.includes(s));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fileExempt && lineIsExempt(line)) continue;
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
for (const rel of files) {
  allViolations.push(...scanFile(rel));
}

assert(
  allViolations.length === 0,
  `no file prescribes or depends on the retired oo mechanism (${allViolations.length} hit(s) across ${files.length} files)`,
);
if (allViolations.length) {
  console.error(allViolations.join("\n"));
}

// Assert the exemptions are not stale: every exempt substring must still be
// present in its file. A missing anchor means the negative gate was rewritten
// away and the exemption is now covering nothing.
for (const [rel, subs] of Object.entries(EXEMPT)) {
  const abs = path.join(ROOT, rel);
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    assert(false, `exemption file missing: ${rel}`);
    continue;
  }
  for (const s of subs) {
    assert(text.includes(s), `exemption anchor still present in ${rel}: ${JSON.stringify(s)}`);
  }
}
// The parity fixture must exist and be non-empty (it is what test-agents-json
// -no-oo.ts proves bare-coverage against).
{
  const fp = path.join(ROOT, "extension", "smoke-tests", "fixtures", "agents-json-removed-oo-entries.json");
  let ok = false;
  try {
    const t = readFileSync(fp, "utf8");
    ok = t.trim().length > 2 && t.includes('"oo ');
  } catch {
    ok = false;
  }
  assert(ok, "exemption: the parity fixture lists removed `oo` entries");
}

// Canary: an in-memory line that prescribes oo MUST be flagged.
{
  const canary = 'Run the suite with `oo cargo test` to keep the report short.';
  let hit = false;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(canary)) {
      hit = true;
      break;
    }
  }
  assert(hit, "canary: a prescriptive `oo cargo test` line IS flagged");

  const canary2 = 'Run the suite with `git log` to see the recent commits.';
  let hit2 = false;
  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(canary2)) {
      hit2 = true;
      break;
    }
  }
  assert(!hit2, "canary: a bare `git log` line is NOT flagged (word boundary holds)");

  // Standalone-token canary: a prose mention of the `oo` binary (no runner)
  // must be caught by the standalone pattern.
  const canary3 = "The `oo` prefix is retired; run the runner bare.";
  const standRe = /(?<![\w-])oo(?![\w-])/g;
  standRe.lastIndex = 0;
  assert(
    standRe.test(canary3),
    "canary: a standalone `oo` prose mention IS flagged",
  );

  // Standalone-token negative: `too` / `loop` / `foo` are NOT flagged.
  for (const word of ["too", "loop", "foo", "group"]) {
    const re = /(?<![\w-])oo(?![\w-])/g;
    re.lastIndex = 0;
    assert(!re.test(word), `canary: '${word}' is NOT flagged (lookarounds hold)`);
  }
}

console.log(exit === 0 ? "\nAll oo-residue checks passed." : "\nFAILED");
process.exit(exit);
