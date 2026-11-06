#!/usr/bin/env bun
/**
 * Lean line budget — a ratchet on the total size of `extension/src/lean/`.
 *
 * The per-file 500-line gate (`test-file-size-limit.ts`) measures each file on
 * its own, so a directory can grow without bound by adding files: lean went from
 * 19,609 lines at v0.14.54 to over 20,700 across 95 flat `.ts` files without a
 * single file breaching its cap. Nothing anywhere measured the directory total,
 * so the size of the lean engine was nobody's number.
 *
 * Two committed numbers, and the gate reads them in the direction an agent
 * cannot weaken:
 *
 *   - **A 25,000-line hard cap** that no budget value can lift. The ceiling for
 *     the tree as a whole is an operator decision, so the gate checks it against
 *     the literal and not against the file the same PR could edit.
 *   - **A ratcheting budget in `.pi/lean-line-budget`**, the current size plus
 *     300 lines of slack. Growing lean past it fails and names the file to raise;
 *     shrinking it more than the slack below the budget also fails and names the
 *     file to lower. Headroom therefore cannot accumulate in either direction.
 *
 * **The budget is read from the committed tree** (`git show HEAD:.pi/lean-line-budget`),
 * never the working copy, so a change cannot raise the number it is judged
 * against by editing the file in place. A working-tree copy that differs from
 * HEAD fails with its own message rather than being silently ignored. A missing,
 * unparseable or non-positive budget FAILS — it never defaults to "no budget",
 * because a typo'd budget that means nothing is the same defect as no gate.
 *
 * **No environment escape hatch, deliberately.** The per-file ratchet and the
 * README ratchet both honour a `PI_ENSEMBLE_*=0` skip; a budget the agent under
 * review can switch off is not a budget. Only the operator moves the number, by
 * merging a `.pi/` change.
 *
 * **Proven in both directions.** Every boundary is pinned on each side (cap,
 * budget, and budget-minus-slack), and each failing arm is shown red on a
 * deliberate fixture input. A gate never observed to fail is worthless.
 */

import { execFileSync } from "node:child_process";
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

/** No budget value lifts this. The operator's ceiling for the whole directory. */
const HARD_CAP = 25_000;
/** How far below the budget lean may sit before the budget must be lowered. */
const SLACK = 300;
/** Committed gate file holding the budget, read from HEAD. */
const BUDGET_FILE = ".pi/lean-line-budget";
/** The directory under budget: every `.ts` file at any depth. */
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
 * and counting it as 0 would tell the author to lower the budget.
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

/** A budget violation: what is wrong, and the file that fixes it. */
export interface BudgetViolation {
  kind: "over-cap" | "over-budget" | "under-budget";
  total: number;
  budget: number;
  message: string;
}

/**
 * The pure ratchet: three arms, each naming its OWN remedy, so the operator is
 * never told to edit the wrong file. `budget` is the caller's parsed HEAD value,
 * which keeps every boundary testable against a fixture rather than only
 * against the real tree.
 */
export function checkLeanLines(
  total: number,
  budget: number,
  cap = HARD_CAP,
  slack = SLACK,
): BudgetViolation | null {
  if (total > cap) {
    return {
      kind: "over-cap",
      total,
      budget,
      message: `extension/src/lean is ${total} lines, over the ${cap}-line hard cap by ${total - cap} — the cap is the operator's ceiling and ${BUDGET_FILE} cannot lift it: delete code instead`,
    };
  }
  if (total > budget) {
    return {
      kind: "over-budget",
      total,
      budget,
      message: `extension/src/lean is ${total} lines, ${total - budget} over its budget of ${budget} — prefer deleting; otherwise raise ${BUDGET_FILE} (operator-merged) in this PR with the reason in the PR body`,
    };
  }
  if (total < budget - slack) {
    return {
      kind: "under-budget",
      total,
      budget,
      message:
        `extension/src/lean is ${total} lines, ${budget - total} below its budget of ${budget} ` +
        `(more than the ${slack}-line slack) — slack must not accumulate: ` +
        `lower ${BUDGET_FILE} to the current total plus ${slack}`,
    };
  }
  return null;
}

/** The committed budget: a trimmed positive integer, or an explanatory failure. */
export function parseBudget(raw: string | null): { budget: number } | { error: string } {
  if (raw === null) {
    return {
      error: `${BUDGET_FILE} is not committed at HEAD — the gate needs a number to enforce`,
    };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      error: `${BUDGET_FILE} is not a positive integer (${JSON.stringify(trimmed.slice(0, 40))})`,
    };
  }
  const budget = Number(trimmed);
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    return { error: `${BUDGET_FILE} must be a positive integer, got ${trimmed}` };
  }
  return { budget };
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------- boundaries pinned on both sides

{
  const BUDGET = 21_035; // any fixture number; the arms are relative to it
  const kind = (total: number, budget = BUDGET) => checkLeanLines(total, budget)?.kind ?? null;

  // The cap boundary needs a budget at or above it, or the budget arm answers
  // first and the assertion would be measuring the wrong arm.
  assert(kind(HARD_CAP, HARD_CAP) === null, `exactly the ${HARD_CAP}-line cap passes`);
  assert(
    kind(HARD_CAP + 1, HARD_CAP) === "over-cap",
    `canary: ${HARD_CAP + 1} lines IS over the cap — and the message names deletion, not the budget`,
  );
  assert(
    (checkLeanLines(HARD_CAP + 1, HARD_CAP + 10)?.message ?? "").includes("cannot lift it"),
    "the over-cap message says the budget cannot lift the cap (a raise would be the wrong fix)",
  );

  assert(kind(BUDGET, BUDGET) === null, "a total exactly equal to the budget passes");
  assert(kind(BUDGET + 1, BUDGET) === "over-budget", "canary: budget+1 IS flagged as over-budget");
  assert(
    (checkLeanLines(BUDGET + 1, BUDGET)?.message ?? "").includes(`raise ${BUDGET_FILE}`),
    "the over-budget message names the file to raise and who merges it",
  );
  assert(
    (checkLeanLines(BUDGET + 1, BUDGET)?.message ?? "").includes("1 over its budget"),
    "the over-budget message states the overage",
  );

  assert(
    kind(BUDGET - SLACK, BUDGET) === null,
    `budget−${SLACK} exactly passes (the slack is allowed)`,
  );
  assert(
    kind(BUDGET - SLACK - 1, BUDGET) === "under-budget",
    `canary: budget−${SLACK + 1} IS flagged as under-budget`,
  );
  assert(
    (checkLeanLines(BUDGET - SLACK - 1, BUDGET)?.message ?? "").includes(`lower ${BUDGET_FILE}`),
    "the under-budget message names the file to lower — the other arm says raise",
  );

  // The arms are ordered: far below the budget AND over the cap cannot co-occur,
  // and over-cap wins when a budget was raised past the operator's ceiling.
  assert(
    kind(HARD_CAP + 500, HARD_CAP + 500) === "over-cap",
    "a budget raised past the cap still trips the cap, not the budget",
  );

  // A budget beyond the cap is itself wrong, and the cap arm is what says so.
  assert(
    kind(0, BUDGET) === "under-budget",
    "an empty lean tree is an under-budget failure, not a pass",
  );
}

// ---------------------------------------------- budget parsing fails closed

{
  const ok1 = parseBudget("21035\n");
  const ok2 = parseBudget("  21035  ");
  assert("budget" in ok1 && ok1.budget === 21_035, "a committed budget parses");
  assert("budget" in ok2 && ok2.budget === 21_035, "surrounding whitespace is trimmed");
  assert(
    "error" in parseBudget(null),
    "canary: a missing budget FAILS rather than meaning no budget",
  );
  assert("error" in parseBudget(""), "canary: an empty budget FAILS");
  assert(
    "error" in parseBudget("0"),
    "canary: a zero budget FAILS (it would allow nothing / mean nothing)",
  );
  assert("error" in parseBudget("-1"), "canary: a negative budget FAILS");
  assert("error" in parseBudget("many"), "canary: an unparseable budget FAILS, never defaults");
  assert("error" in parseBudget("2103.5"), "canary: a non-integer budget FAILS");
}

// ---------------------------------------------- the counting rule, on a fixture

{
  const fixture = mkdtempSync(path.join(tmpdir(), "pi-ens-leanbudget-"));
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
    const violation = checkLeanLines(got.total, 10);
    assert(
      violation?.kind === "over-budget" && violation.message.includes("107 over its budget"),
      `canary: the same fixture, sized over a fixture budget, IS flagged red (${violation?.message ?? "not flagged"})`,
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

// ---------------------------------------------- each arm, red on a mutant

{
  const BUDGET = 21_035;
  const mutants: [string, number, BudgetViolation["kind"] | null, string][] = [
    ["over the hard cap", HARD_CAP + 1, "over-cap", "cannot lift it"],
    ["over the budget", BUDGET + 40, "over-budget", `raise ${BUDGET_FILE}`],
    ["below budget by slack+1", BUDGET - SLACK - 1, "under-budget", `lower ${BUDGET_FILE}`],
    ["inside the slack", BUDGET - 10, null, ""],
  ];
  for (const [name, total, wantKind, wantText] of mutants) {
    const hit = checkLeanLines(total, BUDGET);
    assert(
      (hit?.kind ?? null) === wantKind && (hit === null || hit.message.includes(wantText)),
      `mutant "${name}" at ${total} lines: ${wantKind === null ? "green" : `red as ${wantKind}, naming its own remedy`}`,
    );
    if (hit) console.log(`    ${hit.message}`);
  }
}

// ---------------------------------------------- the real tree, against the committed budget

{
  let committed: string | null = null;
  try {
    committed = execFileSync("git", ["show", `HEAD:${BUDGET_FILE}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    committed = null;
  }
  const parsed = parseBudget(committed);
  if ("error" in parsed) {
    assert(false, `${BUDGET_FILE} is readable from HEAD: ${parsed.error}`);
  } else {
    assert(true, `${BUDGET_FILE} at HEAD is ${parsed.budget}`);
    // A working-tree copy that differs from HEAD is not the number being
    // enforced, so it must be reported rather than quietly ignored.
    let working: string | null = null;
    try {
      working = readFileSync(path.join(REPO_ROOT, BUDGET_FILE), "utf8");
    } catch {
      working = null;
    }
    if (working !== null && working !== committed) {
      assert(
        false,
        `the working-tree ${BUDGET_FILE} differs from HEAD — the gate enforces HEAD's ${parsed.budget}; commit or revert the local copy`,
      );
    } else {
      assert(true, `the working-tree ${BUDGET_FILE} matches HEAD`);
    }

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
      const violation = checkLeanLines(total, parsed.budget);
      if (violation === null) {
        assert(
          true,
          `extension/src/lean is ${total} lines over ${files} files (budget ${parsed.budget}, hard cap ${HARD_CAP})`,
        );
      } else {
        assert(false, violation.message);
      }
      // The headroom that remains before the next raise is needed, so the number
      // to watch is known before a PR trips it.
      console.log(
        `  headroom: ${parsed.budget - total} lines to the budget, ${HARD_CAP - total} to the cap`,
      );
    }
  }
}

console.log(exit === 0 ? "\nAll lean-line-budget checks passed." : "\nFAILED");
process.exit(exit);
