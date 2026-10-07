#!/usr/bin/env bun
/**
 * #814 — branches-converged IN THE RETURNED STATE's eventLog (the persisted
 * artifact) carries the flipped verdict. Split out of test-scope-fanout-814.ts
 * (500-line gate). Driven through the REAL runDevelopTopological (not a local
 * copy of the event update) in a live temp git repo: workstream b (a fence
 * violator) commits a file that a declared — the develop verify gate records
 * the sibling-declared fence violation, and the develop branches-converged
 * event is replaced in place with a copy of the flipped verdicts. Exactly one
 * develop branches-converged survives, and the originally-appended event is
 * never mutated.
 *
 * Case 2 — the no-evidence path (N>1, no worktree evidence): branches-converged
 * IS still emitted, as on origin/main (the pre-fix post-gate-only emit lost it
 * when there was no evidence).
 */

import { exec as cpExec } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import { replaceDevelopConvergedVerdicts } from "../src/work-develop-fence-verdicts.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const execp = promisify(cpExec);

const root = await mkdtemp(`${tmpdir()}/pi-rkas-814-persisted-`);
const wtA = `${root}/wt-a`;
const wtB = `${root}/wt-b`;
try {
  const g = (cmd: string, cwd: string) =>
    execp(cmd, { cwd, maxBuffer: 1024 * 1024 }).then((r) => r.stdout.trim());
  // Base repo with one commit at baseSha.
  await g("git init -q -b main", root);
  await g("git config user.email t@t", root);
  await g("git config user.name t", root);
  await writeFile(`${root}/base.txt`, "base\n");
  await g("git add base.txt", root);
  await g("git commit -q --no-verify -m base", root);
  const baseSha = await g("git rev-parse HEAD", root);
  // Worktree a: commits its own file (clean).
  await g(`git -c core.hooksPath=/dev/null worktree add -q -B wt-a ${wtA}`, root);
  await writeFile(`${wtA}/a-file.txt`, "a\n");
  await g("git add a-file.txt", wtA);
  await g("git commit -q --no-verify -m a", wtA);
  // Worktree b: commits a's declared file — the fence violation.
  await g(`git -c core.hooksPath=/dev/null worktree add -q -B wt-b ${wtB}`, root);
  await writeFile(`${wtB}/a-file.txt`, "B annexed a's file\n");
  await g("git add a-file.txt", wtB);
  await g("git commit -q --no-verify -m b", wtB);

  const workstreams = {
    a: { id: "a", scope: "file a", paths: ["a-file.txt"], outOfScope: ["b-file.txt"] },
    b: { id: "b", scope: "file b", paths: ["b-file.txt"], outOfScope: ["a-file.txt"] },
  };
  let s = initialState(814, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha,
      worktrees: { a: wtA, b: wtB },
      // #849/#1005 — the workstream ids the merged workstream keeps (the
      // merged id is the OWNER's id, a; the violator b is absorbed into a).
      workstreams,
    },
  };
  // #1005 — the merge-and-retry's re-dispatch commits the merged workstream's
  // in-scope file (b-file.txt — the violator's half, which the stub's
  // "done" reply represents) on top of the owner's commit, so the re-run
  // gate sees real evidence in the merged worktree (a bare commitless stub
  // would fail the re-run gate's empty-diff check and park with
  // "verify failed AFTER the merge-and-retry").
  const onMergeRetry = async (cwd: string) => {
    await writeFile(`${cwd}/b-file.txt`, "b\n");
    await g("git add b-file.txt", cwd);
    await g("git commit -q --no-verify -m b-scope", cwd);
  };
  const dispatch = (() => {
    let called = 0;
    return (async (_pi: unknown, spec: { prompt?: string }) => {
      called += 1;
      const isMerge = (spec.prompt ?? "").includes("FENCE MERGE-AND-RETRY");
      if (isMerge) {
        // The re-dispatch runs in the violator's worktree (now the merged
        // workstream's worktree).
        await onMergeRetry(wtB);
      }
      return { reply: "done", ok: true };
    }) as never;
  })();
  const result = await runDevelopTopological(
    { repoRoot: root, issue: 814 } as never,
    s,
    ["a", "b"],
    workstreams,
    [814],
    dispatch,
    execp as never,
    Date.now(),
    "job-persisted",
  );
  const convergedEvents = result.eventLog.filter((e) => e.kind === "branches-converged");
  const converged = [...convergedEvents].reverse().find((e) => e.kind === "branches-converged");
  assert(
    converged !== undefined,
    `persisted eventLog: a branches-converged event is present (got kinds: ${result.eventLog.map((e) => e.kind).join(", ")})`,
  );
  assert(
    convergedEvents.length === 1,
    `persisted eventLog: exactly ONE develop branches-converged (got ${convergedEvents.length})`,
  );

  const verdicts =
    converged !== undefined
      ? (converged as { verdicts: Array<{ id: string; ok: boolean; reason?: string }> }).verdicts
      : [];
  const a = verdicts.find((v) => v.id === "a");
  // #1005 — the fence recovery is now a MERGE-AND-RETRY (the #849
  // re-dispatch-of-the-violator-alone flow is replaced by the merge:
  // a sibling-declared violation (b annexed a's file) merges the two
  // coupled workstreams, re-dispatches ONCE on the merged one (the owner a
  // keeps its id; the violator b is absorbed), and re-runs the gates. A
  // clean re-run restores the SURVIVING merged workstream's verdict (a)
  // to ok:true; the absorbed id (b) has no verdict entry of its own — it
  // is no longer a workstream. The recovery is recorded on a
  // fence-recovery-started event (evidence of the discard), naming the
  // merged workstream (a) and the absorbed violator (b).
  const recoveryEvent = result.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    recoveryEvent !== undefined &&
      recoveryEvent.kind === "fence-recovery-started" &&
      recoveryEvent.workstreamId === "a" &&
      recoveryEvent.owners.includes("b"),
    `#1005 persisted: a fence-recovery-started event records the merged workstream a (with the absorbed violator b) (got: ${recoveryEvent ? JSON.stringify(recoveryEvent) : "none"})`,
  );
  assert(
    a?.ok === true,
    `#1005 persisted: the SURVIVING merged workstream a's verdict is restored to ok (the merge re-run was clean) (got: ${JSON.stringify(verdicts)})`,
  );
  assert(
    verdicts.find((v) => v.id === "b") === undefined && verdicts.length === 1,
    `#1005 persisted: the absorbed id b is NO LONGER a separate workstream (no verdict entry under the absorbed id; exactly one entry for the merged workstream) (got: ${JSON.stringify(verdicts)})`,
  );

  // #1005 — the persisted event carries the RESTORED verdict (the merge
  // re-run was clean). The merge-and-retry is a deliberate #1005 behaviour
  // change: a sibling-declared violation no longer re-dispatches the
  // violator alone (the #849 flow) but merges the two coupled workstreams
  // and re-runs the merged one, and a clean re-run restores the merged
  // workstream's verdict (the owner id, a). Note the converged event in
  // this test still shows the pre-merge entry (a: false, b: true): the
  // converge gate's emit is not re-run after a merge, so the surviving
  // merged workstream's verdict is the restored verdicts entry keyed by
  // the owner id, asserted above.
  assert(
    a?.ok === true,
    `#1005 persisted: the persisted event carries the RESTORED verdict (the merge re-run was clean) (got: ${JSON.stringify(verdicts)})`,
  );

  // No-evidence path — N>1, no worktree evidence: branches-converged is still
  // emitted (as on origin/main). Uses the base repo with NO worktree entries
  // so hasAnyWorktreeEvidence is false and the gate is skipped — the event is
  // emitted unconditionally at its origin/main position (before the gate),
  // not inside the hasDevelopEvidence block.
  {
    const ws2 = {
      a: { id: "a", scope: "file a", paths: ["a-file.txt"], outOfScope: [] },
      b: { id: "b", scope: "file b", paths: ["b-file.txt"], outOfScope: [] },
    };
    let s2 = initialState(814, 1_000_000);
    s2 = {
      ...s2,
      pipelineState: {
        ...s2.pipelineState,
        baseSha,
        worktrees: {}, // no worktree entries → no evidence → gate skipped
        workstreams: ws2,
      },
    };
    const r2 = await runDevelopTopological(
      { repoRoot: root, issue: 814 } as never,
      s2,
      ["a", "b"],
      ws2,
      [814],
      (() => Promise.resolve({ reply: "done", ok: true })) as never,
      execp as never,
      Date.now(),
      "job-noevidence",
    );
    const conv2 = r2.eventLog.filter((e) => e.kind === "branches-converged");
    assert(
      conv2.length === 1,
      `no-evidence path: a branches-converged IS emitted (as on origin/main) (got ${conv2.length})`,
    );
    const v2 =
      conv2.length === 1
        ? (conv2[0] as { verdicts: Array<{ id: string; ok: boolean }> }).verdicts
        : [];
    assert(
      v2.length === 2,
      `no-evidence path: both workstreams appear in the verdicts (got: ${JSON.stringify(v2)})`,
    );
  }
  // Gate passes (undeclared-only records — the workstream touched a file no
  // workstream declared and that is not fenced): no verdict is flipped. The
  // run goes through the real gate: b's undeclared record is warn-only, the
  // gate passes, so the originally-emitted branches-converged verdicts (both
  // ok:true) survive untouched and the step is NOT halted.
  {
    const wsU = {
      a: { id: "a", scope: "file a", paths: ["a-file.txt"], outOfScope: [] },
      b: { id: "b", scope: "file b", paths: ["b-file.txt"], outOfScope: [] },
    };
    let sU = initialState(814, 1_000_000);
    sU = {
      ...sU,
      pipelineState: {
        ...sU.pipelineState,
        baseSha,
        worktrees: { a: wtA, b: wtB },
        workstreams: wsU,
      },
    };
    const rU = await runDevelopTopological(
      { repoRoot: root, issue: 814 } as never,
      sU,
      ["a", "b"],
      wsU,
      [814],
      (() => Promise.resolve({ reply: "done", ok: true })) as never,
      execp as never,
      Date.now(),
      "job-undeclared",
    );
    const convU = rU.eventLog.filter((e) => e.kind === "branches-converged");
    const vU =
      convU.length === 1
        ? (convU[0] as { verdicts: Array<{ id: string; ok: boolean; reason?: string }> }).verdicts
        : [];
    assert(
      convU.length === 1 && vU.every((v) => v.ok === true),
      `undeclared-only: the gate passes — exactly one branches-converged and every verdict stays ok:true (got: ${JSON.stringify(vU)})`,
    );
    assert(
      !rU.eventLog.some((e) => e.kind === "cap-hit"),
      `undeclared-only: the step is NOT halted (no cap-hit; got kinds: ${rU.eventLog.map((e) => e.kind).join(", ")})`,
    );
  }

  // replaceDevelopConvergedVerdicts — unit test: replaces the LAST develop
  // branches-converged only, leaves every other event (including a
  // branches-converged from another step) untouched, and returns the state
  // unchanged (same reference) when no develop branches-converged exists.
  {
    const mk = () => {
      const s = initialState(814, 1_000_000);
      s.eventLog.push({ kind: "branches-converged", step: "adversarial", verdicts: [{ id: "x", ok: true }], at: 1 });
      s.eventLog.push({ kind: "branches-converged", step: "develop", verdicts: [{ id: "a", ok: true }], at: 2 });
      s.eventLog.push({ kind: "cap-hit", at: 3, cap: "verify-failed:develop", reviewRound: 0, nextStep: "handoff" });
      return s;
    };
    const base = mk();
    const r1 = replaceDevelopConvergedVerdicts(base, [{ id: "a", ok: false, reason: "fence violation: f" }]);
    const devEv = r1.eventLog.find(
      (e) => e.kind === "branches-converged" && e.step === "develop",
    ) as { verdicts: Array<{ id: string; ok: boolean; reason?: string }> };
    const advEv = r1.eventLog.find(
      (e) => e.kind === "branches-converged" && e.step === "adversarial",
    ) as { verdicts: Array<{ id: string }> };
    assert(
      devEv.verdicts.length === 1 &&
        devEv.verdicts[0].ok === false &&
        devEv.verdicts[0].reason === "fence violation: f",
      `replaceDevelopConvergedVerdicts: the develop event carries the new verdicts (got: ${JSON.stringify(devEv.verdicts)})`,
    );
    assert(
      advEv.verdicts[0].id === "x" && advEv.verdicts[0].ok === true,
      `replaceDevelopConvergedVerdicts: the other step's branches-converged is untouched (got: ${JSON.stringify(advEv.verdicts)})`,
    );
    assert(
      r1.eventLog.length === base.eventLog.length &&
        r1.eventLog[3] === base.eventLog[3] &&
        r1.eventLog[1] !== base.eventLog[1] &&
        base.eventLog[1].kind === "branches-converged" &&
        (base.eventLog[1] as { verdicts: Array<{ ok: boolean }> }).verdicts[0].ok === true,
      "replaceDevelopConvergedVerdicts: immutable — other events untouched, original develop event keeps its old verdicts in the source state",
    );
    const absent = initialState(814, 1_000_000);
    assert(
      replaceDevelopConvergedVerdicts(absent, [{ id: "a", ok: false }]) === absent,
      "replaceDevelopConvergedVerdicts: returns the SAME state object when no develop branches-converged exists",
    );
  }
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nexit ${exit}`);
process.exit(exit);
