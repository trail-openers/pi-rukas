#!/usr/bin/env bun
/**
 * The doctrine must not PRESCRIBE a conventional-commit header (or PR title)
 * with an issue number in the scope position — the `feat(#123): description`
 * shape.
 *
 * Issue #508. Under squash-merge the PR title becomes the commit subject, and
 * the ops role's doctrine prescribed the numeric-scope form for PR titles.
 * The number in the scope position is non-standard and decorative — linkage
 * already flows through `Closes #N` in the PR body and the branch slug, and
 * no pi-ensemble parser reads it. Downstream changelog tooling can mangle
 * the form; that is motivation, not the claim this gate rests on.
 *
 * ## The predicate
 *
 * A conventional-commit type immediately followed by `(` and a `#`,
 * tolerating markdown list/table/quote prefixes and inline-code backticks
 * before the type. Alphabetic subsystem scopes (`fix(spawn):`,
 * `feat(work):`) are clean by construction — the character class before the
 * `(` must contain a `#`, and alphabetic scopes do not.
 *
 * Anchoring on the type prefix is what keeps bare prose citations (e.g.
 * `pre-#200` in `docs/troubleshooting.md`) from matching: a bare `(#N)`
 * anywhere in prose is out of scope by construction, not by exemption list.
 *
 * ## Negation exemption
 *
 * The fix itself teaches the rule: doctrine now carries explicit warnings
 * against the numeric-scope form. A warning that cites the bad form
 * concretely ("NEVER use `feat(#123):`") must not trip its own gate. A line
 * is therefore exempt when it is negated — when a negation token (never /
 * avoid / do not / don't / not / no / ❌, case-insensitive) occurs in the
 * same line before the pattern. The exemption is positional, not global:
 * a line that cites the bad form first and only later says "use this
 * instead" is still a prescription and still fails.
 *
 * This is the amendment to the parked cycle: the first revision's raw
 * predicate matched the very warning lines the fix added.
 *
 * ## What is scanned, and why
 *
 * Scanned: `modules/**`, `agents-base/**`, `pi-prompts/**`, `docs/**`, plus
 * `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `install.sh`, `bin/pi-ensemble`.
 *
 * NOT scanned: `extension/**`. Historical hits live there (comments
 * describing a past incident, inert parser input in a test fixture).
 * Excluding the directory is preferred to a per-line exemption list — an
 * exemption list rots as the files around it move.
 *
 * Sources only, not `dist/prompts/standard/`: `dist/` is gitignored and
 * absent on a clean checkout, and the assembled prompt is a mechanical
 * composition of `modules/` + `agents-base/`, which are scanned.
 *
 * ## Two-directional assertion
 *
 * The gate asserts the scanned set is clean AND that hard-coded canaries
 * behave: a positive fixture (the form used as a prescription) must be
 * caught, and a negative fixture (the actual warning line the fix added)
 * must not. A gate never observed to fail is worthless.
 *
 * This test is offline — no binary needed — so it runs in the ordinary CI
 * loop and cannot regress silently.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// A conventional-commit type immediately followed by `(` and a `#`. The
// lookbehind tolerates markdown list/table/quote prefixes and inline-code
// backticks before the type without consuming them, so the match itself
// starts exactly at the type — a clean boundary for the negation check.
const PREDICATE =
  /(?<![^\s\-*>|`"'])\b(feat|fix|chore|docs|test|refactor|perf|ci|build|style|revert)!?\(\s*#/;

// A negation marker occurring BEFORE the pattern in the same line turns a
// citation into a prohibition. Matched case-insensitively against the raw
// line; the `❌` bullet is the doctrine's own prohibition marker.
const NEGATION =
  /never|don'?t|do\s+not|avoid|must\s+not|should\s+not|prohibit|forbid|don't|❌|\bn[o]\b|\bnot\b/i;

/** True if the line prescribes (rather than prohibits) the numeric scope form. */
function isPrescription(line: string): boolean {
  if (!PREDICATE.test(line)) return false;
  const match = PREDICATE.exec(line);
  const prefixEnd = match ? match.index + match[0].length : 0;
  return !NEGATION.test(line.slice(0, prefixEnd));
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = [
  ...["modules", "agents-base", "pi-prompts", "docs"].flatMap((d) => walk(path.join(ROOT, d))),
  ...["AGENTS.md", "README.md", "CONTRIBUTING.md", "install.sh", "bin/pi-ensemble"]
    .map((f) => path.join(ROOT, f))
    .filter((f) => existsSync(f)),
];

assert(files.length > 10, `the scan covers the doctrine set (${files.length} files)`);

// ------------------------------------------------- direction 1: the set is clean

{
  const hits: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((text, i) => {
      if (isPrescription(text)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert(
    hits.length === 0,
    `no doctrine line prescribes an issue number in the scope position${
      hits.length ? ` — ${hits.join(", ")}` : ""
    }`,
  );
}

// ------------------------------------- direction 2: the positive canaries bite

// Not vacuous: the exact forms the doctrine used to prescribe must still be
// recognised as bad, including under the markdown prefixes they appeared under.
{
  const knownBad = [
    "feat(#123): description",
    "- feat(#123): description",
    "- Include issue number in all commits: `feat(#123): description`",
    "Use this commit format: feat(#123): description",
    'git commit -m "feat(#N): description"',
    "| `feat(#123): description` |",
  ];
  for (const bad of knownBad) {
    assert(isPrescription(bad), `canary: ${JSON.stringify(bad)} IS caught`);
  }
}

// ------------------------------ direction 3: the negative fixtures are exempt

// The fixed doctrine teaches the rule by warning against the pattern. Those
// warning lines must not trip the gate — including the real line from
// modules/workflows/github-issues.md, cited here verbatim.
{
  const knownGood = [
    "- NEVER put the issue number in the scope position — issue linkage flows through the PR body and the branch slug.",
    "- Commit subjects use an alphabetic subsystem scope (`feat(work): description`); NEVER put the issue number in the scope position — linkage flows through the PR body and the branch slug",
    "Never use `feat(#123):` — that puts the issue number in the scope position.",
    "- ❌ `feat(#123): description` — issue numbers go in the PR body, not the scope",
    "Do not write `fix(#475):` subjects; use `fix(spawn):` instead.",
    // Forms that never carried the pattern — the clean prescriptions:
    "fix(spawn): close stdin to prevent hang on macOS",
    "feat(work): add per-lens retry on parse failure",
    "fix: description",
    "feat!(work): replace max with env",
    "pre-#200 and friends",
    "Closes #123 in the PR body",
  ];
  for (const good of knownGood) {
    assert(!isPrescription(good), `...and ${JSON.stringify(good)} is NOT caught`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
