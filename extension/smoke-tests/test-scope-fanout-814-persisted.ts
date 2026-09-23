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
      workstreams,
    },
  };
  const result = await runDevelopTopological(
    { repoRoot: root, issue: 814 } as never,
    s,
    ["a", "b"],
    workstreams,
    [814],
    (() => Promise.resolve({ reply: "done", ok: true })) as never,
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
  const b = verdicts.find((v) => v.id === "b");
  const a = verdicts.find((v) => v.id === "a");
  assert(
    b?.ok === false &&
      (b?.reason ?? "").includes("a-file.txt") &&
      (b?.reason ?? "").includes("declared by a"),
    `persisted eventLog: the violator's verdict is ok:false with the attributed reason (got: ${JSON.stringify(verdicts)})`,
  );
  assert(
    a?.ok === true,
    `persisted eventLog: the clean workstream keeps ok:true (got: ${JSON.stringify(verdicts)})`,
  );

  // #814 aliasing invariant — the persisted event carries the FLIPPED verdict
  // (b ok:false, a ok:true), not the original all-true array that was
  // originally appended. The dispatch fakes all return ok:true, so the
  // originally-appended event had both ok:true. The gate replaced it with a
  // copy showing b flipped — proving the in-place replacement worked.
  assert(
    b?.ok === false && a?.ok === true,
    `persisted eventLog: the persisted event carries the FLIPPED verdict (not the original all-true array) (got: ${JSON.stringify(verdicts)})`,
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
