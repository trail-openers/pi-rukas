#!/usr/bin/env bun
/**
 * #1852 review round 2 — the lens-fix stray revert the DRIVER performed is
 * recorded on the state, persisted before the landing arm runs, and counted
 * against the round's single allowance.
 *
 * `lensFixFenceCheck` reverts one out-of-fence set per round and hands the
 * resulting `fix-pass-strays-reverted` event back on its verdict. On d1f73c90
 * the ONLY consumer of that event was the refusal path (the `lens-fix-scope`
 * cap-hit's `restoredToRef`/`restoredToPath`). On the `ok: true` path — the
 * revert succeeded, the re-judged delta is clean — the event was dropped, and
 * the round landed with a driver commit that had deleted the fixer's files:
 *
 *   (a) the operator never saw the preserved ref or the patch;
 *   (b) `lensFixRevertAlreadyUsed` counts those events off the event log, so a
 *       retried adversarial step (the RETRY_ONCE router, or the transient retry
 *       ladder) read "this round reverted nothing" and reverted a SECOND set in
 *       the same round.
 *
 * Both halves are driven THROUGH `runAdversarial` here, over a real repo, rather
 * than against the gate: the bug was in what the STEP kept, not what the gate
 * returned. `test-lens-fix-revert-record.ts` covers the record's shape and its
 * ordering against the persist in isolation.
 *
 * The durability claim is measured the way `test-fix-pass-strays-durable.ts`
 * measures it: the write was ISSUED with the event on it before the landing arm
 * ran. `writeState` serialises through a per-file promise chain, so asserting a
 * later reader saw the bytes would assert an ordering that is not there.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { workStateFile } from "../src/workflow-state.ts";
import { git } from "./lib/adversarial-fix-fixtures.ts";
import { fixtureStrayAllowed, stateWith, stubCtx } from "./lib/lens-fix-landing-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function cleanup(repoRoot: string): void {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(`${repoRoot}-origin`, { recursive: true, force: true });
}

function capsOf(state: { eventLog: readonly { kind: string; cap?: string }[] }): string[] {
  return state.eventLog.filter((e) => e.kind === "cap-hit").map((e) => (e as { cap: string }).cap);
}

console.log("# a reverted-and-allowed round RECORDS its revert before it lands");
{
  const f = fixtureStrayAllowed("land-revert-recorded");
  const st = await stateWith(f.repoRoot, f.tree, f.branch);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot, []);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const evs = out.eventLog.filter((e) => e.kind === "fix-pass-strays-reverted");
  assert(
    evs.length === 1,
    `the reverted-and-allowed round left exactly one revert event on the state (${evs.length}) — on d1f73c90 there were none`,
  );
  const ev = evs[0];
  if (ev !== undefined && ev.kind === "fix-pass-strays-reverted") {
    assert(
      ev.source === "lens-fix" && ev.round === 1 && ev.workstreamId === "default",
      `it is the lens-fix round's own record (${ev.source} / round ${ev.round} / ${ev.workstreamId}) — the three fields the counter keys on`,
    );
    assert(
      ev.paths.includes("scratch-notes.md"),
      `it names the stray it deleted (${JSON.stringify(ev.paths)})`,
    );
    // The operator's half: the record is only useful if it says where the
    // deleted content still lives, and an untracked stray survives only in the
    // patch — a ref can never reach it.
    assert(
      ev.preservedRef.length > 0 && ev.patchPath.length > 0,
      `it names both recovery locations (${ev.preservedRef} / ${ev.patchPath})`,
    );
    const note = out.pipelineState.plumbReports.find((r) => r.step === "lens-fix");
    assert(
      note?.body.includes(ev.preservedRef) &&
        note.body.includes(ev.patchPath) &&
        note.body.includes("scratch-notes.md"),
      "a plumb report stamped `lens-fix` puts the paths, the ref and the patch in front of the operator",
    );
    const body = (() => {
      try {
        return readFileSync(workStateFile(f.repoRoot, 1852), "utf8");
      } catch {
        return "";
      }
    })();
    assert(
      body.includes("fix-pass-strays-reverted"),
      "the revert reached the state file on disk, not just the returned state",
    );
    assert(
      body.includes(ev.preservedRef),
      "and the durable copy names the preserved ref — the crash-window this closes",
    );
  }
  const caps = capsOf(out);
  assert(
    !caps.includes("lens-fix-scope"),
    `the round was allowed to land after reverting the stray (caps: ${JSON.stringify(caps)})`,
  );
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  assert(
    Number(after) > Number(before),
    `the in-fence fix landed (${before} -> ${after}) — recording the revert does not park the round`,
  );
  cleanup(f.repoRoot);
}

console.log("# a retried adversarial step does NOT revert the same round twice");
{
  // The half with teeth: the round re-enters `runAdversarial` with the first
  // run's revert already recorded (that is what the RETRY_ONCE router and the
  // transient retry ladder do). Before the record existed the log was silent,
  // the counter said "no revert yet", and the driver reverted a SECOND set.
  const f = fixtureStrayAllowed("land-revert-once");
  const st = await stateWith(f.repoRoot, f.tree, f.branch);
  const ctx = stubCtx(f.repoRoot, []);
  const first = await runAdversarial(ctx, st, 2_000_000);
  const firstReverts = first.eventLog.filter((e) => e.kind === "fix-pass-strays-reverted");
  assert(
    firstReverts.length === 1,
    `the first run performed one revert (${firstReverts.length}) — the case needs a recorded round to retry`,
  );
  // A fresh stray from a fixer that would not stay inside its fence.
  writeFileSync(`${f.tree}/scratch-again.md`, "a second set\n");
  const second = await runAdversarial(ctx, first, 3_000_000);
  const reverts = second.eventLog.filter((e) => e.kind === "fix-pass-strays-reverted");
  assert(
    reverts.length === 1,
    `the retried step reverted a SECOND time (${reverts.length} revert events) — the round's single allowance is what should stop it`,
  );
  const caps = capsOf(second);
  assert(
    caps.includes("lens-fix-scope"),
    `and the second stray set parks the round on its own cap (caps: ${JSON.stringify(caps)})`,
  );
  const park = second.eventLog.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope") as
    | { evidence?: string; restoredToRef?: string; restoredToPath?: string }
    | undefined;
  assert(
    (park?.evidence ?? "").includes("ALREADY had one out-of-fence set reverted"),
    `the park says WHY it will not revert again (${(park?.evidence ?? "").slice(0, 140)})`,
  );
  assert(
    existsSync(`${f.tree}/scratch-again.md`),
    "the second set was left in the tree untouched — the driver refused it rather than deleting it",
  );
  // #1852 round 2 item 2 — the park has to NAME both recovery locations. The
  // cap-hit now declares `restoredToPath` beside `restoredToRef`, and the
  // handoff renderer prints both: a ref alone cannot reach an untracked stray,
  // so an operator told only about the ref would find nothing.
  assert(
    park?.restoredToRef !== undefined && park.restoredToPath !== undefined,
    `the cap-hit carries both locations (ref ${JSON.stringify(park?.restoredToRef)}, path ${JSON.stringify(park?.restoredToPath)})`,
  );
  const explained = explainCap("lens-fix-scope", second);
  assert(
    park?.restoredToRef !== undefined &&
      explained.includes(park.restoredToRef) &&
      park.restoredToPath !== undefined &&
      explained.includes(park.restoredToPath),
    "the handoff explanation renders BOTH the preserved ref and the patch path",
  );
  cleanup(f.repoRoot);
}

console.log("# an unattributable round gets NO revert hook (so no fallback id can spend an allowance)");
{
  // #1852 round 3 item 5. `lensFixRevertAlreadyUsed` matches on `workstreamId`
  // EXACTLY. The landing arm used to fall back to `"default"` when the round
  // could not be attributed, which asked the counter about a workstream the
  // round does not belong to: it answered "not spent", the revert ran, and its
  // record was stamped with an id no reader matches — the one-revert allowance
  // became unenforceable for exactly the rounds whose attribution was unclear.
  // Now the caller supplies no `onRevertible` at all in that case, and the gate
  // parks on its "revert unavailable" arm.
  const f = fixtureStrayAllowed("land-revert-no-id");
  const st = await stateWith(f.repoRoot, f.tree, f.branch);
  // Strip the attribution from BOTH places the gate and the caller read it from:
  // the snapshot's `workstreamId` and the recorded `worktrees` entry that would
  // otherwise resolve an id by path.
  const unattributed: WorkState = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      worktrees: {},
      lensFixFence:
        st.pipelineState.lensFixFence === undefined
          ? undefined
          : { ...st.pipelineState.lensFixFence, workstreamId: "" },
    },
  };
  const pushes: string[] = [];
  const ctx = stubCtx(f.repoRoot, pushes);
  const out = await runAdversarial(ctx, unattributed, 2_000_000);
  assert(
    !out.eventLog.some((e) => e.kind === "fix-pass-strays-reverted"),
    "no revert event — the driver never reverted under a workstream id it did not have",
  );
  const caps = capsOf(out);
  assert(
    caps.includes("lens-fix-scope"),
    `the round parked instead of landing (${JSON.stringify(caps)})`,
  );
  assert(
    existsSync(`${f.tree}/scratch-notes.md`),
    "the stray is still in the tree — a round with no attribution gets no destructive revert",
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `and nothing was pushed (${JSON.stringify(pushes)})`,
  );
  cleanup(f.repoRoot);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
