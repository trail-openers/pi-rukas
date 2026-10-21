#!/usr/bin/env bun
/**
 * The #1743 repeat-park guard's HEADLESS PROJECTION — what a refused GROUP
 * reports.
 *
 * `test-repeat-park-scope.ts` pins which parks the guard may refuse. This pins
 * the other half: a grouped cycle refused on ONE member must not report every
 * member as its own repeat-park. Nothing ever looked at the sibling, and saying
 * otherwise is the driver inventing a verdict (#404's failure mode again).
 *
 * Tested at the projector, because whether two issues share a cycle is the
 * grouping pass's decision, not this guard's — the guard only returns one
 * verdict naming one issue.
 *
 * Offline: no Pi session, no network (the issue-body fetch and the open-PR
 * lookup are both stubbed through `verifyExecFn`).
 */
import { rmSync } from "node:fs";
import { projectRepeatParkRefusal } from "../src/headless/repeat-park-refusal.ts";
import { refuseRepeatPark } from "../src/work-driver-state-guards.ts";
import {
  ISSUE,
  armParkRecord,
  assert,
  ctxOf,
  exitCode,
  fingerprintOf,
  world,
} from "./lib/park-harness.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_INTENT = "1";
process.env.PI_ENSEMBLE_FORGE = "none";

/** One projected headless result line, as the runner's `results` array holds it. */
interface Projected {
  issue: number;
  exitCode: number;
  cap?: string;
  failure?: { message?: string };
  status: string;
}

const SIBLING = 86;

{
  const w = world("group-headless");
  try {
    armParkRecord(
      w,
      "intent-park",
      {
        reason: "contradicted-by-code",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      },
      SIBLING,
    );
    const ctx = ctxOf(w, { issues: [ISSUE, SIBLING] });
    const refusal = await refuseRepeatPark(ctx);
    assert(typeof refusal?.reason === "string", "the grouped start is refused");
    const results: Projected[] = [];
    const codes = projectRepeatParkRefusal(
      [ISSUE, SIBLING],
      w.dir,
      { started: false, ...refusal } as never,
      results as never,
    );
    assert(
      codes !== undefined && codes.every((c) => c === 40),
      "…and every member exits EXIT.refused — the group did not start",
    );
    const armed = results.find((r) => r.issue === SIBLING);
    const sibling = results.find((r) => r.issue === ISSUE);
    assert(
      armed?.cap === "repeat-park" && /already parked 2 times/.test(armed.failure?.message ?? ""),
      "the issue that armed the guard carries the repeat-park cap and its count",
    );
    assert(
      sibling?.cap === undefined &&
        /^not evaluated: the group was refused because #86/.test(
          sibling?.failure?.message ?? "",
        ),
      "…and its sibling is reported as NOT EVALUATED, naming the issue that actually armed the guard — not as a repeat-park of its own",
    );
    // The projector reads the RECORD, not the prose: hand it a refusal whose
    // sentence has been mangled and the numbers it publishes still come from
    // the structured verdict it arrived with.
    const mangled: Projected[] = [];
    projectRepeatParkRefusal(
      [ISSUE, SIBLING],
      w.dir,
      { started: false, reason: "repeat-park: ", repeatPark: refusal?.repeatPark } as never,
      mangled as never,
    );
    assert(
      /^#86 intent-park \(contradicted-by-code\) already parked 2 times/.test(
        mangled.find((r) => r.issue === SIBLING)?.failure?.message ?? "",
      ) &&
        /^not evaluated: the group was refused because #86 intent-park/.test(
          mangled.find((r) => r.issue === ISSUE)?.failure?.message ?? "",
        ),
      "the projected detail is BUILT FROM THE STRUCTURED VERDICT, not parsed back out of the reason string the guard wrote for a human (an empty sentence still prints the record)",
    );
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
}

process.exit(exitCode());
