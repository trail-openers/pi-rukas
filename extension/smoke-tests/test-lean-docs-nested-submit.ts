#!/usr/bin/env bun
/**
 * #2618 — the docs that tell an operator how submissions are read say the true thing.
 *
 * An operator whose child submitted inside a codemode script read the step's
 * `the child never submitted a test` and had nothing in the docs to connect it
 * to codemode. The specify row of `docs/lean.md` now states where submissions are
 * read from, and `docs/troubleshooting.md` names the symptom, the cause and the
 * workaround. Prose nobody reads at runtime only stays true if something greps it
 * (R8), and the needles below are the exact sentences — a rewrite that quietly
 * drops either fails this file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const SELF = "test-lean-docs-nested-submit.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const repo = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

const lean = read("docs/lean.md");
const troubleshooting = read("docs/troubleshooting.md");

// The specify row's sentence, verbatim — the string the issue pins.
const SENTENCE =
  "Submissions are read from the child's own `submit_tests` calls and from the ones a codemode script made inside them.";
assert(lean.includes(SENTENCE), "docs/lean.md states where submissions are read from, verbatim");
assert(
  lean.split(SENTENCE).length === 2,
  "and it says it once, not in two places that can drift apart",
);
// The sentence belongs to the specify row, not to some other table it fell into.
const specifyRow = lean.split("\n").find((line) => line.startsWith("| `specify` |")) ?? "";
assert(specifyRow.includes(SENTENCE), "the sentence lives in the specify row of the step table");

// The troubleshooting entry: symptom, cause, and the operator's way out.
assert(
  troubleshooting.includes("the child never submitted a test"),
  "docs/troubleshooting.md names the symptom the operator actually reads",
);
assert(
  troubleshooting.includes("PI_ENSEMBLE_CHILD_CODEMODE=0"),
  "and gives the workaround the operator can set today",
);
const entryStart = troubleshooting.indexOf(
  "### Symptom: a lean step says `the child never submitted a test`",
);
assert(entryStart >= 0, "the entry exists under a heading that names the symptom");
const rest = troubleshooting.slice(entryStart);
const nextHeading = rest.indexOf("\n### ", 4);
const entry = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
assert(entry.length > 0 && entry.length < 6000, "the entry is a bounded symptom/cause/fix block");
assert(entry.includes("**Cause:**"), "with its cause");
assert(entry.includes("**Fix:**"), "and its fix");
assert(entry.includes("codemode"), "naming codemode as the thing that hid the submissions");

process.exit(exit);
