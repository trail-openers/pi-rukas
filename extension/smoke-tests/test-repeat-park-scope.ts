#!/usr/bin/env bun
/**
 * The #1743 repeat-park guard's SCOPE — the half that decides what the guard
 * is not allowed to do.
 *
 * `test-repeat-park-guard.ts` pins the refusal itself. This pins the four ways
 * a refusal could be wrong, each a false stop the guard was caught making:
 * refusing a plan gate whose verdict is a model's judgement; writing from the
 * read path; enforcing a GitHub state it has not re-read; and counting parks
 * that were never reported. Plus the group scope (every issue, one name) and
 * the advice the queue gives for each refusal.
 *
 * Offline: no Pi session, no network (`PI_ENSEMBLE_FORGE=none`, the issue-body
 * fetch and the open-PR lookup are both stubbed through `verifyExecFn`).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { projectRepeatParkRefusal } from "../src/headless/repeat-park-refusal.ts";
import { parkRecordPath, repeatParkVerdict } from "../src/work-driver-park-memory.ts";
import {
  REPEAT_PARK_REFUSAL_PREFIX,
  refuseRepeatPark,
} from "../src/work-driver-state-guards.ts";
import { humanActionFor } from "../src/work-queue-cap.ts";
import type { DriverHost } from "../src/work-driver-host.ts";

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_INTENT = "1";
process.env.PI_ENSEMBLE_FORGE = "none";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 85;

interface World {
  repo: string;
  body: string;
}

function world(label: string): World {
  const repo = mkdtempSync(path.join(tmpdir(), `repeat-scope-${label}-`));
  mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  return { repo, body: `title:\tmock #${ISSUE}\n\nthe retry budget is shared` };
}

const now = Date.now();

// ── 4. The other two covered caps behave DIFFERENTLY, and the guard writes
// nothing. `plan-spec-mismatch` is the planner's judgement — counting it is
// useful, refusing on it is the driver claiming a nondeterministic verdict was
// settled. `existing-pr-detected` records a GitHub state, so the guard re-reads
// that state before refusing. And a verdict is a READ: a record of other issue
// text simply does not count; it is not rewritten on the way past.
{
  const mkCtx = (w: World, prList: unknown): DriverContext =>
    ({
      host: { sendUserMessage: () => undefined } as unknown as DriverHost,
      repoRoot: w.repo,
      issue: ISSUE,
      issues: [ISSUE],
      issueBodyFetcherFn: async () => ({ stdout: w.body }),
      // The seam `findOpenPrForIssue` runs its `gh pr list` through — the same
      // seam the branch pre-flight uses, so the re-check is the same lookup.
      verifyExecFn: async () => ({ stdout: JSON.stringify(prList) }),
    }) as unknown as DriverContext;

  const now = Date.now();
  const write = (w: World, cap: string, reason: string, fingerprint: string, count: number, delivered: number) => {
    const file = parkRecordPath(w.repo, ISSUE, cap as never);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        cap,
        reason,
        fingerprint,
        count,
        deliveredCount: delivered,
        firstAt: now - 60_000,
        lastAt: now - 30_000,
        lastMarker: `<!-- pi-rukas:handoff issue=${ISSUE} cap=${cap} -->`,
        lastCycleId: 3,
      }),
      "utf8",
    );
    return file;
  };

  // 4a. plan-spec-mismatch: remembered, never refused.
  {
    const w = world("plan-no-refuse");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "plan-spec-mismatch", "no-calls", here, 5, 5);
      const ctx = mkCtx(w, []);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "plan-spec-mismatch: five identical plan parks do NOT refuse — the planner is a model, not a computation",
      );
      assert(
        (await refuseRepeatPark(ctx)) === undefined,
        "…and refuseRepeatPark lets that start through to run the plan gate again",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4b. A record of OTHER issue text is left exactly as it was.
  {
    const w = world("pure-guard");
    try {
      const file = write(w, "intent-park", "contradicted-by-code", "0".repeat(64), 2, 2);
      const before = readFileSync(file, "utf8");
      const ctx = mkCtx(w, []);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "intent-park: a record from other issue text is not a refusal",
      );
      assert(
        readFileSync(file, "utf8") === before,
        "…and the guard WROTE NOTHING: a verdict is a read, and a half-reset record on a failed comparison is how a guard starts lying",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4c. existing-pr-detected: refuses only while that PR is still open.
  for (const [prList, label] of [
    [[{ number: 77, headRefName: `feature/issue-${ISSUE}-x`, body: `Closes #${ISSUE}` }], "still open"],
    [[], "since closed"],
  ] as const) {
    const w = world(`pr-${label}`);
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "existing-pr-detected", "77", here, 2, 2);
      const ctx = mkCtx(w, prList);
      const refusal = await repeatParkVerdict(ctx);
      if (label === "still open") {
        assert(
          refusal?.cap === "existing-pr-detected" &&
            refusal.reason === "77" &&
            refusal.count === 2 &&
            refusal.issue === ISSUE,
          "existing-pr-detected: the PR is still open, so the guard names the cap, the PR and the count",
        );
        const refusedReason = await refuseRepeatPark(ctx);
        assert(
          typeof refusedReason === "string" &&
            refusedReason.startsWith(REPEAT_PARK_REFUSAL_PREFIX) &&
            refusedReason.includes("existing-pr-detected"),
          "…and refuseRepeatPark turns that into the reason the runner recognises",
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
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4d. `--continue-pr` is the documented remedy for the open-PR park, so the
  // guard never arms against the invocation that tells the operator to use it.
  {
    const w = world("continue-pr");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "existing-pr-detected", "77", here, 2, 2);
      const ctx = {
        ...mkCtx(w, [{ number: 77, headRefName: `feature/issue-${ISSUE}-x`, body: `Closes #${ISSUE}` }]),
        continuePr: true,
      } as unknown as DriverContext;
      assert(
        (await refuseRepeatPark(ctx)) === undefined,
        "--continue-pr with a count-2 open-PR record: the run proceeds — refusing the documented remedy would block the fix",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4e. The threshold is DELIVERED parks, not attempted ones. A factory that
  // ran the cycle twice while `gh` was down has told nobody anything; refusing
  // the third start would silence the first report that ever gets posted.
  {
    const w = world("undelivered");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "intent-park", "contradicted-by-code", here, 2, 0);
      const ctx = mkCtx(w, []);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "two cycles parked and NEITHER reported it (both posts failed): the third start runs — a park nobody read has not been made twice",
      );
      write(w, "intent-park", "contradicted-by-code", here, 3, 1);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "…three parks, one delivered: still short of the two REPORTED parks the threshold asks for",
      );
      write(w, "intent-park", "contradicted-by-code", here, 3, 2);
      assert(
        (await repeatParkVerdict(ctx))?.deliveredCount === 2,
        "…and once two of them were actually reported, the guard arms",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4f. A record nobody can believe is treated as absent: a count that is not
  // a number, or a timestamp from before the driver existed.
  for (const [field, value, label] of [
    ["count", "2", "a string count"],
    ["count", -1, "a negative count"],
    ["lastAt", 2, "a 1970 timestamp"],
  ] as const) {
    const w = world(`bad-${label}`);
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      const file = write(w, "intent-park", "contradicted-by-code", here, 2, 2);
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec[field] = value;
      writeFileSync(file, JSON.stringify(rec), "utf8");
      const ctx = mkCtx(w, []);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        `a malformed record (${label}) is treated as ABSENT — a hand-edited file cannot arm a hard stop`,
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4g. An expired record is ignored, whatever its counters say.
  {
    const w = world("expired");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      const ancient = Date.now() - 20 * 24 * 60 * 60 * 1000;
      const file = write(w, "intent-park", "contradicted-by-code", here, 4, 4);
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec.firstAt = ancient;
      rec.lastAt = ancient;
      writeFileSync(file, JSON.stringify(rec), "utf8");
      const ctx = mkCtx(w, []);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        "a park older than the sweep's 14-day life does not refuse — the guard and the sweep share one clock",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4h. Group scope: a grouped cycle must not start because only the PRIMARY
  // was clean — every issue in the group is checked, like the attention gate.
  {
    const w = world("group");
    try {
      const SIBLING = 86;
      const here = createHash("sha256").update(w.body).digest("hex");
      const file = path.join(w.repo, ".pi", "work-state", String(SIBLING), "park-intent-park.json");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          cap: "intent-park",
          reason: "contradicted-by-code",
          fingerprint: here,
          count: 2,
          deliveredCount: 2,
          firstAt: now - 60_000,
          lastAt: now - 30_000,
          lastMarker: `<!-- pi-rukas:handoff issue=${SIBLING} cap=intent-park -->`,
          lastCycleId: 3,
        }),
        "utf8",
      );
      const ctx = mkCtx(w, []) as unknown as { issues: number[] };
      ctx.issues = [ISSUE, SIBLING];
      const refusal = await repeatParkVerdict(ctx as unknown as DriverContext, ctx.issues);
      assert(
        refusal?.issue === SIBLING,
        "group scope: the guard checks EVERY issue — #86 arms the refusal even though the primary #85 is clean",
      );
      const reason = await refuseRepeatPark(ctx as unknown as DriverContext);
      assert(
        typeof reason === "string" && reason.includes(`#${SIBLING}`),
        "…and the refusal NAMES the issue that armed it, not just the primary",
      );
    } finally {
      rmSync(w.repo, { recursive: true, force: true });
    }
  }
}

// ── 5. Group scope in the HEADLESS RESULT: a grouped cycle refused on one
// member must not report every member as its own repeat-park — nothing ever
// looked at the sibling, and saying otherwise is the driver inventing a verdict
// (#404's failure mode again). Tested at the projector, because whether two
// issues share a cycle is the grouping pass's decision, not this guard's.
{
  const w = world("group-headless");
  const SIBLING = 86;
  try {
    const here = createHash("sha256").update(w.body).digest("hex");
    const file = path.join(w.repo, ".pi", "work-state", String(SIBLING), "park-intent-park.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const t = Date.now();
    writeFileSync(
      file,
      JSON.stringify({
        cap: "intent-park",
        reason: "contradicted-by-code",
        fingerprint: here,
        count: 2,
        deliveredCount: 2,
        firstAt: t - 60_000,
        lastAt: t - 30_000,
        lastMarker: `<!-- pi-rukas:handoff issue=${SIBLING} cap=intent-park -->`,
        lastCycleId: 3,
      }),
      "utf8",
    );
    const ctx = {
      host: { sendUserMessage: () => undefined } as unknown as DriverHost,
      repoRoot: w.repo,
      issue: ISSUE,
      issues: [ISSUE, SIBLING],
      issueBodyFetcherFn: async () => ({ stdout: w.body }),
      verifyExecFn: async () => ({ stdout: "" }),
    } as unknown as DriverContext;
    const reason = await refuseRepeatPark(ctx);
    assert(typeof reason === "string", "the grouped start is refused");
    const results: { issue: number; exitCode: number; cap?: string; failure?: { message?: string }; status: string }[] = [];
    const codes = projectRepeatParkRefusal(
      [ISSUE, SIBLING],
      w.repo,
      { started: false, reason: reason ?? "" } as never,
      results as never,
    );
    assert(codes !== undefined && codes.every((c) => c === 40), "…and every member exits EXIT.refused — the group did not start");
    const armed = results.find((r) => r.issue === SIBLING);
    const sibling = results.find((r) => r.issue === ISSUE);
    assert(
      armed?.cap === "repeat-park" && /already parked 2 times/.test(armed.failure?.message ?? ""),
      "the issue that armed the guard carries the repeat-park cap and its count",
    );
    assert(
      sibling?.cap === undefined &&
        /^not evaluated: the group was refused because #86/.test(sibling?.failure?.message ?? ""),
      "…and its sibling is reported as NOT EVALUATED, naming the issue that actually armed the guard — not as a repeat-park of its own",
    );
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}


process.exit(exit);
