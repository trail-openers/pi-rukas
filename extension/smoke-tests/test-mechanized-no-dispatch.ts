#!/usr/bin/env bun
/**
 * Work the driver did itself must not be reported as a subagent dispatch.
 *
 * `runMerged` performs the merge in code (`mechanizedMerge`), and then — on
 * SUCCESS — called `runSingleDispatch(ctx, state, "merged", "driver", …)` with
 * a prompt thunk reading *"Mechanized merge succeeded (no dispatch needed —
 * short-circuit)"*. The comment was aspirational: `runSingleDispatch` really
 * calls `dispatch()` → `dispatchCore` → `spawnSpecialist`, and
 * `spawn.ts:158` throws `Unknown role: driver` because "driver" is not a role.
 *
 * The throw became `dispatch-failed`; `work-driver-merged.ts` returned before
 * the `merged` event, `restoreCheckout`, worktree removal and teardown; and
 * `STEP_FAILURE_POLICY.merged === "HALT"` routed it to handoff. **A PR that was
 * genuinely merged on GitHub reported a failed cycle with teardown skipped**,
 * on the default happy path.
 *
 * `work-driver-commit.ts` had the shape right all along: for its mechanized
 * path it builds the `dispatch-completed` event directly (`:180-190`) and never
 * dispatches. This test pins that asymmetry closed.
 *
 * The existing test (`test-work-driver-pr10-core.ts`) could not catch it: its
 * `greenGh` fake makes `deriveMergeMethod` fail, so `mechanizedMerge` returns
 * `ok: false` and only the LLM fallback is ever exercised.
 */

import { ROLE_NAMES, isRoleName } from "../src/roles.ts";
import { synthesizeDriverCompletion } from "../src/work-driver-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------ "driver" is not a role

{
  assert(
    !isRoleName("driver"),
    `canary: "driver" is NOT a spawnable role — roles are ${ROLE_NAMES.join(", ")}`,
  );
  assert(
    isRoleName("ops"),
    "...while the role the fallback path really dispatches is one",
  );
}

// -------------------------- the driver's own work is recorded, not dispatched

{
  const event = synthesizeDriverCompletion({
    step: "merged",
    label: "driver:merge",
    summary: "Mechanized merge: PR #42 merged via --squash",
    startedAt: 1000,
    now: 1500,
  });

  assert(
    event.kind === "dispatch-completed",
    "the driver's own work yields the same event kind a dispatch would",
  );
  assert(event.role === "driver", "...tagged `driver` so the log says who did it");
  assert(event.step === "merged", "...on the right step");
  assert(
    event.summary.includes("PR #42 merged via --squash"),
    "...carrying the summary a reader needs",
  );
  assert(event.ms === 500, `...and the real elapsed time (${event.ms}ms)`);
  assert(
    typeof event.jobId === "string" && event.jobId.length > 0,
    "...with a jobId, because downstream readers index on it",
  );
}

{
  // Two synthesized events must not collide in the log.
  const a = synthesizeDriverCompletion({
    step: "merged",
    label: "driver:merge",
    summary: "a",
    startedAt: 1,
    now: 2,
  });
  const b = synthesizeDriverCompletion({
    step: "commit-pr",
    label: "driver:commit-pr",
    summary: "b",
    startedAt: 1,
    now: 2,
  });
  assert(a.jobId !== b.jobId, "distinct synthesized events get distinct jobIds");
}

// ------------------------ no production path dispatches a non-role, ever

{
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const SRC = path.resolve(import.meta.dirname, "..", "src");

  // Every string literal handed to runSingleDispatch as its `role` argument.
  const offenders: string[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(path.join(SRC, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const m of text.matchAll(
      /runSingleDispatch\(\s*ctx\s*,\s*[^,]+,\s*("[^"]+"|[A-Za-z_$][\w$]*)\s*,\s*"([^"]+)"/g,
    )) {
      const role = m[2] as string;
      if (!isRoleName(role)) offenders.push(`${f}: role "${role}"`);
    }
  }
  assert(
    offenders.length === 0,
    `canary: no runSingleDispatch call site names a non-role${
      offenders.length ? ` — found: ${offenders.join(", ")}` : ""
    }`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
