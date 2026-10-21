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
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4d. `--continue-pr` is the documented remedy for the OPEN-PR park, so the
  // guard never arms against the invocation that tells the operator to use it.
  // But it is the remedy for THAT park only: an intent park is a statement
  // about the issue body, and continuing a PR does nothing about it.
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
  {
    const w = world("continue-pr-intent");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "intent-park", "contradicted-by-code", here, 2, 2);
      const ctx = {
        ...mkCtx(w, []),
        continuePr: true,
      } as unknown as DriverContext;
      const refused = await refuseRepeatPark(ctx);
      assert(
        refused?.repeatPark?.cap === "intent-park" &&
          refused.reason.startsWith(REPEAT_PARK_REFUSAL_PREFIX),
        "--continue-pr does NOT waive an intent-park refusal — the flag continues a PR; it does not make the issue say more",
      );
      // And the flag still waives nothing when the PR park is not the one that
      // armed: an intent record beside an open-PR record refuses on the intent.
      write(w, "existing-pr-detected", "77", here, 2, 2);
      const both = await refuseRepeatPark({
        ...mkCtx(w, [{ number: 77, headRefName: `feature/issue-${ISSUE}-x`, body: `Closes #${ISSUE}` }]),
        continuePr: true,
      } as unknown as DriverContext);
      assert(
        both?.repeatPark?.cap === "intent-park",
        "…and with both records armed, --continue-pr stands down only the open-PR one",
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
  {
    // `1e999` is the case a JSON parse turns into Infinity, and
    // `new Date(Infinity).toISOString()` THROWS. The refusal sentence formats
    // that date, so an Infinity firstAt must be rejected on the read, not
    // survive to crash the start it is refusing.
    const w = world("bad-infinite-firstAt");
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      const file = write(w, "intent-park", "contradicted-by-code", here, 2, 2);
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
      const ctx = mkCtx(w, []);
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
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // 4f-bis. An `existing-pr-detected` record whose reason is not a PR number
  // cannot be re-checked against the forge, so it fails OPEN: the driver does
  // not get to refuse on a GitHub state it could not confirm.
  for (const reason of ["not-a-pr", "77.5", "0", "-3", ""]) {
    const w = world(`bad-pr-reason-${reason || "empty"}`);
    try {
      const here = createHash("sha256").update(w.body).digest("hex");
      write(w, "existing-pr-detected", reason, here, 2, 2);
      const ctx = mkCtx(w, [
        { number: 77, headRefName: `feature/issue-${ISSUE}-x`, body: `Closes #${ISSUE}` },
      ]);
      assert(
        (await repeatParkVerdict(ctx)) === undefined,
        `existing-pr-detected with reason ${JSON.stringify(reason)}: the forge re-check cannot run, so the guard fails OPEN (a PR that looks open is not a reason the driver may enforce)`,
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
      const refused = await refuseRepeatPark(ctx as unknown as DriverContext);
      assert(
        typeof refused?.reason === "string" && refused.reason.includes(`#${SIBLING}`),
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
    const refusal = await refuseRepeatPark(ctx);
    assert(typeof refusal?.reason === "string", "the grouped start is refused");
    const results: { issue: number; exitCode: number; cap?: string; failure?: { message?: string }; status: string }[] = [];
    const codes = projectRepeatParkRefusal(
      [ISSUE, SIBLING],
      w.repo,
      { started: false, ...refusal } as never,
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
    // The projector reads the RECORD, not the prose: hand it a refusal whose
    // sentence has been mangled and the numbers it publishes still come from
    // the structured verdict it arrived with.
    const mangled: typeof results = [];
    projectRepeatParkRefusal(
      [ISSUE, SIBLING],
      w.repo,
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
    rmSync(w.repo, { recursive: true, force: true });
  }
}


process.exit(exit);
