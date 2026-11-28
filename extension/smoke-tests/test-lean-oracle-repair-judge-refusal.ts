#!/usr/bin/env bun
/**
 * The judge's refusal reason belongs to the judgement that made it (#2668).
 *
 * `judgeOne` used to say "refused" by returning nothing and stashing its reason in one module-level
 * variable, which the loop read only AFTER an await. Two judgements in flight in one process therefore read
 * each other's reason: the round that refused a green-at-base replacement could be reported as having
 * resubmitted the contract, and the handback then told the builder to fix the wrong thing. A reason that can
 * name the wrong file is as useless as no reason.
 *
 * Both judgements here run against a REAL git repository and the REAL `sh {file}` runner — only the model is
 * absent. Each is refused for its own mechanical reason, so a shared slot is observable as a wrong sentence
 * and not as a crash.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { sha256 } from "../src/lean/specify-proof.ts";
import { judgeRepairSubmission } from "../src/oracle-repair-judge.ts";
import { outsideDir } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.log(`\u2717 ${msg}`);
    exit = 1;
  }
}

const GREEN = "tests/AC1-green.test.sh";
const RESUBMIT = "tests/AC1-resubmit.test.sh";
const RUNNER = "sh {file}";
/** The contract behind the green submission: bytes whose every case passes at the base. */
const GREEN_ORIGINAL = '#!/bin/sh\necho "ok - tests/AC1-green.test.sh"\nexit 0\n';
/** The contract behind the resubmission: red at the base, and the only case it prints is its own. */
const RED_ORIGINAL =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-resubmit.test.sh own case" 1>&2; exit 1; fi\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-resubmit.test.sh second case" 1>&2; exit 1; fi\nexit 0\n';
const RED_BASE = "export const retry = () => { throw new Error('not-implemented'); };\n";
/** A submission that deletes the contract's second case and goes red on a line the contract never printed. */
const BORROWED =
  '#!/bin/sh\nif grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-resubmit.test.sh borrowed case" 1>&2; exit 1; fi\nexit 0\n';
/**
 * The contract's own bytes with one case DELETED and a passing line bolted on: bytes that differ from the
 * record, a red that is still the contract's own, and lines the original never printed. The shape the identity
 * check alone lets through, and the one the surviving-line rule of `provesNewRed` exists for.
 */
const RESUBMITTED = RED_ORIGINAL.replace(
  'if grep -q not-implemented src/retry.ts; then echo "not ok - tests/AC1-resubmit.test.sh second case" 1>&2; exit 1; fi\n',
  'echo "ok - a passing case the contract never had"\n',
);

/** A real git repo at one commit: the failing source and both frozen tests, as the records hash them. */
function baseRepo(): { root: string; sha: string } {
  const root = mkdtempSync(outsideDir());
  const git = (...argv: string[]): string =>
    execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "src/retry.ts"), RED_BASE);
  writeFileSync(path.join(root, GREEN), GREEN_ORIGINAL, { mode: 0o755 });
  writeFileSync(path.join(root, RESUBMIT), RED_ORIGINAL, { mode: 0o755 });
  git("add", "-A");
  git("commit", "-q", "-m", "base + two frozen tests");
  return { root, sha: git("rev-parse", "HEAD") };
}

const repo = baseRepo();

/** The two judgements, started together so their awaits interleave. */
const [green, resubmit] = await Promise.all([
  judgeRepairSubmission({
    exec: execp,
    baseTree: repo.root,
    baseRef: repo.sha,
    template: RUNNER,
    named: [GREEN],
    replacements: [
      {
        path: GREEN,
        bytes: Buffer.from(`${GREEN_ORIGINAL}\nexit 0\n`),
        frozenHash: sha256(GREEN_ORIGINAL),
      },
    ],
  }),
  judgeRepairSubmission({
    exec: execp,
    baseTree: repo.root,
    baseRef: repo.sha,
    template: RUNNER,
    named: [RESUBMIT],
    replacements: [
      { path: RESUBMIT, bytes: Buffer.from(RESUBMITTED), frozenHash: sha256(RED_ORIGINAL) },
    ],
  }),
]);

// A third judgement, run after the two above have each refused: its own refusal must not be reported as
// either earlier reason.
const borrowed = await judgeRepairSubmission({
  exec: execp,
  baseTree: repo.root,
  baseRef: repo.sha,
  template: RUNNER,
  named: [RESUBMIT],
  replacements: [
    { path: RESUBMIT, bytes: Buffer.from(BORROWED), frozenHash: sha256(RED_ORIGINAL) },
  ],
});

assert(green.accepted === false, "(1) the green-at-base replacement is refused");
assert(resubmit.accepted === false, "(1) the resubmitted contract is refused");
const greenWhy = green.accepted === false ? green.why : "";
const resubmitWhy = resubmit.accepted === false ? resubmit.why : "";
assert(
  greenWhy.includes("passes at the base"),
  `(2) the green judgement carries ITS OWN reason (${greenWhy || "accepted"})`,
);
assert(
  resubmitWhy.includes("the frozen file already had"),
  `(2) the resubmission judgement carries ITS OWN reason (${resubmitWhy || "accepted"})`,
);
assert(
  borrowed.accepted === false,
  `(2) the borrowed-red submission is refused (${borrowed.accepted ? "accepted" : borrowed.why})`,
);
const borrowedWhy = borrowed.accepted === false ? borrowed.why : "";
assert(
  borrowedWhy.includes("the frozen file already had"),
  `(2) the last judgement still carries ITS OWN reason (${borrowedWhy || "accepted"})`,
);
assert(greenWhy !== resubmitWhy, "(2) the two refusals do not read the same reason slot");

console.log(exit === 0 ? "\nlean oracle repair judge refusal: OK" : "\nFAILED");
process.exit(exit);
