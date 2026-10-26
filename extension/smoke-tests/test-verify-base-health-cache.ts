#!/usr/bin/env bun
/**
 * #1765 — the CACHE rules of the base-commit probe: what may cross a cycle
 * boundary, keyed on what, and what never may.
 *
 * Split from `test-verify-base-health-probe.ts` (which drives the dispatch and
 * verdict paths) for the AGENTS.md §12 budget, along the seam that separates the
 * two halves of the probe's cost model. The rules here are the ones that decide
 * whether a cycle pays for a suite run at all:
 *
 *   - a GREEN crosses cycles, but only for the exact run it judged — base sha,
 *     command, and tier bound all three, so a moved base, an edited gate, or a
 *     raised budget can never be answered by a stale pass;
 *   - a RED never crosses cycles: each cycle re-probes, because one flaky red
 *     must not park (or now, attribute) cycles it never ran in;
 *   - a cache file that cannot be parsed is re-probed, never read as green —
 *     the writer's shape rule, asserted against the file it wrote.
 *
 * The fixtures are shared with the dispatch suite (`lib/base-health-probe-fixture.ts`),
 * and each case runs its probe OUTSIDE the single-flight registry
 * (`freshProbe`), because these are the assertions a NEW CYCLE makes and a registry
 * entry from the previous case would answer for a run it did not perform.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import {
  type BaseHealthVerdict,
  baseHealthCacheFile,
  baseHealthKey,
  cachedBaseHealth,
  matchingVerdict,
  readBaseHealthCache,
} from "../src/work-driver-verify-base-health.ts";
import { developTierTimeouts } from "../src/work-driver-verify-budget.ts";
import { compareWithBaseline } from "../src/work-driver-verify-baseline-compare.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  PROBE_CMD as CMD,
  GREEN_GATE,
  RED_GATE,
  branchState,
  capsOf,
  freshProbe,
  probe,
  redGateExecCounter,
  settled,
} from "./lib/base-health-probe-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

/** Read the repo-level cache after a settled probe; undefined when absent/unreadable. */
function readBaseHealthCacheSync(repo: string): BaseHealthVerdict | undefined {
  try {
    const raw = JSON.parse(readFileSync(baseHealthCacheFile(repo), "utf8"));
    return raw.verdict as BaseHealthVerdict;
  } catch {
    return undefined;
  }
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The cache file's reader, inlined here rather than exported from the module:
 * the seam is a guard on the CACHE WRITER (a green must reach the file in a
 * shape a later cycle can read), not a behaviour the driver calls — its
 * production twin is `usableVerdict`, which the probe already runs. A
 * malformed or non-green record is not green, so this is the writer's
 * assertion, never a second opinion the probe could consult.
 */
function looksLikeGreenVerdict(raw: unknown): raw is BaseHealthVerdict {
  const v = raw as Record<string, unknown> | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.status === "green" &&
    typeof v.baseSha === "string" &&
    v.baseSha !== "" &&
    typeof v.command === "string" &&
    v.command !== "" &&
    typeof v.tierBoundMs === "number" &&
    Number.isFinite(v.tierBoundMs) &&
    v.tierBoundMs > 0
  );
}

const root = mkdtempSync(path.join(tmpdir(), "pi-base-health-cache-"));
/** The probe serialises behind `withVerifySlot`; unbounded keeps the suite fast. */
__setHostBudget({ verifyConcurrency: 0 } as HostBudget);

// ── 7 — the green verdict is cached across cycles, keyed by the run it judged.
{
  const f = await redGateFixture(root, "cache-green", GREEN_GATE, { "notes.md": "x\n" });
  const first = await probe(f);
  // The probe is registered and NOT awaited (that is the #1809 change), so a case
  // that reads the cost counters has to settle it first — the same point the
  // develop gate would have read the verdict. `outcome === undefined` here would
  // mean no probe was registered, which is a different failure from zero runs.
  await settled(first);
  assert(first.gateRuns.length === 1, "cache: the first cycle pays for the probe");
  const second = await probe(f);
  await settled(second);
  assert(
    second.gateRuns.length === 0 && second.worktreeAdds === 0,
    `cache: a second cycle on the same base does NOT re-probe (got ${second.gateRuns.length})`,
  );
  assert(capsOf(second.state).length === 0, "cache: the cached green proceeds like a probed green");
  await realExec("git", {
    argv: ["commit", "-q", "--allow-empty", "-m", "chore: base moved"],
    cwd: f.repo,
  });
  const moved = (await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })).stdout.trim();
  const third = await probe(f, { state: branchState(moved) });
  await settled(third);
  assert(
    third.gateRuns.length === 1,
    `cache: a new baseSha re-probes (got ${third.gateRuns.length}) — a green is only a green for the commit it ran on`,
  );
  // The bound is the key's third part: a project that raises its suite budget
  // has not been judged under the new one, so the cached verdict may not answer
  // for it. `.pi/verify-timeout-ms` is the suite tier's own project file.
  const bound = (await developTierTimeouts(f.repo)).suite;
  const cached = await readBaseHealthCache(
    async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
    f.repo,
  );
  assert(cached?.status === "green", "cache key: a green sits in the file to be judged");
  assert(
    matchingVerdict(cached, { baseSha: f.baseSha, command: CMD, tierBoundMs: bound + 1 }) ===
      undefined,
    "cache key: a different tier bound is a different run — re-probe",
  );
  await realExec("git", { argv: ["checkout", "-q", "--detach", f.baseSha], cwd: f.repo });
  mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
  writeFileSync(path.join(f.repo, ".pi", "verify-timeout-ms"), `${bound + 60_000}\n`);
  const raised = await probe(f);
  await settled(raised);
  assert(
    raised.gateRuns.length === 1,
    `cache key: a raised suite bound re-probes (got ${raised.gateRuns.length}) — the cached verdict judged a different budget`,
  );
  rmSync(path.join(f.repo, ".pi", "verify-timeout-ms"), { force: true });
  const green: BaseHealthVerdict = {
    status: "green",
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: bound,
  };
  assert(
    matchingVerdict(green, {
      baseSha: f.baseSha,
      command: "sh other.sh",
      tierBoundMs: bound,
    }) === undefined,
    "cache key: a different command is a different run — re-probe",
  );
  assert(
    baseHealthKey(green) === baseHealthKey({ ...green }),
    "cache key: the same run, the same key",
  );
  const hit = await cachedBaseHealth(initialState(1765), f.repo, {
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: bound + 60_000,
  });
  assert(hit.from === "cache" && hit.verdict?.status === "green", "cache: read back from the file");
}

// ── 8 — a RED is never cached across cycles.
{
  const f = await redGateFixture(root, "cache-red", RED_GATE, { "notes.md": "x\n" });
  const first = await probe(f);
  const firstOut = await settled(first);
  assert(firstOut.verdict?.status === "red", "red cache: the first cycle probed red");
  assert(
    readBaseHealthCacheSync(f.repo) === undefined,
    "red cache: a red probe leaves nothing for a later cycle to reuse",
  );
  // The registry makes concurrent probes for one key answer ONCE, so a second
  // call here would observe 0 runs without any cycle having been skipped. The
  // rule this case owns — a red is never *cached* — is about the durable file, and
  // the only observation that carries it is a probe that had to reach the gate:
  // `freshProbe` runs the probe body directly and reads that file itself.
  assert(
    readBaseHealthCacheSync(f.repo) === undefined,
    "red cache: the durable cache holds no red for the next cycle to reuse",
  );
  const second = await freshProbe(f);
  assert(
    second.out.ran === true && second.out.verdict?.status === "red",
    `red cache: the next cycle RE-PROBES rather than reusing a red (ran=${second.out.ran}, verdict=${second.out.verdict?.status}, ${second.gateRuns.length} runs) — one flaky red must not speak for cycles it never ran in`,
  );
  const red: BaseHealthVerdict = {
    status: "red",
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: 1,
  };
  // #1826 — the cache and the state carry reds, so both readers are checked
  // against the two-run rule: a record that states no confirmed second run is
  // still READABLE (the parser refuses nothing), and it is the CLAIM that is
  // withheld, not the row. `usableVerdict` keeps such a record usable so the
  // comparison can re-confirm it rather than re-probe from nothing.
  const noSecond = JSON.stringify({
    verdict: { status: "red", baseSha: f.baseSha, command: CMD, tierBoundMs: red.tierBoundMs },
  });
  const readBare = await readBaseHealthCache(async () => noSecond, f.repo);
  assert(
    readBare?.status === "red" && readBare.secondRun === undefined,
    "red cache: a red with no secondRun field still reads back — it is a colour, not a claim",
  );
  // The fixture's `.pi/work-state/` exists only once a cycle has written there (the
  // probe's own cache write is what creates it), and a red NEVER takes that write —
  // so this case, which stages a red record by hand, has to create the directory
  // the same way the driver's first green would.
  mkdirSync(path.join(f.repo, ".pi", "work-state"), { recursive: true });
  writeFileSync(baseHealthCacheFile(f.repo), noSecond);
  // The cache is read on ONE condition and it is not this one: `cachedBaseHealth`
  // may answer for a cycle only with a GREEN, because "a red is never cached across
  // cycles" is enforced at the read, not the write. So the row stays readable — that
  // is the parser's business — and the probe never sees it. The anti-vacuity half is
  // the pair below: a red this cycle DID watch is handed out with its evidence, so
  // the assertion above is not a case of a probe that could not produce one.
  // The same gate the develop gate's consultation runs through, with the row in
  // place: it returns the red it watched itself, never the row, and says what the
  // row was. A case that only looked at `out.red === undefined` would be satisfied
  // by a probe that could not produce an evidence at all.
  // #1826 — the row on disk is not the only thing that must not speak for a
  // cycle. The in-flight probe's red is the ONE red a develop round may reuse, and
  // it reuses only a record whose own `secondRun` field says a second run agreed:
  // the probe's confirmation is the only thing a reuse has behind it, because the
  // throwaway checkouts that printed the stream are gone and the reuse pays for
  // nothing. A record written by an older build states no such field, and reusing
  // it would be the single-red park this issue exists to end.
  const reuseRuns: string[] = [];
  const confirmedRe = await compareWithBaseline(redGateExecCounter(reuseRuns), {
    repoRoot: f.repo,
    baseSha: f.baseSha,
    issue: 1826,
    cmd: CMD,
    timeoutMs: second.out.verdict?.tierBoundMs ?? bound,
    changeFailures: [{ text: "1 failed", timedOut: false }],
    failures: [],
    notes: [],
    cachedVerdict: { ...second.out.verdict, fromInFlightProbe: true },
  });
  assert(
    confirmedRe?.established === true &&
      confirmedRe.verdict?.reused === true &&
      reuseRuns.length === 0,
    `red cache: the in-flight red this pass collected IS reused, and its record's own confirmation carries the claim — no run paid for it (established=${confirmedRe?.established}, reused=${confirmedRe?.verdict?.reused}, ${reuseRuns.length} runs)`,
  );
  // A SECOND base, because the comparison's own runs register in the same
  // single-flight registry the branch-step probe uses: a second consultation for
  // the SAME key would answer from the first one's in-flight entry and report "two
  // runs paid for" as whatever the first run happened to cost.
  const staleRuns: string[] = [];
  const staleRe = await compareWithBaseline(redGateExecCounter(staleRuns), {
    repoRoot: f.repo,
    baseSha: (await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })).stdout.trim(),
    issue: 1826,
    cmd: CMD,
    timeoutMs: second.out.verdict?.tierBoundMs ?? bound,
    changeFailures: [{ text: "1 failed", timedOut: false }],
    failures: [],
    notes: [],
    cachedVerdict: {
      status: "red",
      baseSha: f.baseSha,
      command: CMD,
      tierBoundMs: second.out.verdict?.tierBoundMs ?? bound,
      fromInFlightProbe: true,
    },
  });
  assert(
    staleRe?.verdict?.reused !== true && staleRuns.length === 2,
    `red cache: an in-flight red with no stated second run pays for BOTH runs again rather than reusing a colour (reused=${staleRe?.verdict?.reused}, ${staleRuns.length} runs)`,
  );
  const unreadableSecond = JSON.stringify({
    verdict: {
      status: "red",
      baseSha: f.baseSha,
      command: CMD,
      tierBoundMs: red.tierBoundMs,
      secondRun: "ok",
    },
  });
  assert(
    (await readBaseHealthCache(async () => unreadableSecond, f.repo)) === undefined,
    "red cache: a PRESENT but unreadable secondRun makes the whole record unusable — re-probe (#1826, the same rule as timedOut)",
  );
  // The `read` twin the pair above reads its row through.
  const read = await readBaseHealthCache(async () => JSON.stringify({ verdict: red }), f.repo);
  assert(
    read?.status === "red",
    "red cache: a red CAN be read back, so refusing to reuse it is the policy, not the parser",
  );
  const held = branchState(f.baseSha);
  held.pipelineState.baseHealthProbe = red;
  const hit = await cachedBaseHealth(held, f.repo, {
    baseSha: f.baseSha,
    command: CMD,
    tierBoundMs: 1,
  });
  assert(
    hit.verdict?.status === "red",
    "red cache: an in-state red is readable (the aggregate reuses it)",
  );
  const third = await freshProbe(f, { state: held });
  assert(
    third.gateRuns.length >= 1 && third.out.verdict?.status === "red",
    `red cache: an in-state red does NOT let the probe skip its own run (${third.gateRuns.length} runs, verdict=${third.out.verdict?.status})`,
  );
}

// ── 9 — a malformed cache file means re-probe, never green.
{
  const f = await redGateFixture(root, "cache-bad", GREEN_GATE, { "notes.md": "x\n" });
  mkdirSync(path.dirname(baseHealthCacheFile(f.repo)), { recursive: true });
  const cases: Array<[string, string]> = [
    ["not JSON", "{ this is not json"],
    ["a bare array", "[]"],
    ["no verdict field", '{"other":1}'],
    ["a green with no sha", '{"verdict":{"status":"green","command":"x","tierBoundMs":1,"at":0}}'],
    [
      "a green with a zero bound",
      '{"verdict":{"status":"green","baseSha":"a","command":"x","tierBoundMs":0,"at":0}}',
    ],
    ["an unknown status", '{"verdict":{"status":"purple","baseSha":"a"}}'],
  ];
  for (const [label, body] of cases) {
    writeFileSync(baseHealthCacheFile(f.repo), body);
    // Each case is a fresh cycle: run outside the registry so the assertion is
    // about the CACHE file, not about a probe this process left running.
    const r = await freshProbe(f);
    assert(
      r.gateRuns.length === 1 && capsOf(r.state).length === 0,
      `malformed cache (${label}): re-probe, and never read as green`,
    );
  }
  const healthy = JSON.parse(readFileSync(baseHealthCacheFile(f.repo), "utf8"));
  assert(healthy.verdict?.status === "green", "malformed cache: the good probe rewrote the file");
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
