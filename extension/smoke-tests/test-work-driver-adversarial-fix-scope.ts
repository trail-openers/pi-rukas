#!/usr/bin/env bun
/**
 * #1114 — the fix pass's fence covers everything the developer leaves in the
 * worktree, not only committed work; an unfenced (N=1, undeclared) workstream
 * is held to the files it already changed plus the files its findings name;
 * and a declared fence's fan-out ceiling is computed from the DECLARED paths.
 */

import { rmSync, writeFileSync } from "node:fs";
import {
  devCommit,
  devWrite,
  fixCtx,
  fixState,
  repoWithFile,
  git,
} from "./lib/adversarial-fix-fixtures.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

async function runPass(dir: string, st: WorkState, onDev: (d: string) => void) {
  const out = await runAdversarialFixPass(
    fixCtx(dir, onDev),
    st,
    pendingFixes(st.eventLog),
    Date.now(),
  );
  const tail = out.eventLog[out.eventLog.length - 1];
  return {
    applied: tail?.kind === "adversarial-fix-applied",
    parked: tail?.kind === "cap-hit" ? tail.evidence : "",
  };
}

// B7 — an UNCOMMITTED edit outside the fence parks; only committed work used to be checked.
// The developer works in a real separate worktree, as a cycle does.
{
  const dir = repoWithFile("fs-uncommitted");
  const wt = `${dir}-wt`;
  try {
    git(dir, `worktree add -q --detach ${wt} HEAD`);
    const s0 = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const st = { ...s0, pipelineState: { ...s0.pipelineState, worktrees: { default: wt } } };
    const r = await runPass(dir, st, () => {
      devCommit(wt, "a.txt", "two\n");
      devWrite(wt, "b.txt", "stray, uncommitted\n");
    });
    assert(
      !r.applied && r.parked.includes("default changed b.txt"),
      `B7: an uncommitted stray outside the fence parks (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
}

// B8 — an unfenced (N=1, undeclared) pass may touch only what it already
// changed and what its findings name. A third file parks.
{
  const dir = repoWithFile("fs-unfenced");
  try {
    const r = await runPass(dir, fixState(dir, [], "a.txt: change one to two"), (d) =>
      devCommit(d, "b.txt", "two\n"),
    );
    assert(
      !r.applied && r.parked.includes("outside the files it already changed"),
      `B8: an unfenced pass changing an unnamed file parks (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = repoWithFile("fs-unfenced-ok");
  try {
    const r = await runPass(dir, fixState(dir, [], "a.txt: change one to two"), (d) =>
      devCommit(d, "a.txt", "two\n"),
    );
    assert(r.applied, "B8: an unfenced pass changing the file its findings name applies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// C2 — the fan-out ceiling is the DECLARED count. One declared path at factor 1
// and minimum 1 allows one file; a finding naming a second file widens the
// fence for the pass but not the ceiling, so changing both parks.
{
  const dir = repoWithFile("fs-fanout");
  const env = {
    factor: process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR,
    min: process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN,
  };
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  try {
    const r = await runPass(dir, fixState(dir, ["a.txt"], "a.txt: one; b.txt: also"), (d) => {
      writeFileSync(`${d}/a.txt`, "two\n");
      writeFileSync(`${d}/b.txt`, "two\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked.includes("fan-out limit 1 for its 1 declared path"),
      `C2: the fan-out ceiling counts declared paths only (got "${r.parked}")`,
    );
  } finally {
    for (const [k, v] of [
      ["PI_ENSEMBLE_SCOPE_FANOUT_FACTOR", env.factor],
      ["PI_ENSEMBLE_SCOPE_FANOUT_MIN", env.min],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
