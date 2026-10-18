#!/usr/bin/env bun
/**
 * The consumer half of the skill-load proof — the round-3 adversarial cases
 * (PR #1530 review, round 3). Companion to `test-lens-skill-load-consumer.ts`
 * (the shadow policy) and the two pure-proof files; one suite split under
 * AGENTS.md §12.
 *
 * These drive `runLensChild` with the shapes the adversarial review measured on
 * the proof itself — a `SKILL.md` from another directory, a redirect target, an
 * in-place `sed` — plus the macOS-tmpdir shape that made the path handling
 * matter. Each must WARN (the proof has to keep seeing through it, since that
 * log is the evidence the enforce decision is built on) and none may BLOCK
 * (shadow mode). Each carries the honest case that stays silent, so a warn that
 * fires on everything cannot pass as a refutation.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

let spawnResponder: () => unknown = () => ({
  role: "code-review-specialist",
  ok: true,
  text: "clean",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1530",
  spawnSpecialist: async () => spawnResponder(),
}));

// The SHADOW warn is the deliverable of the unproven branch, so it has to be
// observable. `traceWarn` writes straight to `process.stderr` (trace.ts) — this
// swaps the stream's `write` before the lens modules load and clears after each
// case, so every assertion reads exactly the lines one `runChild` produced.
const shadowLines: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  shadowLines.push(String(chunk));
  return true;
}) as typeof process.stderr.write;

const { runLensChild } = await import("../src/lens-review-child.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");

const ALL_SKILLS = LENS_ROSTER.map((l) => l.skill);
const skillsRoot = mkdtempSync(path.join(os.tmpdir(), "lens1530-r3-"));
const skillsDir = path.join(skillsRoot, "skills");
mkdirSync(skillsDir, { recursive: true });
let prec = 10;
for (const s of ALL_SKILLS) {
  const d = path.join(skillsDir, s);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${s}\nprecedence: ${prec}\n---\n`);
  prec += 10;
}

const childLens = { name: "SECURITY", skill: "code-review-security", precedence: 10 };

async function runChild(dir = skillsDir) {
  shadowLines.length = 0;
  return await runLensChild({
    lens: childLens,
    runId: "run-1530",
    skillsDir: dir,
    context: "",
    roster: [],
    opts: { diff: "d" },
    bumpBatch: () => {},
  });
}

function shadowText(): string {
  return shadowLines.join("");
}

const FINDING_CALL = {
  name: "report_finding",
  arguments: { severity: "MEDIUM", path: "src/a.ts", line: 1, title: "kept finding" },
};

/* 2k — the two adversarial-review findings on the proof itself, driven through
 * the consumer so the shapes are the ones a real child produces. Each is a WRITE
 * or an OUT-OF-TREE file masquerading as the skill; each must WARN (the proof has
 * to keep seeing through it — that warn log is the evidence the enforce decision
 * is built on) and none may BLOCK (shadow mode). Each is paired with the honest
 * case that stays silent, so a matcher that simply rejects everything cannot
 * pass these. */
{
  const SUCCESS_TEXT = "All clear.\n\nSkill Load Status: SUCCESS";
  const skillFile = path.join(skillsDir, "code-review-security", "SKILL.md");
  const cases: Array<[string, unknown[], string]> = [
    [
      "a SKILL.md in another directory",
      [{ name: "read", arguments: { path: path.join(skillsRoot, "SKILL.md") } }, FINDING_CALL],
      "(2k) read of an out-of-tree SKILL.md is not a load",
    ],
    [
      "a redirect targeting the skill",
      [
        { name: "bash", arguments: { command: `echo x > ${skillFile}` } },
        FINDING_CALL,
      ],
      "(2k) `echo x > <skill>/SKILL.md` is a write, not a load",
    ],
    [
      "an in-place sed on the skill",
      [
        { name: "bash", arguments: { command: `sed -i s/a/b/ ${skillFile}` } },
        FINDING_CALL,
      ],
      "(2k) `sed -i … <skill>/SKILL.md` is a write, not a load",
    ],
  ];
  for (const [, toolUses, label] of cases) {
    spawnResponder = () => ({
      role: "code-review-specialist",
      ok: true,
      text: SUCCESS_TEXT,
      toolUses,
      ms: 10,
      exitCode: 0,
    });
    const r = await runChild();
    assert(r.blocked === false, `${label}: not blocked (shadow)`);
    assert(shadowText().includes("SHADOW"), `${label}: the proof sees through it and warns`);
  }
  // Canary for 2k: the honest read of the same file, in the same fixture, is
  // silent. Without this a warn that fired on every child would pass all three.
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: SUCCESS_TEXT,
    toolUses: [{ name: "read", arguments: { path: skillFile } }, FINDING_CALL],
    ms: 10,
    exitCode: 0,
  });
  const honest = await runChild();
  assert(honest.blocked === false, "(2k) canary: the real read is not blocked");
  assert(
    !shadowText().includes("SHADOW"),
    "(2k) canary: the real read emits no warn (2k's warns are conditional)",
  );

  // (2k-dup) The macOS `$TMPDIR` shape, end to end: the driver's skills dir sits
  // under a path whose ANCESTOR is a symlink (`/var` → `/private/var` is the real
  // one) and the child opens the canonical target — a path the driver never
  // builds. The inode arm is the only thing that can accept it, and it must,
  // because refuting it is precisely how the pre-round-3 check blocked every
  // honest lens. The canary that keeps this non-vacuous is the case above.
  const dupRoot = mkdtempSync(path.join(os.tmpdir(), "lens1530-dup-"));
  const dupReal = path.join(dupRoot, "real");
  for (const s of ALL_SKILLS) {
    const d = path.join(dupReal, s);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  const dupLinked = path.join(dupRoot, "skills");
  symlinkSync(dupReal, dupLinked, "dir");
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: SUCCESS_TEXT,
    toolUses: [
      {
        name: "read",
        arguments: {
          path: path.join(realpathSync(dupLinked), "code-review-security", "SKILL.md"),
        },
      },
      FINDING_CALL,
    ],
    ms: 10,
    exitCode: 0,
  });
  const rDup = await runChild(dupLinked);
  eq(rDup.attempts, 1, "(2k-dup) one spawn — the symlinked skills dir passes the pre-spawn stat");
  assert(
    rDup.blocked === false && !shadowText().includes("SHADOW"),
    "(2k-dup) a child reading the canonical target under a symlinked skills root " +
      "is neither blocked nor warned (the macOS /var -> /private/var shape, where " +
      "the target is a path the driver never builds and only the inode arm reaches)",
  );
}

console.log(`\nexit ${exit}`);
process.stderr.write = realStderrWrite;
process.exit(exit);
