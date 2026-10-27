#!/usr/bin/env bun
/**
 * The CONSUMER half of the `Skill Load Status` proof (PR #1530 lens finding,
 * SECURITY/MEDIUM) — `runLensChild` (lens-review-child.ts) with a stubbed
 * spawner.
 *
 * #1847 RETIRED the proof for lens children: the parent now reads
 * `<skillDir>/SKILL.md` itself and inlines the body in the child's prompt, so a
 * lens that never called `read` is the expected outcome rather than a claim to
 * corroborate, and a child-reported FAILED no longer blocks (there is no load
 * left for it to fail). What this file therefore pins is the RETIREMENT: no
 * shadow warn is produced on any shape, nothing blocks on a marker, and the
 * lens's own findings survive regardless — the policy lives in the consumer,
 * so that is where the absence has to be asserted. The proof function itself
 * keeps its coverage in the pure files (verified / round2 / round3), where
 * `isSkillReadWith` — the predicate the #1827 cap counts with — is exercised.
 *
 * Companion to `test-lens-skill-load-verified.ts` (the pure check) and
 * `test-lens-skill-load-round2.ts` (the round-2 false-negative cases); the
 * three are one suite split under AGENTS.md §12, not three suites.
 *
 * The consumer, not the proof, owns the POLICY — and as of round 3 of the
 * #1530 review that policy is SHADOW: a refutation (`unproven`) is traced and
 * changes NOTHING, because a false refutation would block every lens review on
 * every PR and two false-refutation classes were still open. Only the child's
 * own `FAILED` self-report blocks. These cases drive the real function rather
 * than the pure predicate precisely because the policy lives here: a bug in
 * which outcome maps to which field is invisible at the predicate level, and a
 * bug that silently RE-ENABLES the block would turn every honest lens into a
 * blocked one. Hence the canaries — (A)/(F)/(G) are the shapes the proof
 * refutes and that must now pass, and (C) is the shape that must still block.
 *
 * Section 3 covers `lensPromptFor` refusing to interpolate a skill path
 * carrying a newline, backtick, `<` or `>` (PR #1530 lens finding, LOW): the
 * section is omitted rather than the fence escaped.
 *
 * `spawn.ts` is stubbed before the lens modules load (the `test-lens-kill-child.ts`
 * pattern), so no Pi child spawns and every result below is a fixture.
 */

import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lensPromptFor } from "../src/lens-review-format.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

// #1069 — isolate before any src import: the real runLensReview write must
// land in a temp file, not the main clone's .git (worktree common dir).
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

// The SHADOW warn is the whole deliverable of the unproven branch, so it has
// to be observable. `traceWarn` writes straight to `process.stderr` (trace.ts)
// — this swaps the stream's `write` before the lens modules load and restores
// it after each case, so every assertion below reads exactly the lines that
// one `runChild` produced.
const shadowLines: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  shadowLines.push(String(chunk));
  return true;
}) as typeof process.stderr.write;

const { runLensChild } = await import("../src/lens-review-child.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");

const ALL_SKILLS = LENS_ROSTER.map((l) => l.skill);
const skillsRoot = mkdtempSync(path.join(os.tmpdir(), "lens1530-"));
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

// (A) The finding's headline case: a result CLAIMS SUCCESS and never read the
// skill. The proof REFUTES it — and in shadow mode that refutation only warns.
// Before round 3 this blocked; a false refutation of this shape would block
// every lens on every PR, which is the whole reason it does not gate anything
// until the shadow log clears. Findings stay, no parseError, no retry.
{
  // The warn must be attributable to THIS child's reply, not to a spawn that
  // retried after a failed attempt — so pin the attempt count this case relies
  // on before asserting on the log it produced.
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear from a security perspective.\n\nSkill Load Status: SUCCESS",
    toolUses: [FINDING_CALL],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  eq(r.attempts, 1, "(A) exactly one spawn, so the single warn below is this reply's");
  assert(
    r.blocked === false,
    "(A) SUCCESS with no matching read is NOT blocked — the proof runs in shadow",
  );
  eq(r.parseError, undefined, "(A) no parseError: the child's own marker decides the outcome");
  eq(
    r.findings.length,
    1,
    "(A) findings are KEPT — a bogus marker does not invalidate a tool call",
  );
  eq(
    shadowLines.filter((l) => l.includes("SHADOW")).length,
    0,
    "(A) NO shadow line — #1847 retired the lens-side proof (an inline lens never reads)",
  );
  eq(r.attempts, 1, "(A) the shadow warn is not a retry trigger (one spawn)");
  // Every warn assertion this file used to make against the refuting reply is
  // now an assertion of ABSENCE, and the shape that WOULD warn if the proof
  // were still wired is exactly (A): a SUCCESS claim with no read of the skill.
  // test-lens-skill-load-verified.ts keeps the proof itself under test.
  const warn = shadowText();
  assert(
    !warn.includes("SHADOW"),
    "(A) the retired proof emits no warn even on the shape that used to refute (the retirement is real, not vacuous)",
  );
  assert(
    !warn.toLowerCase().includes("treated as failed"),
    "(A) no downgrade text is emitted at all",
  );
}

// (A2) Canary for (A): the SAME reply with the read present must be silent.
// Without this, a warn emitted on every SUCCESS makes (A)'s log assertions
// pass unconditionally — a shadow line that always fires is not evidence of
// anything, and the promotion decision would be built on it.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      {
        name: "read",
        arguments: { path: path.join(skillsDir, "code-review-security", "SKILL.md") },
      },
      FINDING_CALL,
    ],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(r.blocked === false, "(A2) a corroborated SUCCESS is not blocked");
  assert(
    !shadowText().includes("SHADOW"),
    "(A2) a corroborated SUCCESS emits NO shadow warn (the warn is conditional)",
  );
}

// (B) The same reply WITH the read the prompt asks for. Must be honoured.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear from a security perspective.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      {
        name: "read",
        arguments: { path: path.join(skillsDir, "code-review-security", "SKILL.md") },
      },
      FINDING_CALL,
    ],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(r.blocked === false, "(B) SUCCESS backed by a read of the skill → honoured, not blocked");
  eq(r.parseError, undefined, "(B) no parseError on a corroborated SUCCESS");
  eq(r.findings.length, 1, "(B) findings still recorded");
}

// (C) #1847 — an explicit FAILED no longer blocks, because there is no skill
// load left for the child to fail: the parent read the file before the spawn
// and the driver blocks the lens itself when THAT read fails
// (test-lens-skill-inline-1847.ts). This is the case that keeps the retirement
// honest: had the marker check been left wired, the lens would block here.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "Could not load my skill.\n\nSkill Load Status: FAILED",
    toolUses: [FINDING_CALL],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(C) a stale Skill Load Status: FAILED blocks nothing — the driver, not the child, owns the skill",
  );
  eq(r.parseError, undefined, "(C) no parseError is invented from a retired marker");
  eq(r.findings.length, 1, "(C) the lens's findings stand regardless of what its prose says");
  assert(
    !shadowText().includes("SHADOW"),
    "(C) and no warn — the marker is read by nothing on the lens path",
  );
}

// (D) No marker at all: absence is still not a block (the #872 policy is
// untouched by this check).
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "Checked the diff; nothing in my lane.",
    toolUses: [],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(r.blocked === false, "(D) an absent marker still does not block");
}

// (E) SUCCESS with no tool calls at all — `unverifiable`, not `unproven`. The
// pre-spawn stat is the evidence; absence of a transcript is not a refutation.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [],
    observedToolCalls: 7,
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(E) SUCCESS with no recorded tool calls is unverifiable → not blocked (only a refutation blocks)",
  );
}

// (F) The read must be of THIS lens's skill, not any file in the tree. The
// proof refutes; shadow mode means the lens still runs.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      { name: "read", arguments: { path: path.join(skillsDir, "code-review-security-x") } },
    ],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(F) a prefix-sharing read neither refutes nor blocks — nothing on the lens path judges it now",
  );
  assert(
    !shadowText().includes("SHADOW"),
    "(F) the containment gap is covered by the pure proof files, not by a lens-side warn",
  );
}

// (G) A read of a SIBLING file in the skill dir — the shape the old "anything
// under the dir" rule accepted. Refuted; and in shadow, not blocked.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      {
        name: "read",
        arguments: { path: path.join(skillsDir, "code-review-security", "notes.md") },
      },
    ],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(G) a sibling file inside the skill dir is neither refuted nor blocked",
  );
  assert(
    !shadowText().includes("SHADOW"),
    "(G) the sibling-file case emits no warn on the lens path",
  );
}

// (H) Under-recovery at the CONSUMER: the replay carried only the finding, but
// the live stream saw 3 calls. Blocking here would punish a lens whose
// transcript was simply truncated — so the pre-spawn stat remains the evidence.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [FINDING_CALL],
    observedToolCalls: 3,
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(H) SUCCESS with an under-recovered replay (observed 3 > recovered 1) → NOT blocked",
  );
  eq(r.findings.length, 1, "(H) findings from the recovered calls are still kept");
}

// (I) Same replay, but the counts AGREE (observed 1 = recovered 1). Now the
// absence is real and the claim is refuted — (H) is not just a fixture artefact.
// Refuted still means warn-only in shadow: the outcome is the child's word.
{
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [FINDING_CALL],
    observedToolCalls: 1,
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild();
  assert(
    r.blocked === false,
    "(I) the same reply with AGREED counts is neither refuted nor blocked",
  );
  assert(
    !shadowText().includes("SHADOW"),
    "(I) and produces no shadow log line — the whole marker path is silent",
  );
  eq(r.parseError, undefined, "(I) no parseError is invented for a retired check");
}

// (J) The symlinked skills dir, end to end: the driver passes the symlink and
// the child read through it. Blocked here would be the round-2 bug in
// production — install.sh symlinks skill/* into the skills dir.
{
  const symRoot = mkdtempSync(path.join(os.tmpdir(), "lens1530-sym-child-"));
  const realSkills = path.join(symRoot, "real");
  const linkedSkills = path.join(symRoot, "skills");
  for (const s of ALL_SKILLS) {
    const real = path.join(realSkills, s);
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "SKILL.md"), `---\nname: ${s}\n---\n`);
    mkdirSync(linkedSkills, { recursive: true });
    symlinkSync(real, path.join(linkedSkills, s), "dir");
  }
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      {
        name: "read",
        arguments: { path: path.join(realSkills, "code-review-security", "SKILL.md") },
      },
      FINDING_CALL,
    ],
    ms: 10,
    exitCode: 0,
  });
  const r = await runChild(linkedSkills);
  // Why this case must not warn (the point of the whole shadow decision): the
  // real install.sh tree has NO symlink at the skills-dir level — it puts real
  // `SKILL.md` files in real dirs under `$TMPDIR`-style paths, and on macOS
  // `/var` → `/private/var` is a symlink. A check that canonicalised the
  // CHILD's path (the pre-round-3 shape) turned every honest child into a
  // refutation, which enforced means every lens on every PR blocked. The fix is
  // to canonicalise only the DRIVER's path, once, and accept either spelling.
  assert(r.blocked === false, "(J) a child that read through the symlink is not blocked");
  eq(r.findings.length, 1, "(J) findings kept");
  assert(
    !shadowText().includes("SHADOW"),
    "(J) nor warned: the driver resolves its OWN path once, so the realpath the " +
      "child opened matches one of the driver's own spellings. GOT: " +
      JSON.stringify(shadowText()),
  );

  // Canary for (J): the child opened the LINKED spelling — the path the prompt
  // actually printed. Canonicalising only the driver's side (the pre-round-3
  // shape) honours (J) and refutes THIS, which is the normal child behaviour.
  spawnResponder = () => ({
    role: "code-review-specialist",
    ok: true,
    text: "All clear.\n\nSkill Load Status: SUCCESS",
    toolUses: [
      {
        name: "read",
        arguments: { path: path.join(linkedSkills, "code-review-security", "SKILL.md") },
      },
      FINDING_CALL,
    ],
    ms: 10,
    exitCode: 0,
  });
  const rLinked = await runChild(linkedSkills);
  assert(
    rLinked.blocked === false && !shadowText().includes("SHADOW"),
    "(J2) canary for (J): the linked spelling of the same file is also honoured " +
      "(so (J)'s pass is not a one-sided realpath)",
  );
}

console.log(`\nexit ${exit}`);
process.stderr.write = realStderrWrite;
process.exit(exit);
