#!/usr/bin/env bun
/**
 * #1421 fix round 4 (lens, performance) — the ignore probes stop queueing.
 *
 * Three shapes this round changed, all of them latency rather than verdict:
 *
 *   - `probeIgnored` ran its ≤500-path batches SEQUENTIALLY. A root with 2 000
 *     untracked paths paid four `git check-ignore` round-trips back to back for
 *     no benefit — the batches are independent reads of one tree. They now run
 *     through a small bounded pool (4 in flight). The contract that has to
 *     survive the concurrency is the fail-closed one, so this file pins both
 *     halves: the concurrency is real and bounded, and one batch that rejects
 *     with anything but git's exit-1 answer still voids the WHOLE answer.
 *   - the two git reads (`readIgnoredPaths`, `probeIgnored`) ran one after the
 *     other at all three call sites, though at two of them the probe's
 *     candidates come straight from the status read and never need the ignored
 *     listing. They now start together — pinned here by a fake that only
 *     resolves each read once both have been issued.
 *   - the preflight re-derived the same candidate list twice and re-spread the
 *     ignored set back into the probe, so every `!!` path git had already
 *     answered went back to git as a question. The probe argv now carries the
 *     untracked paths once, de-duplicated, and the lines the classifier
 *     adjudicates come from that same derivation.
 *   - the residue failure string promised "the consolidated verify ran despite
 *     them" on a path that declines BEFORE the checkout, so nothing ran.
 *
 * Separate from `test-build-residue-dirty-root-1421c.ts`, which is at 331
 * lines and would cross the 500-line gate with these cases appended.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { readRepoRootDirt } from "../src/work-driver-branch-residue.ts";
import { readRepoRootPreflight } from "../src/work-driver-consolidated-verify-preflight.ts";
import {
  classifyRootDirt,
  probeIgnored,
} from "../src/work-driver-dirty-root-classify.ts";
import { buildResidueFailure } from "../src/work-driver-dirty-root-classify.ts";
import type { ExecFn } from "../src/worktree.ts";
import { initialState } from "../src/workflow-state.ts";
import { makeRepo, worktreeWithCommit } from "./lib/build-residue-1421-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const IGNORE_PROBE_BATCH = 500;
const IGNORE_PROBE_CONCURRENCY = 4;

function untracked(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`?? target/f${i}.o`);
  return out;
}

/** An executor that answers every `git check-ignore` from its own argv. */
function echoExec(delayMs = 0): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    calls.push(argv);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return { stdout: argv.filter((a) => a.startsWith("target/")).join("\n") };
  };
  return { exec, calls };
}

// ── A. the batches overlap, and never more than IGNORE_PROBE_CONCURRENCY ───
// The fake records a counter that every in-flight call bumps on entry and
// drops on settle; the maximum the counter reaches is the real concurrency, so
// a sequential loop scores 1 and an unbounded fan-out scores the batch count.
{
  const { exec, calls } = echoExec(5);
  let inFlight = 0;
  let peak = 0;
  const tracked: ExecFn = async (cmd, o) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      return await exec(cmd, o);
    } finally {
      inFlight--;
    }
  };
  const res = await probeIgnored(tracked, "/repo", untracked(2500));
  const gitCalls = calls.filter((a) => a[0] === "check-ignore");
  assert(
    gitCalls.length === 5,
    `A: 2500 candidates are asked in 5 batches (got ${gitCalls.length})`,
  );
  assert(
    peak > 1,
    `A: the batches run CONCURRENTLY, not one after another (peak in flight: ${peak})`,
  );
  assert(
    peak <= IGNORE_PROBE_CONCURRENCY,
    `A: never more than ${IGNORE_PROBE_CONCURRENCY} batches in flight (peak: ${peak})`,
  );
  assert(
    res !== undefined && res.size === 2500,
    `A: the concurrent union is complete (got ${res?.size})`,
  );
}

// ── B. one rejecting batch still voids the whole answer ───────────────────
{
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    // The SECOND batch by position fails — not the first, so the answer cannot
    // be produced by an early return that skips the batches that answered.
    if (argv[3] === "target/f500.o") {
      throw Object.assign(new Error("argument list too long"), { code: null });
    }
    await new Promise((r) => setTimeout(r, 2));
    return { stdout: argv.filter((a) => a.startsWith("target/")).join("\n") };
  };
  const res = await probeIgnored(exec, "/repo", untracked(2500));
  assert(
    res === undefined,
    `B: a batch that rejects with no exit code voids the WHOLE answer (got ${res === undefined ? "undefined" : `a set of ${res.size}`})`,
  );
}

{
  // A kill (a timeout's shape) is the same void, with the batches in flight.
  const exec: ExecFn = async (_cmd, o) => {
    await new Promise((r) => setTimeout(r, 2));
    if ((o?.argv ?? [])[3] === "target/f1000.o") {
      throw Object.assign(new Error("Killed"), { killed: true });
    }
    return { stdout: "" };
  };
  assert(
    (await probeIgnored(exec, "/repo", untracked(2500))) === undefined,
    "B: a killed batch voids the whole answer, concurrency notwithstanding",
  );
}

{
  // Exit 1 remains git's ANSWER: the other batches still stand.
  const exec: ExecFn = async (_cmd, o) => {
    const argv = o?.argv ?? [];
    if (argv[3] === "target/f1500.o") throw Object.assign(new Error("no match"), { code: 1 });
    await new Promise((r) => setTimeout(r, 2));
    return { stdout: argv.filter((a) => a.startsWith("target/")).join("\n") };
  };
  const res = await probeIgnored(exec, "/repo", untracked(2500));
  assert(
    res !== undefined && res.size === 2000,
    `B: an exit-1 batch is an answer, so the concurrent siblings survive (got ${res?.size})`,
  );
}

// ── C. the two git reads start together where the probe needs no listing ──
// The executor is a LATCH, not a barrier: every read it is asked for is held
// open, and the latch opens only once `needed` reads are in flight at once. A
// caller that awaits one read before issuing the next never gets two open, so
// the call rejects at the bound — that rejection IS the sequential shape's
// evidence, which is what makes these three cases RED before the fix.
function latchedExec(
  status: string,
  listing: string,
  needed: number,
): { exec: ExecFn; issued: string[] } {
  const issued: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exec: ExecFn = async (cmd, o) => {
    const key = o?.argv ? "git check-ignore" : cmd;
    // The status read is the caller's own first read: it is not one of the
    // pair under test, and gating it would stall the caller before it ever
    // issued the two reads this case is about.
    if (cmd.startsWith("git status --porcelain")) return { stdout: status };
    issued.push(key);
    if (issued.length >= needed) release();
    await Promise.race([
      gate,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("the concurrent reads were never issued together")),
          2000,
        ),
      ),
    ]);
    if (key === "git check-ignore") {
      return { stdout: (o?.argv ?? []).filter((a) => a.startsWith("target/")).join("\n") };
    }
    if (key.startsWith("git status --ignored")) return { stdout: listing };
    return { stdout: status };
  };
  return { exec, issued };
}

{
  const { exec } = latchedExec(untracked(3).join("\n"), "", 2);
  let ok = true;
  let dirt: string[] | undefined;
  try {
    dirt = await readRepoRootDirt(exec, "/repo");
  } catch {
    ok = false;
  }
  assert(
    ok && dirt === undefined,
    `C: the branch gate's ignored read and probe run CONCURRENTLY (settled: ${ok}, dirt: ${JSON.stringify(dirt)})`,
  );
}

{
  const { exec } = latchedExec(untracked(3).join("\n"), "", 2);
  let ok = true;
  let out: unknown;
  try {
    out = await consolidateWorktreesToBranch(
      { repoRoot: "/repo", issue: 1421, scratchDir: "/repo/tmp" },
      {
        ...initialState(1421, 1_000_000),
        pipelineState: {
          ...initialState(1421, 1_000_000).pipelineState,
          branchName: "feature/issue-1421-x",
          baseSha: "deadbeef",
          worktrees: { a: "/repo/.worktrees/a" },
        },
      } as never,
      exec,
    );
  } catch {
    ok = false;
  }
  assert(
    ok && out !== undefined,
    `C: the handoff consolidation's two git reads run CONCURRENTLY (settled: ${ok})`,
  );
}

{
  // The preflight runs its status-derived probe beside the listing, so the
  // latch opens there too. Its second probe — the collapsed directory's
  // descendants, which only the listing can witness — legitimately waits.
  const { exec } = latchedExec(untracked(3).join("\n"), "", 2);
  let ok = true;
  let out: unknown;
  try {
    out = await readRepoRootPreflight(exec, "/repo", undefined);
  } catch {
    ok = false;
  }
  assert(
    ok && out !== undefined,
    `C: the preflight starts its probe beside the ignored listing (settled: ${ok})`,
  );
}

// ── D. the preflight probes each path once and never asks about `!!` ──────
{
  const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1421d-"));
  try {
    const repo = path.join(root, "repo");
    const base = await makeRepo(repo);
    const a = await worktreeWithCommit(repo, "issue-1421-a", base, "a.rs");
    // Status: the same untracked path printed twice, plus a SECOND untracked
    // path (so the probe cannot pass by asking one path twice), plus the
    // collapsed directory the listing names but the status never walks into.
    const STATUS = "?? target/.cargo-lock\n?? target/.cargo-lock\n?? build/x.o\n";
    const LISTING = "!! target/\n!! build/\n";
    const probeArgvs: string[][] = [];
    const exec: ExecFn = async (cmd, o) => {
      if (cmd === "git") {
        const argv = o?.argv ?? [];
        probeArgvs.push(argv);
        // Nothing is ignored according to the direct probe — the classification
        // below rests entirely on the listing's `!!` entries and the
        // driver-observed line the preflight derives from them.
        return { stdout: "" };
      }
      if (cmd.startsWith("git status --porcelain")) return { stdout: STATUS };
      if (cmd.startsWith("git status --ignored")) return { stdout: LISTING };
      throw new Error(`unexpected command ${cmd}`);
    };
    const res = await readRepoRootPreflight(exec, repo, undefined);
    const asked = probeArgvs.flatMap((a) => a.slice(3));
    assert(
      probeArgvs.length > 0,
      "D: the preflight does run the probe (the assertions below are not vacuous)",
    );
    assert(
      asked.length > 0 && !asked.some((p) => p.includes("!!")),
      `D: no ignored-listing path is ever asked back — git already answered those (asked: ${JSON.stringify(asked)})`,
    );
    assert(
      asked.length === new Set(asked).size,
      `D: each candidate is probed ONCE — no duplicates across the argv batches (asked: ${asked.length}, distinct: ${new Set(asked).size})`,
    );
    assert(
      asked.includes("target/.cargo-lock") && asked.includes("build/x.o"),
      `D: every untracked path the status read printed IS asked (asked: ${JSON.stringify(asked)})`,
    );
    // The classification still declines on residue alone, so the de-duplication
    // above did not quietly drop the residue the decline rests on.
    assert(
      res !== undefined && res.kind === "build-residue" && res.buildResidueOnly === true,
      `D: the de-duplicated probe still classifies the root as residue-only (got ${JSON.stringify(res ?? {}).slice(0, 90)})`,
    );
    void a;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── E. the residue prose is true on the path that declines before the run ─
{
  const text = buildResidueFailure(["target/.cargo-lock"], "the repo root is not clean");
  assert(
    !/ran despite them/.test(text),
    `E: the residue string no longer claims the verify RAN on the decline path (got: ${text.slice(110, 220)})`,
  );
  assert(
    /declined before the checkout/.test(text),
    "E: the residue string says the gate declined before the checkout",
  );
  // #1421 round 3 — the closing sentence states the gate's own silence as a
  // neutral clause, not as an assertion about the code. The old phrasing ("the
  // code reached no verdict") reads as a finding about the change; the gate
  // never judged it, so it may only say no verdict was reached.
  assert(
    /no verdict was reached on the code/.test(text),
    `E: the closing sentence is neutral about the code (got: ${text.slice(-260)})`,
  );
  assert(
    !/the code reached no verdict/.test(text),
    "E: the old code-facing phrasing is gone",
  );
  // The other caller-visible half: the string is still routeable, and still
  // names the fix. Changing the prose must not cost the cap router its key.
  const c = classifyRootDirt(["?? target/.cargo-lock"], new Set(["target", "target/"]));
  const declined = buildResidueFailure(
    c.residue.map((r) => r.line.slice(3)),
    "the repo root is not clean",
  );
  assert(
    declined.startsWith("[build-residue]") && /CARGO_TARGET_DIR/.test(declined),
    "E: the rewritten sentence keeps the routing label and the build advice",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
