#!/usr/bin/env bun
/**
 * The durable facts a blocked report leaves for the repair round: the head the driver judged the red at, and
 * the one run of the runner it watched print it. Both are read off the step's own record, so this drives the
 * real `build` step over the real project runner (`lib/lean-build-fixture.ts`) and asks git and the record —
 * never a stubbed verdict. A round resets its seat to that head and its brief quotes only that output, so a
 * field missing here is a round built on a fact nobody ran.
 */

import { put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const CONFLICT = "the frozen assertion contradicts the problem statement";

/** The child's one `report_blocked` call, in the shape Pi records a tool call. */
function blocked(names: Array<{ path: string; reason: string }>): unknown[] {
  return [{ name: "report_blocked", arguments: { conflicts: names } }];
}

// ── (1c) the record carries what the repair round needs: the judged head, and the executed red ──
{
  // A repair round resets its seat to the commit the driver judged the red at, and its brief may quote ONLY
  // the output the driver itself watched the project's runner print. Both are therefore durable facts of the
  // blocked step, not things a later step re-derives — so this asks the real step, through the real runner,
  // for the bytes the round is built from. The log holds the decided round the fields were built for: that is
  // what earns them (see (1e) for the arm whose log holds no round at all).
  const r = await runBuild({
    issue: 3022,
    earned: true,
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(r.outcome?.kind === "blocked", `(1c) the step blocked (got ${r.outcome?.kind})`);
  assert(
    r.outcome?.headBefore === r.headBefore,
    `(1c) the record names the head the driver ran the files at (got ${r.outcome?.headBefore})`,
  );
  const rows = r.outcome?.blockedEvidence ?? [];
  assert(rows.length === 1, `(1c) one executed run is recorded (got ${String(rows.length)})`);
  assert(
    rows[0]?.path === "tests/AC1-retry.test.sh",
    `(1c) the evidence row names the file the driver watched fail (got ${rows[0]?.path})`,
  );
  assert(
    rows[0]?.cmd === "sh tests/AC1-retry.test.sh",
    `(1c) it names the command the driver rendered (got ${rows[0]?.cmd})`,
  );
  assert(
    (rows[0]?.output ?? "").includes("not ok - tests/AC1-retry.test.sh"),
    `(1c) and the runner's own words, not the child's (got ${JSON.stringify(rows[0]?.output)})`,
  );
  assert(
    !/not-implemented|export const/.test(rows[0]?.output ?? ""),
    "(1c) the quoted output holds none of the builder's source",
  );
}

// ── (1d) a report the driver could NOT prove records no head and no evidence ─
{
  // The field pair is only ever written by the honoured path. A refused report leaves the step no head to
  // reset to and no red to quote, which is what keeps a round from being bought on an unproven claim.
  const r = await runBuild({
    issue: 3023,
    // The child implemented the frozen test's own requirement, so the driver's re-run comes back green.
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(r.outcome?.kind !== "blocked", `(1d) a green named test proves nothing (got ${r.outcome?.kind})`);
  // The round's entry point is the proven map; without it there is nothing named to reset a seat to or to
  // quote a red about. (`headBefore` means the range an `ok` round changed, so it is not this arm's tell.)
  assert(r.outcome?.blockedBy === undefined, "(1d) no proven conflict is recorded");
  assert(r.outcome?.blockedEvidence === undefined, "(1d) no executed evidence is recorded");
}


// ── (1e) a run that earns no round records neither field ──
{
  // The only thing separating this arm from (1c) is whether the log holds a round: no reader, no fields. A
  // record that carried them anyway would be a build record widened on the arm a golden captured before the
  // round existed refutes — and a golden can only refute a field its own arm does not write. Key ORDER is part
  // of the claim: the whole record, in the order the step wrote it, is what an off arm reproduces byte for byte.
  const r = await runBuild({
    issue: 3024,
    toolUses: () => blocked([{ path: "tests/AC1-retry.test.sh", reason: CONFLICT }]),
  });
  assert(r.outcome?.kind === "blocked", `(1e) the step still blocked (got ${r.outcome?.kind})`);
  assert(
    r.outcome?.headBefore === undefined,
    `(1e) an unearned run records no head (${JSON.stringify(r.outcome?.headBefore)})`,
  );
  assert(r.outcome?.blockedEvidence === undefined, "(1e) and no executed red");
  assert(
    JSON.stringify(Object.keys(r.outcome ?? {})) === JSON.stringify(["kind", "reason", "blockedBy", "dispatches"]),
    `(1e) and the record's key order is the one the release wrote (${JSON.stringify(Object.keys(r.outcome ?? {}))})`,
  );
}

console.log(exit === 0 ? "\nlean blocked evidence: OK" : "\nFAILED");
process.exit(exit);
