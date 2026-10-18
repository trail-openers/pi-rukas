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
import { foldWriteFenceCount } from "../src/work-driver-write-fence.ts";
import { initialState } from "../src/workflow-state-update.ts";
import {
  clearWriteFenceLogs,
  countWriteFenceRefusals,
  writeFenceChildEnv,
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
  const env = writeFenceChildEnv({ root: "/w/wt", scratch: "/w/tmp/issue-1655" });
  assert(
    env.PI_ENSEMBLE_WRITE_ROOT === "/w/wt" && env.PI_ENSEMBLE_WRITE_SCRATCH === "/w/tmp/issue-1655",
    "A: a fenced child gets PI_ENSEMBLE_WRITE_ROOT and PI_ENSEMBLE_WRITE_SCRATCH",
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
    JSON.stringify(fenced) === JSON.stringify(["work-develop-run.ts", "work-driver-lens-fix.ts"]),
    `B: only the develop and lens-fix developer dispatches build a fence (got ${fenced.join(", ")})`,
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

assert(
  (await countWriteFenceRefusals(scratch)) === 3,
  "C: the reader sums lines across every fenced child's log",
);
assert(
  (await countWriteFenceRefusals(path.join(fx.base, "absent"))) === 0,
  "C: a missing scratch dir counts as zero, never throws",
);

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
