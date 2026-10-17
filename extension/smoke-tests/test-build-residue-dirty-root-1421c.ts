#!/usr/bin/env bun
/**
 * #1421 fix round 3 (lens) — the classifier's O(N) residue scan.
 *
 * `classifyRootDirt` built its `dirt` list and its `buildResidueOnly` test
 * with `residue.some((r) => r.line === l)`, i.e. a linear scan per considered
 * line. The behaviour was correct; the shape was quadratic in the residue
 * count, and a root with a large build directory (the incident's `target/`
 * under `-uall`, plus the driver-observed descendant lines the preflight adds)
 * is exactly the case that reaches it. The fix is a Set of the residue lines,
 * so this test pins that the two scans still agree — same `dirt`, same
 * decline — when the residue list is large enough that a Set and a `some()`
 * are not the same code path.
 *
 * Separate from `test-build-residue-dirty-root-1421.ts` only because that
 * file is at the 500-line cap.
 */
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeHandoffEmittedEvent } from "../src/work-driver-handoff-post.ts";
import { renderStatus } from "../src/work-status.ts";
import { singleCycleQueueEntry } from "../src/work-queue-single-entry.ts";
import { parkReason } from "../src/work-queue-park-reason.ts";
import { type WorkState, initialState, writeState } from "../src/workflow-state.ts";
import {
  classifyRootDirt,
  probeIgnored,
  readIgnoredPaths,
} from "../src/work-driver-dirty-root-classify.ts";
import { buildResidueFailure } from "../src/work-driver-dirty-root-classify.ts";
import type { ExecFn } from "../src/worktree.ts";
import { makeRepo } from "./lib/build-residue-1421-fixtures.ts";

const RESIDUE_FAILURE = buildResidueFailure(
  ["target/.rustc_info.json", "target/CACHEDIR.TAG", "target/debug/.cargo-lock"],
  "the repo root is not clean",
);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** N residue lines under `target/`, plus any extra lines appended. */
function residueLines(n: number, extra: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`?? target/f${i}.o`);
  return [...out, ...extra];
}

const IGNORED = new Set(["target", "target/"]);

{
  // 2000 residue lines + one real source file: the Set must still discount
  // every residue line and keep the dirt, and must NOT claim a decline.
  const c = classifyRootDirt(residueLines(2000, ["?? src/stray.ts"]), IGNORED);
  assert(
    c.dirt.length === 1 && c.dirt[0] === "?? src/stray.ts",
    `#5: one source file among 2000 residue lines is the only dirt (got ${JSON.stringify(c.dirt)})`,
  );
  assert(
    c.residue.length === 2000,
    `#5: all 2000 residue lines classified (got ${c.residue.length})`,
  );
  assert(
    c.buildResidueOnly === undefined,
    "#5: dirt among the residue rules the decline out",
  );
}

{
  // The pure case: nothing but residue, at the same scale, still declines.
  const c = classifyRootDirt(residueLines(2000), IGNORED);
  assert(
    c.dirt.length === 0 && c.buildResidueOnly === true,
    "#5: 2000 residue lines and nothing else still declines the gate",
  );
}

{
  // A duplicate residue line must not inflate the count into a false decline
  // nor lose the dirt: the Set is a membership test, not a de-duplication, so
  // this pins that the O(N) change did not become a different question.
  // A repeated line in the caller's batch is passed through unchanged — the
  // Set is a membership test, not a de-duplication, so the O(N) change cannot
  // quietly become "the count of distinct lines". Both halves are pinned:
  // duplicates survive (the caller's batch is echoed, so the refusal still
  // names every line it saw) and the decline is still ruled out.
  const dup = [...residueLines(1500), "?? src/evil.ts", "?? src/evil.ts"];
  const c = classifyRootDirt(dup, IGNORED);
  assert(
    c.dirt.length === 2 && c.dirt.every((l) => l === "?? src/evil.ts"),
    `#5: a repeated dirt line stays dirt and is not silently de-duplicated (got ${JSON.stringify(c.dirt)})`,
  );
  assert(
    c.buildResidueOnly === undefined,
    "#5: a repeated dirt line is never read as pure residue",
  );
}

{
  // Mixed codes at scale: a tracked modification vetoes, whatever the count.
  const c = classifyRootDirt(residueLines(1200, [" M a.txt"]), IGNORED);
  assert(
    c.dirt.some((l) => l === " M a.txt") && c.buildResidueOnly === undefined,
    "#5: a tracked modification among 1200 residue lines vetoes the decline",
  );
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1421c-"));
try {
  // ── #4 the two bounded git reads, on a real repo: the bound is applied and a
  // kill takes the fail-closed branch.
  {
    const dir = path.join(root, "timeout-bound");
    await makeRepo(dir);
    const IGNORE_PROBE_TIMEOUT_MS = 30_000;
    const seen: Array<number | undefined> = [];
    const killed = (async (_cmd: string, o?: { timeout?: number }) => {
      seen.push(o?.timeout);
      throw Object.assign(new Error("Killed"), { killed: true });
    }) as unknown as ExecFn;
    assert(
      (await probeIgnored(killed, dir, ["?? target/x.o"])) === undefined,
      "#4: a killed probe returns undefined (the fail-closed branch, not an empty set)",
    );
    assert(
      (await readIgnoredPaths(killed, dir)) === undefined,
      "#4: a killed ignored-listing read returns undefined (never 'nothing is ignored')",
    );
    assert(
      seen.length === 2 && seen.every((t) => t === IGNORE_PROBE_TIMEOUT_MS),
      `#4: both git reads carry the 30s bound (got ${JSON.stringify(seen)})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── #6 the probe batches, and one bad batch fails the whole answer ────────
// `git check-ignore` gets its paths as trailing pathspec arguments, so a
// single call whose argv grows past ARG_MAX fails at execvp with E2BIG. The
// pre-fix shape made one call for the whole candidate list, so a root with a
// very large build directory turned "git could not answer" into the routine
// outcome — and every untracked path in the root became dirt, which parks a
// finished change. Bounded batches keep the union complete.

const IGNORE_PROBE_BATCH = 500;

function untracked(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`?? target/f${i}.o`);
  return out;
}

{
  // 1200 candidates → three calls, none over the batch, union complete.
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    calls.push(argv);
    return { stdout: argv.filter((a) => a.startsWith("target/")).join("\n") };
  };
  const res = await probeIgnored(exec, "/repo", untracked(1200));
  const gitCalls = calls.filter((a) => a[0] === "check-ignore");
  assert(
    gitCalls.length === 3,
    `#6: 1200 candidates are asked in 3 git calls (got ${gitCalls.length})`,
  );
  assert(
    gitCalls.every((a) => a.slice(3).length <= IGNORE_PROBE_BATCH),
    `#6: no call carries more than ${IGNORE_PROBE_BATCH} paths (got ${gitCalls
      .map((a) => a.slice(3).length)
      .join(",")})`,
  );
  assert(
    res !== undefined && res.size === 1200,
    `#6: the union across batches is complete (got ${res?.size})`,
  );
}

{
  // One batch fails → the whole answer is undefined. A partial union would
  // exempt the paths that answered and leave the rest as dirt: a mix no
  // caller can reason about, and the fail-open direction the classifier was
  // built to avoid.
  let n = 0;
  const exec: ExecFn = async (_cmd, o) => {
    n++;
    if (n === 2) throw Object.assign(new Error("argument list too long"), { code: null });
    return { stdout: (o?.argv ?? []).filter((a) => a.startsWith("target/")).join("\n") };
  };
  assert(
    (await probeIgnored(exec, "/repo", untracked(1200))) === undefined,
    "#6: one failing batch makes the WHOLE answer undefined (fail closed, never a partial union)",
  );
}

{
  // Exit 1 on a batch is git's ANSWER ("none of these are ignored"), not a
  // failure — the union of the batches that named paths still stands.
  let n = 0;
  const exec: ExecFn = async (_cmd, o) => {
    n++;
    if (n === 2) throw Object.assign(new Error("no matches"), { code: 1 });
    return { stdout: (o?.argv ?? []).filter((a) => a.startsWith("target/")).join("\n") };
  };
  const res = await probeIgnored(exec, "/repo", untracked(1200));
  assert(
    res !== undefined && res.size === 700,
    `#6: an exit-1 batch is an answer, not a failure — the other batches survive (got ${res?.size})`,
  );
}

{
  // #4 — a kill is git not answering: the bounded reads must take the same
  // fail-closed branch as an exit ≥ 2, for BOTH readers. The argv shape and
  // the bound the call carries are pinned against the real executor's own
  // behaviour in `test-exec-argv-contract.ts`; here the question is only
  // which branch a kill takes.
  const killed = (async () => {
    throw Object.assign(new Error("Killed"), { killed: true });
  }) as unknown as ExecFn;
  assert(
    (await probeIgnored(killed, "/repo", ["?? target/x.o"])) === undefined,
    "#4: a killed probe returns undefined (the fail-closed branch, not an empty set)",
  );
  assert(
    (await readIgnoredPaths(killed, "/repo")) === undefined,
    "#4: a killed ignored-listing read returns undefined (never 'nothing is ignored')",
  );
}

// ── #1 the SINGLE-group queue row reads its reason through `parkReason`, so
// the residue advice survives on the path that never enters `runWorkQueue`.
//
// The pre-fix shape built its own `cap <cap>` string here, so every suffix
// `parkReason` carries for `humanActionFor` was missing on this build: a
// build-residue park from a one-issue cycle got the fork advice ("free
// processes on the host"), because `/verify-env:/` matched the unsuffixed
// reason before the `:build-residue` rule was ever reached.
{
  const dir = path.join(root, "single-entry");
  await makeRepo(dir);
  const base = initialState(1421, 1_000_000) as WorkState;
  const state = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      status: "handoff",
      currentStep: "develop",
      lastCompletedStep: "develop",
      verifyEvidence: {
        step: "develop",
        failures: [RESIDUE_FAILURE],
        at: 1,
        origin: "outcome-gate",
        buildResidueOnly: true,
      },
    },
    eventLog: [
      {
        kind: "cap-hit",
        at: 1,
        cap: "verify-env:develop",
        nextStep: "handoff",
        reviewRound: 0,
      },
    ],
  } as WorkState;
  await writeState(dir, state);
  const entry = await singleCycleQueueEntry(dir, 1421);
  assert(
    entry?.reason === "cap verify-env:develop:build-residue",
    `#1: the single-group row carries the residue suffix parkReason writes (got ${JSON.stringify(entry?.reason)})`,
  );
  assert(
    /CARGO_TARGET_DIR/.test(entry?.humanAction ?? ""),
    `#1: the single-group row's action points at the build (got ${(entry?.humanAction ?? "").slice(0, 70)})`,
  );
  assert(
    !/free processes on the host/.test(entry?.humanAction ?? ""),
    "#1: the single-group row never gets the fork advice for a residue park",
  );
  assert(
    entry?.reason === parkReason(state).reason,
    "#1: the single-group reason IS parkReason's, so the two builders cannot drift",
  );
}

// ── #7b `/work-status` prints the consolidation decline reason the event
// carries. The `degradedReason` jsdoc claimed the renderers print it while
// nothing read the field, so the operator's only view of a declined
// consolidation was a bare `handoff-emitted` line.
{
  const mk = (degradedReason?: string): WorkState => {
    const base = initialState(1421, 1_000_000) as WorkState;
    return {
      ...base,
      pipelineState: { ...base.pipelineState, status: "handoff", currentStep: "develop" },
      eventLog: [
        makeHandoffEmittedEvent({
          at: 1,
          commentUrl: "https://x/c/1",
          labelApplied: true,
          handoffBodyPath: "/tmp/b.md",
          consolidated: false,
          ...(degradedReason === undefined ? {} : { degradedReason }),
        }),
      ],
    } as WorkState;
  };
  const declined = renderStatus(mk("repoRoot has uncommitted changes (target/)"), "/repo");
  assert(
    /consolid: declined/.test(declined) && declined.includes("target/"),
    `#7b: /work-status renders the driver's decline reason (got ${declined.split("\n").find((l) => l.includes("consolid:"))?.trim() ?? "NO LINE"})`,
  );
  const success = renderStatus(mk(undefined), "/repo");
  assert(
    !/consolid: declined/.test(success),
    "#7b: a handoff with no decline reason prints no decline line",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
