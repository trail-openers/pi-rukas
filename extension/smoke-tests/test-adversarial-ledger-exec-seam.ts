#!/usr/bin/env bun
/**
 * #1360 lens 6 — the writer's execFn reaches the binding's git reads (one seam).
 *
 * Capture and write share ONE injectable executor (the shape `commentExecFn`
 * already sets for the comment check). Counting the git calls the injected
 * executor sees proves the binding did NOT fall back to the real executor
 * behind the caller's back — a caller with its own git policy has exactly one
 * seam to give, and the row must honour it.
 *
 * Split from `test-adversarial-ledger-range.ts` for the 500-line cap.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { honestBinding, setupRepo, toolArm } from "./lib/adversarial-ledger-harness.ts";

// The three env pins, in assignment form: biome's noDelete rule refuses the
// `delete process.env.X` shape the sibling ledger tests use, and assigning ""
// is equivalent for every reader — the ledger override is read via `?.trim()`
// and the merge guard's override via `=== "1"`, so an empty value means unset.
process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE = "";
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

try {
  const { dir, mergeBase } = setupRepo();
  try {
    let gitCalls = 0;
    const real = execp as unknown as (
      cmd: string,
      o?: { argv?: string[] },
    ) => Promise<{ stdout: string }>;
    const { row } = await toolArm(dir, {
      base: mergeBase,
      head: "HEAD",
      binding: (await honestBinding(dir, mergeBase, "HEAD")) as never,
      execFn: async (cmd, o) => {
        if (cmd === "git" || cmd.startsWith("git ")) gitCalls++;
        return real(cmd, o);
      },
    });
    assert(
      row.passed === true,
      `injected execFn: the bound row still passes (detail=${JSON.stringify(row.detail)})`,
    );
    assert(
      gitCalls > 0,
      `injected execFn: the write's git reads went through it (${gitCalls} calls)`,
    );
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
} finally {
  // nothing global to restore
}

console.log(`\nexit ${exit}`);
process.exit(exit);
