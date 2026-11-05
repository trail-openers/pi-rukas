#!/usr/bin/env bun
/**
 * AC4 (#2030) — `docs/troubleshooting.md` carries the symptom → cause → fix
 * entry for the second commit-pr that fell back to the ops dispatch because the
 * pick batch re-picked what the branch already holds.
 *
 * The fallback's plumb-report body is the literal text an operator reads in the
 * handoff (`work-driver-commit-lock.ts`: "Mechanized commit-pr fell back to the
 * ops dispatch: " + integrate()'s reason, which says "cherry-pick conflict").
 * `test-dockerfile-pins.ts` already pins that a docs entry exists for another
 * recurring failure; this is the same rule for this one.
 *
 * Fails today: the file has no entry naming that symptom.
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
  assert(/\*\*Fix:?\*\*|\bFix\b|fixed:/i.test(entry), "…with a Fix the operator can act on");
  assert(/commit-pr/i.test(entry), "…on a SECOND commit-pr (not the first round's conflict)");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
