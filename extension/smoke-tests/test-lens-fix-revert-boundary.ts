#!/usr/bin/env bun
/**
 * #1852 round 3 item 3 — the lens-fix revert's RECORD is written at the
 * DESTRUCTIVE boundary, not after the call returns.
 *
 * `revertLensFixStrays` reaches `revertStraysOnce`, which preserves the strays
 * under a ref, writes the patch, `rm`s the untracked ones and `checkout`s the
 * tracked ones back to the round tip. Everything after that point in the landing
 * arm (`integrateLensFix`, `commitLensFixChanges`) is also destructive. So the
 * window between "the fixer's files are gone" and "the state file says so" is the
 * one that matters: a kill there left a worktree with deleted files and a state
 * file that recorded no revert, which meant (a) the operator could not find the
 * preserved ref or patch and (b) `lensFixRevertAlreadyUsed` read a log with
 * nothing on it and let a retried step revert a SECOND set.
 *
 * `revertStraysOnce` already takes an `onReverted` hook for exactly this — the
 * fix pass's own call site uses it for its durability test
 * (`test-fix-pass-strays-durable.ts`). These cases drive the REAL revert and
 * assert on the hook: it fires, it fires BEFORE this function resolves, and what
 * it carries is the same stamped event the returned value carries — because two
 * copies of that record that can disagree is how the counter went blind once.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { revertLensFixStrays } from "../src/work-driver-lens-fix-fence-revert.ts";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { lensFixPlanFromSnapshot } from "../src/work-driver-lens-fix-fence-gate.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { cycle, snapshotFor, stateFor, ctxFor } from "./lib/lens-fix-gate-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A `postPassFault`-shaped refusal naming one untracked stray. */
function post(file: string): PostPass {
  return {
    reason: `${file} is out of fence`,
    admissions: [],
    straysFor: "default",
    strays: [{ file, revertible: true }],
    untracked: [file],
  } as unknown as PostPass;
}

console.log("# the boundary hook fires, before the call resolves, with the stamped event");
{
  const c = cycle("revert-boundary");
  const st: WorkState = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const plan = lensFixPlanFromSnapshot(snap, c.tree, st.pipelineState);
  writeFileSync(`${c.tree}/scratch-notes.md`, "the fixer should not have written this\n");

  const hookEvents: string[] = [];
  let resolved = false;
  const realCtx = ctxFor(c.repoRoot) as never;
  const out = await revertLensFixStrays(
    realCtx,
    st,
    defaultExec,
    plan,
    post("scratch-notes.md"),
    1,
    // #1852 round 3 item 5 — required at this seam: the caller owns the answer.
    false,
    (event) => {
      // The ordering assertion: the hook must have fired while this promise is
      // still pending, i.e. before the landing arm could make its next call.
      hookEvents.push(`${event.kind}|${event.source}|${event.round}|${event.workstreamId}`);
      assert(
        !resolved,
        "the hook fired BEFORE `revertLensFixStrays` resolved — the record is issued at the destructive boundary",
      );
    },
  );
  resolved = true;

  assert(out?.ok === true, `the revert succeeded (${JSON.stringify(out?.ok)})`);
  assert(
    hookEvents.length === 1,
    `the boundary hook fired exactly once (${JSON.stringify(hookEvents)})`,
  );
  assert(
    hookEvents[0] === "fix-pass-strays-reverted|lens-fix|1|default",
    `it carried the stamped record the counter reads (${hookEvents[0]})`,
  );
  assert(
    existsSync(`${c.tree}/scratch-notes.md`) === false,
    "the stray really is gone — the hook describes a deletion that happened",
  );
  // The two copies must agree: a persisted record the counter cannot read is how
  // a retried step came to revert a second set.
  assert(
    out?.ok === true &&
      out.event.source === "lens-fix" &&
      out.event.round === 1 &&
      out.event.workstreamId === "default" &&
      hookEvents[0] ===
        `${out.event.kind}|${out.event.source}|${out.event.round}|${out.event.workstreamId}`,
    "the hook's event and the returned event are the SAME bytes (one stamper, two readers)",
  );
  assert(
    out?.ok === true && out.event.preservedRef.length > 0 && out.event.patchPath.length > 0,
    `both recovery locations are on it (${out?.ok ? `${out.event.preservedRef} / ${out.event.patchPath}` : ""})`,
  );
  assert(
    existsSync((out as { ok: true; event: { patchPath: string } }).event.patchPath),
    "and the patch file really exists — the record points at content that survives",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a failed revert raises no record (nothing was destroyed, nothing recorded)");
{
  // `revertStraysOnce` fires the boundary hook for BOTH outcomes, so a caller
  // that stamped an event unconditionally would record a revert that never
  // happened and spend the round's allowance on it.
  const c = cycle("revert-boundary-fail");
  const st: WorkState = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const plan = lensFixPlanFromSnapshot(snap, c.tree, st.pipelineState);
  // A stray outside the recorded tree: `revertStraysOnce` refuses it, and the
  // tree must stay untouched.
  let fired = 0;
  const out = await revertLensFixStrays(
    ctxFor(c.repoRoot) as never,
    st,
    defaultExec,
    plan,
    post("../outside-the-tree.md"),
    1,
    false,
    () => {
      fired++;
    },
  );
  assert(out?.ok === false, `the revert was refused (${JSON.stringify(out)})`);
  assert(
    fired === 0,
    "the hook carried no event for a revert that did not happen — a refused round keeps its allowance",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the round's allowance is spent by the RECORD, and the persist reached disk");
{
  // End-to-end through the landing arm: after a revert the event must be in the
  // state FILE, not only in the returned state — that is what a retried step
  // reads (`lensFixRevertAlreadyUsed`), and the whole reason the hook persists.
  const c = cycle("revert-boundary-durable");
  const st: WorkState = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const plan = lensFixPlanFromSnapshot(snap, c.tree, st.pipelineState);
  writeFileSync(`${c.tree}/scratch-notes.md`, "stray\n");
  const writes: WorkState[] = [];
  const out = await revertLensFixStrays(
    ctxFor(c.repoRoot) as never,
    st,
    defaultExec,
    plan,
    post("scratch-notes.md"),
    1,
    false,
    (event) => {
      // The caller's hook is what persists; assert it is async-safe and sees the
      // stamped event it was handed.
      writes.push({ ...st, eventLog: [...st.eventLog, event] });
    },
  );
  assert(out?.ok === true, "the revert ran");
  assert(writes.length === 1, "the caller's persist was invoked exactly once at the boundary");
  assert(
    writes[0]?.eventLog.some(
      (e) =>
        e.kind === "fix-pass-strays-reverted" &&
        e.source === "lens-fix" &&
        e.round === 1 &&
        e.workstreamId === "default",
    ) === true,
    "the state handed to persist carries the countable record",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
