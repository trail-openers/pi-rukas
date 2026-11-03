#!/usr/bin/env bun
/**
 * lean/state — the base commit a durable run record may claim (#1920).
 *
 * Split from `test-lean-state-outcome.ts` at AGENTS.md \u00a712's line cap, along the
 * seam the cases already had: that file judges which STEP may record which piece of
 * evidence, this one judges the ONE field of the RUN that anchors every later read.
 *
 * `baseSha` is the ref the config load, the diff and the verify verdict all resolve
 * AT. A record carrying `main` in that field is not a slightly odd base: it is a run
 * that silently means "the mainline, whichever commit that happens to be", and only
 * the load path sees it before a model is billed \u2014 `ready` proves a base it was
 * handed, and `runLean` drives from the record without asking. So the loader holds a
 * NON-empty base to the same rule `ready` does, a full lowercase oid, and the cases
 * below pin both halves: a moving ref or a mangled oid is refused, and the two
 * legitimately empty-shaped values are not.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * The base invariant, checked at load rather than at first use.
 *
 * `baseSha` is the ref every later read of the run is anchored to — the config
 * load, the diff, the verify verdict all resolve AT it. A record carrying
 * `main` in that field is not a slightly odd base: it is a run that silently
 * means "the mainline, whichever commit that happens to be", and only the load
 * path sees it before a model is billed — `ready` proves a base it was handed,
 * and `runLean` drives from the record without asking. So the loader holds a
 * NON-empty base to the same rule `ready` does, a full lowercase oid, and the
 * cases below pin both halves: a moving ref or a mangled oid is refused, and
 * the two legitimately empty-shaped values are not.
 */
function forgedBase(dir: string, issue: number, baseSha: string): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha,
    branch: `feature/issue-${issue}`,
    state: "ready",
    counters: INITIAL_COUNTERS,
    steps: [],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

for (const [label, issue, baseSha] of [
  ["a branch name", 55, "main"],
  ["an abbreviated oid", 56, "0123456"],
  ["a mixed-case oid", 57, FIXTURE_BASE_SHA.toUpperCase()],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedBase(dir, issue, baseSha);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a hand-edited baseSha of ${label} is refused at load (got: ${String(thrown)})`,
    );
    assert(
      /baseSha/.test((thrown as Error)?.message ?? ""),
      `the refusal for ${label} names the field (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(baseSha) === true,
      `the refusal for ${label} quotes the offending value (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

// The two shapes that are NOT corruptions: a full oid, and the empty string a
// seed whose probe failed legitimately writes (which `ready` then refuses with
// the reason the probe gave). Refusing either would refuse the only shape a
// first run can have.
for (const [label, issue, baseSha] of [
  ["a full oid", 58, FIXTURE_BASE_SHA],
  ["the empty base a failed seed writes", 59, ""],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedBase(dir, issue, baseSha);
    let thrown: unknown;
    let loaded: unknown;
    try {
      loaded = loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(thrown === undefined, `a baseSha of ${label} loads (got: ${String(thrown)})`);
    assert(
      (loaded as { baseSha?: string })?.baseSha === baseSha,
      `the loaded record keeps its ${label} (got ${JSON.stringify((loaded as { baseSha?: string })?.baseSha)})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
