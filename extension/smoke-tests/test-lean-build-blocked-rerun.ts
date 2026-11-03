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
 *   (3b)  the cause sentence names the file the DRIVER saw fail
 *   (3c)  no runner configured: the report is ignored, and the gap is NAMED
 *
 * The report is the child's word; these are the cases that make it the driver's.
 */

import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";

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
