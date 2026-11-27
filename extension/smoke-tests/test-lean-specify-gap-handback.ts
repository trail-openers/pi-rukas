#!/usr/bin/env bun
/**
 * A specify child that cannot prove a criterion red hands the run back (exit 10); it is not a refused spec.
 *
 *   (b) a child whose test passes on the base ends `handed-back` at exit 10, with ONE comment — the
 *       handback — carrying the gap rule, the dropped-file evidence and the second reading, and the
 *       headless projection classifies it as `failure.kind: "red-test-gap"`; the result reason is the gap
 *       rule; the record equals `on`;
 *   (c) the five retired specify-path switches set to `"0"` are ignored: the record is still `on`;
 *   (d) a handback comment that failed to post rides on the gap reason, a host-channel one does not;
 *   (e) a gap whose reason already spells a rule prints that rule once, beside the rules it does not spell.
 *
 * Both runs drive the real `runLean` over the real phase-1 handlers (`lib/lean-specify-gap-golden.ts`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { reasonFor } from "../src/lean/engine-facts.ts";
import { neededFromLog } from "../src/lean/handback.ts";
import type { Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { GAP_FIXTURE, type GapRecord, driveGapRun } from "./lib/lean-specify-gap-golden.ts";

const { assert, failures } = makeAssert();
const golden = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, GAP_FIXTURE), "utf8"),
) as Record<"on", GapRecord>;

// ── (b) a handback, not a decline
{
  const on = await driveGapRun(2360);
  assert(
    on.state === "handed-back" && on.code === 10,
    `(b) the gap hands back at exit 10 (got ${on.state} exit ${String(on.code)})`,
  );
  const body = on.comments[0] ?? "";
  assert(
    on.comments.length === 1 && body.includes("is handed back"),
    `(b) exactly one comment, the handback (got ${String(on.comments.length)})`,
  );
  assert(
    body.includes("criterion AC1 has no red test") &&
      body.includes("exited 0 on base") &&
      body.includes("may also mean the criterion already holds there"),
    `(b) the comment carries the gap rule, the dropped-file evidence and the second reading\n${body}`,
  );
  assert(
    on.reason === "criterion AC1 has no red test",
    `(b) the run's result reason is the gap rule, not the handback's own outcome (got ${on.reason})`,
  );
  const failure = on.failure;
  assert(
    failure?.kind === "red-test-gap" && failure.message === "criterion AC1 has no red test",
    `(b) the headless failure is kind red-test-gap with the rules (got ${JSON.stringify(failure)})`,
  );
  assert(
    JSON.stringify(on) === JSON.stringify(golden.on),
    `(b) the on record is the golden\n    want: ${JSON.stringify(golden.on)}\n    got:  ${JSON.stringify(on)}`,
  );
}

// ── (c) the retired switches set to "0" change nothing
{
  const retired = Object.fromEntries(
    [
      "SPECIFY_GAP_HANDBACK",
      "PROJECT_ROSTER",
      "RUNNER_PREFLIGHT",
      "PREFIX_HEAD",
      "SPECIFY_REASK",
    ].map((k) => [`PI_ENSEMBLE_LEAN_${k}`, "0"]),
  );
  const zero = await driveGapRun(2360, retired);
  assert(
    JSON.stringify(zero) === JSON.stringify(golden.on),
    `(c) with all five at "0" the record is the on golden\n    got:  ${JSON.stringify(zero)}`,
  );
}

const GAP = "criterion AC1 has no red test";
const gapStep = (reason: string, failedRules = [GAP]): Step => ({
  key: "1:specify:1",
  state: "specify",
  startedAt: 0,
  outcome: { kind: "red-test-gap", failedRules, reason },
});

// ── (d) a failed handback post reaches the run's reason
{
  const steps = [gapStep(GAP)];
  const failed = { kind: "done", posted: false, reason: "NOT posted: x" };
  const lost = reasonFor("handed-back", failed, steps);
  assert(lost === `${GAP}: NOT posted: x`, `(d) a failed post rides on the gap (got ${lost})`);
  const host = { kind: "done", posted: false, channel: "host" as const, reason: "posted" };
  const held = reasonFor("handed-back", host, steps);
  assert(held === GAP, `(d) a host-channel handback is the gap alone (got ${held})`);
}

// ── (e) each gap line shows once
{
  const size = "AC2 t.sh: over the size cap";
  const reason = `${GAP}; no submitted test was red against <sha>; ${GAP}; dropped 1: exited 0 on base`;
  const cause = neededFromLog([gapStep(reason, [GAP, size])]);
  assert(
    cause.split(GAP).length === reason.split(GAP).length && cause.includes(size),
    `(e) no generic rule beside the reason that spells it, the size row kept\n${cause}`,
  );
}

console.log(`\n${failures() === 0 ? "gap handback green" : "gap handback RED"}`);
process.exit(failures());
