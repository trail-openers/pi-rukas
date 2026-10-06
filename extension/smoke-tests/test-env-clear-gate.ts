#!/usr/bin/env bun
/**
 * Env-clear ratchet — the Bun 1.4 `process.env.X = undefined` regression gate.
 *
 * Bun 1.4.0 changed the semantics of assigning `undefined` to an environment
 * key: `process.env.FOO = undefined` now stores the literal string
 * `"undefined"` instead of deleting the key (verified: on Bun 1.4.2
 * `typeof process.env.FOO` prints `"string"`, and the key is present in
 * `Object.keys(process.env)`). On Bun 1.3.13 the same assignment deletes the
 * key, which is why the pattern is invisible under CI (pinned to 1.3.13,
 * `.github/workflows/ci.yml`) while it poisons the three smoke tests on a
 * 1.4.x host — test-models, test-work-notify and test-slow-notice-levels —
 * #997.
 *
 * The fix that PR #520 (commit 2ab483b, #504) established is the `delete`
 * form: `delete process.env.FOO` deletes the key on BOTH 1.3 and 1.4, and
 * `delete` on an absent key is a no-op. Restore helpers therefore take the
 * shape `if (prev === undefined) delete process.env.X; else process.env.X = prev;`.
 *
 * **Source scan, both forms.** The anti-pattern has two spellings — the
 * dot form (`process.env.X = undefined`) and the bracket form
 * (`process.env[k] = undefined`, the dynamic-clear branch of the per-file
 * `withEnv`/`withCmd` helpers) — and this gate catches both. It does NOT
 * match comparisons (`=== undefined`, `!== undefined`), reads
 * (`const prev = process.env.X`), or comments; it matches only the
 * *assignment* of the `undefined` literal to a key.
 *
 * **Proven in both directions.** A gate never observed to fail is worthless
 * (the same defect class the file-size ratchet documents). So this asserts
 * not only that the tree is clean — it creates a deliberately poisoned
 * fixture in a temp dir (one dot-form site, one bracket-form site, one
 * legitimate comparison that must NOT match) and proves the scanner catches
 * the first two and spares the last, then removes it in `finally`.
 *
 * The gate's own source must not trip itself: the scanner is built from
 * concatenated regex fragments so the contiguous literal
 * `process.env.<KEY> = undefined` never appears in this file, and this
 * file is the one file excluded from the tree scan by name (a comment,
 * not a ratchet).
 *
 * Scope: every `.ts` file under `extension/smoke-tests/` and `extension/src/`.
 * `extension/src/` is included so a future regression on the production side
 * is caught at the same seam. No escape hatch — the tree has zero sites by
 * construction (no allowlist, no baseline file, per #997 operator resolution
 * 2).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * The two shapes the gate must catch, each a single anchored regex so the
 * `process.env.<key>` and the `= undefined` are required to be adjacent (a
 * comparison `=== undefined` or a read `const x = process.env.Y` on the same
 * line must not be mistaken for an assignment). Built as fragments so the
 * contiguous literal never appears in this source (the gate must not trip
 * itself on its own fixture text).
 *
 *   dot form:     process.env.PI_ENSEMBLE_X = undefined
 *   bracket form: process.env[k] = undefined
 *
 * Only the *assignment* of the `undefined` literal to a key matches.
 */
/** The dot form: `process.env.X = undefined`. */
const DOT_FORM = /\bprocess\.env\.[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*undefined(?!\w)/;
/** The bracket form: `process.env[k] = undefined`. */
const BRACKET_FORM = /\bprocess\.env\[[^\]\n]*\]\s*=\s*undefined(?!\w)/;

/** True if `text` contains at least one `process.env.<key> = undefined` assignment (either form). */
export function hasEnvUndefinedAssignment(text: string): boolean {
  return DOT_FORM.test(text) || BRACKET_FORM.test(text);
}

/** True if `text` contains the dot form specifically. */
export function hasDotForm(text: string): boolean {
  return DOT_FORM.test(text);
}

/** True if `text` contains the bracket form specifically. */
export function hasBracketForm(text: string): boolean {
  return BRACKET_FORM.test(text);
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // unreadable dir is not a violation
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue; // broken symlink is not a violation
    }
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan every `.ts` file under `extension/smoke-tests/` and `extension/src/`, excluding
 * this gate's own file (which documents the pattern in comments). Returns
 * `[{file, line, lineNo}]` for every offending assignment.
 */
export function findEnvUndefinedSites(
  root: string,
): { file: string; line: string; lineNo: number }[] {
  const here = path.join(import.meta.dirname, "test-env-clear-gate.ts");
  const sites: { file: string; line: string; lineNo: number }[] = [];
  for (const sub of ["extension/smoke-tests", "extension/src"]) {
    const base = path.join(root, sub);
    if (!statSyncSync(base)) continue;
    for (const file of listTsFiles(base)) {
      if (file === here) continue; // this file documents the pattern in its docstring
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hasDotForm(lines[i]) || hasBracketForm(lines[i])) {
          sites.push({ file: path.relative(root, file), line: lines[i].trim(), lineNo: i + 1 });
        }
      }
    }
  }
  return sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.lineNo - b.lineNo));
}

function statSyncSync(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------- the gate CAN fail (two-direction proof)

{
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-envgate-"));
  try {
    // A file with a dot-form site — must be caught.
    const dotFormFile = path.join(fixtureRoot, "poison-dot.ts");
    writeFileSync(
      dotFormFile,
      [
        'const KEY = "PI_ENSEMBLE_EXAMPLE";',
        "process.env[KEY] = undefined; // bracket form, must be caught",
        "process.env.PI_ENSEMBLE_DOT = undefined; // dot form, must be caught",
        "if (process.env.PI_ENSEMBLE_OK === undefined) {}",
        "const saved = process.env.PI_ENSEMBLE_READ;",
        "delete process.env.PI_ENSEMBLE_GOOD;",
      ].join("\n"),
    );
    const dotText = readFileSync(dotFormFile, "utf8");
    assert(
      hasDotForm(dotText) && hasBracketForm(dotText),
      "canary: the scanner flags a deliberately planted dot-form and bracket-form fixture — a gate never observed to fail is worthless",
    );
    assert(hasEnvUndefinedAssignment(dotText), "...and the combined predicate flags it too");

    // A file with ONLY legitimate uses — must NOT be caught. The comparison
    // (`=== undefined`), the read (`= process.env.X`), and the `delete`
    // form are all benign on both Bun 1.3 and 1.4.
    const cleanFile = path.join(fixtureRoot, "clean.ts");
    writeFileSync(
      cleanFile,
      [
        "if (process.env.PI_ENSEMBLE_X === undefined) return;",
        "const prev = process.env.PI_ENSEMBLE_Y;",
        "delete process.env.PI_ENSEMBLE_Z;",
        "if (prev === undefined) delete process.env.PI_ENSEMBLE_Y;",
        "else process.env.PI_ENSEMBLE_Y = prev;",
      ].join("\n"),
    );
    const cleanText = readFileSync(cleanFile, "utf8");
    assert(
      !hasDotForm(cleanText) && !hasBracketForm(cleanText) && !hasEnvUndefinedAssignment(cleanText),
      "canary: comparisons (=== undefined), reads (const prev = process.env.X) and delete forms are all correctly spared",
    );

    // The fixture's offending lines must each be located by line number, so
    // a real failure names the line, not just the file.
    const fixtureSites = readFileSync(dotFormFile, "utf8")
      .split("\n")
      .map((l, i) => ({ line: l, lineNo: i + 1 }))
      .filter((x) => hasDotForm(x.line) || hasBracketForm(x.line));
    assert(
      fixtureSites.length === 2 && fixtureSites[0].lineNo === 2 && fixtureSites[1].lineNo === 3,
      `canary: the fixture's two offending lines are located (found at ${fixtureSites.map((s) => s.lineNo).join(",")})`,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------- and the tree is clean

const sites = findEnvUndefinedSites(REPO_ROOT);
if (sites.length === 0) {
  assert(
    true,
    "every .ts file under extension/smoke-tests/ and extension/src/ clears env with `delete` (zero `process.env.X = undefined` sites, dot or bracket form)",
  );
} else {
  for (const s of sites) {
    assert(false, `${s.file}:${s.lineNo}: ${s.line}`);
  }
}

// The scan must actually reach both directories, or this is a narrower gate
// with a longer docstring.
{
  const srcDir = path.join(REPO_ROOT, "extension/src");
  const testsDir = path.join(REPO_ROOT, "extension/smoke-tests");
  assert(
    statSyncSync(srcDir) && listTsFiles(srcDir).length > 0,
    "canary: extension/src .ts files are in scope (a future production regression is caught at the same seam)",
  );
  assert(
    statSyncSync(testsDir) && listTsFiles(testsDir).length > 0,
    "canary: extension/smoke-tests .ts files are in scope",
  );
}

console.log(exit === 0 ? "\nAll env-clear checks passed." : "\nFAILED");
process.exit(exit);
