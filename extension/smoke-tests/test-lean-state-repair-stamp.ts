#!/usr/bin/env bun
/**
 * lean/state — the repair stamp is a boolean or the record is refused (#2668).
 *
 * `oracleRepair` is the run's copy of a switch the environment holds, written once
 * at creation so a resume answers the same way the first visit did. `assertRunFile`
 * hands it back with a bare cast, which means `"yes"` — the value an operator types
 * into a state file, and the value every other env reader in this repo treats as
 * false — reaches the transition table and reads TRUE there, buying a round the run
 * was never created to spend.
 *
 * The sibling fields on the same record are refused for exactly this: `counters.draft`
 * and friends are held to `typeof … === "boolean"`. The stamp joins them, and the
 * two shapes below are the ones a hand-edit actually produces.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, type LeanRun, leanStateFile, loadRun } from "../src/lean/state.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const CLOCK = 1000;

/** A minimal honest record, with one field made wrong. */
function record(issue: number, stamp: unknown): Record<string, unknown> {
  const run: Record<string, unknown> = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${String(issue)}`,
    state: "build",
    counters: { ...INITIAL_COUNTERS },
    steps: [
      { key: `${String(issue)}:ready:0`, state: "ready", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok" } },
    ],
  };
  if (stamp !== undefined) run.oracleRepair = stamp;
  return run;
}

function loadWith(dir: string, issue: number, stamp: unknown): LeanRun | undefined {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(record(issue, stamp), null, 2), "utf8");
  return loadRun(dir, issue);
}

// ── an honest stamp, present or absent, loads
for (const [name, stamp, want] of [
  ["absent", undefined, undefined],
  ["true", true, true],
  ["false", false, false],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    let loaded: LeanRun | undefined;
    let threw = "";
    try {
      loaded = loadWith(dir, 2680, stamp);
    } catch (err) {
      threw = (err as Error).message;
    }
    assert(threw === "", `an ${name} stamp loads (got ${threw || "no error"})`);
    assert(
      loaded?.oracleRepair === want,
      `an ${name} stamp reads back as ${String(want)} (got ${String(loaded?.oracleRepair)})`,
    );
  } finally {
    cleanup();
  }
}

// ── a stamp that is not a boolean is refused, not cast
for (const [name, stamp] of [
  ['the string "yes"', "yes"],
  ["the number 1", 1],
  ["the number 0", 0],
  ['the string "true"', "true"],
  ["an object", { on: true }],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    let refused = false;
    let message = "";
    let value: unknown = "loaded";
    try {
      const loaded = loadWith(dir, 2681, stamp);
      value = loaded?.oracleRepair;
    } catch (err) {
      refused = true;
      message = (err as Error).message;
    }
    assert(
      refused,
      `a stamp of ${name} is refused on load (got a value of ${JSON.stringify(value)}${
        refused ? "" : ` — ${message}`
      })`,
    );
    assert(
      !refused || /oracleRepair/.test(message),
      `and the refusal names the field (${message.slice(0, 90)})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
