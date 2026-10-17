#!/usr/bin/env bun
/**
 * #1403 — a develop child whose engine DIED mid-pass is a named step outcome,
 * recorded structurally, with the dirty leftover named.
 *
 * The incident (tehas #238, cycle 238-261015-223744): develop round 3's
 * developer logged `the engine stopped unexpectedly (exit code 1); the next
 * request restarts it`, its async job "finished in 197676ms" with nothing in
 * `err.txt` recording a failure, and the step reported
 * `--- step 4/9 develop done in 1490s` with
 * `kind=step-completed … develop, round 3, recovered: false`. Adversarial
 * round 3 then reviewed the SAME worktree and saw `M libexec/stop` /
 * `1 file changed, 56 insertions(+), 23 deletions(-)` — the fix the round-2
 * review asked for, never committed, never on the consolidated branch.
 *
 * Three contracts, one per acceptance criterion in the issue:
 *
 *   1. `the engine stopped unexpectedly (exit code N)` is a STEP OUTCOME: the
 *      pass is not ok, and the develop step ends on a named cap
 *      (`develop-child-crash`), never a bare completion.
 *   2. The crash is RECORDED STRUCTURALLY — on the `branch-completed` event's
 *      `crash` field (exit code, tree state, the leftover paths) — and the
 *      cap's evidence names the uncommitted file. It is not free text in a
 *      prose field beside an unrelated cap.
 *   3. The dirty leftover is NAMED: the paths the dead pass left behind appear
 *      on the event, in the cap evidence, in the status line and in the
 *      handoff sentence.
 *
 * The crash is detected from the real marker string, not from a driver-side
 * guess, and the safety net's exclusion rule is asserted: a failed pass's
 * partial work is NEVER auto-committed, which is exactly why the park (rather
 * than an advance) is the only honest outcome.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { FAILURE_KINDS, failureOf } from "../src/headless/failure.ts";
import {
  ENGINE_STOPPED_MARKER,
  classifyDevelopPass,
  crashFragment,
  crashedBranchCompleted,
  developCrashes,
  engineCrashed,
} from "../src/work-develop-crash.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { fmtEvent } from "../src/work-status-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One classify call's fixed arguments — only the tree/executor varies. */
const crashArgs = (id: string, cwd: string, base: string | undefined, execFn: never) => ({
  id,
  cwd,
  base,
  execFn,
  result: { ok: false, text: CRASH_TEXT, exitCode: 1 },
});

const CRASH_TEXT = `working on the lock fix\n\n${ENGINE_STOPPED_MARKER} (exit code 1); the next request restarts it`;

// ---------------------------------------------------------------------------
// 1. Detection: the marker, and only the marker.
// ---------------------------------------------------------------------------
assert(
  engineCrashed({ text: CRASH_TEXT, exitCode: 1 }),
  "1a: the engine-death notice in the child's output is detected",
);
assert(
  engineCrashed({ text: ENGINE_STOPPED_MARKER.toUpperCase(), exitCode: 1 }),
  "1b: detection is case-insensitive (the child's harness may capitalise it)",
);
assert(
  !engineCrashed({ text: "Implemented the feature and committed.", exitCode: 0 }),
  "1c: an ordinary completion is not a crash",
);
assert(
  !engineCrashed({ exitCode: 1 }),
  "1d: a non-zero exit with no text is not claimed as a crash",
);
assert(
  !engineCrashed({
    text: "I will not print the engine stopped unexpectedly line, it is only an example.",
    exitCode: 0,
  }) === false,
  "1e: a child quoting the phrase still counts (the marker is the harness's own line)",
);

// ---------------------------------------------------------------------------
// 2. classifyDevelopPass: a dead child is never ok, and its tree is named.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "develop-crash-1403-"));
try {
  const wt = path.join(dir, ".worktrees", "default");
  mkdirSync(path.join(dir, ".worktrees"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  // The dead pass's work: one modified file, uncommitted — the `libexec/stop`
  // shape from the incident.
  mkdirSync(path.join(wt, "libexec"), { recursive: true });
  writeFileSync(path.join(wt, "libexec", "stop"), "#!/bin/sh\n# fixed lock handling\n");
  // A driver artefact, which must NOT be named as lost work.
  mkdirSync(path.join(wt, ".pi"), { recursive: true });
  writeFileSync(path.join(wt, ".pi", "note.txt"), "driver scratch\n");

  const BASE = "0123456789abcdef0123456789abcdef01234567";
  const statusLines = ["?? libexec/stop", "?? .pi/note.txt"].join("\0");

  // A fake executor: git status returns the porcelain above; rev-list says the
  // dead pass committed NOTHING (the incident's shape — its fix was never
  // committed). Records what it was asked so the test can assert the base used.
  const asked: string[][] = [];
  const execFn = (async (cmd: string, opts: { argv?: string[]; cwd?: string }) => {
    const argv = opts.argv ?? [];
    asked.push(argv);
    if (argv[0] === "status") return { stdout: statusLines, stderr: "" };
    if (argv[0] === "rev-list") return { stdout: "0\n", stderr: "" };
    throw new Error(`unexpected git ${argv.join(" ")}`);
  }) as never;

  const crashed = await classifyDevelopPass(crashArgs("default", wt, BASE, execFn));
  assert(crashed.ok === false, "2a: a pass whose engine died is NOT ok");
  assert(crashed.crashed === true, "2b: the verdict records the crash itself");
  assert(
    crashed.evidence === "leftover",
    `2c: the worktree is reported as holding leftovers (got ${crashed.evidence})`,
  );
  assert(
    crashed.uncommitted.length === 1 && crashed.uncommitted[0] === "libexec/stop",
    `2d: the leftover path is named, driver artefacts excluded (got ${JSON.stringify(crashed.uncommitted)})`,
  );
  assert(
    crashed.lostWork === true,
    "2e: crash + dirty tree is the lost-work shape the issue names",
  );
  assert(
    (crashed.reason ?? "").includes("engine crashed") &&
      (crashed.reason ?? "").includes("libexec/stop"),
    `2f: the reason names both the crash and the leftover (${crashed.reason})`,
  );
  assert(
    asked.some((a) => a[0] === "rev-list" || a[0] === "status"),
    "2g: the classification reads the WORKTREE, not only the child's claim",
  );
  assert(
    asked.some((a) => a[0] === "rev-list"),
    "2h0: the pass is checked for commits ahead of base, not only for dirt",
  );
  assert(
    asked.some((a) => a.join(" ").includes(BASE)),
    "2h: the commit count is taken against the workstream's effective base",
  );

  // An errorStop (a provider fault) is a DIFFERENT shape and stays not-ok,
  // but is not mislabelled as a crash.
  const provider = await classifyDevelopPass({
    ...crashArgs("default", wt, BASE, execFn),
    result: { ok: false, errorStop: { reason: "error", message: "terminated" }, exitCode: 0 },
  });
  assert(
    provider.ok === false && provider.crashed === false,
    "2i: a provider error-stop is not-ok but never reported as an engine crash",
  );

  // A clean tree + crash: honest about there being nothing to recover. The
  // tree reads clean (no porcelain entries) and commits ahead of base.
  const cleanExec = (async (_c: string, opts: { argv?: string[] }) => {
    const argv = opts.argv ?? [];
    if (argv[0] === "status") return { stdout: "", stderr: "" };
    return { stdout: "1\n", stderr: "" };
  }) as never;
  const cleanCrash = await classifyDevelopPass(crashArgs("default", wt, BASE, cleanExec));
  assert(
    cleanCrash.crashed === true && cleanCrash.evidence === "clean" && cleanCrash.lostWork === false,
    `2j: a crash whose tree has commits ahead of base is a crash with nothing left behind (evidence ${cleanCrash.evidence})`,
  );

  // No base at all: the commit half is unresolvable, and the record says so
  // rather than claiming the tree is clean.
  const noBaseCrash = await classifyDevelopPass(crashArgs("default", wt, undefined, execFn));
  assert(
    noBaseCrash.crashed && crashFragment(noBaseCrash).tree === "dirty",
    `2k2: a crash with no base still names the dirt it left (${crashFragment(noBaseCrash).tree})`,
  );
  // A readable tree with neither dirt nor commits: the pass wrote nothing.
  const emptyExec = (async (_c: string, opts: { argv?: string[] }) => {
    const argv = opts.argv ?? [];
    if (argv[0] === "status") return { stdout: "", stderr: "" };
    return { stdout: "0\n", stderr: "" };
  }) as never;
  const emptyCrash = await classifyDevelopPass(crashArgs("default", wt, BASE, emptyExec));
  assert(
    emptyCrash.crashed && crashFragment(emptyCrash).tree === "empty",
    `2m: a crash over an empty tree says so, and does not park the cycle on a phantom loss (${crashFragment(emptyCrash).tree})`,
  );

  // An unreadable tree is never reported as clean.
  const brokenExec = (async () => {
    throw new Error("fork failed");
  }) as never;
  const unreadable = await classifyDevelopPass(crashArgs("default", wt, BASE, brokenExec));
  assert(
    unreadable.evidence === undefined && (unreadable.reason ?? "").includes("unreadable"),
    "2k: an unreadable worktree is reported as unreadable, never as clean",
  );

  // -----------------------------------------------------------------------
  // 3. The structured record on the event.
  // -----------------------------------------------------------------------
  const ev = crashedBranchCompleted({ id: "default", ms: 197676, verdict: crashed });
  assert(
    ev.kind === "branch-completed" && ev.ok === false,
    "3a: the crashed pass records a failed branch-completed",
  );
  const frag = ev.kind === "branch-completed" ? ev.crash : undefined;
  assert(frag !== undefined, "3b: the event carries the structured `crash` fragment");
  assert(frag?.tree === "dirty", `3c: the fragment names the tree state (got ${frag?.tree})`);
  assert(
    frag?.exitCode === 1,
    `3d: the fragment names the exit code (got ${String(frag?.exitCode)})`,
  );
  assert(
    JSON.stringify(frag?.paths) === JSON.stringify(["libexec/stop"]),
    `3e: the fragment names the uncommitted paths (got ${JSON.stringify(frag?.paths)})`,
  );
  assert(
    crashFragment(cleanCrash).tree === "committed" &&
      crashFragment(unreadable).tree === "unreadable" &&
      crashFragment(emptyCrash).tree === "empty" &&
      crashFragment(crashed).tree === "dirty",
    "3f: the fragment's tree vocabulary covers dirty / committed / empty / unreadable",
  );
  assert(
    crashFragment(crashed).exitCode === 1,
    `3f2: the fragment carries the exit code onto the event (${String(crashFragment(crashed).exitCode)})`,
  );
  const recovered = developCrashes([ev]);
  assert(
    recovered.length === 1 &&
      recovered[0]?.id === "default" &&
      recovered[0]?.paths[0] === "libexec/stop",
    "3g: developCrashes reads the record back without parsing prose",
  );
  assert(
    developCrashes([
      { kind: "branch-completed", step: "develop", workstreamId: "a", ok: true, ms: 1, at: 1 },
    ]).length === 0,
    "3h: an ordinary branch-completed carries no crash (absence is a real state)",
  );

  // -----------------------------------------------------------------------
  // 4. The step ends on the named cap, not a completion — via the REAL
  //    topological step with an injected dispatch that returns the crash.
  // -----------------------------------------------------------------------
  const base = initialState(1403, 1_000_000) as WorkState;
  const state: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "develop",
      baseSha: BASE,
      worktrees: { default: wt },
      workstreamBaseShas: { default: BASE },
    },
    eventLog: [{ kind: "step-started", step: "develop", at: 1 }],
  };
  const out = await runDevelopTopological(
    {
      repoRoot: dir,
      issue: 1403,
      // The child that "finished" exactly as the incident's did: ok:false,
      // no errorStop, the harness's engine-death line in its output.
      dispatchFn: (async () => ({
        role: "developer",
        ok: false,
        text: CRASH_TEXT,
        toolUses: [],
        ms: 197676,
        exitCode: 1,
      })) as never,
      verifyExecFn: execFn,
    } as never,
    state,
    ["default"],
    {
      default: { id: "default", scope: "fix the lock", paths: ["libexec/stop"], outOfScope: [] },
    } as never,
    [1403],
    (async () => ({
      role: "developer",
      ok: false,
      text: CRASH_TEXT,
      toolUses: [],
      ms: 197676,
      exitCode: 1,
    })) as never,
    execFn,
    Date.now(),
    "develop",
  );
  const tail = out.eventLog[out.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" && tail.cap === "develop-child-crash",
    `4a: develop ends on cap-hit develop-child-crash, not a completion (got ${tail?.kind === "cap-hit" ? tail.cap : tail?.kind})`,
  );
  assert(tail?.kind === "cap-hit" && tail.nextStep === "handoff", "4b: the cap routes to handoff");
  const capEvidence = tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "";
  assert(
    capEvidence.includes("libexec/stop"),
    `4c: the cap's evidence NAMES the dirty leftover (${capEvidence})`,
  );
  assert(
    out.eventLog.some((e) => e.kind === "branch-completed" && e.crash !== undefined),
    "4d: the crash is on the event log, not only in prose",
  );
  assert(
    validateDiscriminants(out).length === 0,
    `4e: the crashed cycle's state file validates on re-entry (${JSON.stringify(validateDiscriminants(out))})`,
  );

  // -----------------------------------------------------------------------
  // 5. Every published surface knows the cap / renders the crash.
  // -----------------------------------------------------------------------
  assert(
    (FIXED_CAPS as readonly string[]).includes("develop-child-crash"),
    "5a: the cap is in the published fixed-cap vocabulary",
  );
  const explained = explainCap("develop-child-crash", out);
  assert(
    explained.includes("libexec/stop") && explained.toLowerCase().includes("engine"),
    `5b: explainCap names the crash AND the leftover file (${explained.slice(0, 120)}…)`,
  );
  const line = fmtEvent(
    out.eventLog.find((e) => e.kind === "branch-completed" && e.crash !== undefined) as WorkEvent,
  );
  assert(
    line.includes("CRASHED") && line.includes("libexec/stop"),
    `5c: /work-status renders the crash line with the leftover (${line})`,
  );
  const failed = failureOf(out, "develop-child-crash", "develop");
  assert(
    failed !== undefined && (FAILURE_KINDS as readonly string[]).includes(failed.kind),
    `5d: the headless result publishes a failure kind for the crash (${failed?.kind})`,
  );
  assert(
    failed?.kind === "crashed",
    `5e: a dead child is its own failure kind, not "process" or "cap" (${failed?.kind})`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
