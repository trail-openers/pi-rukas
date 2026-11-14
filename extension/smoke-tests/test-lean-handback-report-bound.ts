#!/usr/bin/env bun
/**
 * lean: the routed deadline report is bounded by the handoff allowance (#2269).
 *
 * A deadline stop routes the run into `handback` because the report is the one step
 * `deadlineStopsSteps` exempts (#2268). That exemption is also what left the report
 * with no wall: it is not started through `startStep`/`settle`, so it gets neither
 * the step's own budget nor the cycle clamp, and the only bounds on it were the
 * per-call git and forge timeouts inside the handler. A hung await inside the
 * reporting step — a wedged in-process call, a comment poster that never returns —
 * therefore held the run past the allowance it exists to protect, and a wrapper's
 * kill recorded a kill instead of the handback. The bound is
 * `handoffAllowanceMs()` — the allowance the routing spends — raced against the
 * handler, and on overrun the run takes the plain deadline stamp.
 *
 *   (a) a hung handler is cut at the bound: the run ends `handed-back` with the
 *       plain deadline stamp, names the bound that fired in BOTH its reason and a
 *       `traceWarn`, writes no report entry, and the handler's late settle writes
 *       nothing. The bound is asserted against the shared helper, not a copy of the
 *       number; origin is untouched, because the cut handler hung before any push;
 *       and the per-issue lock is free behind it, which is the executed evidence
 *       that `runLean`'s `finally` released it;
 *   (b) the bound's ARITHMETIC is the helper's own answer: one arm of a fixed
 *       allowance is settled inside the bound and still delivered its verdict —
 *       proof the bound was large enough to let a real report land, so (a)'s cut
 *       cannot be a bound of zero — while the hung arm of the same allowance is
 *       cut at that number within the case's own guard, a guard that fails the case
 *       rather than hanging the suite;
 *   (c) `PI_ENSEMBLE_LEAN_REPORT_BOUND=0` awaits the handler with no wall at all:
 *       the same hung handler, and the drive only ends when the handler is let
 *       settle, at a time PAST the bound. The bound's sentence appears nowhere in
 *       the record, and the verdict the bound refused lands;
 *   (d) the bound's timer is a ref'd timer and is cleared on the way out of the race
 *       — read off the source, because both properties are invisible to a drive from
 *       outside (a passing drive exits either way). Ref'd is the direction the timer
 *       has to go: an unref'd bound timer is not a reason the loop stays alive, so a
 *       hung handler that holds no handle of its own lets the process exit with the
 *       run carrying no result at all. The `clearTimeout` in the race's `finally` is
 *       what keeps the ref'd timer from outliving the run, so the pair is asserted
 *       together;
 *   (e) the overrun's reason is honest about what the bound does NOT cancel: the
 *       rewind's push and the forge comment of a cut report are already in flight and
 *       may still land after the stamp, so the sentence says so — and the settled arm,
 *       which abandoned nothing, says neither word.
 *
 * The rig is the same one the two deadline suites drive (`driveToDeadline`): the
 * crossing clock, the scripted walk, and the production reporting wiring. Every case
 * owns its repo, and each drive races a guard of its own — an unref'd timer, so a
 * regression on the unbounded arm is a failed case rather than a suite that never
 * exits (R3). `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` is pinned per case rather than
 * inherited from the rig's `ENV`, which is what lets the bound be read as an
 * `allowance` the case knows and pins.
 */

import {
  GUARD_MS,
  assert,
  greenAt,
  guarded,
  hungHandler,
  recordBytes,
  rigEnv,
  state,
} from "./lib/lean-report-bound-shared.ts";
import { unverifiedRef } from "../src/lean/handback-rewind.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { acquireLock } from "../src/lean/lock.ts";
import { withEnv } from "./lib/env-scope.ts";
import { captureWarns } from "./lib/lean-review-bound-fixtures.ts";
import { driveToDeadline } from "./lib/lean-verified-handback-deadline-rig.ts";
import { ISSUE } from "./lib/lean-verified-handback-fixture.ts";
import {
  originBranchSha,
  originRefSha,
  repoWithFixHead,
} from "./lib/lean-verified-handback-repo.ts";
import type { Driven } from "./lib/lean-report-bound-shared.ts";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOTS } from "./lib/lean-verified-handback-fixture.ts";

// ── (a) a hung reporting step is cut at the allowance, and its late settle writes nothing.
{
  const repo = repoWithFixHead();
  const hung = hungHandler();
  // The bound IS the allowance, so this case pins one number for both: the env is
  // what `handoffAllowanceMs()` reads, and the assertion below compares the run's
  // disclosure against that helper rather than against a literal.
  const ALLOWANCE_MS = 4_000;
  const warns: string[] = [];
  const before = originBranchSha(repo.origin);
  if (before !== repo.headSha)
    throw new Error(`(a)'s origin does not hold the fix head: ${String(before)}`);
  const started = Date.now();
  // `Ran` is spelled out rather than derived from the rig's return type: the union's
  // non-object arm has to be a type, not a value, or the widening to `string` swallows the
  // object arm and every read below the `typeof` guard is a `never`.
  type Ran = Driven | `HUNG:${string}` | "NOT_RUN";
  let ran: Ran = "NOT_RUN";
  let allowanceSeen = -1;
  await withEnv(rigEnv(ALLOWANCE_MS), async () => {
    // The helper is read INSIDE the env scope: it is the same reader the engine calls
    // when it asks for the bound, so comparing the two is comparing one number rather
    // than a copy of a constant (the shape of `test-lean-ci-tier-budget.ts` (w)).
    allowanceSeen = handoffAllowanceMs();
    // `captureWarns` collects into the caller's array and returns nothing (its
    // docstring's own reason: a returned value would not exist yet inside the body
    // that produced it), so the drive is captured by the body itself.
    await captureWarns("[pi-rukas] WARN", warns, async () => {
      // The write goes through a local, not `ran`: the capture body is typed
      // `() => Promise<void>`, so an assignment in its tail position is where the object
      // arm gets dropped.
      const result = await guarded("a:hung-handler", () =>
        driveToDeadline(repo.repoRoot, greenAt(repo.baseSha), repo.baseSha, {
          handback: hung.handler,
        }),
      );
      ran = result;
    });
  });
  const waited = Date.now() - started;

  // Narrowed ONCE, into a const of the object arm's own type. An `if (typeof ran !==
  // "string")` guard does not narrow here: the variable is written inside a callback, and
  // the assertions below are reached with the union emptied to `never`.
  const drive: Driven | undefined = typeof ran === "object" ? ran : undefined;
  assert(
    drive !== undefined,
    `(a) the hung reporting step did not hold the run: the drive returned in ${String(waited)}ms instead of hanging (got ${JSON.stringify(ran)})`,
  );
  if (drive !== undefined) {
    const ran = drive as Driven;
    assert(
      ran.crossed,
      `(a) the clock really crossed the handoff allowance during the drive (crossed=${String(ran.crossed)})`,
    );
    assert(
      ran.state === "handed-back",
      `(a) the run ended handed-back rather than never ending (got ${ran.state}: ${ran.reason})`,
    );
    // The cut is the deadline stamp the run always took — not a report's verdict and
    // not a kill. `outcome` is undefined for the same reason the throw arm's is: the
    // handler never answered, so there is no verdict to record.
    assert(
      ran.reason.includes("cycle deadline") && ran.reason.includes("reached at verify"),
      `(a) and it took the PLAIN deadline stamp, naming the step the clock refused (got ${JSON.stringify(ran.reason)})`,
    );
    assert(
      ran.outcome === undefined,
      `(a) so no handback verdict is recorded (got ${JSON.stringify(ran.outcome)})`,
    );
    assert(
      !ran.steps.some((s) => s.state === "handback"),
      `(a) and no report entry reached the log — the bound fired before the visit was written (${ran.steps.map((s) => `${s.key}=${s.outcome?.kind ?? "?"}`).join(",")})`,
    );
    // THE BOUND'S ARITHMETIC, asserted against the shared helper rather than a copy
    // of the number: change `PI_ENSEMBLE_HANDOFF_TIMEOUT_MS` and the bound the run
    // names moves with it, in this assertion and in the code together.
    assert(
      allowanceSeen === ALLOWANCE_MS,
      `(a) the allowance the case pinned is the helper's own answer (${String(allowanceSeen)}, pinned ${String(ALLOWANCE_MS)})`,
    );
    // The overrun's origin is told on the UNGATED `traceWarn` channel — the same one
    // the throw arm beside it uses, for the same reason: the run's outcome changed, so
    // a warning gated on `PI_ENSEMBLE_DEBUG` would not be a disclosure. It names the
    // await that timed out and how long it was given, which is what separates this
    // record from the kill an unbounded run would have left behind.
    assert(
      warns.length === 1 &&
        warns[0]?.includes("WARN") === true &&
        warns[0].includes("report") &&
        warns[0].includes("handback report timed out") &&
        warns[0].includes(String(allowanceSeen)),
      `(a) the overrun is disclosed on the ungated traceWarn channel, naming the report that timed out and the allowance it was cut at (warns ${JSON.stringify(warns)})`,
    );
    assert(
      warns.length === 1 &&
        String(ran.reason).includes(String(allowanceSeen)) &&
        String(ran.reason).includes("handback report timed out"),
      `(a) and the bound rides into the durable record too — the plain deadline stamp names it in the helper's own number, so a reader of the file alone can tell a cut report from an ordinary stop (warns ${JSON.stringify(warns)}, reason ${JSON.stringify(ran.reason)})`,
    );
    // The hung handler hung BEFORE any push, so origin is the arm R4 fixes: origin at
    // F, no keeping-ref. Nothing about the cut moves a ref.
    assert(
      originBranchSha(repo.origin) === repo.headSha,
      `(a) origin still holds F — the handler hung before its push, and the cut moved nothing (got ${String(originBranchSha(repo.origin))})`,
    );
    assert(
      originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
      `(a) and no keeping-ref was written (got ${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
    );
    // The bytes the run wrote are the run's whole durable claim, so the late settle
    // is judged on them rather than on the in-memory object the drive returned.
    const bytesBeforeRelease = recordBytes(repo.repoRoot);
    hung.release();
    // A macrotask turn, so a handler that settled after the cut has had its
    // continuation scheduled — if any of its writes could still land, they land here.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert(
      hung.releases === 1 && hung.calls === 1,
      `(a) the released handler did settle — so the assertion below is a late write that was refused, not a handler that never ran (calls ${String(hung.calls)}, releases ${String(hung.releases)})`,
    );
    assert(
      recordBytes(repo.repoRoot) === bytesBeforeRelease,
      "(a) and the late settle wrote nothing: the record the cut left is byte-identical after the handler finally returned",
    );
    // R6: the bound's return path is `runLean`'s, whose `finally` releases the
    // per-issue lock. A second acquire on the same issue is the executed evidence.
    let lockError: Error | undefined;
    let releaseSecond: (() => void) | undefined;
    try {
      releaseSecond = acquireLock(repo.repoRoot, ISSUE);
    } catch (err) {
      lockError = err as Error;
    }
    assert(
      lockError === undefined,
      `(a) and the per-issue lock is free behind the bound — a run cut mid-report does not wedge its issue (got ${String(lockError?.name)}: ${String(lockError?.message)})`,
    );
    releaseSecond?.();
  }
}

// ── (b) the bound is wide enough to let a real report land: inside settles, hung is cut.
{
  // One allowance for both arms. The settled arm's handler resolves at a third of
  // it and must deliver its verdict; the hung arm of that same allowance must be cut
  // at it. A bound set too small — the silent way this rule breaks — turns the first
  // assertion red, and the guard keeps the second one from hanging the suite.
  const ALLOWANCE_MS = 6_000;
  const inside = repoWithFixHead();
  await withEnv(rigEnv(ALLOWANCE_MS), async () => {
    const ran = await guarded("b:fast-handler", () =>
      driveToDeadline(inside.repoRoot, greenAt(inside.baseSha), inside.baseSha, {
        handback: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, Math.floor(ALLOWANCE_MS / 3)));
          return { kind: "done", reason: `reported inside the bound at ${ctx.stepKey}` };
        },
      }),
    );
    assert(
      typeof ran === "object",
      `(b) a report that settles inside the bound was not cut short (got ${JSON.stringify(ran)})`,
    );
    if (typeof ran !== "string") {
      assert(
        ran.state === "handed-back" &&
          ran.reason.includes("cycle deadline reached at verify"),
        `(b) and it still ended as the routed report it always was (got ${ran.state}: ${ran.reason})`,
      );
      assert(
        ran.outcome?.kind === "done" &&
          ran.outcome?.reason === `reported inside the bound at ${ISSUE}:handback:0`,
        `(b) the handler's own verdict landed on the record — the bound is wide enough for a real report (got ${JSON.stringify(ran.outcome)})`,
      );
      assert(
        ran.newest?.state === "handback" && ran.newest.outcome?.kind === "done",
        `(b) and the log still ends on the report's entry with its verdict (${String(ran.newest?.state)}:${String(ran.newest?.outcome?.kind ?? "undecided")})`,
      );
    }
  });

  const hungRepo = repoWithFixHead();
  await withEnv(rigEnv(ALLOWANCE_MS), async () => {
    const started = Date.now();
    const ran = await guarded("b:hung-handler", () =>
      driveToDeadline(hungRepo.repoRoot, greenAt(hungRepo.baseSha), hungRepo.baseSha, {
        handback: () => new Promise(() => {}),
      }),
    );
    const waited = Date.now() - started;
    assert(
      typeof ran === "object",
      `(b) the hung arm of the same allowance was cut rather than hung (waited ${String(waited)}ms, guard ${String(GUARD_MS)}ms, got ${JSON.stringify(ran)})`,
    );
    if (typeof ran !== "string") {
      assert(
        ran.reason.includes(String(handoffAllowanceMs())),
        `(b) and it names the allowance the run was cut at — the same helper, the same number (${String(handoffAllowanceMs())}, got ${JSON.stringify(ran.reason)})`,
      );
      // The cut must land on the bound, not on the guard: a bound read from anything
      // other than the allowance (zero, or the guard) would still return here.
      assert(
        waited >= handoffAllowanceMs() - 500 && waited < GUARD_MS / 2,
        `(b) the cut happened AT the allowance rather than at the case's guard (${String(waited)}ms, allowance ${String(handoffAllowanceMs())}ms, guard ${String(GUARD_MS)}ms)`,
      );
    }
  });
}

// ── (c) `PI_ENSEMBLE_LEAN_REPORT_BOUND=0`: the await is unbounded, exactly as before.
{
  // The off arm cannot be shown by a hang — a hang is what the bound exists to cut,
  // and on the off arm it would never end. So the handler is held pending past the
  // bound and let settle, and the case asserts the run waited for it: the stamp it
  // carries is the report's verdict, and the bound's own sentence appears nowhere.
  const repo = repoWithFixHead();
  const hung = hungHandler();
  const ALLOWANCE_MS = 2_000;
  const warns: string[] = [];
  await withEnv(
    rigEnv(ALLOWANCE_MS, { PI_ENSEMBLE_LEAN_REPORT_BOUND: "0" }),
    async () => {
      const started = Date.now();
      let ran: Driven | string = "NOT_RUN";
      await captureWarns("[pi-rukas] WARN", warns, async () => {
        // Past the bound by more than the bound itself, so the drive cannot have
        // been cut at it and simply waited out the case's own clock.
        const hold = setTimeout(() => hung.release(), ALLOWANCE_MS * 3);
        try {
          ran = await guarded("c:unbounded", () =>
            driveToDeadline(repo.repoRoot, greenAt(repo.baseSha), repo.baseSha, {
              handback: hung.handler,
            }),
          );
        } finally {
          clearTimeout(hold);
          hung.release();
        }
      });
      const waited = Date.now() - started;
      assert(
        typeof ran === "object",
        `(c) with the bound off the drive is the drive it always was — it ends when the handler does (got ${JSON.stringify(ran)})`,
      );
      const cDrive: Driven | undefined = typeof ran === "object" ? ran : undefined;
      assert(
        cDrive !== undefined,
        `(c) with the bound off the drive ended at all (got ${JSON.stringify(ran)})`,
      );
      if (cDrive !== undefined) {
        const ran = cDrive as Driven;
        assert(
          waited >= ALLOWANCE_MS,
          `(c) and it really waited for the handler past the allowance the ON arm would have cut at (${String(waited)}ms, allowance ${String(ALLOWANCE_MS)}ms)`,
        );
        assert(
          ran.reason.includes("cycle deadline reached at verify") &&
            ran.outcome?.kind === "done" &&
            ran.outcome.reason === `posted late for ${ISSUE}:handback:0`,
          `(c) the report's own verdict landed — the engine awaited the handler and nothing else (got ${JSON.stringify([ran.reason, ran.outcome])})`,
        );
        assert(
          !ran.reason.includes("timed out"),
          `(c) and the bound's sentence is nowhere in the record — the off arm writes nothing the bound says (got ${JSON.stringify(ran.reason)})`,
        );
        assert(
          warns.length === 0,
          `(c) and nothing was warned about a bound — the off arm emits no bound disclosure either (warns ${JSON.stringify(warns)})`,
        );
      }
    },
  );
}

// ── (d) the bound's timer cannot hold the process, and cannot outlive the race (R3).
//
// A ref'd timer that outlives the run keeps bun alive past the terminal stamp — the
// failure the suite would show as a green file that never exits — and a timer never
// cleared is still armed after the run has stopped waiting on it. Both are properties of
// the source a behavioural case cannot see from outside (a passing drive exits either
// way), so they are asserted where the precedent in this repo asserts them
// (`test-host-spawn-lease.ts`), over the race that (a) and (b) show firing.
{
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "lean", "engine-report.ts"),
    "utf8",
  );
  const race = src.slice(src.indexOf("Promise.race([call, overrun]"));
  const timerWindow = src.slice(
    src.indexOf("const overrun = new Promise"),
    src.indexOf("const settled = await Promise.race"),
  );
  assert(
    !/\.unref\?\.\(\)|\.unref\(\)/.test(timerWindow),
    "(d) the bound timer is NOT unref'd — an unref'd bound timer is not a reason the loop stays alive, so a hung handler that holds no handle of its own lets the process exit with the run unstamped",
  );
  assert(
    /if \(boundTimer\) clearTimeout\(boundTimer\)/.test(src),
    "(d) and the timer is cleared on the way out of the race, in the arm that settles as well as the one that overruns — that is what keeps a ref'd timer from outliving the run",
  );
  assert(
    race !== undefined && race.includes("overrun"),
    "(d) and the handler's promise is what the race runs against — the bound is on the await, not on a copy of it",
  );
}

// ── (e) the overrun's reason says what the abandoned handler may still do.
//
// The bound abandons the handler; it cannot cancel it. The rewind's `git push` and the
// forge comment that were already issued go on running — a group kill that recalled them
// is not available at this layer — and may well complete after the stamp. A reason line
// that reads as though the report simply never happened is the record that hides a landed
// push behind a routine stop, so the sentence has to say both halves.
{
  const hungRepo = repoWithFixHead();
  const ALLOWANCE_MS = 2_000;
  const warns: string[] = [];
  // `Drive` is the rig's own result type, named once: a `let` whose union carries a string
  // arm is read back as `never` by a `typeof` guard after an assignment made inside a
  // callback, so each case narrows into a `const` of this type instead.
  type Drive = Awaited<ReturnType<typeof driveToDeadline>>;
  let ran: Drive | string = "NOT_RUN";
  await withEnv(rigEnv(ALLOWANCE_MS), async () => {
    await captureWarns("[pi-rukas] WARN", warns, async () => {
      const result = await guarded("e:hung-handler", () =>
        driveToDeadline(hungRepo.repoRoot, greenAt(hungRepo.baseSha), hungRepo.baseSha, {
          handback: () => new Promise(() => {}),
        }),
      );
      ran = result;
    });
  });
  const eDrive: Drive | undefined = typeof ran === "object" ? ran : undefined;
  assert(
    eDrive !== undefined,
    `(e) the hung reporting step was cut (got ${JSON.stringify(ran)})`,
  );
  if (eDrive !== undefined) {
    const ran = eDrive as Driven;
    assert(
      ran.reason.includes("may still complete") &&
        ran.reason.includes("rewind") &&
        ran.reason.includes("comment") &&
        ran.reason.includes("handback report timed out"),
      `(e) the overrun's own sentence says the abandoned handler is not cancelled: its rewind and comment may still land after the stamp (got ${JSON.stringify(ran.reason)})`,
    );
    assert(
      warns.length === 1 &&
        warns[0]?.includes("may still complete") === true &&
        warns[0].includes("rewind"),
      `(e) and the ungated warning tells the operator the same thing the record says — one sentence, two surfaces (warns ${JSON.stringify(warns)})`,
    );
  }

  // The settled arm says neither: a report that answered has nothing outstanding, and a
  // reason that hedged about a landed push would make a clean handback look unfinished.
  const clean = repoWithFixHead();
  await withEnv(rigEnv(ALLOWANCE_MS), async () => {
    const settledRun = await guarded("e:settled", () =>
      driveToDeadline(clean.repoRoot, greenAt(clean.baseSha), clean.baseSha, {
        handback: async () => ({ kind: "done", reason: "reported" }),
      }),
    );
    assert(
      typeof settledRun === "object" &&
        !String(settledRun.reason).includes("may still complete"),
      `(e) the settled report's reason says nothing about an abandoned handler — that clause belongs to the overrun alone (got ${JSON.stringify(settledRun)})`,
    );
  });
}


for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(state.exit);
