#!/usr/bin/env bun
/**
 * Lean size cap — the total size of `extension/src/lean/` must stay under one
 * hard ceiling.
 *
 * The per-file 500-line gate (`test-file-size-limit.ts`) measures each file on
 * its own, so a directory can grow without bound by adding files: lean passed
 * 20,000 lines across 95 flat `.ts` files without a single file breaching its
 * cap. Nothing anywhere measured the directory total, so the size of the lean
 * engine was nobody's number.
 *
 * **One number: a 25,000-line hard cap, checked against the literal in this
 * file.** The ceiling for the tree as a whole is an operator decision, so the
 * gate does not read it from a file the same PR could edit. Growth below the cap
 * is policed by review, not by a committed budget a PR has to raise: a budget
 * turns every legitimate addition into an operator-merged `.pi/` change, which is
 * a gate on the merge rather than on the code. The run prints the total and the
 * headroom to the cap, so the number stays visible in the log of every PR.
 *
 * **Fails closed.** A tree that cannot be counted — missing or unreadable — is a
 * gate failure, never a total of zero, because counting an unmeasured tree as
 * empty is how a size gate begins reporting a confident wrong answer.
 *
 * **No environment escape hatch, deliberately.** The per-file ratchet and the
 * README ratchet both honour a `PI_ENSEMBLE_*=0` skip; a cap the agent under
 * review can switch off is not a cap.
 *
 * **Proven in both directions.** The cap boundary is pinned on each side and the
 * failing arm is shown red on a deliberate fixture input. A gate never observed
 * to fail is worthless.
 */

import {
  type Dirent,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The operator's ceiling for the whole directory, held as a literal. */
const HARD_CAP = 25_000;
/** The directory under the cap: every `.ts` file at any depth. */
const LEAN_DIR = path.join("src", "lean");

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "extension");

/**
 * Count newlines — a trailing-newline-terminated file of N lines has N newline
 * characters, matching `wc -l`. Identical to `lineCount()` in
 * test-file-size-limit.ts, duplicated rather than imported for the same reason
 * test-readme-size.ts duplicates it: that gate is not a library, and importing
 * a test from a test makes each the other's failure mode.
 */
function lineCount(file: string): number {
  const text = readFileSync(file, "utf8");
  return (text.match(/\n/g) ?? []).length;
}

/**
 * A counting failure: the tree could not be measured, so no verdict is honest.
 * The real tree always has `src/lean`, so an unreadable one is a broken gate,
 * and counting it as 0 would pass an unmeasured tree.
 */
export class LeanCountError extends Error {}

/**
 * Total lines across every `.ts` file under `root`/src/lean, at any depth — a
 * subdirectory is still lean code, so it must count. Symlinked directories are
 * never followed: a link out of the tree would pull in files that are not lean
 * (or loop). A directory or file that cannot be read is a gate failure, not a
 * zero.
 */
function leanTotal(root: string): { total: number; files: number } {
  let total = 0;
  let files = 0;
  const fail = (target: string, err: unknown) =>
    new LeanCountError(`${target} is not readable: ${(err as { code?: string }).code ?? err}`);
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw fail(dir, err);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        try {
          total += lineCount(full);
        } catch (err) {
          throw fail(full, err);
        }
        files++;
      }
    }
  };
  walk(path.join(root, LEAN_DIR));
  return { total, files };
}

/** The cap violation, or null when the tree fits. */
export function checkLeanLines(total: number, cap = HARD_CAP): string | null {
  if (total <= cap) return null;
  return `extension/src/lean is ${total} lines, over the ${cap}-line hard cap by ${total - cap} — the cap is the operator's ceiling and no gate file lifts it: delete code instead`;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------- the cap boundary, both sides

{
  assert(checkLeanLines(HARD_CAP) === null, `exactly the ${HARD_CAP}-line cap passes (green)`);
  const mutant = checkLeanLines(HARD_CAP + 1);
  assert(mutant !== null, `canary: ${HARD_CAP + 1} lines IS over the cap`);
  assert(
    (mutant ?? "").includes("no gate file lifts it"),
    "the over-cap message says nothing lifts the cap",
  );
  assert((mutant ?? "").includes("delete code"), "the over-cap message names deletion as the fix");
  if (mutant) console.log(`    ${mutant}`);
}

// ---------------------------------------------- the counting rule, on a fixture

{
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-ens-leancap-"));
  try {
    // The rule under test: 10 + 5 + a file with no trailing newline (2 newlines
    // = `wc -l` semantics) + a nested file = 117. The `.md` files never count.
    const lean = path.join(fixture, LEAN_DIR);
    mkdirSync(lean, { recursive: true });
    writeFileSync(path.join(lean, "a.ts"), "x\n".repeat(10));
    writeFileSync(path.join(lean, "b.ts"), "x\n".repeat(5));
    writeFileSync(path.join(lean, "c.ts"), "x\nx\nx"); // no trailing newline
    writeFileSync(path.join(lean, "notes.md"), "x\n".repeat(100)); // not .ts
    const nested = path.join(lean, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "d.ts"), "x\n".repeat(100)); // nested .ts COUNTS
    writeFileSync(path.join(nested, "notes.md"), "x\n".repeat(100)); // nested, still not .ts
    const got = leanTotal(fixture);
    assert(
      got.total === 117 && got.files === 4,
      `canary: the counter recurses and sums .ts files with wc -l semantics, .md excluded (got ${got.total} lines over ${got.files} files, want 117 over 4)`,
    );
    // The same counter measured against a fixture cap it does exceed, so the
    // over-cap arm is shown red on a fixture input and not only on the real tree.
    const over = checkLeanLines(got.total, 10);
    assert(
      over !== null && over.includes("over the 10-line hard cap by 107"),
      `canary: the same fixture, sized over a fixture cap, IS flagged red (${over ?? "not flagged"})`,
    );
    assert(
      checkLeanLines(got.total, 117) === null,
      "canary: the same fixture exactly at a fixture cap is green",
    );
    // The two ways the tree becomes unmeasurable, each of which must throw
    // rather than return a total of 0. A missing directory is one; a directory
    // the process cannot read is the other, and root ignores mode 000 so that
    // arm is only observable as a non-root uid.
    const missing = mkdtempSync(path.join(tmpdir(), "pi-ens-leanmissing-"));
    let missingErr = "";
    try {
      leanTotal(missing);
    } catch (err) {
      missingErr = err instanceof LeanCountError ? err.message : `non-gate throw: ${err}`;
    }
    rmSync(missing, { recursive: true, force: true });
    assert(
      missingErr.includes("is not readable") && missingErr.includes("ENOENT"),
      `canary: a missing lean directory THROWS instead of counting as 0 (${missingErr || "no throw"})`,
    );
    const unreadableDir = path.join(fixture, "blocked");
    mkdirSync(path.join(unreadableDir, LEAN_DIR), { recursive: true });
    let dirErr = "";
    const canMakeUnreadable = process.getuid !== undefined && process.getuid() !== 0;
    if (canMakeUnreadable) chmodSync(path.join(unreadableDir, LEAN_DIR), 0o000);
    try {
      leanTotal(unreadableDir);
    } catch (err) {
      dirErr = err instanceof LeanCountError ? err.message : `non-gate throw: ${err}`;
    }
    if (canMakeUnreadable) chmodSync(path.join(unreadableDir, LEAN_DIR), 0o755);
    assert(
      dirErr.includes("is not readable"),
      `canary: an unreadable lean directory THROWS instead of counting as 0 (${canMakeUnreadable ? dirErr || "no throw" : "not observable as root"})`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

// ---------------------------------------------- the real tree, against the cap

{
  let counted: { total: number; files: number } | null = null;
  try {
    counted = leanTotal(EXTENSION_ROOT);
  } catch (err) {
    assert(
      false,
      `cannot measure extension/src/lean — the gate cannot pass an unmeasured tree: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (counted !== null) {
    const { total, files } = counted;
    const violation = checkLeanLines(total);
    assert(
      violation === null,
      violation ?? `extension/src/lean is ${total} lines over ${files} files (cap ${HARD_CAP})`,
    );
    // The headroom before the cap, printed on every run so the number to watch
    // is known before a PR trips it.
    console.log(`  total ${total} lines, ${HARD_CAP - total} lines of headroom to the cap`);
  }
}

console.log(exit === 0 ? "\nAll lean-size-cap checks passed." : "\nFAILED");
process.exit(exit);
