#!/usr/bin/env bun
/**
 * lean/ci — the WAIT: a check that has not finished is not a check that failed.
 *
 * The companion to `test-lean-ci.ts`, which covers the step's single-read
 * verdicts. Those cases cannot express the defect this issue is about: the step
 * read the forge 0.7 s after publish, found `mergeStateStatus` UNSTABLE because
 * the repo's one required check was still running, called that `red`, and the
 * machine routed the run into a build round asking a child to fix code that was
 * not broken. Grading a wait requires a SEQUENCE of forge replies and a `sleep`
 * that advances the clock the wait is bounded by, which is what the recorder in
 * `lib/lean-ci-recorder.ts` provides (and why every case that waits asks for a
 * moving clock — a frozen one never crosses the bound and the case hangs).
 *
 *   (n) checks pending, then passing on the next poll -> green, tier once
 *   (o) checks pending, then one failing -> red naming the failed check
 *   (p) checks still pending at the wait's bound -> THROWS, no tier, no red
 *   (q) a row in no state list at all is waited on, never graded green
 *   (r) the PR head moves on the second poll -> red, and no third poll
 *   (s) `gh pr checks`' exit-8 pending reply is read as DATA, not a failed read
 *   (t) the poll stops at the run's whole-cycle deadline -> THROWS, no red
 *   (u) the wait bound is `budgets.ci.minutes`, not a constant in this step
 *   (v) the PRODUCTION sleep is a real timer, not a no-op, and the production
 *        clock advances with it
 *
 * (v) is the one case in either suite allowed to touch the production timer, and
 * it never sleeps the poll's minute: it asks that function to wait 40 ms and
 * races it against a `sleep 5` child, which a no-op sleep loses. Every other case
 * injects its own `sleep`, so nothing else in the suite can reach real time.
 *
 * Offline throughout: the forge is a recorder answering the pinned argv, the tier
 * is an `sh` command, no PR and no merge exist.
 */

import { CI_POLL_MS } from "../src/lean/ci.ts";
import { ciDeps } from "../src/lean/ci-deps.ts";
import { execp } from "../src/exec.ts";
import { cleanUp, run, viewAt } from "./lib/lean-ci-recorder.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (n) pending, then passing on the next poll -> green, tier exactly once ─
{
  // The bug this issue is about: the step read the forge 0.7s after publish,
  // found UNSTABLE, called it red, and the machine spent a build round on code
  // nobody had broken. A pending row is a check that has not FINISHED, not a
  // check that failed, so the poll waits and the green arrives after.
  // The head the checks are read at must be the head the gate certified, so a
  // poll case builds its replies from the oid `run` reports — a constant here is
  // a head this repo never held, and the step would be red before it polled.
  const r = await run({
    full: "true",
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h)],
    checksSeq: [
      [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
      [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
    ],
  });
  assert(
    r.outcome?.kind === "green",
    `(n) pending then passing -> green after the tier (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  const views = r.cmds.filter((c) => c.startsWith("gh pr view ")).length;
  const checks = r.cmds.filter((c) => c.startsWith("gh pr checks ")).length;
  assert(
    views === 2 && checks === 2,
    `(n) both reads ran once PER POLL, not once per step (views ${String(views)}, checks ${String(checks)})`,
  );
  assert(
    r.cmds.filter((c) => c === "true").length === 1,
    `(n) the full tier ran exactly once, not once per poll (${String(r.cmds.filter((c) => c === "true").length)})`,
  );
  assert(
    r.slept.length === 1 && r.slept[0] === 60_000,
    `(n) one wait of a minute between the two reads (${JSON.stringify(r.slept)})`,
  );
  // The tier's bound is its OWN and of the same size as the wait's: the default
  // `ci` budget is 30 minutes, so after waiting out a minute of CI the tier must
  // still be given the full 30. A step that shared one deadline between the two
  // would hand the tier the leftover, and a hung suite would then be a tier kill
  // reported as infra rather than a tier that got its own time.
  const rBound = await run({ full: "true", clockMs: 0, tierTimeoutMs: null });
  assert(
    rBound.tierTimeoutMs === 30 * 60_000,
    `(n) the tier kept its own full bound after the wait, from budgets.ci.minutes (${String(rBound.tierTimeoutMs)})`,
  );
}

// ── (o) pending, then one row failing -> red naming that check ───────────
{
  const r = await run({
    full: "true",
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h, { mergeStateStatus: "DIRTY" })],
    checksSeq: [
      [
        { name: "quality-gate", bucket: "pending", state: "PENDING" },
        { name: "offline-smoke", bucket: "pending", state: "PENDING" },
      ],
      [
        { name: "quality-gate", bucket: "fail", state: "FAILURE" },
        { name: "offline-smoke", bucket: "pass", state: "SUCCESS" },
      ],
    ],
  });
  assert(
    r.outcome?.kind === "red",
    `(o) a check that really failed -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("quality-gate"),
    `(o) the red names the failed check, not the pending ones (${r.outcome?.reason})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("offline-smoke"),
    `(o) a passing row is not dragged into the red (${r.outcome?.reason})`,
  );
  assert(
    !r.cmds.includes("true"),
    "(o) the tier never ran over a CI that failed",
  );
  assert(r.slept.length === 1, `(o) one poll waited out, then the verdict (${JSON.stringify(r.slept)})`);
}

// ── (p) still pending at the bound -> infra handback, no tier, no red ────
{
  // A run whose CI never finishes is not a run whose code is wrong. Red would
  // route a build round at code that is fine; this is the throw the engine ends
  // `handed-back` for, naming the checks that never came in.
  const r = await run({
    full: "true",
    waitTimeoutMs: 150_000,
    // The wait is bounded by the case's clock, which only the injected sleep
    // moves: a case that leaves it frozen at 4 can never exhaust its bound, and
    // the poll spins issuing `gh` reads forever. Any case that waits asks for a
    // moving clock.
    clockMs: 0,
    viewAt: (h) => viewAt(h, { mergeStateStatus: "UNSTABLE" }),
    checks: [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(p) a wait that expires THROWS infra, it is not a red (${String(r.threw?.message)})`,
  );
  assert(r.outcome === undefined, "(p) and records no verdict the machine could route to a build round");
  assert(
    (r.threw?.message ?? "").includes("still pending after 3 min"),
    `(p) the reason names the bound it ran out of (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("quality-gate"),
    `(p) and names the checks that never finished (${String(r.threw?.message)})`,
  );
  assert(!r.cmds.includes("true"), "(p) the full tier never ran on a wait nobody observed through");
  // 150 000 ms of bound at 60 000 ms per poll: three waits, then the throw.
  assert(
    r.slept.length === 3,
    `(p) the bound is measured in polls, not in one hot read (${JSON.stringify(r.slept)})`,
  );
}

// ── (q) a row in no state list at all is waited, never graded ───────────
{
  // A state this file has never seen is not evidence of a pass and not
  // evidence of a failure. Grading it red spends a build round on a name nobody
  // read; grading it green merges on a check that said nothing. So it waits, and
  // the expired wait hands back — the same answer as a pending row.
  const r = await run({
    full: "true",
    waitTimeoutMs: 90_000,
    clockMs: 0,
    viewAt: (h) => viewAt(h, { mergeStateStatus: "UNSTABLE" }),
    checks: [{ name: "mystery-check", bucket: "blocked", state: "BLOCKED" }],
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(q) an unrecognised row state is waited on, never graded (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("mystery-check"),
    `(q) and the handback names it (${String(r.threw?.message)})`,
  );
  assert(r.outcome === undefined, "(q) an unreadable forge state never becomes a red the machine routes");
  assert(!r.cmds.includes("true"), "(q) and no tier ran over it");
}

// ── (r) the head moves on poll 2 -> red naming both oids, no poll 3 ─────
{
  // The head check runs on EVERY poll precisely because a PR can move while the
  // step waits. A green about a head the checks did not run at is the one thing
  // this step exists to make unreachable, so the poll that sees the move
  // settles the step — it does not sleep and read again.
  const other = "c".repeat(40);
  const r = await run({
    full: "true",
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h, { headRefOid: other })],
    checksSeq: [
      [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
      [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
    ],
  });
  assert(
    r.outcome?.kind === "red",
    `(r) a head that moved mid-wait -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(other.slice(0, 12)) &&
      (r.outcome?.reason ?? "").includes(r.head.slice(0, 12)),
    `(r) the red names BOTH oids (${r.outcome?.reason})`,
  );
  assert(
    r.cmds.filter((c) => c.startsWith("gh pr view ")).length === 2,
    `(r) the poll that saw the move settled the step — no third read (${String(r.cmds.filter((c) => c.startsWith("gh pr view ")).length)} views)`,
  );
  assert(
    r.slept.length === 1,
    `(r) and it did not sleep and read again after deciding (${JSON.stringify(r.slept)})`,
  );
  assert(!r.cmds.includes("true"), "(r) no tier runs at a head the checks never ran at");
}

// ── (s) `gh pr checks` exit 8 (checks pending) is DATA, not an infra throw ─
{
  // The real CLI exits 8 while checks run (`gh pr checks --help`, gh 2.103.3:
  // `8: Checks pending`) and the shared executor rejects on any non-zero exit.
  // Read as a failed read, the poll could never observe the one state it exists
  // for, and every pending CI would hand the run back. stdout still carries the
  // rows, so the reply is answered — and the poll continues.
  const pendingExit8 = Object.assign(new Error("Command failed: gh pr checks"), {
    code: 8,
    stdout: JSON.stringify([{ name: "quality-gate", bucket: "pending", state: "PENDING" }]),
  });
  const r = await run({
    full: "true",
    checksThrows: [pendingExit8],
    checksSeq: [[{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }]],
  });
  assert(
    r.outcome?.kind === "green",
    `(s) an exit-8 pending reply is read as data, not a broken read (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    r.cmds.filter((c) => c.startsWith("gh pr checks ")).length === 2,
    "(s) the exit-8 row was seen, waited out, and re-read",
  );
  // The same exit code carrying NO rows is not data — that is the read failing.
  const emptyExit8 = Object.assign(new Error("Command failed: gh pr checks"), { code: 8, stdout: "" });
  const bad = await run({ full: "true", checksThrows: [emptyExit8] });
  assert(
    bad.threw instanceof VerifyInfraError,
    `(s) an exit-8 reply with nothing in it THROWS — an empty stdout is not rows (${String(bad.threw?.message)})`,
  );
  // A poll case that got as far as the forge answered every read well, which is
  // what the step's own green is a claim about. A well-formed poll cannot end on
  // the first read unless it read what it was handed, so this is the witness that
  // the sequence machinery answers the SECOND poll too.
  const v = await run({ full: "true", viewAt: (h) => [viewAt(h), viewAt(h)] });
  assert(
    v.outcome?.kind === "green" && v.slept.length === 0,
    `(s) a passing poll answers at once and does not wait (${JSON.stringify(v.outcome ?? v.threw?.message)})`,
  );
}

// ── (t) the poll stops at the run's whole-cycle deadline -> handback ─────
{
  // The engine only consults the cycle arm BETWEEN steps, so a poll that never
  // ends outlives the host's deadline and the run dies with no document. The
  // poll reads the same arm the engine reads, on the context's clock.
  const r = await run({
    full: "true",
    clockMs: 1_000,
    deadlineMs: 61_000,
    viewAt: (h) => viewAt(h, { mergeStateStatus: "UNSTABLE" }),
    checks: [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
  });
  assert(
    r.threw instanceof VerifyInfraError &&
      (r.threw.message ?? "").includes("cycle deadline"),
    `(t) the poll stops inside the handoff allowance (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("61000"),
    `(t) the handback NAMES the cycle deadline it stopped at (${String(r.threw?.message)})`,
  );
  assert(r.outcome === undefined, "(t) a deadline is not a verdict about the code");
  assert(!r.cmds.includes("true"), "(t) no tier starts when the run has no time to report");
}

// ── (u) the wait bound is the project's `budgets.ci.minutes`, not a constant ─
{
  // The tier's bound and the wait's bound both come from `budgetFor(config, "ci")`,
  // so a project that sets a 2-minute ci budget gets a 2-minute wait — not the
  // shipped 30. If the step read a literal instead, this run would keep polling
  // past the bound it was configured with and never hand back.
  const r = await run({
    full: "true",
    clockMs: 0,
    ciBudget: { turns: 0, tokens: 0, minutes: 2 },
    viewAt: (h) => viewAt(h, { mergeStateStatus: "UNSTABLE" }),
    checks: [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
  });
  assert(
    r.threw instanceof VerifyInfraError &&
      (r.threw.message ?? "").includes("still pending after 2 min"),
    `(u) the bound is budgets.ci.minutes read through budgetFor (${String(r.threw?.message)})`,
  );
  assert(
    r.slept.every((ms) => ms === CI_POLL_MS) && r.slept.length === 2,
    `(u) at the poll's own interval, twice before the bound (${JSON.stringify(r.slept)})`,
  );
  assert(!r.cmds.includes("true"), "(u) and the tier never started");
}

// ── (v) the production sleep is a REAL timer, never a zero-delay no-op ────
{
  // Every case above injects its own `sleep`, so nothing but the production
  // default can catch a sleep that degenerates to a no-op: the poll would then
  // hammer `gh` for the whole budget. Asserted without waiting the poll's minute
  // — the function is raced against a timer, which a no-op sleep cannot win (and
  // neither can a busy loop, which reports done long before the bound). The
  // production clock is read for the same reason: a frozen default would let the
  // wait never expire in production, which is the hang this whole step is here
  // to avoid, only in the other direction.
  const deps = ciDeps();
  // The 40 ms sleep is raced against a `sleep 5` child: a no-op sleep wins that
  // race, so the assertion fails when the production timer is removed, and the
  // case still costs milliseconds, not the poll's minute.
  const raced = await Promise.race([
    deps.sleep(40).then(() => "slept" as const),
    execp("sleep 5", { timeout: 60_000, killGroup: true }).then(() => "too-fast" as const),
  ]);
  assert(raced === "slept", `(v) the production sleep waits real time (${raced})`);
  const before = deps.now();
  await deps.sleep(30);
  const after = deps.now();
  assert(
    after > before,
    `(v) the production clock advances with real time (${String(before)} -> ${String(after)})`,
  );
}

cleanUp();
process.exit(exit);
