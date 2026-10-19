#!/usr/bin/env bun
/**
 * #1655 — the driver's side of the write fence: which dispatches are fenced,
 * how the child's environment carries the fence, and how the cycle counts and
 * reports the refusals.
 *
 *   A. the env a fenced dispatch's child gets, and none for an unfenced one;
 *   B. only the develop and fix-developer dispatches CONSTRUCT a fence (a canary
 *      over the source: explore, plan, review and policy children never do);
 *   C. the cycle's count is summed from the scratch-dir logs, is idempotent
 *      across step boundaries, and is cleared by a restart;
 *   D. a parked handoff names the refusal count, and a clean one does not.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CycleContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { foldWriteFenceCount, resetWriteFenceLogs } from "../src/work-driver-write-fence.ts";
import { initialState } from "../src/workflow-state-update.ts";
import { childEnvFor, writeFenceChildEnv } from "../src/write-fence-contract.ts";
import {
  appendWriteFenceRefusal,
  clearWriteFenceLogs,
  countWriteFenceRefusals,
  unscratchedDir,
} from "../src/write-fence-log.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");
const ISSUE = 1655;

// ============================================================
// A. The child's environment.
// ============================================================
assert(
  Object.keys(writeFenceChildEnv(undefined)).length === 0,
  "A: an unfenced child gets no write-fence env (the fence stays off for it)",
);
{
  const env = writeFenceChildEnv({ root: "/w/wt", repo: "/w/repo", scratch: "/w/tmp/issue-1655" });
  assert(
    env.PI_ENSEMBLE_WRITE_ROOT === "/w/wt" &&
      env.PI_ENSEMBLE_WRITE_REPO === "/w/repo" &&
      env.PI_ENSEMBLE_WRITE_SCRATCH === "/w/tmp/issue-1655",
    "A: a fenced child gets PI_ENSEMBLE_WRITE_ROOT, _REPO and _SCRATCH",
  );
  // The child inherits no fence setting from its parent: a process with an ambient root spawns an unfenced child.
  const inherited = childEnvFor(
    {
      PI_ENSEMBLE_WRITE_ROOT: "/ambient/root",
      PI_ENSEMBLE_WRITE_REPO: "/ambient/repo",
      PI_ENSEMBLE_WRITE_SCRATCH: "/ambient/scratch",
      PATH: "/bin",
    },
    "explore",
  );
  assert(
    inherited.PI_ENSEMBLE_WRITE_ROOT === undefined &&
      inherited.PI_ENSEMBLE_WRITE_REPO === undefined &&
      inherited.PI_ENSEMBLE_WRITE_SCRATCH === undefined &&
      inherited.PATH === "/bin" &&
      inherited.PI_ENSEMBLE_ROLE === "explore",
    "A: an unfenced child never inherits an ambient write root, repo or scratch (other env and its role kept)",
  );
}
{
  const spawn = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  assert(
    spawn.includes("writeFenceChildEnv(opts.writeFence)"),
    "A: spawn.ts builds the child env from the dispatch's writeFence",
  );
}

// ============================================================
// B. Which dispatches construct a fence: canary over the source.
// ============================================================
{
  const constructs = /writeFence:\s*\{\s*root:/;
  const fenced = readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && constructs.test(readFileSync(path.join(SRC, f), "utf8")))
    .sort();
  assert(
    JSON.stringify(fenced) ===
      JSON.stringify(["work-develop-run.ts", "work-driver-corrective-round.ts", "work-driver-lens-fix.ts"]),
    `B: only the develop, corrective-round and lens-fix developer dispatches build a fence (got ${fenced.join(", ")})`,
  );
  const develop = readFileSync(path.join(SRC, "work-develop-run.ts"), "utf8");
  assert(
    (develop.match(/writeFence/g) ?? []).length === 1,
    "B: the develop closure fences its developer only — the speculative explore in the same closure is not fenced",
  );
  const adversarialFix = readFileSync(path.join(SRC, "work-driver-adversarial-fix.ts"), "utf8");
  assert(
    !/writeFence/.test(adversarialFix),
    "B: the adversarial-fix pass reaches the fence through the develop closure, not a second construction",
  );
}

// ============================================================
// C. The count: summed from the logs, idempotent, cleared on restart.
// ============================================================
const fx = buildFenceFixture("driver");
const scratch = path.join(fx.repo, "tmp", `issue-${ISSUE}`);
mkdirSync(scratch, { recursive: true });
const line = (n: number) =>
  `${JSON.stringify({ tool: "write", path: `p${n}`, reason: "r", at: n })}\n`;
writeFileSync(path.join(scratch, "write-fence-101.jsonl"), line(1) + line(2));
writeFileSync(path.join(scratch, "write-fence-102.jsonl"), line(3));
writeFileSync(path.join(scratch, "notes.md"), "not a fence log\n");

const summed = await countWriteFenceRefusals(scratch);
assert(
  summed.count === 3 && summed.unreadable === 0,
  "C: the reader sums lines across every fenced child's log",
);
assert(
  (await countWriteFenceRefusals(path.join(fx.base, "absent"))).count === 0,
  "C: a missing scratch dir counts as zero, never throws",
);
// #1655 MEDIUM 6 — a log that cannot be read is unknown, never a silent zero.
mkdirSync(path.join(scratch, "write-fence-103.jsonl"));
const withUnreadable = await countWriteFenceRefusals(scratch);
assert(
  withUnreadable.count === 3 && withUnreadable.unreadable === 1,
  "C: an unreadable log is counted as unreadable, and its refusals are not guessed",
);
rmSync(path.join(scratch, "write-fence-103.jsonl"), { recursive: true });

const ctx = { repoRoot: fx.repo, issue: ISSUE } as unknown as CycleContext;
const start = initialState(ISSUE);
const once = await foldWriteFenceCount(ctx, start);
assert(
  once.pipelineState.writeFenceRefusals === 3,
  "C: the fold stores the refusal total on the cycle state",
);
const twice = await foldWriteFenceCount(ctx, once);
assert(twice === once, "C: a fold with nothing new returns the same state object (idempotent)");
writeFileSync(path.join(scratch, "write-fence-101.jsonl"), line(1) + line(2) + line(4));
const grown = await foldWriteFenceCount(ctx, once);
assert(
  grown.pipelineState.writeFenceRefusals === 4,
  "C: a later fold picks up a refusal logged since",
);
const clean = await foldWriteFenceCount(ctx, start);
assert(
  clean.pipelineState.writeFenceRefusals === 4 &&
    start.pipelineState.writeFenceRefusals === undefined,
  "C: the fold is pure — the input state is not mutated",
);

await clearWriteFenceLogs(scratch);
assert(
  readdirSync(scratch).filter((n) => /^write-fence-\d+\.jsonl$/.test(n)).length === 0,
  "C: a restart clears the fence logs",
);
assert(
  readdirSync(scratch).includes("notes.md"),
  "C: the restart clears only the fence's own logs",
);

// ============================================================
// E. What the count cannot see is unknown, never a silent zero (#1655 review r3).
// ============================================================
{
  const unlogged = path.join(fx.base, "unlogged");
  mkdirSync(unlogged, { recursive: true });
  // The child's own log name is taken by a directory, so its append fails and it cannot log.
  mkdirSync(path.join(unlogged, `write-fence-${process.pid}.jsonl`));
  appendWriteFenceRefusal(unlogged, { tool: "write", path: "/x", reason: "r", at: 1 });
  assert(
    (await countWriteFenceRefusals(unlogged)).unreadable >= 1,
    "E: a refusal the child could not log leaves an unaccounted marker, so the count is unknown",
  );
  await resetWriteFenceLogs(unlogged);
  assert(
    (await countWriteFenceRefusals(unlogged)).unreadable >= 1,
    "E: a restart that cannot remove a log leaves the new count unknown",
  );
  const cleanDir = path.join(fx.base, "clean-restart");
  mkdirSync(cleanDir, { recursive: true });
  writeFileSync(path.join(cleanDir, "write-fence-7.jsonl"), line(1));
  await resetWriteFenceLogs(cleanDir);
  const afterClean = await countWriteFenceRefusals(cleanDir);
  assert(
    afterClean.count === 0 && afterClean.unreadable === 0,
    "E: a restart that removes every log starts the count at a known zero",
  );
}

// ============================================================
// F. A refusal the cycle scratch dir cannot take is counted unknown, never 0 (#1655 review r4).
// ============================================================
{
  const repoNoScratch = path.join(fx.base, "repo-no-scratch");
  mkdirSync(repoNoScratch, { recursive: true });
  // An unset scratch dir, and a relative one: neither names a place the driver reads.
  appendWriteFenceRefusal(undefined, { tool: "bash", path: "/x", reason: "r", at: 1 }, repoNoScratch);
  appendWriteFenceRefusal("tmp/relative", { tool: "bash", path: "/y", reason: "r", at: 2 }, repoNoScratch);
  const fallback = await countWriteFenceRefusals(unscratchedDir(repoNoScratch));
  assert(
    fallback.unreadable >= 1,
    "F: a refusal with an unset or relative scratch dir leaves an unaccounted marker in the repo's fallback dir",
  );
  const folded = await foldWriteFenceCount(
    { repoRoot: repoNoScratch, issue: ISSUE } as unknown as CycleContext,
    initialState(ISSUE),
  );
  assert(
    (folded.pipelineState.writeFenceUnreadable ?? 0) >= 1,
    "F: the driver's fold reads the fallback marker, so the handoff reports the count unknown",
  );
  // A usable scratch dir takes the refusal as before, with no fallback marker.
  const usable = path.join(fx.base, "usable-scratch");
  mkdirSync(usable, { recursive: true });
  appendWriteFenceRefusal(usable, { tool: "bash", path: "/z", reason: "r", at: 3 }, repoNoScratch);
  assert(
    (await countWriteFenceRefusals(usable)).count === 1,
    "F: a usable scratch dir still logs the refusal to the child's own log",
  );
}

// ============================================================
// D. The handoff names the count, and a clean cycle says nothing.
// ============================================================
{
  const parked = {
    ...initialState(ISSUE),
    pipelineState: { ...initialState(ISSUE).pipelineState, writeFenceRefusals: 2 },
  };
  const md = renderHandoffMarkdown(parked, fx.repo);
  assert(
    md.includes("### Writes refused by the write fence"),
    "D: a parked handoff renders the write-fence section",
  );
  assert(
    md.includes("2 writes outside a developer's worktree were refused"),
    "D: the section states the count",
  );
  const one = renderHandoffMarkdown(
    {
      ...initialState(ISSUE),
      pipelineState: { ...initialState(ISSUE).pipelineState, writeFenceRefusals: 1 },
    },
    fx.repo,
  );
  assert(
    one.includes("1 write outside a developer's worktree was refused"),
    "D: a single refusal reads in the singular",
  );
  const none = renderHandoffMarkdown(initialState(ISSUE), fx.repo);
  assert(
    !none.includes("write fence"),
    "D: a cycle with no refusals renders no write-fence section",
  );
}

rmSync(fx.base, { recursive: true, force: true });
if (exit === 0) console.log("✓ all write-fence driver assertions passed");
process.exit(exit);
