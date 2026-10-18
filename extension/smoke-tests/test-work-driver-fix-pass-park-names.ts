#!/usr/bin/env bun
/**
 * #1522 — a fix pass that parks on its scope fence names the fence it checked
 * against (the declared paths and the files the findings name), whether any
 * finding names the stray file, where the change sits, and how to clear it.
 * The park used to be one clause — "default changed lib/config.sh — outside
 * its declared paths and the files the findings name" — which left the
 * operator to reconstruct the rule and the recovery from the state file.
 */

import { rmSync } from "node:fs";
import { devCommit, fixCtx, fixState, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { explainCap } from "../src/work-driver-explain.ts";
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
  return { out, parked: tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "" };
}

const strayPass = (d: string) => {
  devCommit(d, "a.txt", "two\n");
  devCommit(d, "b.txt", "stray\n");
};

// A — no finding names the stray file: the park says so, lists the fence and
// both ways to clear it.
{
  const dir = repoWithFile("park-names-unnamed");
  try {
    const { out, parked } = await runPass(
      dir,
      fixState(dir, ["a.txt"], "a.txt: change one to two"),
      strayPass,
    );
    assert(parked.includes("default changed b.txt"), `A: the stray is named (got "${parked}")`);
    assert(parked.includes("declared paths: a.txt"), "A: the declared paths are listed");
    assert(
      parked.includes("finding-named files it admits: none"),
      "A: the empty named set is stated",
    );
    assert(parked.includes("No finding names b.txt"), "A: says no finding names the stray");
    assert(parked.includes(dir), "A: names the worktree that holds the change");
    assert(
      parked.includes("--restart") && parked.includes("revert b.txt"),
      "A: names both ways to clear it (declare the file and restart, or revert it)",
    );
    const cap = explainCap("fix-pass-park", out);
    assert(cap.includes("No finding names b.txt"), "A: the handoff cap text carries the reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B — a finding names the stray file, but it is not widenable (a root file
// never widens a root-declared fence): the park says the finding named it and
// why that did not admit it.
{
  const dir = repoWithFile("park-names-named");
  try {
    const { parked } = await runPass(
      dir,
      fixState(dir, ["a.txt"], "a.txt: change one to two; b.txt: also fix"),
      strayPass,
    );
    assert(parked.includes("default changed b.txt"), `B: the stray is named (got "${parked}")`);
    assert(
      parked.includes("A finding names b.txt, but it does not widen the fence"),
      "B: says the finding named it and that naming did not widen the fence",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
