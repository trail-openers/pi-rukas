#!/usr/bin/env bun
/**
 * #2042 AC7 — the rule is documented, and the documentation is pinned.
 *
 * Both files are read by an operator who is deciding whether a hand-back is a bug:
 * `docs/lean.md`'s step table says what `verify` and `ci` do, and
 * `docs/troubleshooting.md` turns the hand-back's symptom into a cause and a fix.
 * Nothing reads them at runtime, so an assertion here is the only thing that keeps
 * the prose from drifting away from the gate it describes (R8).
 *
 * The needles are the ones a reader needs, not incidental words: that the excuse is
 * decided by FAILURE LINE (runner-agnostic, no parser), that the disclosure is recorded in
 * `preexistingFailures`, that a head-only line keeps the hand-back, and that the PR body prints
 * the disclosure under the section `publish` actually renders.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leanPreexistingFailuresSection } from "../src/lean/publish-body.ts";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";

const SELF = "test-AC7-baseline-excuse-docs.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repo, rel), "utf8");

const lean = read("docs/lean.md");
const troubleshooting = read("docs/troubleshooting.md");

/** One row of the step table, so an assertion is about the row it belongs to. */
function row(step: string): string {
  const line = lean.split("\n").find((l) => l.startsWith(`| \`${step}\` |`));
  assert(line !== undefined, `(row) docs/lean.md has a \`${step}\` step row`);
  return line ?? "";
}

const verifyRow = row("verify");
const ciRow = row("ci");

// ------------------------------------------------------------- (verify row)
{
  assert(
    verifyRow.includes("preexistingFailures"),
    "(verify) the row names the field the disclosure is recorded in",
  );
  assert(
    /FAILURE LINE|failure line/.test(verifyRow),
    "(verify) the row says the base's red is graded by whole failure LINE, not by colour alone",
  );
  assert(
    verifyRow.includes("baseline red:"),
    "(verify) the row names the hand-back the excuse does not replace",
  );
  assert(
    verifyRow.includes("acceptance tests green") ||
      verifyRow.includes("frozen acceptance tests green"),
    "(verify) the row states the frozen acceptance tests must be green to be excused",
  );
  assert(/build round/.test(verifyRow), "(verify) the row says neither arm bills a build round");
}

// ------------------------------------------------------------------ (ci row)
{
  assert(
    /same LINE rule|same line rule|LINE rule/.test(ciRow),
    "(ci) the row says the full tier is excused by the same line rule",
  );
  assert(
    ciRow.includes("byte-identical"),
    "(ci) the row states the one condition under which verify's proof is reused",
  );
  assert(
    /re-prob|reprob|probe/i.test(ciRow),
    "(ci) the row says ci probes the base itself when it cannot reuse",
  );
}

// ------------------------------------------------- (troubleshooting entry)
{
  assert(
    troubleshooting.includes("`baseline red: tier"),
    "(troubleshooting) the entry names the symptom an operator actually reads",
  );
  assert(
    troubleshooting.includes("### Symptom") || troubleshooting.includes("**Symptom:**"),
    "(troubleshooting) the entry keeps the symptom → cause → fix shape",
  );
  assert(
    /### Cause|\*\*Cause:\*\*/.test(troubleshooting) &&
      /### Fix|\*\*Fix:\*\*/.test(troubleshooting),
    "(troubleshooting) with its cause and its fix sections present",
  );
  assert(
    troubleshooting.includes("preexistingFailures"),
    "(troubleshooting) the fix names the record the disclosure lives in",
  );
  assert(
    /no recognised failure line|recognised failure line at all/.test(troubleshooting),
    "(troubleshooting) it says a tier that prints no recognised failure line is not excusable",
  );
  assert(
    /pytest/.test(troubleshooting) &&
      /TAP/.test(troubleshooting) &&
      /\bgo\b/.test(troubleshooting) &&
      /any runner|excusable|is excusable|any runner the shared/.test(troubleshooting),
    "(troubleshooting) it says any runner the classifier reads — pytest, TAP, go — is excusable",
  );
  assert(
    /whole\n?failure line|whole failure line/.test(troubleshooting) &&
      /whole failure line|LINE rule|line rule/.test(verifyRow + ciRow),
    "(docs) the step table and the entry both say the rule compares WHOLE failure lines",
  );
  assert(
    /dependency|dependencies/.test(troubleshooting),
    "(troubleshooting) it says a base red shaped like missing dependencies is not the commit's",
  );
}

// ------------------------------------ (the docs and the code cannot disagree)
{
  // The section name the docs promise is the one `publish` renders, or an operator
  // following the troubleshooting entry finds nothing under the heading it named.
  const rec: PreexistingTierRecord = {
    cmd: "pytest",
    names: ["FAILED tests/x_test.py::test_a - AssertionError"],
    total: 3,
    baseSha: "d".repeat(40),
  };
  const section = leanPreexistingFailuresSection({ fast: rec });
  const heading = "## Pre-existing test failures";
  assert(
    section.startsWith("\n" + heading),
    `(agreement) publish renders the heading the docs promise (${section.split("\n")[1]})`,
  );
  assert(
    troubleshooting.includes(heading),
    "(agreement) the troubleshooting entry names that exact heading",
  );
  assert(
    /not introduced by this change/.test(section) &&
      /not introduced by this change/.test(troubleshooting),
    "(agreement) the same one-line explanation in both the body and the docs",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
