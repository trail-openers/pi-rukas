#!/usr/bin/env bun
/**
 * The #1743 repeat-park guard's SCOPE — the half that decides what the guard
 * is not allowed to do.
 *
 * `test-repeat-park-guard.ts` pins the refusal itself. This pins the four ways
 * a refusal could be wrong, each a false stop the guard was caught making:
 * refusing a plan gate whose verdict is a model's judgement; writing from the
 * read path; enforcing a GitHub state it has not re-read; and counting parks
 * that were never reported. Plus the group scope (every issue, one name).
 *
 * The HEADLESS projection of a refused group is the sibling file
 * `test-repeat-park-projector.ts` — whether two issues share a cycle is the
 * grouping pass's decision, not this guard's, so that half is tested at the
 * projector.
 *
 * Offline: no Pi session, no network (`PI_ENSEMBLE_FORGE=none`, the issue-body
 * fetch and the open-PR lookup are both stubbed through `verifyExecFn`).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DriverContext } from "../src/work-driver-context.ts";
import { ISSUE_BODY_TIMEOUT_MS } from "../src/work-driver-explore.ts";
import { repeatParkVerdict } from "../src/work-driver-park-memory.ts";
import {
  REPEAT_PARK_REFUSAL_PREFIX,
  refuseRepeatPark,
} from "../src/work-driver-state-guards.ts";
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

// ── 4. The other two covered caps behave DIFFERENTLY, and the guard writes
// nothing. `plan-spec-mismatch` is the planner's judgement — counting it is
// useful, refusing on it is the driver claiming a nondeterministic verdict was
// settled. `existing-pr-detected` records a GitHub state, so the guard re-reads
// that state before refusing. And a verdict is a READ: a record of other issue
// text simply does not count; it is not rewritten on the way past.
{
  const OPEN_PR = [
    { number: 77, headRefName: `feature/issue-${ISSUE}-x`, body: `Closes #${ISSUE}` },
  ];

  // 4a. plan-spec-mismatch: remembered, never refused.
  {
    const w = world("plan-no-refuse");
    try {
      armParkRecord(w, "plan-spec-mismatch", {
        reason: "no-calls",
        fingerprint: fingerprintOf(w),
        count: 5,
        deliveredCount: 5,
      });
      const ctx = ctxOf(w, { prList: [] });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "plan-spec-mismatch: five identical plan parks do NOT refuse — the planner is a model, not a computation",
      );
      assert(
        (await refuseRepeatPark(ctx)) === undefined,
        "…and refuseRepeatPark lets that start through to run the plan gate again",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4b. A record of OTHER issue text is left exactly as it was.
  {
    const w = world("pure-guard");
    try {
      const file = armParkRecord(w, "intent-park", {
        reason: "contradicted-by-code",
        fingerprint: "0".repeat(64),
        count: 2,
        deliveredCount: 2,
      });
      const before = readFileSync(file, "utf8");
      const ctx = ctxOf(w, { prList: [] });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "intent-park: a record from other issue text is not a refusal",
      );
      assert(
        readFileSync(file, "utf8") === before,
        "…and the guard WROTE NOTHING: a verdict is a read, and a half-reset record on a failed comparison is how a guard starts lying",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4c. existing-pr-detected: refuses only while that PR is still open.
  for (const [prList, label] of [
    [OPEN_PR, "still open"],
    [[], "since closed"],
  ] as const) {
    const w = world(`pr-${label}`);
    try {
      armParkRecord(w, "existing-pr-detected", {
        reason: "77",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });
      const ctx = ctxOf(w, { prList });
      const refusal = await repeatParkVerdict(ctx);
      if (label === "still open") {
        assert(
          refusal?.cap === "existing-pr-detected" &&
            refusal.reason === "77" &&
            refusal.count === 2 &&
            refusal.issue === ISSUE,
          "existing-pr-detected: the PR is still open, so the guard names the cap, the PR and the count",
        );
        const refused = await refuseRepeatPark(ctx);
        assert(
          typeof refused?.reason === "string" &&
            refused.reason.startsWith(REPEAT_PARK_REFUSAL_PREFIX) &&
            refused.reason.includes("existing-pr-detected") &&
            refused.repeatPark?.cap === "existing-pr-detected" &&
            refused.repeatPark.issue === ISSUE &&
            refused.repeatPark.count === 2,
          "…and refuseRepeatPark turns that into the reason the runner recognises, WITH the record fields on the refusal",
        );
      } else {
        assert(
          refusal === undefined,
          "existing-pr-detected: the PR has since been closed — the guard re-reads the forge instead of enforcing a GitHub state it has not looked at",
        );
        assert(
          (await refuseRepeatPark(ctx)) === undefined,
          "…and the start runs",
        );
      }
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4c-bis. The re-check is BOUNDED, and a lookup that cannot answer is not a
  // refusal. It runs before any step is dispatched, so an unbounded
  // `gh pr list` here holds up the start for as long as the network hangs, and
  // the guard would be the slowest thing in a cycle that runs no steps at all.
  // The deadline is the issue-body fetch's own per-attempt bound, and a
  // timeout — or a cycle that is being interrupted — fails OPEN.
  {
    const w = world("pr-lookup-bounded");
    try {
      armParkRecord(w, "existing-pr-detected", {
        reason: "77",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });

      let calls = 0;
      let deadlineSeen: number | undefined;
      const timingOut = {
        ...ctxOf(w, { prList: OPEN_PR }),
        verifyExecFn: async (_cmd: string, opts?: { timeout?: number }) => {
          calls++;
          deadlineSeen = opts?.timeout;
          throw Object.assign(new Error("command timed out after 45000ms"), {
            killed: true,
            timedOutKill: true,
          });
        },
      } as unknown as DriverContext;
      assert(
        (await repeatParkVerdict(timingOut)) === undefined,
        "existing-pr-detected: a `gh pr list` that times out does NOT refuse — the driver still cannot confirm the PR, so it does not get to enforce it",
      );
      assert(
        calls > 0 && deadlineSeen === ISSUE_BODY_TIMEOUT_MS,
        `…and the re-check ran WITH a deadline (saw ${String(deadlineSeen)}ms, expected ${ISSUE_BODY_TIMEOUT_MS}ms) — an unbounded forge call before the loop is how a start hangs forever`,
      );
      assert(
        (await refuseRepeatPark(timingOut)) === undefined,
        "…and refuseRepeatPark lets that start run rather than parking it on a state it could not read",
      );

      const stopping = new AbortController();
      stopping.abort();
      calls = 0;
      const interrupted = {
        ...ctxOf(w, { prList: OPEN_PR }),
        signal: stopping.signal,
        verifyExecFn: async () => {
          calls++;
          return { stdout: JSON.stringify(OPEN_PR) };
        },
      } as unknown as DriverContext;
      assert(
        (await repeatParkVerdict(interrupted)) === undefined,
        "an interrupted cycle is not refused on a PR state — nothing is about to run either way, so the guard has no verdict to defend",
      );
      assert(
        calls === 0,
        "…and the abort is checked BEFORE the `gh pr list`: the way out of a stopping cycle is not a network call",
      );

      // And a lookup that THROWS is a state the driver could not read. `[null]`
      // parses fine — the throw happens after the lookup's own try blocks, when
      // the matcher walks the row. A pre-flight gate has no exception path.
      let lookupThrew = false;
      let thrown: unknown;
      try {
        thrown = await repeatParkVerdict(ctxOf(w, { prList: [null] }));
      } catch {
        lookupThrew = true;
      }
      assert(
        !lookupThrew && thrown === undefined,
        "existing-pr-detected: rows that make the matcher THROW neither refuse nor propagate out of the pre-flight gate",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4d. `--continue-pr` is the documented remedy for the OPEN-PR park, so the
  // guard never arms against the invocation that tells the operator to use it.
  // But it is the remedy for THAT park only: an intent park is a statement
  // about the issue body, and continuing a PR does nothing about it.
  {
    const w = world("continue-pr");
    try {
      armParkRecord(w, "existing-pr-detected", {
        reason: "77",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });
      const ctx = ctxOf(w, { prList: OPEN_PR, continuePr: true });
      assert(
        (await refuseRepeatPark(ctx)) === undefined,
        "--continue-pr with a count-2 open-PR record: the run proceeds — refusing the documented remedy would block the fix",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
  {
    const w = world("continue-pr-intent");
    try {
      const here = fingerprintOf(w);
      armParkRecord(w, "intent-park", {
        reason: "contradicted-by-code",
        fingerprint: here,
        count: 2,
        deliveredCount: 2,
      });
      const ctx = ctxOf(w, { prList: [], continuePr: true });
      const refused = await refuseRepeatPark(ctx);
      assert(
        refused?.repeatPark?.cap === "intent-park" &&
          refused.reason.startsWith(REPEAT_PARK_REFUSAL_PREFIX),
        "--continue-pr does NOT waive an intent-park refusal — the flag continues a PR; it does not make the issue say more",
      );
      // And the flag still waives nothing when the PR park is not the one that
      // armed: an intent record beside an open-PR record refuses on the intent.
      armParkRecord(w, "existing-pr-detected", {
        reason: "77",
        fingerprint: here,
        count: 2,
        deliveredCount: 2,
      });
      const both = await refuseRepeatPark(ctxOf(w, { prList: OPEN_PR, continuePr: true }));
      assert(
        both?.repeatPark?.cap === "intent-park",
        "…and with both records armed, --continue-pr stands down only the open-PR one",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4e. The threshold is DELIVERED parks, not attempted ones. A factory that
  // ran the cycle twice while `gh` was down has told nobody anything; refusing
  // the third start would silence the first report that ever gets posted.
  {
    const w = world("undelivered");
    try {
      const here = fingerprintOf(w);
      const arm = (count: number, delivered: number) =>
        armParkRecord(w, "intent-park", {
          reason: "contradicted-by-code",
          fingerprint: here,
          count,
          deliveredCount: delivered,
        });
      arm(2, 0);
      const ctx = ctxOf(w, { prList: [] });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "two cycles parked and NEITHER reported it (both posts failed): the third start runs — a park nobody read has not been made twice",
      );
      arm(3, 1);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "…three parks, one delivered: still short of the two REPORTED parks the threshold asks for",
      );
      arm(3, 2);
      assert(
        (await repeatParkVerdict(ctx))?.deliveredCount === 2,
        "…and once two of them were actually reported, the guard arms",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4f. A record nobody can believe is treated as absent: a count that is not
  // a number, a timestamp from before the driver existed, delivered parks
  // exceeding the parks, a cycle id that is not a number, or a timestamp JSON
  // parses to Infinity (which would make the refusal's `toISOString()` throw).
  for (const [field, value, label] of [
    ["count", "2", "a string count"],
    ["count", -1, "a negative count"],
    ["lastAt", 2, "a 1970 timestamp"],
    ["deliveredCount", 3, "more parks reported than there were"],
    ["lastCycleId", "3", "a string cycle id"],
    ["lastCycleId", Number.NaN, "a NaN cycle id"],
  ] as const) {
    const w = world(`bad-${label}`);
    try {
      const file = armParkRecord(w, "intent-park", {
        reason: "contradicted-by-code",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec[field] = value;
      writeFileSync(file, JSON.stringify(rec), "utf8");
      const ctx = ctxOf(w, { prList: [] });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        `a malformed record (${label}) is treated as ABSENT — a hand-edited file cannot arm a hard stop`,
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
  {
    // `1e999` is the case a JSON parse turns into Infinity, and
    // `new Date(Infinity).toISOString()` THROWS. The refusal sentence formats
    // that date, so an Infinity firstAt must be rejected on the read, not
    // survive to crash the start it is refusing.
    const w = world("bad-infinite-firstAt");
    try {
      const file = armParkRecord(w, "intent-park", {
        reason: "contradicted-by-code",
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });
      const rec = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(
        file,
        JSON.stringify(rec).replace(`"firstAt":${rec.firstAt}`, '"firstAt":1e999'),
        "utf8",
      );
      assert(
        readFileSync(file, "utf8").includes("1e999"),
        "the record really carries the infinite timestamp on disk (JSON.parse turns it into Infinity)",
      );
      const ctx = ctxOf(w, { prList: [] });
      let threw: string | undefined;
      let verdict: unknown;
      try {
        verdict = await repeatParkVerdict(ctx);
        await refuseRepeatPark(ctx);
      } catch (err) {
        threw = (err as Error).message;
      }
      assert(
        threw === undefined && verdict === undefined,
        `an infinite firstAt is treated as ABSENT and the guard does not throw (${threw ?? "no throw"}) — a corrupted date cannot crash the refusal or print Invalid Date`,
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4f-bis. An `existing-pr-detected` record whose reason is not a PR number
  // cannot be re-checked against the forge, so it fails OPEN: the driver does
  // not get to refuse on a GitHub state it could not confirm.
  for (const reason of ["not-a-pr", "77.5", "0", "-3", "", " 77 ", "0x11", "1e2"]) {
    const w = world(`bad-pr-reason-${reason.trim() || "empty"}`);
    try {
      armParkRecord(w, "existing-pr-detected", {
        reason,
        fingerprint: fingerprintOf(w),
        count: 2,
        deliveredCount: 2,
      });
      const ctx = ctxOf(w, { prList: OPEN_PR });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        `existing-pr-detected with reason ${JSON.stringify(reason)}: the forge re-check cannot run, so the guard fails OPEN (a PR that looks open is not a reason the driver may enforce)`,
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4g. An expired record is ignored, whatever its counters say.
  {
    const w = world("expired");
    try {
      const ancient = Date.now() - 20 * 24 * 60 * 60 * 1000;
      const file = armParkRecord(w, "intent-park", {
        reason: "contradicted-by-code",
        fingerprint: fingerprintOf(w),
        count: 4,
        deliveredCount: 4,
      });
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec.firstAt = ancient;
      rec.lastAt = ancient;
      writeFileSync(file, JSON.stringify(rec), "utf8");
      const ctx = ctxOf(w, { prList: [] });
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "a park older than the sweep's 14-day life does not refuse — the guard and the sweep share one clock",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }

  // 4h. Group scope: a grouped cycle must not start because only the PRIMARY
  // was clean — every issue in the group is checked, like the attention gate.
  {
    const w = world("group");
    try {
      const SIBLING = 86;
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
      const ctx = ctxOf(w, { prList: [], issues: [ISSUE, SIBLING] });
      const refusal = await repeatParkVerdict(ctx, [ISSUE, SIBLING]);
      assert(
        refusal?.issue === SIBLING,
        "group scope: the guard checks EVERY issue — #86 arms the refusal even though the primary #85 is clean",
      );
      const refused = await refuseRepeatPark(ctx);
      assert(
        typeof refused?.reason === "string" && refused.reason.includes(`#${SIBLING}`),
        "…and the refusal NAMES the issue that armed it, not just the primary",
      );
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
}

process.exit(exitCode());
