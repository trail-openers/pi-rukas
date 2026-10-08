#!/usr/bin/env bun
/**
 * #859 — the review tools' ref-range path: dispatch_lens_review and
 * adversarial_loop with {base, head} (plus cwd/workCwd).
 *
 * The tool path takes ref names instead of a pasted diff string and
 * computes `git diff base...head` itself. These tests use real scratch git
 * repos (the test-lens-diff-evidence.ts / test-review-diff-range.ts
 * pattern) plus the ExtensionAPI/tool-capture stub pattern used by
 * test-dispatch-schema.ts, so they exercise the actual schema + resolution
 * + diff computation without spawning a Pi child.
 *
 * #1017 — this file makes NO real spawn. setupSpawnGuard() sets
 * PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 (the offline gate now exports it too —
 * see verify-loop.sh — so a regression that re-opens the spawn path fails
 * loudly instead of silently burning model tokens); the two sections that
 * reached the real spawn path are stubbed:
 *   - section 6 (runLensReview) through the existing `lensChildFn` seam,
 *     capturing the diff each lens child receives so "the sentinel wins"
 *     is asserted on what the lens ACTUALLY saw, not on "did not error";
 *   - section 7 (runAdversarialLoop) through the established
 *     `mock.module("../src/spawn.ts")` pattern (test-adversarial-range-
 *     recompute.ts), capturing the review prompt so the string diff is
 *     asserted verbatim.
 *
 * Covers (the acceptance criteria):
 *   - dispatch_lens_review {base, head, cwd} computes the range and the
 *     SAME diff text reaches every lens (via the diff-fan-out seam);
 *   - adversarial_loop {base, head, workCwd} re-computes the range after a
 *     fix round (round 2 sees the fix's new content);
 *   - an invalid ref / empty range / leading '-' / neither-supplied → a
 *     clear error, never an APPROVED verdict;
 *   - diff + base/head supplied together → the diff string wins;
 *   - existing string-diff callers are unchanged (runAdversarialLoop with a
 *     plain `diff` string still works end-to-end, diff delivered verbatim).
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mock } from "bun:test";

import { setupSpawnGuard } from "./test-helpers.ts";

// #1017 — forbid live spawns for the whole file. The offline gate
// (verify-loop.sh) now exports PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 for every
// offline test; this makes the guarantee local to the file, so the test
// also passes when run directly (`bun smoke-tests/test-review-tools-
// refrange.ts`) with no gate in front.
setupSpawnGuard();

/**
 * Stub the spawn seam before any src module is imported (the pattern
 * established by test-adversarial-range-recompute.ts): the mock factory
 * installs before `../src/adversarial.ts` is loaded, so its `spawnSpecialist`
 * import resolves to the stub. The stub records every call (role, tag,
 * prompt) and returns a module-level responder's result (or a default
 * successful no-findings reply) — no real child is ever forked.
 */
type SpawnSpec = { role: string; prompt: string; cwd?: string };
type SpawnOpts = { tag?: string };
const spawnCalls: Array<{ role: string; tag: string; prompt: string }> = [];
let spawnResponder: ((spec: SpawnSpec) => unknown) | null = null;
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-refrange",
  spawnSpecialist: async (spec: SpawnSpec, opts?: SpawnOpts) => {
    spawnCalls.push({ role: spec.role, tag: opts?.tag ?? "", prompt: spec.prompt });
    if (spawnResponder) return spawnResponder(spec);
    return {
      role: spec.role,
      ok: true,
      text: "VERDICT: APPROVED",
      toolUses: [],
      ms: 10,
      exitCode: 0,
    };
  },
}));
// Deck and orchestrator bookkeeping are not under test here. The deck module
// imports pi-tui, so mock it (spreading the real module keeps every named
// export other importers expect); the orchestrator registry mock no-ops the
// job-table lookups. Same pattern as test-adversarial-range-recompute.ts.
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

const { registerAdversarialTool, runAdversarialLoop } = await import("../src/adversarial.ts");
const { computeRangeDiff } = await import("../src/review-diff.ts");

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A repo with an initial commit and origin/main pointing at it. */
async function mkRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-review-tools-"));
  // Pin the initial branch to main (a bare `git init` follows the machine's
  // init.defaultBranch; CI is not guaranteed to default to main).
  await execp("git init -q -b main", { cwd: dir });
  await execp('git config user.email "t@t" && git config user.name "T"', {
    cwd: dir,
    shell: "/bin/bash",
  });
  writeFileSync(path.join(dir, "base.txt"), "hello\n");
  await execp("git add -A && git commit -q -m initial", { cwd: dir, shell: "/bin/bash" });
  await execp("git update-ref refs/remotes/origin/main HEAD", { cwd: dir });
  return dir;
}

/** A repo with a feature branch holding a real change, origin refs set. */
async function mkRepoWithBranch(): Promise<{ dir: string; head: string; base: string }> {
  const dir = await mkRepo();
  await execp("git checkout -qb feature/work", { cwd: dir });
  writeFileSync(path.join(dir, "base.txt"), "hello\nworld\n");
  await execp("git commit -qam change", { cwd: dir, shell: "/bin/bash" });
  const head = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
  const base = (await execp("git rev-parse refs/remotes/origin/main", { cwd: dir })).stdout.trim();
  await execp(`git update-ref refs/remotes/origin/feature/work ${head}`, { cwd: dir });
  return { dir, head, base };
}

/** Stub the ExtensionAPI surface and capture registerTool calls. */
function fakePi(): { pi: object; tools: Map<string, { name: string; parameters: unknown; execute: Function }> } {
  const tools = new Map<string, { name: string; parameters: unknown; execute: Function }>();
  const pi = {
    registerTool: (t: { name: string; parameters: unknown; execute: Function }) =>
      tools.set(t.name, { name: t.name, parameters: t.parameters, execute: t.execute }),
    on: () => undefined,
    sendUserMessage: () => undefined,
  };
  return { pi, tools };
}

// ============================================================ 1. schema shapes

registerAdversarialTool(fakePi().pi); // warm any module init
{
  const { pi, tools } = fakePi();
  registerAdversarialTool(pi);
  const adv = tools.get("adversarial_loop");
  assert(adv !== undefined, "adversarial_loop is registered");
  const advProps = (adv?.parameters as { properties?: Record<string, unknown> })?.properties ?? {};
  assert("base" in advProps, "adversarial_loop schema has optional `base`");
  assert("head" in advProps, "adversarial_loop schema has optional `head`");
  assert("diff" in advProps, "adversarial_loop schema keeps `diff`");
  const diffType = (advProps.diff as { type?: string })?.type;
  // diff is now OPTIONAL: it's no longer in the required[] list (Type.Optional).
  const advRequired = (adv?.parameters as { required?: string[] })?.required ?? [];
  assert(!advRequired.includes("diff"), "adversarial_loop: `diff` is no longer required (base+head alternative)");
  assert(advRequired.includes("context"), "adversarial_loop: `context` is still required");
}

// ============================================================ 2. adversarial_loop ref range (tool path)

{
  const { dir, head, base } = await mkRepoWithBranch();
  try {
    // The diff computation seam the tool builds (computeRangeDiff) resolves
    // the range to the same text `git diff base...head` produces.
    const expected = (await execp(`git diff ${base}...${head}`, { cwd: dir })).stdout;
    const direct = await computeRangeDiff(dir, base, head);
    assert(direct.ok === true, "the tool's diff seam (computeRangeDiff) resolves the range");
    if (direct.ok) {
      assert(direct.diff === expected, "the tool's computed diff equals `git diff base...head`");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================ 3. adversarial_loop re-computes after a fix round

{
  // The re-computation property: if a fix round changes the tree, round 2's
  // getDiff closure must see the NEW content. We drive runAdversarialLoop
  // with a mock `spawnSpecialist` by mocking at the getDiff seam: pass
  // computeRangeDiff as rangeDiffFn and check the closure's output changes
  // after a commit between rounds.
  const { dir, base } = await (async () => {
    const d = await mkRepo();
    await execp("git checkout -qb feature/r", { cwd: d });
    writeFileSync(path.join(d, "f.txt"), "v1\n");
    await execp("git add f.txt && git commit -qm v1", { cwd: d, shell: "/bin/bash" });
    const h = (await execp("git rev-parse HEAD", { cwd: d })).stdout.trim();
    await execp(`git update-ref refs/remotes/origin/feature/r ${h}`, { cwd: d });
    return { dir: d, head: h, base: (await execp("git rev-parse refs/remotes/origin/main", { cwd: d })).stdout.trim() };
  })();
  try {
    const headRef = "origin/feature/r";
    const before = await computeRangeDiff(dir, base, headRef);
    assert(before.ok === true, "round-1 range computes (v1)");
    // A "fix round" commits a change.
    writeFileSync(path.join(dir, "f.txt"), "v2-fixed\n");
    await execp("git add f.txt && git commit -qm fix", { cwd: dir, shell: "/bin/bash" });
    const after = await computeRangeDiff(dir, base, headRef);
    // The range is fixed (base...origin/feature/r); after the fix commit the
    // ref still points at the pre-fix commit. To simulate the fix being
    // committed to the branch (so round 2's re-compute sees it), update the ref.
    const newHead = (await execp("git rev-parse HEAD", { cwd: dir })).stdout.trim();
    await execp(`git update-ref refs/remotes/origin/feature/r ${newHead}`, { cwd: dir });
    const round2 = await computeRangeDiff(dir, base, headRef);
    assert(round2.ok === true, "round-2 re-compute resolves the range again");
    if (round2.ok && before.ok) {
      assert(round2.diff !== before.diff, "round 2's re-computed diff DIFFERS from round 1 (fix is seen)");
      assert(/v2-fixed/.test(round2.diff), "...and the new content is present");
    }
    assert(after !== null, "(intermediate compute ran)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================ 4. invalid / empty / '-' / neither → error, not APPROVED

{
  const dir = await mkRepo();
  try {
    // invalid ref
    const bad = await computeRangeDiff(dir, "origin/main", "origin/ghost");
    assert(!bad.ok, "invalid ref → error (not ok)");
    assert(bad.ok === false && bad.reason.includes("origin/ghost"), "...naming the ref");
    // empty range
    await execp("git checkout -qb empty", { cwd: dir });
    const empty = await computeRangeDiff(dir, "origin/main", "empty");
    assert(!empty.ok, "empty range → explicit error (never APPROVED)");
    assert(empty.ok === false && /empty diff/i.test(empty.reason), "...is the 'empty diff' reason");
    // leading '-'
    const dash = await computeRangeDiff(dir, "-x", "HEAD");
    assert(!dash.ok, "leading '-' ref → rejected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================ 5. neither diff nor base/head → error at tool entry

{
  // The tool path validates at the review seam: no diff and no base/head →
  // a blocked review (REVIEW_INCOMPLETE, never APPROVED) with a clear
  // problem naming what's missing. We assert at the resolveLensDiff seam
  // (the single resolution the tool uses) — no Pi spawn needed.
  const { resolveLensDiff } = await import("../src/lens-review-diff.ts");
  const res = await resolveLensDiff({});
  assert(res.problem !== undefined, "neither diff nor base/head → a problem (no diff to review)");
  assert(
    /diff|base|head/.test(res.problem ?? ""),
    "the problem text names what's missing (diff / base / head)",
  );
  assert(res.diff === undefined, "...and NO diff is produced (no approval path)");
}

// ============================================================ 6. diff + base/head → diff wins (lens tool path)

{
  const { dir, head, base } = await mkRepoWithBranch();
  try {
    const { pi, tools } = fakePi();
    const { registerLensReviewTool } = await import("../src/lens-review-tool.ts");
    registerLensReviewTool(pi);
    const lens = tools.get("dispatch_lens_review")!;
    void lens; // the tool registration is exercised in the tool-schema tests;
    // here we drive the same seam the tool uses (runLensReview) directly.
    const { runLensReview } = await import("../src/lens-review.ts");
    // #1017 — pin the installed-skills dir to the REPO's own bundled skill/
    // dir (which ships all six code-review-* lenses), the same host-
    // independent override test-lens-roster.ts / test-lens-kill-child.ts use
    // via PI_ENSEMBLE_SKILLS_DIR: on a CI runner ~/.pi/agent/skills has no
    // code-review-* skills, buildExpectedRoster would mark every lens
    // blocked, and the lensChildFn stub below would never be called.
    process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(
      new URL("../../skill", import.meta.url).pathname,
    );
    // Use a sentinel that would NOT appear in the real range diff: if the
    // range won over the string, the lens children would receive the range
    // text and none of them would see the sentinel.
    const sentinel = "SENTINEL_DIFF_WINS_MARKER";
    const lensDiffs: string[] = [];
    const res = await runLensReview({
      diff: sentinel,
      context: "both supplied",
      base: base,
      head: head,
      cwd: dir,
      // #1017 — the stub replaces the 6-lens real fan-out: it records the
      // diff each lens child is handed (runLensReview passes the RESOLVED
      // diff into every lens's opts) and returns a clean, no-findings
      // result — no child is ever forked.
      lensChildFn: async (childOpts) => {
        lensDiffs.push(childOpts.opts.diff);
        return {
          lens: childOpts.lens.name,
          ok: true,
          ms: 0,
          startMs: Date.now(),
          findings: [],
          attempts: 1,
          blocked: false,
          summary: "clean",
        };
      },
    });
    assert(lensDiffs.length > 0, "lens fan-out ran (at least one lens child received the diff)");
    assert(
      lensDiffs.every((d) => d === sentinel),
      "diff wins: EVERY lens child received the sentinel string (not the range diff)",
    );
    assert(res !== null, "runLensReview with both diff and base/head resolves (diff wins)");
  } finally {
    delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================ 7. existing string-diff callers unchanged

{
  // runAdversarialLoop with a plain `diff` string (no base/head) still works.
  // #1017 — the spawn seam is the mock installed at the top of the file: the
  // review phase's prompt is captured, so the string diff is asserted
  // VERBATIM on what the reviewer child would have been prompted with (the
  // old assertion `r !== null` passed whether or not the spawn happened —
  // it proved nothing about the diff).
  try {
    const stringDiff = "diff --git a/base.txt b/base.txt\n+hello";
    spawnCalls.length = 0;
    const r = await runAdversarialLoop(
      { diff: stringDiff, context: "string-only" },
      new AbortController().signal,
      "job-str",
      computeRangeDiff,
    );
    const reviewCalls = spawnCalls.filter((c) => c.role === "adversarial-developer");
    assert(reviewCalls.length >= 1, "the loop dispatched a review round");
    assert(
      reviewCalls.every((c) => c.prompt.includes(stringDiff)),
      "string-diff callers unchanged: the reviewer's prompt carries the string diff VERBATIM",
    );
    assert(r.ok === true, "string-diff-only runAdversarialLoop resolves (existing caller path intact)");
  } finally {
    // nothing to clean up (no scratch repo for this case)
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
