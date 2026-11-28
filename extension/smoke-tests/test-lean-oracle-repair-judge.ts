#!/usr/bin/env bun
/**
 * The repair judge's three rules, each observed REFUSING a mutant that looks like a repaired test.
 *
 * The round is the one place lean lets a child rewrite the contract it is graded on, so what makes it safe is
 * not the brief but the gate. A gate never run in a failing state proves nothing, so every rule here is aimed
 * at the mutant it exists to catch: an out-of-quota replacement, an oracle that is green at base, and the
 * frozen file resubmitted with a passing case bolted on. The fourth case pins the direction a judge that could
 * not read the runner takes: it throws rather than refuse, so a broken toolchain never silently costs a run
 * its one round on a verdict nobody observed.
 *
 * Real git, the real project runner, the real base checkout — only the child is the bytes it submitted.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { outsideDir } from "./lib/lean-build-fixture.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import {
  RepairJudgeError,
  judgeRepairSubmission,
  submissionScopeProblem,
  type ReplacementInput,
} from "../src/oracle-repair-judge.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.log(`\u2717 ${msg}`);
    exit = 1;
  }
}

const FILE = "tests/AC1.test.sh";
const RUNNER = "sh {file}";
/** Red while `src/retry.ts` says `not-implemented`, and it names a case the original never printed. */
const GOOD =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh returns the value" 1>&2; exit 1; fi\nexit 0\n';
/** The frozen bytes as the base holds them: green for every case, because the base already implements it. */
const GREEN_AT_BASE = '#!/bin/sh\nif grep -q nope src/retry.ts; then echo "not ok - tests/AC1.test.sh" 1>&2; exit 1; fi\nexit 0\n';
/** Different bytes from the original — a passing case bolted on — whose ONLY red is the original's own. */
const RESUBMITTED =
  '#!/bin/sh\necho "ok - a case that always passes"\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh old case" 1>&2; exit 1; fi\nexit 0\n';
const ORIGINAL =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1.test.sh old case" 1>&2; exit 1; fi\nexit 0\n';

/** A checkout whose `src/retry.ts` is what the run's base held. */
async function baseTree(withSrc: string): Promise<string> {
  const dir = mkdtempSync(outsideDir());
  // The submitted file reads `src/retry.ts`, so the base checkout holds the implementation under test.
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src/retry.ts"), withSrc);
  return dir;
}

const trees: string[] = [];
async function tree(withSrc: string): Promise<string> {
  const d = await baseTree(withSrc);
  trees.push(d);
  return d;
}

const RED_BASE = "export const retry = () => { throw new Error('not-implemented'); };\n";
const GREEN_BASE = "export const retry = () => 1;\n";

const input = (bytes: string, frozen: string): ReplacementInput => ({
  path: FILE,
  bytes: Buffer.from(bytes),
  frozenHash: sha256(frozen),
});

// ── (1) the named-only rule ───────────────────────────────────────────────────────────────────────────
{
  const why = submissionScopeProblem([FILE, "tests/AC2.test.sh"], [FILE]);
  assert(
    why !== undefined && why.includes("tests/AC2.test.sh"),
    "(1) a replacement of a file the report never named is refused, naming it",
  );
  assert(
    submissionScopeProblem([FILE], [FILE]) === undefined,
    "(1) a replacement inside the named set passes the scope rule",
  );
  assert(
    submissionScopeProblem([], [FILE]) !== undefined,
    "(1) an empty submission is refused rather than accepted as a no-op",
  );
}

// ── (2) the accepted mutant: red at base, a case the original never printed ────────────────────────────
{
  const j = await judgeRepairSubmission({
    exec: execp,
    baseTree: await tree(RED_BASE),
    template: RUNNER,
    named: [FILE],
    replacements: [input(GOOD, ORIGINAL)],
  });
  assert(j.accepted === true, `(2) a red-at-base replacement of a named file is accepted (${JSON.stringify(j.accepted === false ? j.why : "")})`);
  if (j.accepted)
    assert(
      j.verdicts[0]?.redCase.includes("returns the value") === true,
      `(2) the accepted verdict carries the runner's own words on the red case (got ${JSON.stringify(j.verdicts[0]?.redCase)})`,
    );
}

// ── (3) mutant: an oracle every case of which passes at the base ───────────────────────────────────────
{
  const j = await judgeRepairSubmission({
    exec: execp,
    baseTree: await tree(GREEN_BASE),
    template: RUNNER,
    named: [FILE],
    replacements: [input(GREEN_AT_BASE, ORIGINAL)],
  });
  assert(
    j.accepted === false && j.why.includes("passes at the base"),
    `(3) a replacement green at base for every case is refused (got ${JSON.stringify(j.accepted ? "accepted" : j.why)})`,
  );
}

// ── (4) mutant: the frozen file with a passing case appended ───────────────────────────────────────────
{
  const j = await judgeRepairSubmission({
    exec: execp,
    baseTree: await tree(RED_BASE),
    template: RUNNER,
    named: [FILE],
    replacements: [input(RESUBMITTED, ORIGINAL)],
  });
  assert(
    j.accepted === false && j.why.includes("already had"),
    `(4) a replacement whose only red is the original's own case is refused (got ${JSON.stringify(j.accepted ? "accepted" : j.why)})`,
  );
}

// ── (5) mutant: byte-identical resubmission, and a path the run never froze ────────────────────────────
{
  const same = await judgeRepairSubmission({
    exec: execp,
    baseTree: await tree(RED_BASE),
    template: RUNNER,
    named: [FILE],
    replacements: [input(ORIGINAL, ORIGINAL)],
  });
  assert(
    same.accepted === false && same.why.includes("byte-identical"),
    `(5) the frozen bytes resubmitted are refused (got ${JSON.stringify(same.accepted ? "accepted" : same.why)})`,
  );
  const unknown = await judgeRepairSubmission({
    exec: execp,
    baseTree: await tree(RED_BASE),
    template: RUNNER,
    named: [FILE],
    replacements: [{ path: FILE, bytes: Buffer.from(GOOD), frozenHash: undefined }],
  });
  assert(
    unknown.accepted === false && unknown.why.includes("no frozen record"),
    `(5) a replacement for a path the run never froze is refused (got ${JSON.stringify(unknown.accepted ? "accepted" : unknown.why)})`,
  );
}

// ── (6) a judge that could not read the runner THROWS; it does not refuse ─────────────────────────────
{
  // The runner cannot start at all: a template whose binary does not exist. An unobserved replacement is not
  // evidence about the replacement, and refusing on it would spend the run's one round on the toolchain.
  let threw = "";
  try {
    await judgeRepairSubmission({
      exec: execp,
      baseTree: await tree(RED_BASE),
      template: "definitely-not-a-real-runner-binary {file}",
      named: [FILE],
      replacements: [input(GOOD, ORIGINAL)],
    });
  } catch (err) {
    threw = err instanceof Error ? err.name : String(err);
  }
  assert(
    threw === "RepairJudgeError",
    `(6) a base run that observed nothing throws ${RepairJudgeError.name} rather than refusing (got ${JSON.stringify(threw)})`,
  );
}

console.log(exit === 0 ? "\nlean oracle repair judge: OK" : "\nFAILED");
process.exit(exit);
