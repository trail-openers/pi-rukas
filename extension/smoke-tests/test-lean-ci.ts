#!/usr/bin/env bun
/**
 * lean/ci — the step that refuses to call a green a green on a child's word.
 *
 * `ci` sits between `publish` and `land`, and `land` trusts it for the merge. So
 * every case below asks one of two questions: did the step OBSERVE both halves
 * (the forge's required-check verdict and the project's full verify tier), or did
 * it talk itself into a green? A case passes `green` only when the recorder says
 * both commands really ran against the right head; anything it did not run can
 * only produce red or a throw.
 *
 *   (a) both halves observed at the verified head -> green
 *   (b) no full tier configured -> red naming that gap (and the tier never ran)
 *   (c) the tier exits non-zero -> red carrying its tail
 *   (d) a required check not passing -> red, and the tier was never run
 *   (e) no checks reported at all -> red (absence of evidence is not green)
 *   (f) the PR head moved off the verified head -> red, tier not run
 *   (g) the PR is not OPEN -> red
 *   (h) `gh` could not run -> THROWS (infra), never a red the machine routes to a fix
 *   (i) the tier was killed at its bound -> THROWS, not a red
 *   (j) the tier could not be started -> THROWS
 *   (k) no verified head on the log -> THROWS (nothing to observe)
 *   (l) no PR on the log -> THROWS
 *   (m) the full tier falls back to `.pi/verify-cmd` when work.json has none
 *
 * The WAITING half of the step lives in `test-lean-ci-poll.ts` (cases (n)-(v)):
 * a step that reads the forge once, 0.7s after publish, grades a still-running CI
 * as a failed check and the machine spends a build round on code that is not
 * broken. Both suites drive the same recorder in `lib/lean-ci-recorder.ts`.
 *
 * Everything is offline: the forge is a recorder answering the pinned argv, the
 * tier is an `sh` command the recorder runs, and no PR or merge exists.
 */

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

// ── (a) both halves observed -> green, and BOTH commands really ran ────────
{
  const r = await run({ full: "true" });
  assert(r.outcome?.kind === "green", `(a) both halves observed -> green (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(r.cmds.some((c) => c.startsWith("gh pr view ")), "(a) the forge's merge verdict was read");
  assert(r.cmds.some((c) => c.startsWith("gh pr checks ")), "(a) the check rows were read");
  assert(r.cmds.includes("true"), "(a) the full tier actually ran");
}

// ── (b) no full tier -> red naming the gap, and the tier never ran ─────────
{
  const r = await run({});
  assert(r.outcome?.kind === "red", `(b) no full tier -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("no full verify tier"),
    `(b) the red names the missing full tier (${r.outcome?.reason})`,
  );
  assert(
    !r.cmds.some((c) => c.startsWith("gh ")),
    "(b) a run with no full tier never reads the forge — there is no green on offer",
  );
}

// ── (c) the tier fails -> red carrying its tail ───────────────────────────
{
  const r = await run({ full: "tier", tierExit: 3 });
  assert(r.outcome?.kind === "red", `(c) a failing full tier -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("boom from the full tier"),
    `(c) the red carries the tier's own output (${r.outcome?.reason})`,
  );
  assert((r.outcome?.reason ?? "").includes("exited 3"), "(c) and the exit code it failed with");
}

// ── (d) a required check not passing -> red, tier never run ───────────────
{
  const r = await run({ full: "true", checks: [{ name: "test", bucket: "fail" }] });
  assert(r.outcome?.kind === "red", `(d) a failing check -> red (${JSON.stringify(r.outcome)})`);
  assert((r.outcome?.reason ?? "").includes("test"), "(d) the red names the failing check");
  assert(!r.cmds.includes("true"), "(d) the tier was not run over a red CI");
}

// ── (e) `skipped` is not green, and neither is an empty list ──────────────
{
  const skipped = await run({ full: "true", checks: [{ name: "build", bucket: "skipped" }] });
  assert(skipped.outcome?.kind === "red", "(e) a skipped required check is not green");
  assert((skipped.outcome?.reason ?? "").includes("build"), "(e) and the red names it");
  const none = await run({ full: "true", checks: [] });
  assert(none.outcome?.kind === "red", "(e) no checks reported is not green either");
}

// ── (f) the PR moved off the verified head -> red, tier not run ───────────
{
  const r = await run({ full: "true", view: { state: "OPEN", mergeStateStatus: "CLEAN", headRefOid: "c".repeat(40) } });
  assert(r.outcome?.kind === "red", `(f) a moved head -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`);
  assert(
    (r.outcome?.reason ?? "").includes("is not the verified head"),
    `(f) the red names both heads (${r.outcome?.reason})`,
  );
  assert(!r.cmds.includes("true"), "(f) a green about another head runs no tier over it");
}

// ── (g) the PR is not OPEN -> red ─────────────────────────────────────────
{
  // The head is the verified one and every row passes: the PR's own state is the
  // ONLY thing that can refuse this, so the case is not carried by the head or
  // row checks (it read as red before, but for the wrong reason).
  const r = await run({
    full: "true",
    viewAt: (h) => viewAt(h, { state: "MERGED" }),
    checks: [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
  });
  assert(
    r.outcome?.kind === "red",
    `(g) a closed PR -> red (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("not OPEN"),
    `(g) and the red is the PR's own state, not another check's (${r.outcome?.reason})`,
  );
  assert(!r.cmds.includes("true"), "(g) no tier runs on a PR that is no longer open");
}

// ── (h) `gh` did not run -> infrastructure, never a routed red ────────────
{
  const r = await run({ full: "true", ghFails: true });
  assert(r.threw instanceof VerifyInfraError, `(h) an unreadable forge THROWS (${String(r.threw?.message)})`);
  assert(r.outcome === undefined, "(h) and produces no verdict the machine could route to a fix round");
}

// ── (i) the tier killed at its bound -> infrastructure, not a red ─────────
{
  const killed = Object.assign(new Error("was killed"), { killed: true });
  const r = await run({ full: "true", tierFails: killed });
  assert(r.threw instanceof VerifyInfraError, `(i) a killed tier THROWS (${String(r.threw?.message)})`);
}

// ── (j) the tier could not be started -> infrastructure ──────────────────
{
  const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const r = await run({ full: "true", tierFails: enoent });
  assert(r.threw instanceof VerifyInfraError, `(j) an un-startable tier THROWS (${String(r.threw?.message)})`);
}

// ── (k) no verified head -> nothing to observe, so it throws ─────────────
{
  const r = await run({ full: "true", noHead: true });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("no verified head"),
    `(k) no verified head on the log THROWS (${String(r.threw?.message)})`,
  );
}

// ── (l) no PR recorded -> throws ─────────────────────────────────────────
{
  const r = await run({ full: "true", noPr: true });
  assert(
    r.threw instanceof VerifyInfraError && (r.threw.message ?? "").includes("no PR"),
    `(l) no PR on the log THROWS (${String(r.threw?.message)})`,
  );
}

// ── (m) work.json names no full tier, .pi/verify-cmd does ───────────────
{
  const r = await run({ verifyCmd: "true" });
  assert(
    r.outcome?.kind === "green",
    `(m) the full tier falls back to .pi/verify-cmd (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(r.cmds.includes("true"), "(m) and that command is the one that ran");
}


cleanUp();
process.exit(exit);
