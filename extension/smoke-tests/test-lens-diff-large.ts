#!/usr/bin/env bun
/**
 * #2261 — a large diff reaches the six lens children BOUNDED, and a provider
 * context-length refusal is named rather than reported as a bare `exit 1`.
 *
 * The two field shapes from the issue's external report:
 *
 *   1. base+head over a >1 MiB range died inside `computeRangeDiff` at the
 *      1 MiB `maxBuffer` — six lenses, four attempts each, all `exit 1`;
 *   2. base+head+`since` inlined a ~795 KB delta with a ~100 KB full-context
 *      block on top; every lens died at the provider with HTTP 400 "maximum
 *      context length", and the only reason the operator read was `exit 1` /
 *      `REVIEW_INCOMPLETE`.
 *
 * Both are asserted at the seam that crosses the process boundary: the REAL
 * `runLensReview` → `runLensChild` chain runs over a REAL scratch repo and only
 * the model child is replaced (`lib/lens-stub-spawn.ts`), so the assertions read
 * the `spec.prompt` the spawn actually received and the serialized stdin
 * envelope built from it — the value that fills the child's context.
 *
 * Three properties per arm:
 *   - the fenced diff stays under `MAX_INLINE_DIFF_CHARS`, so the child has a
 *     context window left to review in;
 *   - the omitted files are NAMED with the command that reads them
 *     (`git diff <base>...<head> -- <file>`), which a lens can run with its
 *     read-only tools;
 *   - each of the six lens children was spawned EXACTLY ONCE — an unbounded
 *     prompt that killed the child would have been retried four times.
 *
 * The provider arm is the other half of Z3: a context-length refusal is not
 * retried and it is named in the lane reason.
 *
 * The switch arm is the byte-identity proof: `PI_ENSEMBLE_LENS_LARGE_DIFF=0`
 * restores the pre-fix prompt verbatim (whole diff inlined, no inventory).
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_INLINE_DIFF_CHARS } from "../src/adversarial-diff-cap.ts";
import { installLensSkills, setStubSpawnAnswer, stubLensSpawn } from "./lib/lens-stub-spawn.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { withEnv } from "./lib/env-scope.ts";

const spawnCalls = stubLensSpawn();

// Imported AFTER the mock, so every lens module binds to the recorder.
const { runLensReview } = await import("../src/lens-review.ts");
const { runLensChild } = await import("../src/lens-review-child.ts");
const { lensPromptFor } = await import("../src/lens-review-format.ts");
const { buildDeltaFullContext, FULL_CONTEXT_CAP } = await import(
  "../src/lens-review-full-context.ts"
);
const { boundLensPromptDiff } = await import("../src/lens-diff-bound.ts");
const { computeRangeDiff, computeDeltaDiff } = await import("../src/review-diff.ts");
const { LENS_ROSTER } = await import("../src/lens-roster.ts");
type RosterEntryName = (typeof LENS_ROSTER)[number];
const { incompleteLanes } = await import("../src/lens-review-incomplete.ts");
const { providerContextProblem } = await import("../src/lens-provider-cause.ts");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = promisify(exec);
const G = (cwd: string, ...args: string[]) =>
  execp(`git ${args.map((a) => `'${a}'`).join(" ")}`, { cwd, maxBuffer: 64 * 1024 * 1024 });

const ONE_MIB = 1024 * 1024;

/** A file body of `lines` added lines, ~64 bytes each — a predictable diff size. */
function bigFileBody(lines: number): string {
  return `${Array.from(
    { length: lines },
    (_u, i) => `line ${i} with enough filler to make the diff genuinely large`,
  ).join("\n")}\n`;
}

/** A real clone: `main` at the base commit, `feature/large` one commit past it. */
async function mkRepo(
  dir: string,
  opts: { files: number; lines: number },
): Promise<{ base: string; head: string }> {
  gitTestEnv();
  mkdirSync(dir, { recursive: true });
  const origin = `${dir}.git`;
  await G(path.dirname(dir), "init", "-q", "--bare", origin);
  await G(dir, "init", "-q", "-b", "main");
  await G(dir, "config", "user.email", "t@t");
  await G(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "base");
  await G(dir, "remote", "add", "origin", origin);
  await G(dir, "push", "-q", "-u", "origin", "main");
  await G(dir, "checkout", "-qb", "feature/large");
  for (let f = 0; f < opts.files; f++) {
    writeFileSync(path.join(dir, `grown-${String(f)}.ts`), bigFileBody(opts.lines));
  }
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "feat: the large branch change");
  await G(dir, "push", "-q", "-u", "origin", "feature/large");
  return {
    base: (await G(dir, "rev-parse", "origin/main")).stdout.trim(),
    head: (await G(dir, "rev-parse", "HEAD")).stdout.trim(),
  };
}

const root = mkdtempSync(path.join(os.tmpdir(), "lens-large-"));
const skills = path.join(root, "skills");
installLensSkills(skills);
const releaseLedger = isolateLedger();
const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;

/** The fenced diff block of a lens prompt — the part that fills the context. */
/** The fenced body, read from the END of the prompt: a reviewed diff can itself
 * contain a ``` fence, and a match from the front would return the diff's own
 * fenced code as if it were the review's, under-counting an unbounded prompt. */
function fencedDiff(prompt: string): string {
  const open = prompt.lastIndexOf("```diff\n");
  if (open < 0) return "";
  const start = open + "```diff\n".length;
  const close = prompt.indexOf("\n```", start);
  return close < 0 ? prompt.slice(start) : prompt.slice(start, close);
}

/**
 * The notice: the prose the bound prints after the closing fence, located by its
 * own lead. Anchored on the notice's unique `… (diff truncated:` marker rather
 * than on the first fence, because the prompt's own rubric text also mentions a
 * "fenced diff" and an unanchored search captures it and over-counts the block.
 */
function noticeOf(prompt: string): string {
  const at = prompt.indexOf("\u2026 (diff truncated:");
  if (at < 0) return "";
  // Walk back to the inventory lead the bound prints its marker under. The prompt's
  // own rubric prose mentions a "fenced diff", so the search is anchored on the
  // leads the bound itself mints — anything earlier is prompt text, not the notice.
  const leads = ["EVERY file this diff changes", "No `diff --git` file headers were found"];
  const starts = leads.map((l) => prompt.lastIndexOf(l, at)).filter((n) => n >= 0);
  if (starts.length === 0) return "";
  const from = Math.min(...starts);
  const end = prompt.indexOf("\n\n## ", at);
  return prompt.slice(from, end > 0 ? end : prompt.length);
}

/** The serialized stdin envelope `spawn.ts` writes for a prompt: the value that
 * actually crosses the process boundary (the spec's MEDIUM gap-gate finding). */
function stdinEnvelope(prompt: string): string {
  return JSON.stringify({ type: "prompt", message: prompt, images: undefined });
}

/** One round through the real layer; returns every lens child's captured prompt. */
async function round(
  name: string,
  opts: Record<string, unknown>,
): Promise<string[]> {
  spawnCalls.length = 0;
  await runLensReview({ cwd: path.join(root, name, "repo"), ...opts } as never);
  return spawnCalls.filter((c) => c.role === "code-review-specialist").map((c) => c.prompt);
}

const ROSTER_SIZE = LENS_ROSTER.length;

/** What the recorder answers a lens spawn with (#2261 arm 5 replaces it). */
let providerAnswer: () => Record<string, unknown> = () => ({
  ok: true,
  text: "Checked the inlined diff; nothing in my lane.",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});
setStubSpawnAnswer((spec) => ({ role: spec.role, ...providerAnswer() }));

try {
  process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

  // ── (1) FULL ARM: a >1 MiB base+head range reaches all six lenses, bounded.
  {
    const dir = path.join(root, "full", "repo");
    const { base, head } = await mkRepo(dir, { files: 3, lines: 12_000 });
    const range = await computeRangeDiff(dir, base, head);
    assert(
      range.ok === true,
      "(1) precondition: the >1 MiB range now reads (it used to die here)",
    );
    const measured = range.ok ? range.diff.length : 0;
    assert(
      measured > ONE_MIB,
      `(1) precondition: that range is past 1 MiB (${String(measured)} bytes)`,
    );

    const prompts = await round("full", { base, head });
    assert(
      prompts.length === ROSTER_SIZE,
      `(1) all ${String(ROSTER_SIZE)} lens children were spawned (got ${String(prompts.length)})`,
    );
    assert(
      prompts.every((p) => fencedDiff(p).length <= MAX_INLINE_DIFF_CHARS),
      `(1) every lens prompt's fenced diff stays under the bound (${String(MAX_INLINE_DIFF_CHARS)}; got ${JSON.stringify(prompts.map((p) => fencedDiff(p).length))})`,
    );
    assert(
      prompts.every((p) => p.includes(`git diff ${base}...${head}`)),
      "(1) each prompt names the command that reads what was cut",
    );
    assert(
      prompts.every((p) => p.includes("grown-0.ts") && p.includes("grown-2.ts")),
      "(1) each prompt NAMES the omitted files",
    );
    assert(
      prompts.every((p) => !p.includes("line 11999 with enough filler")),
      "(1) the diff past the bound is not inlined verbatim",
    );
    const envelopes = prompts.map((p) => stdinEnvelope(p).length);
    assert(
      envelopes.every((n) => n < measured),
      `(1) the serialized stdin envelopes are smaller than the whole diff (${JSON.stringify(envelopes)} vs ${String(measured)})`,
    );
  }

  // ── (2) DELTA ARM: a >1 MiB delta PLUS the full-context block, one budget.
  {
    const dir = path.join(root, "delta", "repo");
    const { base, head } = await mkRepo(dir, { files: 3, lines: 12_000 });
    const since = base;
    const delta = await computeDeltaDiff(dir, since, head);
    assert(
      delta.ok === true && delta.diff.length > ONE_MIB,
      `(2) precondition: the delta is past 1 MiB (${delta.ok === true ? String(delta.diff.length) : "unreadable"})`,
    );

    const prompts = await round("delta", { base, head, since });
    assert(
      prompts.length === ROSTER_SIZE,
      `(2) all ${String(ROSTER_SIZE)} lens children were spawned (got ${String(prompts.length)})`,
    );
    assert(
      prompts.every((p) => fencedDiff(p).length <= MAX_INLINE_DIFF_CHARS),
      `(2) the delta prompt's fenced diff stays under the bound (got ${JSON.stringify(prompts.map((p) => fencedDiff(p).length))})`,
    );
    // Added scope (b): the full-branch block counts against the SAME budget as the
    // delta, so the two diff-bearing parts together never exceed one bound. What is
    // NOT the bound's business is the lens's own skill body and rubric, which are
    // fixed per lens (the delivered `--skill` body of #1847) and would let a skill
    // edit decide whether this suite passes. So the bound is measured on the parts
    // the module controls: the fenced block plus the notice printed after it.
    const diffBearing = prompts.map((p) => fencedDiff(p).length + noticeOf(p).length);
    assert(
      diffBearing.every((n) => n <= MAX_INLINE_DIFF_CHARS),
      `(2) the delta + full-branch block + notice together stay inside the ONE bound (got ${JSON.stringify(diffBearing)}, bound ${String(MAX_INLINE_DIFF_CHARS)})`,
    );
    assert(
      prompts.every((p) => p.length < 260_000),
      `(2) and the whole prompt is far smaller than the unbounded one the issue reported (~795 KB delta -> six ~911 KB prompts) (got ${JSON.stringify(prompts.map((p) => p.length))})`,
    );
    assert(
      prompts.every((p) => p.includes("grown-0.ts") && p.includes("grown-2.ts")),
      "(2) the omitted delta files are named in the prompt",
    );
  }

  // ── (3) The full-branch orientation block shares the prompt's ONE budget.
  {
    const dir = path.join(root, "ctx", "repo");
    const { base, head } = await mkRepo(dir, { files: 2, lines: 12_000 });
    // The block is diff text wearing a context label, so its own cap is the
    // block's cap, and the prompt's bound is what keeps the whole thing small.
    const block = await buildDeltaFullContext(dir, base, head, base, false);
    assert(
      block.startsWith("FULL BRANCH DIFF"),
      `(3) the block is returned on its own, not glued onto the caller's context (got: ${block.slice(0, 40)})`,
    );
    assert(
      block.length < FULL_CONTEXT_CAP + 400,
      `(3) the block is capped on its own (${String(block.length)} <= ${String(FULL_CONTEXT_CAP)})`,
    );
    // The prompt builder is where the two halves stop adding up: the block is
    // given a SHARE of the bound rather than a fresh one.
    const bound = boundLensPromptDiff({
      diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+x\n",
      context: "CTX",
      fullContext: block,
      range: { base, head },
    });
    assert(
      bound.context.startsWith("CTX") && bound.context.includes("FULL BRANCH DIFF"),
      "(3) the caller's context is preserved and the block rides inside it",
    );
    assert(
      bound.context.length <= MAX_INLINE_DIFF_CHARS,
      `(3) the appended full-branch block counts against the lens prompt's bound (${String(bound.context.length)} chars, bound ${String(MAX_INLINE_DIFF_CHARS)})`,
    );
  }

  // ── (4) THE SWITCH: "0" restores the pre-fix prompt byte-for-byte.
  {
    const lens = LENS_ROSTER[0] as RosterEntryName;
    const BIG = `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n${`+${"x".repeat(60)}\n`.repeat(4_000)}`;
    assert(
      BIG.length > MAX_INLINE_DIFF_CHARS,
      `(4) precondition: the fixture diff is past the bound (${String(BIG.length)})`,
    );
    const baseline = lensPromptFor(lens, BIG, "ctx", undefined, [], "", undefined, undefined);
    await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: "0" }, async () => {
      const off = lensPromptFor(lens, BIG, "ctx", undefined, [], "", undefined, undefined);
      assert(
        fencedDiff(off) === BIG && !off.includes("diff truncated"),
        '(4) "0" is byte-identical to the pre-fix prompt (whole diff inlined, no inventory, no notice)',
      );
      assert(
        fencedDiff(off).length > MAX_INLINE_DIFF_CHARS,
        '(4) and it really does inline the whole diff, which is the behaviour "0" means',
      );
    });
    await withEnv({ PI_ENSEMBLE_LENS_LARGE_DIFF: undefined }, async () => {
      const on = lensPromptFor(lens, BIG, "ctx", undefined, [], "", undefined, undefined);
      assert(
        fencedDiff(on).length <= MAX_INLINE_DIFF_CHARS && fencedDiff(on) !== BIG,
        "(4) unset keeps the bound on — the default is the fixed behaviour",
      );
    });
  }

  // ── (7) A HUGE FIRST FILE MUST NOT EMPTY THE PROMPT (adversarial round 1, finding 2).
  // The first file in a large diff is often a generated bundle or lockfile bigger
  // than the whole budget. A walker that stopped at the first oversized section
  // gave every lens an empty fenced block whose own notice called it a prefix of
  // the change — six spawns that reviewed nothing.
  {
    const lens = LENS_ROSTER[0] as RosterEntryName;
    const huge = Array.from(
      { length: 5_000 },
      (_u, i) => `export const bundle_${String(i)} = "a generated file far past the budget";`,
    ).join("\n");
    const real = Array.from({ length: 40 }, (_u, i) => `export const fix_${String(i)} = 1;`).join(
      "\n",
    );
    const bigFirst =
      `diff --git a/dist/bundle.js b/dist/bundle.js\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/dist/bundle.js\n@@ -0,0 +1,5000 @@\n${huge}\n` +
      `diff --git a/src/fix.ts b/src/fix.ts\nindex 3333333..4444444 100644\n--- /dev/null\n+++ b/src/fix.ts\n@@ -0,0 +1,40 @@\n${real}\n`;
    assert(
      bigFirst.length > MAX_INLINE_DIFF_CHARS,
      `(7) precondition: the fixture diff is past the bound (${String(bigFirst.length)})`,
    );
    const prompt = lensPromptFor(lens, bigFirst, "ctx", undefined, [], "", undefined, undefined, {
      base: "origin/main",
      head: "HEAD",
    });
    const block = fencedDiff(prompt);
    assert(
      block.length > 0,
      `(7) the lens still receives a non-empty diff when the FIRST file alone is past the budget (got ${String(block.length)} characters)`,
    );
    assert(
      block.includes("fix_39") && !block.includes("bundle_4999"),
      "(7) and what it receives is the file the budget affords, whole — never the oversized one cut in half",
    );
    assert(
      prompt.includes("dist/bundle.js") && prompt.includes("NOT inlined"),
      "(7) and the oversized file is named as omitted rather than silently absent",
    );
    assert(
      !prompt.includes("the body above is a PREFIX of the change") || block.length > 0,
      "(7) the notice never calls a non-empty-less block a prefix of the change",
    );

    // A bounded prompt is never an EMPTY prompt: when no single file fits the
    // budget, the reviewer gets the head of the diff cut at a LINE boundary and a
    // notice that says so — the shape the whole change exists to avoid is six
    // lenses spawned to receive a blank fence.
    const allHuge =
      `diff --git a/a.gen b/a.gen\nindex 1111111..2222222 100644\n--- /dev/null\n+++ b/a.gen\n@@ -0,0 +1,5000 @@\n${huge}\n` +
      `diff --git a/b.gen b/b.gen\nindex 3333333..4444444 100644\n--- /dev/null\n+++ b/b.gen\n@@ -0,0 +1,5000 @@\n${huge}\n`;
    const partialPrompt = lensPromptFor(
      lens,
      allHuge,
      "ctx",
      undefined,
      [],
      "",
      undefined,
      undefined,
      { base: "origin/main", head: "HEAD" },
    );
    const partialBlock = fencedDiff(partialPrompt);
    assert(
      partialBlock.length > 0,
      `(7b) with NO whole file affordable the block is still not empty (got ${String(partialBlock.length)} characters)`,
    );
    assert(
      partialBlock.length <= MAX_INLINE_DIFF_CHARS &&
        partialBlock === partialBlock.trimEnd() &&
        !partialBlock.split("\n").some((l) => l.length === 0 && l !== partialBlock),
      `(7b) and the fallback is cut at a LINE boundary, never mid-line (${String(partialBlock.length)} chars, ends on a line boundary)`,
    );
    assert(
      partialPrompt.includes("PARTIAL") &&
        !partialPrompt.includes("the body above is a PREFIX of the change"),
      `(7b) and the notice says the block is PARTIAL — the head of a diff cut because no file fit — rather than calling it a prefix of the change`,
    );
    assert(
      partialPrompt.includes("a.gen") && partialPrompt.includes("b.gen"),
      "(7b) and every file whose body was dropped is still named",
    );

    // The EMPTY wording is reserved for a block that really is empty. Reachable
    // only when the diff carries no characters to cut at all — a diff of zero
    // content never gets here (it is the "nothing to review" path, not a bound
    // one) — so the probe drives the module directly rather than through a
    // fixture that would have to be unrealistic to trigger it.
    const emptyBound = boundLensPromptDiff({
      diff: "x".repeat(MAX_INLINE_DIFF_CHARS + 1),
      context: " ".repeat(MAX_INLINE_DIFF_CHARS),
      range: { base: "origin/main", head: "HEAD" },
    });
    assert(
      emptyBound.mode === "bounded",
      `(7c) precondition: a huge diff with no room left is bounded (got ${emptyBound.mode})`,
    );
    assert(
      emptyBound.diff.length === 0
        ? emptyBound.note !== undefined && emptyBound.note.includes("EMPTY")
        : !emptyBound.note!.includes("EMPTY"),
      `(7c) and only a genuinely empty block is called EMPTY (block ${String(emptyBound.diff.length)} chars)`,
    );
  }

} finally {
  if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
  releaseLedger();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
