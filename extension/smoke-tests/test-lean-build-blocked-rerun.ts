#!/usr/bin/env bun
/**
 * lean/build — the driver's re-run of a blocked report (#1984).
 *
 * Split from `test-lean-build-blocked.ts` for the 500-line gate (AGENTS.md §12),
 * along the seam that file already draws: that one owns the CHANNEL (the tool the
 * child is given, the prompt that tells it to stop, the call it may not make),
 * this one owns the JUDGEMENT — what the driver does with a report it has read,
 * which is to run the named frozen tests itself and believe only what comes back
 * red.
 *
 * Every case here is about the re-run, and only the re-run:
 *   (3a)  a killed/timed-out runner observed nothing, so it is not a red — and it
 *         is SKIPPED rather than fatal, so a toolchain fault on one file cannot
 *         hide a genuine conflict in another
 *   (3a3) the loop shares ONE wall clock, so N named files cannot cost N ceilings
 *   (3a4) a non-zero exit that never named its file is `unclear`, not a red
 *   (3a6) the named file's bytes must still be the bytes the run froze: an
 *         edited frozen test is the child's own edit, not a contradiction
 *   (3a7) the re-run hands its runner an explicit, driver-knob-scrubbed env —
 *         never the ambient one a headless driver's knobs sit in
 *   (3b)  the cause sentence names the file the DRIVER saw fail
 *   (3c)  no runner configured: the report is ignored, and the gap is NAMED
 *
 * The report is the child's word; these are the cases that make it the driver's.
 */

import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, childCommit, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The child's one `report_blocked` call, in the shape Pi records a tool call. */
function blocked(names: Array<{ path: string; reason: string }>): unknown[] {
  return [{ name: "report_blocked", arguments: { conflicts: names } }];
}

/** A conflict naming the fixture's frozen file, in the child's own words. */
const CONFLICT = "case 2 needs the array mutable while case 3 mutates it in place";

// ── (3a) a runner that could not judge the named test is not a red ─────────
{
  // A killed or timed-out runner observed NOTHING, so it cannot prove a
  // conflict: honouring it would let a broken toolchain end a run. The bound is
  // a case knob (`blockedTimeoutMs`), and a hanging runner is a fixture file
  // that sleeps past it.
  const SLOW = "tests/slow.test.sh";
  const probe = {
    extraFrozen: {
      // Sleeps, then prints a TAP-style failure naming its own path: slow enough
      // for a short bound to kill it (infra), and genuinely red when the bound
      // lets it finish. A file that named itself without sleeping would honour
      // both cases; one that never named itself would fail neither.
      [SLOW]: '#!/bin/sh\nsleep 3\necho "not ok - tests/slow.test.sh" 1>&2\nexit 1\n',
    },
    toolUses: () => blocked([{ path: SLOW, reason: CONFLICT }]),
    blockedTimeoutMs: 200,
  };
  // The same report with a bound the runner comfortably finishes inside IS
  // honoured, so the refusal below is the runner's state and not the shape of
  // the report: without the infra rule the two cases would read identically.
  const judgeable = await runBuild({ issue: 336, ...probe, blockedTimeoutMs: 30_000 });
  assert(
    judgeable.outcome?.kind === "blocked",
    `(3a) the same report with a judgeable runner IS honoured (got ${judgeable.outcome?.kind ?? judgeable.threw?.message})`,
  );
  const r = await runBuild({ issue: 335, ...probe });
  assert(
    r.outcome?.kind === "exhausted",
    `(3a) an unjudgeable test is not a conflict (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(3a) and nothing is recorded");
  // The infra file is SKIPPED, not fatal: a second, genuinely red frozen file is
  // still reached and still proves the report, which an early `return` on the
  // first infra would have hidden. The hanging file must NOT name itself — a
  // runner that echoes the path before it is killed would honestly classify as
  // `red`, and the case would be proving nothing.
  const MIXED = "tests/mixed-slow.test.sh";
  const mixed = await runBuild({
    issue: 339,
    extraFrozen: { [MIXED]: "#!/bin/sh\nsleep 3\nexit 1\n" },
    // The red file is named SECOND, so the loop must survive the first one's kill.
    toolUses: () =>
      blocked([
        { path: MIXED, reason: "this one hangs" },
        { path: "tests/AC1-retry.test.sh", reason: CONFLICT },
      ]),
    blockedTimeoutMs: 20_000,
  });
  assert(
    mixed.outcome?.kind === "blocked",
    `(3a2) an infra file is skipped and a later red still honours the report (got ${mixed.outcome?.kind ?? mixed.threw?.message})`,
  );
  assert(
    mixed.outcome?.blockedBy?.[MIXED] === undefined,
    `(3a2) and the skipped file is NOT recorded as a cause (got ${JSON.stringify(mixed.outcome?.blockedBy)})`,
  );
}

// ── (3a3) the re-run shares ONE wall clock across the loop ───────────────
{
  // Two files that each sleep past the per-file bound must not each get a fresh
  // ceiling: with a 300 ms shared budget and 200 ms of sleep each, the second is
  // never started and the report is refused. Per-file ceilings would let N named
  // files cost N × the budget after the child was already paid.
  const SLOW_A = "tests/slow-a.test.sh";
  const SLOW_B = "tests/slow-b.test.sh";
  const started = Date.now();
  const r = await runBuild({
    issue: 340,
    extraFrozen: {
      [SLOW_A]: "#!/bin/sh\nsleep 1\nexit 1\n",
      [SLOW_B]: "#!/bin/sh\nsleep 1\nexit 1\n",
    },
    toolUses: () =>
      blocked([
        { path: SLOW_A, reason: "a hangs" },
        { path: SLOW_B, reason: "b hangs" },
      ]),
    blockedTimeoutMs: 300,
  });
  assert(
    r.outcome?.kind !== "blocked",
    `(3a3) a report whose files all outlast the shared budget is not honoured (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  // And the loop cost ONE bound, not one per file: two fresh 300 ms ceilings on
  // two files that each sleep a second would put this well past 600 ms; a shared
  // budget cannot get far past 300 because the second file is never started.
  assert(
    Date.now() - started < 900,
    `(3a3) and the loop cost one bound, not one per file (${String(Date.now() - started)}ms)`,
  );
}

// ── (3a5) a runner that IGNORES its own kill cannot outlast the budget ───
{
  // (3a3) exercises a runner the group kill actually reaches. The other tail of
  // the same promise is a runner that never returns — a process that swallows the
  // SIGKILL, or a grandchild holding the pipe as a zombie — which keeps the
  // `await` alive long after the loop's deadline. Here the exec stub never
  // rejects and never resolves inside the budget: only the loop's own race can
  // end it, so the step must refuse at roughly ONE budget, not one per file.
  const HANG_A = "tests/hang-a.test.sh";
  const HANG_B = "tests/hang-b.test.sh";
  const HANG_C = "tests/hang-c.test.sh";
  const started = Date.now();
  const r = await runBuild({
    issue: 342,
    extraFrozen: {
      [HANG_A]: "#!/bin/sh\nexit 1\n",
      [HANG_B]: "#!/bin/sh\nexit 1\n",
      [HANG_C]: "#!/bin/sh\nexit 1\n",
    },
    toolUses: () =>
      blocked([
        { path: HANG_A, reason: "a never returns" },
        { path: HANG_B, reason: "b never returns" },
        { path: HANG_C, reason: "c never returns" },
      ]),
    blockedTimeoutMs: 400,
    // A runner that ignores its ceiling entirely: resolves after the whole budget
    // with a red-shaped output, so if the step waited for it, it would believe it.
    hungExec: () => new Promise((resolve) => setTimeout(() => resolve({ stdout: "" }), 5000)),
  });
  const elapsed = Date.now() - started;
  assert(
    r.outcome?.kind !== "blocked",
    `(3a5) a report whose runners never return is not honoured (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    elapsed < 2000,
    `(3a5) and the step refused at one budget, not one per hanging file (${String(elapsed)}ms)`,
  );
}

// ── (3a4) a run that did not name its file is NOT a red ─────────────────
{
  // `runTestFile` calls a non-zero exit whose output never named the file
  // `unclear`: something else failed. Honouring it would let the driver claim
  // "these frozen tests cannot all pass together" on evidence it cannot tie to
  // the test it names — the runner may have died for a reason that has nothing to
  // do with the contract.
  const MYSTERY = "tests/mystery.test.sh";
  const r = await runBuild({
    issue: 341,
    extraFrozen: { [MYSTERY]: '#!/bin/sh\necho "some other tool exploded" 1>&2\nexit 3\n' },
    toolUses: () => blocked([{ path: MYSTERY, reason: "claims a conflict it cannot name" }]),
  });
  assert(
    r.outcome?.kind !== "blocked",
    `(3a4) a non-zero exit that never named the file is not a red (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(3a4) and nothing is recorded");
}

// ── (3a6) a frozen test the CHILD edited is not a conflict ───────────────
{
  // The re-run happens in the child's tree, and the child can write there — it
  // commits its own work — so "the driver ran it and saw red" is only evidence
  // while the bytes git holds under the name are the bytes the freeze hashed:
  // `frozenFromLog` records the sha256 of the committed blob and `blobAt` reads
  // that blob back exactly. Here the child rewrites the frozen test into one that
  // fails unconditionally and names its own path, which is exactly what the real
  // frozen file does when the implementation is missing: to the runner the two are
  // indistinguishable, and only the record tells them apart. Without the hash
  // check the driver certifies the child's own edit as an unsatisfiable contract
  // and prints the contract's words as the cause.
  const TAMPERED = '#!/bin/sh\necho "not ok - tests/AC1-retry.test.sh" 1>&2\nexit 1\n';
  const r = await runBuild({
    issue: 343,
    child: (wt) => {
      // No implementation, so the honest red is available too — the tamper is
      // what the case is about, and it must be the thing that refuses the report.
      put(wt, "tests/AC1-retry.test.sh", TAMPERED, 0o755);
      // The child commits, as a real child does: the record is about the bytes
      // the run holds, so an unstaged edit is not the shape being attacked.
      childCommit(wt, "test: the contract is wrong");
    },
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(
    r.outcome?.kind !== "blocked",
    `(3a6) a report proved only on an edited frozen test is not honoured (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(r.outcome?.blockedBy === undefined, "(3a6) and nothing is recorded");
}

// ── (3a7) the re-run's runner gets the scrubbed env ───────────────────
{
  // Every other call site that runs the PROJECT's tests hands the runner
  // `verifyChildEnv()` — a headless driver's own knobs must not decide what a
  // project's test sees, and a test that reads one can manufacture the very red
  // this gate is meant to prove. The gate runs through the same `runTestFile`, so
  // it must pass the same env. The fixture's exec stub is the only witness: it
  // records what the gate actually handed the runner.
  const seen: { cmd: string; env?: NodeJS.ProcessEnv }[] = [];
  // A driver knob that `verifyChildEnv` DROPS (its scope is not `internal`), set
  // in this process so the ambient env an unscrubbed runner inherits really
  // carries it. The witness is the env the gate handed its exec seam, not the
  // runner's exit: a script cannot tell an explicit scrubbed env from an omitted
  // one, because Node falls back to `process.env` when `env` is absent.
  process.env.PI_ENSEMBLE_CLAIM_STALE_MS = "777";
  const r = await runBuild({
    issue: 344,
    extraFrozen: {
      "tests/env.test.sh":
        '#!/bin/sh\necho "not ok - tests/env.test.sh" 1>&2\nexit 1\n',
    },
    toolUses: () => blocked([{ path: "tests/env.test.sh", reason: CONFLICT }]),
    execSpy: (cmd, o) => {
      if (cmd !== "git") seen.push({ cmd, env: (o as { env?: NodeJS.ProcessEnv })?.env });
    },
  });
  assert(
    seen.length > 0,
    "(3a7) the gate did run the named file through the exec seam",
  );
  assert(
    seen.every(
      (s) =>
        s.env !== undefined &&
        s.env["PI_ENSEMBLE_CLAIM_STALE_MS"] === undefined &&
        "HOME" in s.env,
    ),
    `(3a7) the runner was handed an explicit env with the driver's knobs scrubbed (${String(seen.length)} runner call(s))`,
  );
  assert(
    r.outcome?.kind === "blocked",
    `(3a7) and the scrub still proves a genuine red (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  delete process.env.PI_ENSEMBLE_CLAIM_STALE_MS;
}

// ── (3b) the cause sentence names the file the DRIVER saw red, not the last ─
{
  // The child reports two files; the first is genuinely red and the second
  // passes. `blockedProved` returns on the first red, so the sentence must name
  // THAT file — naming the last vetted entry would print a file the driver ran
  // green, which is a claim the run does not hold.
  const RED = "tests/AC1-retry.test.sh";
  const GREEN = "tests/green.test.sh";
  const r = await runBuild({
    issue: 337,
    // `tests/AC1-retry.test.sh` is red while `src/retry.ts` still holds the
    // placeholder (the child implemented nothing), and `tests/green.test.sh`
    // always exits 0. The child names the RED one SECOND, so a cause line built
    // from the last vetted entry would name the file the driver ran green.
    extraFrozen: { [GREEN]: '#!/bin/sh\necho "ok - passed"\nexit 0\n' },
    toolUses: () =>
      blocked([
        { path: GREEN, reason: "the adversary's file mutates it" },
        { path: RED, reason: "AC1 needs the array mutable" },
      ]),
  });
  assert(
    r.outcome?.kind === "blocked",
    `(3b) the report is honoured on the first red (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(RED) &&
      (r.outcome?.reason ?? "").includes("AC1 needs the array mutable"),
    `(3b) the reason names the file the driver watched fail (got ${r.outcome?.reason})`,
  );
  assert(
    !(r.outcome?.reason ?? "").startsWith(`frozen tests cannot all pass together: ${GREEN}`),
    `(3b) and not the file that ran green (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.blockedBy?.[GREEN] === "the adversary's file mutates it",
    `(3b) while the full map still carries every vetted file (got ${JSON.stringify(r.outcome?.blockedBy)})`,
  );
}

// ── (3c) no runner configured: ignored, and the gap is NAMED in the trace ──
{
  // `verify` THROWS for a missing `verify.test`; this step refuses to believe a
  // report instead. That asymmetry is defensible (silence is never a pass) but it
  // must not be SILENT: a project with no runner otherwise watches its builder
  // probe to the turn ceiling — #1984's shape — with no line saying why the valve
  // never opened. `traceWarn` writes to stderr, so the case captures that stream
  // rather than `console.log`, which the trace helpers never touch.
  const lines: string[] = [];
  const prior = process.stderr.write.bind(process.stderr);
  let r: Awaited<ReturnType<typeof runBuild>>;
  try {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    r = await runBuild({
      issue: 338,
      config: { ...configWithRunner(), verify: { fast: "true", test: "" } },
      toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
    });
  } finally {
    process.stderr.write = prior;
  }
  const captured = lines.join("");
  assert(
    r.outcome?.kind !== "blocked",
    `(3c) with no runner the report is not honoured (got ${r.outcome?.kind ?? r.threw?.message})`,
  );
  assert(
    captured.includes("no verify.test runner is configured"),
    `(3c) and the config gap is named on the trace (got ${JSON.stringify(captured)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
