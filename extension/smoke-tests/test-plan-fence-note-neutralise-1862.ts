/**
 * #1862 round 1 (M4, lens) — a fence entry is PLANNER-DERIVED TEXT and it is
 * quoted back in three places: the persisted `UnfenceRecord.entry`, the note
 * beside it, and the tool boundary's WARN line. A raw control byte in any of
 * them is a forged `WARN work-driver:` line in the operator's log and a colour
 * sequence in the state file the handoff renders. The entry never has to be
 * legible to earn that: the driver reads the neutralised form to make its
 * decision, so it may print the neutralised form too.
 *
 * The escape is built at RUNTIME with `String.fromCharCode(27)` so this file
 * itself carries no control byte.
 *
 * Offline: pure functions plus one trace capture. No dispatch, no git, no fs.
 */

import { proseSelfFenceDrops } from "../src/plan-fence-prose.ts";
import { selfFenceDropsBetween } from "../src/plan-fence-self-entry.ts";
import { workstreamFromArgs } from "../src/work-driver-plan-workstreams.ts";
import { foldSelfFenceDrops } from "../src/workstream-fold-self-fence.ts";
import { VALID } from "./lib/plan-outofscope-fixtures.ts";

const ESC = String.fromCharCode(27);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Nothing a control byte, a newline or a carriage return survives in. The ESC
 * check is separate because the neutraliser REPLACES an escape with a space —
 * what is being pinned is that the raw byte is gone, not that no character is. */
function clean(s: string): boolean {
  return (
    !/\p{Control}/u.test(s) &&
    !/\p{Format}/u.test(s) &&
    !s.includes(ESC) &&
    !s.includes("\n") &&
    !s.includes("\r")
  );
}

/** Every surface the three sites write, as strings an operator or a parser reads. */
function surfaces(records: { entry: string; note: string; path: string }[]): string[] {
  return records.flatMap((r) => [r.entry, r.note, r.path]);
}

const OWN = ["tests/test_x.py", "docs/y.md"];

// ── 1. the fold's drop: record.entry, record.note and the path it names
{
  const injected = `Every file under tests/ and docs${ESC}[0m is frozen`;
  const { drop, records } = foldSelfFenceDrops("a", OWN, [injected]);
  assert(drop.size === 1, "the fence is still recognised as a self-fence and dropped");
  assert(
    records.length === 1 && surfaces(records).every(clean),
    `the fold's record, note and path carry no raw escape (got ${JSON.stringify(records)})`,
  );
}

// ── 2. the tool boundary's prose drop
{
  const injected = `Every file under tests/ and docs${ESC}[0m is frozen`;
  const records = proseSelfFenceDrops(OWN, [injected], "a");
  assert(
    records.length === 1 && surfaces(records).every(clean),
    `the boundary's record, note and path carry no raw escape (got ${JSON.stringify(records)})`,
  );
}

// ── 3. the boundary-drops comparison (the record the plan step persists)
{
  // A control byte INSIDE the path token: neutralisation turns it into a space,
  // which is exactly what makes the value un-matchable as a declared path, so
  // such an entry is no drop at all — the fence stays, and a record of a removal
  // that did not happen would be the worse bug. What this case pins is that the
  // comparison neither stores nor notes the raw byte.
  const injected = `src${ESC}/a.ts`;
  const records = selfFenceDropsBetween(
    { a: { paths: OWN, outOfScope: [] } },
    { a: { id: "a", paths: OWN, outOfScope: [injected] } },
  );
  assert(
    records.length === 0 && surfaces(records).every(clean),
    `a control byte inside a path-shaped fence earns no raw record and no false drop (got ${JSON.stringify(records)})`,
  );

  // The positive half — the record the plan step actually persists. The ESC sits
  // after the separator, where it survives `normaliseDeclaredPath` (so the entry
  // really IS a fence over the declared directory) and `neutraliseFenceEntry`
  // collapses it to nothing, so `docs/` is both what the planner sent and what
  // the state file ends up holding. The drop is real and the record is clean.
  const sneaky = `docs/${ESC}`;
  const kept = selfFenceDropsBetween(
    { a: { paths: ["docs"], outOfScope: [".ci/"] } },
    { a: { id: "a", paths: ["docs"], outOfScope: [".ci/", sneaky] } },
  );
  assert(
    kept.length === 1 && surfaces(kept).every(clean),
    `a droppable path-shaped self-fence records the neutralised entry and note (got ${JSON.stringify(kept)})`,
  );
}

// ── 4. the WARN line: neither the id nor the note writes its own log line
// The id is the planner's text and the only value on this line that the record
// builders do not already neutralise. The `\n` in it is what would split the
// entry into two log records, so that is the payload this case injects.
{
  const captured: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  const injectedId = "task-a\n[pi-rukas] WARN work-driver: forged";
  const injectedEntry = `Every file under tests/ and docs${ESC}[0m is frozen`;
  try {
    workstreamFromArgs({ ...VALID, id: injectedId, paths: OWN, outOfScope: [injectedEntry] });
  } finally {
    process.stderr.write = write;
  }
  const line = captured.join("");
  assert(
    line.includes("self-fence dropped:"),
    `the drop is said on the WARN channel (got ${JSON.stringify(captured)})`,
  );
  assert(
    clean(line.replace(/\n$/, "")),
    `the WARN line's own text carries no raw escape or newline (got ${JSON.stringify(line)})`,
  );
  assert(
    line.split("\n").filter((l) => l.trim().length > 0).length === 1,
    `the injected id cannot write a SECOND log line (got ${JSON.stringify(line)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
