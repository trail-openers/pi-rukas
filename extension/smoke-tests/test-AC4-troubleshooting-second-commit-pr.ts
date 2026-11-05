#!/usr/bin/env bun
/**
 * AC4 (#2030) — `docs/troubleshooting.md` carries the symptom → cause entry for
 * the second commit-pr that fell back to the ops dispatch because the pick batch
 * re-picked what the branch already holds.
 *
 * The fallback's plumb-report body is the literal text an operator reads in the
 * handoff (`work-driver-commit-lock.ts`: "Mechanized commit-pr fell back to the
 * ops dispatch: " + integrate()'s reason, which says "cherry-pick conflict").
 * `test-dockerfile-pins.ts` already pins that a docs entry exists for another
 * recurring failure; this is the same rule for this one.
 *
 * The entry must NOT claim the re-pick is solved: recognising a commit whose
 * patch is already on the branch is open (#2030), so the entry says the round
 * falls back to the ops dispatch and that the report now names the cause.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "test-AC4-troubleshooting-second-commit-pr.ts";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const doc = readFileSync(path.join(ROOT, "docs", "troubleshooting.md"), "utf8");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

// One `###` heading and the prose under it — the unit an operator reads.
const sections = doc.split(/^### /m).slice(1).map((s) => s.split(/^\#\# /m)[0]);
const entry = sections.find(
  (s) => /Mechanized commit-pr fell back to the ops dispatch/.test(s) && /cherry-pick conflict/.test(s),
);

assert(
  entry !== undefined,
  'docs/troubleshooting.md has a "### " entry for "Mechanized commit-pr fell back to the ops dispatch: cherry-pick conflict"',
);
if (entry) {
  assert(
    /\*\*Symptom:?\*\*|\bSymptom\b/i.test(entry),
    `…written as a Symptom (got: ${entry.split("\n")[0].slice(0, 70)})`,
  );
  assert(/\*\*Cause:?\*\*|\bCause\b/i.test(entry), "…with a Cause naming the re-pick of what the branch already holds");
  assert(/commit-pr/i.test(entry), "…on a SECOND commit-pr (not the first round's conflict)");
  // The cause the fix actually ships, and nothing more than that.
  assert(
    /apply-conflict/.test(entry),
    "…naming the cause the fallback now reports (apply-conflict)",
  );
  assert(
    !/patch-id/.test(entry),
    "…without claiming the patch-id skip shipped — recognising an already-applied commit is open (#2030)",
  );
  assert(
    !/now skips|are skipped|is skipped rather/.test(entry),
    "…without claiming already-applied commits are now skipped",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
