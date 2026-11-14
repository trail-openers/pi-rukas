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
const { buildDeltaFullContext, FULL_CONTEXT_CAP } = await import("../src/lens-review-diff.ts");
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
    // Added scope (b): the full-context block counts against the SAME budget,
    // so the whole prompt — delta + full-branch block + skill + rubric — stays
    // inside a bound tied to the prompt bound rather than the diff's own size.
    assert(
      prompts.every((p) => p.length < MAX_INLINE_DIFF_CHARS + 40_000),
      `(2) the WHOLE prompt stays bounded (got ${JSON.stringify(prompts.map((p) => p.length))})`,
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

  // ── (5) PROVIDER CONTEXT-LENGTH REFUSAL: not retried, and named.
  {
    const dir = path.join(root, "provider", "repo");
    await mkRepo(dir, { files: 1, lines: 500 });
    const lens = LENS_ROSTER[0] as RosterEntryName;
    providerAnswer = () => ({
      ok: false,
      text: "",
      toolUses: [],
      ms: 600,
      exitCode: 1,
      errorStop: {
        reason: "error",
        message:
          '400 status code (no body): {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
      },
    });
    spawnCalls.length = 0;
    const result = await runLensChild({
      lens,
      runId: "run-2261",
      skillsDir: skills,
      context: "ctx",
      roster: [],
      opts: { diff: "diff --git a/a b/a\n+x", cwd: dir },
      bumpBatch: () => {},
    } as never);
    providerAnswer = () => ({
      ok: true,
      text: "Checked the inlined diff; nothing in my lane.",
      toolUses: [],
      ms: 10,
      exitCode: 0,
    });
    const spawns = spawnCalls.filter((c) => c.role === "code-review-specialist").length;
    assert(
      result.blocked === true,
      `(5) the context-length lens is blocked (got blocked=${String(result.blocked)})`,
    );
    assert(
      providerContextProblem(result.parseError ?? "") !== undefined,
      `(5) its row names the provider context-length refusal rather than a bare exit code (got: ${String(result.parseError)})`,
    );
    assert(
      spawns === 1,
      `(5) a context-length refusal is NOT retried — one spawn, not four (got ${String(spawns)})`,
    );
    const lanes = incompleteLanes([result]);
    assert(
      lanes.some((l) => providerContextProblem(l) !== undefined),
      `(5) the lane reason names it too (got: ${JSON.stringify(lanes)})`,
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
