/**
 * #1862 round 1 (M4, lens) — a fence entry is PLANNER-DERIVED TEXT and it is
 * quoted back in three places: the persisted `UnfenceRecord.entry`, the note
 * beside it, and the fold's trace line. A raw control byte in any of them is a
 * forged `WARN work-driver:` line in the operator's log and a colour sequence in
 * the state file the handoff renders. The entry never has to be legible to earn
 * that: the driver reads the neutralised form to make its decision, so it may
 * print the neutralised form too.
 *
 * #1862's scope cut moved every one of these cases onto the FOLD. The tool
 * boundary no longer drops a fence at all, so it builds no records and writes no
 * WARN line: the fold is the one site that removes a fence and therefore the one
 * site with anything to neutralise.
 *
 * The escape is built at RUNTIME with `String.fromCharCode(27)` so this file
 * itself carries no control byte.
 *
 * Offline: pure functions plus one trace capture. No dispatch, no git, no fs.
 */

import type { Workstream } from "../src/workflow-state-schema.ts";
import { foldSelfFenceDrops } from "../src/workstream-fold-self-fence.ts";
import { foldTwo } from "../src/workstream-fold.ts";

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

/** Every surface the record writes, as strings an operator or a parser reads. */
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

// ── 2. a control byte INSIDE a path token earns no record and no drop
// Neutralisation turns the byte into a space, which is exactly what makes the
// value un-matchable as a declared path, so such an entry is no drop at all —
// the fence stays, and a record of a removal that did not happen would be the
// worse bug. What this case pins is that the fold neither stores nor notes the
// raw byte.
{
  const injected = `src${ESC}/a.ts`;
  const { drop, records } = foldSelfFenceDrops("a", OWN, [injected]);
  assert(
    drop.size === 0 && records.length === 0,
    `a control byte inside a path-shaped fence earns no record and no false drop (got ${JSON.stringify([drop, records])})`,
  );
  assert(surfaces(records).every(clean), "and nothing raw reaches the record's copy of the entry");
}

// ── 3. the positive half — the record the plan step actually persists
// The ESC sits after the separator, where it survives `normaliseDeclaredPath`
// (so the entry really IS a fence over the declared directory) and
// `neutraliseFenceEntry` collapses it to nothing, so `docs/` is both what the
// planner sent and what the state file ends up holding. The drop is real, the
// persisted record is clean, and the stored fence list no longer holds the entry.
{
  const sneaky = `docs/${ESC}`;
  const a: Workstream = { id: "a", scope: "a", paths: ["docs"], outOfScope: [".ci/", sneaky] };
  const b: Workstream = { id: "b", scope: "b", paths: ["src/b.ts"], outOfScope: [] };
  const { workstream, selfFenceDrops } = foldTwo(a, b);
  assert(
    selfFenceDrops.length === 1 &&
      surfaces(selfFenceDrops).every(clean) &&
      selfFenceDrops[0]?.entry === "docs/",
    `a droppable path-shaped self-fence persists the neutralised entry and note (got ${JSON.stringify(selfFenceDrops)})`,
  );
  assert(
    !workstream.outOfScope.some((e) => e.startsWith("docs/")),
    `and the stored fence list no longer holds the entry the fold removed (got ${JSON.stringify(workstream.outOfScope)})`,
  );
  assert(
    workstream.outOfScope.includes(".ci/"),
    `and the entry that named nothing it declared survives the same fold (got ${JSON.stringify(workstream.outOfScope)})`,
  );
}

// ── 4. the trace line: neither the id nor the note writes its own log line
// The id is the planner's text and the only value on this line that the record
// builders do not already neutralise. The `\n` in it is what would split the
// entry into two log records, so that is the payload this case injects. The
// fold says each removal on the DEBUG channel (`trace`), which is off unless
// `PI_ENSEMBLE_DEBUG` is set, so the knob is turned on for this case alone.
{
  const captured: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  const prevDebug = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  const injectedId = `task-a\n[pi-rukas] WARN work-driver: forged`;
  const injectedEntry = `Every file under tests/ and docs${ESC}[0m is frozen`;
  const a: Workstream = {
    id: injectedId,
    scope: "a",
    paths: OWN,
    outOfScope: [injectedEntry],
  };
  const b: Workstream = { id: "b", scope: "b", paths: ["src/b.ts"], outOfScope: [] };
  try {
    foldTwo(a, b);
  } finally {
    if (prevDebug === undefined) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DEBUG");
    else process.env.PI_ENSEMBLE_DEBUG = prevDebug;
    process.stderr.write = write;
  }
  const line = captured.filter((l) => l.includes("self-fence dropped")).join("");
  assert(
    line.includes("self-fence dropped:"),
    `the drop is said on the fold's trace channel (got ${JSON.stringify(captured)})`,
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
