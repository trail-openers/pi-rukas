#!/usr/bin/env bun
/**
 * The bound on the diff the adversarial prompts inline.
 *
 * Measured: one `adversarial_loop` over a large branch inlined a ~650,000-char
 * diff verbatim in BOTH the reviewer and the fix-developer prompt. The child's
 * context filled (~258K tokens), it stopped after one output token with
 * `stopReason: "length"`, wrote no `VERDICT:`, and every retry failed the same
 * way — an infrastructure failure the loop could not get past.
 *
 * So: at or under the cap the prompt must be EXACTLY what it was before the
 * bound existed (a normal review is not allowed to change shape); over it the
 * prompt carries a complete per-file inventory, the head of the diff, and a
 * notice saying how much was cut and how to read the rest — the command the
 * caller actually ran when it knows a range, "not available" when it does not.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boundDiffForPrompt,
  MAX_INLINE_DIFF_CHARS,
  summarizeDiffFiles,
} from "../src/adversarial-diff-cap.ts";
import { buildAdversarialPrompt, buildFixPrompt } from "../src/adversarial-prompts.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A synthetic unified diff over `n` files, each roughly `perFile` characters. */
function syntheticDiff(files: number, perFile: number): string {
  const filler = "x".repeat(60);
  const lines: string[] = [];
  for (let f = 0; f < files; f++) {
    const p = `src/module-${f}/deep/nested/path/file-${f}.ts`;
    lines.push(`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`);
    lines.push(`@@ -1,${perFile} +1,${perFile} @@`);
    for (let l = 0; l < perFile; l++) lines.push(`+const value${f}_${l} = "${filler}";`);
  }
  return lines.join("\n");
}

const INVENTORY_LEAD = "EVERY file this diff changes";
const NOTICE_LEAD = "\n\n… (diff truncated:";

/** Split a bounded diff block into [inventory, head, notice] by their lead markers. */
function splitBlock(block: string): [string, string, string] {
  const inv = block.indexOf(INVENTORY_LEAD);
  const headAt = block.indexOf("\n\ndiff --git ");
  const noticeAt = block.indexOf(NOTICE_LEAD);
  if (inv !== 0 || headAt < 0 || noticeAt < 0) {
    throw new Error(`bounded block missing a part (inv ${inv}, head ${headAt}, notice ${noticeAt})`);
  }
  return [block.slice(0, headAt), block.slice(headAt + 2, noticeAt), block.slice(noticeAt + 2)];
}

/** The content of the fenced diff block a prompt carries. */
function diffBlock(prompt: string): string {
  const open = prompt.indexOf("```diff\n");
  if (open < 0) throw new Error("prompt has no diff fence");
  const start = open + "```diff\n".length;
  const close = prompt.indexOf("\n```", start);
  if (close < 0) throw new Error("prompt has no closing diff fence");
  return prompt.slice(start, close);
}

const CONTEXT = "hand-built driver fix: bound the adversarial diff";
const BIG = syntheticDiff(48, 220); // ~48 files, comfortably over the cap
const BIG_FILE_COUNT = 48;

assert(BIG.length > MAX_INLINE_DIFF_CHARS * 4, `synthetic diff is large (${BIG.length} chars)`);

// -------------------------------------------------- 1. over-cap: both prompts bound

for (const [label, prompt] of [
  [
    "reviewer",
    buildAdversarialPrompt({
      diff: BIG,
      context: CONTEXT,
      round: 1,
      maxRounds: 3,
      diffRereadCommand: "git diff main...feature/x",
    }),
  ],
  [
    "fix-developer",
    buildFixPrompt({
      findings: "1. silent failure on the cap path",
      context: CONTEXT,
      diff: BIG,
      round: 1,
      diffRereadCommand: "git diff main...feature/x",
    }),
  ],
] as const) {
  const block = diffBlock(prompt);
  assert(
    block.length <= MAX_INLINE_DIFF_CHARS + 40_000,
    `${label}: bounded block is far smaller than the ${BIG.length}-char diff (${block.length})`,
  );
  // The diff body itself never exceeds the cap: everything above it is the
  // per-file inventory, everything below is the notice — both derived, neither
  // a copy of the content that was cut.
  const noticeAt = block.indexOf(NOTICE_LEAD.slice(1));
  assert(noticeAt > 0, `${label}: the truncation notice is present`);
  const [inventory, head, notice] = splitBlock(block);
  assert(
    head.length <= MAX_INLINE_DIFF_CHARS,
    `${label}: the inlined diff head is within the cap (${head.length})`,
  );
  assert(
    inventory.startsWith(INVENTORY_LEAD),
    `${label}: the per-file inventory leads the block`,
  );
  // Every changed file is named, even the ones whose bodies were cut.
  const missing: number[] = [];
  for (let f = 0; f < BIG_FILE_COUNT; f++) {
    if (!block.includes(`src/module-${f}/deep/nested/path/file-${f}.ts`)) missing.push(f);
  }
  assert(missing.length === 0, `${label}: the summary names every one of the ${BIG_FILE_COUNT} files`);
  assert(
    notice.includes("inlined ") && notice.includes(`of ${BIG.length} characters`),
    `${label}: the notice carries the N-of-M character counts`,
  );
  assert(
    notice.includes("`git diff main...feature/x`"),
    `${label}: the notice names the supplied reread command`,
  );
  assert(
    notice.includes("in your working directory"),
    `${label}: the notice tells the reader where to run it`,
  );
  assert(BIG.startsWith(head), `${label}: the head is a verbatim prefix of the diff`);
  assert(
    !head.endsWith("\n") && BIG.startsWith(`${head}\n`),
    `${label}: the cut lands on a line boundary, not mid-line`,
  );
}

// The per-file counts come from the diff text, so they are exact and no git call ran.
{
  const files = summarizeDiffFiles(BIG);
  assert(files.length === BIG_FILE_COUNT, "summary: one row per changed file");
  assert(
    files.every((f) => f.added === 220 && f.removed === 0),
    "summary: added/removed counts parsed from the +/- body lines",
  );
  assert(
    files.every((f) => !f.path.startsWith("a/") && !f.path.includes(" b/")),
    "summary: the b/ path is named, not the raw header",
  );
}

// -------------------------------------------------- 2. no command: pasted diff

{
  const block = diffBlock(
    buildAdversarialPrompt({ diff: BIG, context: CONTEXT, round: 1, maxRounds: 3 }),
  );
  assert(
    block.includes("not available"),
    "pasted diff: the notice says the rest is not available",
  );
  assert(!block.includes("git diff"), "pasted diff: no reread command is invented");
  const fixBlock = diffBlock(buildFixPrompt({ findings: "f", context: CONTEXT, diff: BIG, round: 1 }));
  assert(
    fixBlock.includes("not available") && !fixBlock.includes("git diff"),
    "pasted diff: the fix prompt behaves the same",
  );
}

// ------------------------------------------- 3. under-cap: the prompt is unchanged

{
  const SMALL = syntheticDiff(4, 12);
  assert(SMALL.length < MAX_INLINE_DIFF_CHARS, `synthetic diff is under the cap (${SMALL.length})`);

  // Byte-for-byte the pre-bound prompt: the same template with the diff inlined
  // verbatim, which is what this module's own header promises.
  const expected = `You are reviewing the diff below. Context: ${CONTEXT}
Round: 1 of 3.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. Run lint/type/test if any. Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: MINOR_OBSERVATIONS
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Use the severity your role prompt defines. Only CRITICAL_ISSUES_FOUND blocks the commit; the others are recorded and carried into the pull request. Inflating a finding's severity to avoid approving is the worst failure mode of this role.

Diff:
\`\`\`diff
${SMALL}
\`\`\``;
  const actual = buildAdversarialPrompt({
    diff: SMALL,
    context: CONTEXT,
    round: 1,
    maxRounds: 3,
    // Supplied and still ignored: the bound only speaks when it cuts.
    diffRereadCommand: "git diff main...feature/x",
  });
  assert(actual === expected, "under cap: reviewer prompt is byte-identical to today's");

  const expectedFix = `Fix the following adversarial review findings. Original context: ${CONTEXT}
Round 1 fix.

Findings:
1. the thing

Make the minimal changes needed to address every finding. Run local quality gates before returning.

Current diff of the work so far:
\`\`\`diff
${SMALL}
\`\`\``;
  const actualFix = buildFixPrompt({
    findings: "1. the thing",
    context: CONTEXT,
    diff: SMALL,
    round: 1,
    diffRereadCommand: "git diff main...feature/x",
  });
  assert(actualFix === expectedFix, "under cap: fix prompt is byte-identical to today's");

  assert(
    boundDiffForPrompt(SMALL) === SMALL && boundDiffForPrompt(SMALL, "git diff a...b") === SMALL,
    "helper: an under-cap diff is returned unchanged",
  );
  assert(
    !diffBlock(actual).includes("truncated") && !diffBlock(actualFix).includes("truncated"),
    "under cap: no truncation notice anywhere",
  );
  assert(
    diffBlock(actual).length === SMALL.length,
    "under cap: the whole diff is inlined, nothing summarised",
  );
}

// ------------------------------------------ 4. helper boundaries (pure, direct)

{
  const atCap = "a".repeat(MAX_INLINE_DIFF_CHARS);
  assert(boundDiffForPrompt(atCap) === atCap, "helper: exactly at the cap is NOT truncated");
  // Content that is not a diff at all exercises only the notice path: a real
  // unified diff always begins with a `diff --git` header, so the head the
  // bound inlines never carries the word `git` that could confuse the match.
  const over = "hunk\n".repeat(30000);
  const bounded = boundDiffForPrompt(over, "git diff origin/main...feature/x");
  assert(
    bounded.includes("`git diff origin/main...feature/x`"),
    "helper: command threaded through the pure helper",
  );
  assert(!boundDiffForPrompt(over).includes("git diff"), "helper: no command, no suggestion");
  // A diff with no `diff --git` headers at all still bounds, and says so by count.
  const headerless = boundDiffForPrompt("x".repeat(200000));
  assert(
    headerless.includes(`of ${200000} characters`),
    "helper: a headerless diff is still bounded and counted",
  );
}

// -------------------------- 5. the real loop: which callers thread the command

/*
 * The prompt builders are pure; the interesting question is which CALLER knows
 * a range. Only the loop that ran `git diff <base>...<head>` itself may tell the
 * reviewer to run it — a notice naming a command nobody executed sends the
 * reviewer looking for a range it has none of. This drives the REAL
 * `runAdversarialLoop` twice over one scratch repo with the spawn seam mocked
 * (the shape test-adversarial-range-recompute.ts uses), so no child is spawned.
 */
const GO_DIFF = (() => {
  const lines: string[] = [];
  for (let f = 0; f < 40; f++) {
    const p = `pkg/file-${f}.go`;
    lines.push(`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, "@@ -0,0 +1,200 @@");
    for (let l = 0; l < 200; l++)
      lines.push(`+func case${f}_${l}() { return "${"y".repeat(60)}" }`);
  }
  return lines.join("\n");
})();

const repo = mkdtempSync(path.join(os.tmpdir(), "adv-diffcap-"));
try {
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);

  const prompts: Array<{ role: string; prompt: string }> = [];
  mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-diffcap",
    spawnSpecialist: async (spec: { role: string; prompt: string }) => {
      prompts.push({ role: spec.role, prompt: spec.prompt });
      return { role: spec.role, ok: true, text: "VERDICT: APPROVED", toolUses: [], ms: 1, exitCode: 0 };
    },
  }));
  const realDeck = await import("../src/dispatch-deck.ts");
  mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
    ...realDeck,
    startEntry: () => {},
    updateEntry: () => {},
    clearEntry: () => {},
    startBatchEntry: () => {},
    updateBatchProgress: () => {},
    clearBatchEntry: () => {},
  }));
  const realRegistry = await import("../src/async-jobs-registry.ts");
  mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
    ...realRegistry,
    childHandles: new Map(),
    registerChildHandle: () => {},
    setOrchestratorActiveChild: () => {},
    markOrchestrator: () => {},
  }));
  // The ledger is not under test and must not write into the scratch repo.
  const realLedger = await import("../src/adversarial-ledger.ts");
  mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
    ...realLedger,
    writeAdversarialLedgerEntry: () => undefined,
  }));

  const { runAdversarialLoop } = await import("../src/adversarial.ts");
  const signal = new AbortController().signal;

  // (a) the ref-range path: the loop ran the diff itself, so it names the command.
  // The diff computation is injected (the same seam #859 uses) so the test owns
  // the SIZE without committing 700 KB of synthetic Go.
  prompts.length = 0;
  await runAdversarialLoop(
    { context: "range", base: "main", head: "HEAD", workCwd: repo },
    signal,
    "job-range",
    async () => ({ ok: true as const, diff: GO_DIFF }),
  );
  const ranged = prompts.find((p) => p.role === "adversarial-developer");
  assert(ranged !== undefined, "loop: the ref-range path dispatched a reviewer");
  assert(
    ranged?.prompt.includes("diff truncated") === true,
    "loop (range): the oversized diff was bounded in the reviewer prompt",
  );
  assert(
    ranged?.prompt.includes("`git diff main...HEAD`") === true,
    "loop (range): the notice names the exact range the loop ran",
  );
  assert(
    ranged?.prompt.includes("pkg/file-39.go") === true,
    "loop (range): every file is still named after the bound",
  );

  // (b) the pasted-diff path: no caller ran a command, so the notice must not
  // invent one. This is the /work fan-out's shape — it fetches its own diff.
  prompts.length = 0;
  await runAdversarialLoop(
    { diff: GO_DIFF, context: "pasted", workCwd: repo },
    signal,
    "job-pasted",
  );
  const pasted = prompts.find((p) => p.role === "adversarial-developer");
  assert(
    pasted?.prompt.includes("diff truncated") === true,
    "loop (pasted): the oversized diff was bounded too",
  );
  assert(
    pasted?.prompt.includes("not available") === true &&
      pasted?.prompt.includes("`git diff") === false,
    "loop (pasted): no reread command is invented for a diff no caller computed",
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log(exit === 0 ? "\nOK" : `\nFAILED (${exit})`);
process.exit(exit);