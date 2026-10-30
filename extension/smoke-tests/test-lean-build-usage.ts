#!/usr/bin/env bun
/**
 * lean/build — the step records what its dispatches cost (#1920 slice A).
 *
 * `build` pays for one developer per round, and the run's per-role usage is
 * folded out of the rows the step leaves on the step log. What the three
 * dispatching steps must never do is drop the expensive case: a child the
 * budget stopped, or one whose transport died, spent its tokens before anybody
 * knew, so a total that counted only successes would report the run's most
 * costly failures as free.
 *
 *   (f2) an `ok` build            -> exactly one row, the developer's own usage
 *   (f3) a budget-stopped build   -> the `budget` verdict still carries the row
 *   (f4) a build whose child died -> the rows ride on the infra THROW, marked
 *                                    not-ok, because the engine records no
 *                                    outcome for a throw and it is the only path
 *
 * Split from `test-lean-build.ts` (the 500-line cap) along the field: that file
 * owns what the step COMMITS; this one owns what it RECORDS about its child.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { BuildInfraError } from "../src/lean/build-errors.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { ROOTS, configWithRunner, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------- (f2) an ok build records its one child
{
  // The child edits `src/` only, so normalisation has something to commit and
  // the verdict is `ok` rather than `exhausted` (the shape is (a)'s in the main
  // build suite; this file is about the row, not about the commit).
  const r = await runBuild({
    issue: 131,
    child: (wt) => {
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => retryTwice();\n");
    },
  });
  const rows = r.outcome?.dispatches ?? [];
  assert(r.outcome?.kind === "ok", `(f2) the build succeeded (got ${r.outcome?.kind})`);
  assert(
    rows.length === 1,
    `(f2) the ok build records exactly one dispatch row (got ${String(rows.length)})`,
  );
  assert(
    rows[0]?.role === "developer" && rows[0]?.ok === true,
    `(f2) the row is the developer who succeeded (${JSON.stringify(rows[0])})`,
  );
  assert(
    rows[0]?.usage.input === 11 && rows[0]?.usage.turns === 4,
    `(f2) the row carries the child's own usage report (${JSON.stringify(rows[0]?.usage)})`,
  );
}

// ------------------------------ (f3) a budget stop keeps its row on the verdict
{
  const r = await runBuild({
    issue: 132,
    config: {
      ...configWithRunner(),
      budgets: { ...defaultConfig().budgets, build: { turns: 1, tokens: 0, minutes: 0 } },
    },
    child: (wt) => {
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => 1;\n");
    },
    // The same call `spawn.ts` makes at every `message_end`: one turn past the
    // single-turn ceiling, so the step's own budget ends the child.
    onProgressTick: (onProgress) =>
      onProgress?.({
        role: "developer",
        turns: 2,
        toolUses: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        totalTokens: 0,
        elapsedMs: 0,
        done: false,
      }),
  });
  assert(r.threw === undefined, `(f3) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "budget",
    `(f3) the build stopped on budget (got ${r.outcome?.kind})`,
  );
  assert(
    (r.outcome?.dispatches ?? []).length === 1,
    `(f3) the budget verdict carries the dispatch it paid for (${JSON.stringify(r.outcome?.dispatches)})`,
  );
  assert(
    (r.outcome?.dispatches?.[0]?.usage.input ?? 0) === 11,
    `(f3) and the stopped child's tokens, not zeros (${JSON.stringify(r.outcome?.dispatches?.[0]?.usage)})`,
  );
}

// --------------------- (f4) a child that died keeps its row on the infra throw
{
  const r = await runBuild({ issue: 133, dispatchOk: false });
  const rows = r.deadDispatches ?? [];
  assert(
    r.threw instanceof BuildInfraError,
    `(f4) a dead child throws infra (got ${r.threw?.name}: ${r.threw?.message})`,
  );
  assert(
    rows.length === 1 && rows[0]?.ok === false,
    `(f4) the throw carries the dead child's row, marked not-ok (${JSON.stringify(rows)})`,
  );
  assert(
    rows[0]?.usage.input === 11,
    `(f4) a dead child's tokens are still recorded (${JSON.stringify(rows[0]?.usage)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.exit(exit);
