#!/usr/bin/env bun
/**
 * #1725 round 3 — ONE fence predicate for both gates, and an authorisation is
 * a budget, not a skeleton key.
 *
 * The review's two HIGHs, each pinned by a table the whole gate pair must
 * satisfy:
 *
 *   1. ONE fence predicate. The fix fence's `fencedBy` and the develop gate's
 *      `outOfScope` blocking check read the same entry through two grammars
 *      (`fenceDirPrefix` + a `/` boundary versus a normalise-then-compare), so
 *      `dir/** (note)` or a real glob entry refused one fence and passed the
 *      other. Both now call `fenceMatches`, and `createSpecAdmitter` takes the
 *      fence as INPUT so it refuses a fenced file itself. The table drives
 *      EVERY fence spelling — bare dir, trailing slash, `dir/*`, `dir/**`,
 *      backticked markup, annotation, a real glob and an exact file — through
 *      BOTH fences and asserts the two decisions are identical, row by row.
 *
 *   2. A per-slot bound. The fan-out denominator grew with the number of
 *      admitted FILES, so one slot multiplied into an unbounded bound. It now
 *      grows per distinct ADMITTING SLOT (`SPEC_SLOT_MAX_FILES` files each);
 *      the fourth file under one slot is refused with kind `slot-full` and is
 *      undeclared exactly as before admission existed. The failure text
 *      reports the denominator ACTUALLY used.
 *
 * Also pinned: the discriminated refusal kind (`fenced` | `protected` |
 * `no-slot` | `slot-full`) in the fix-pass park reason, and the admission
 * note's sanitisation of untrusted spec prose (control characters stripped,
 * 120-char cap, the validated glob interpolated).
 */

import { rmSync } from "node:fs";
import { fenceMatches } from "../src/work-driver-declared-path.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import {
  admissionNote,
  createSpecAdmitter,
  sanitizeSlotText,
  SPEC_SLOT_MAX_FILES,
  specPatternSlots,
  type SpecPatternSlot,
} from "../src/work-driver-spec-slot-admission.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import {
  DECLARED,
  NEW_FILE,
  SLOT,
  captureTracesSync,
  fenceVerdict,
  repo,
  spec,
  specWith,
  stateWith,
  withTightFanout,
} from "./lib/spec-slot-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO_DIRS: string[] = [];
function repoDir(label: string): string {
  const dir = repo(label);
  REPO_DIRS.push(dir);
  return dir;
}

// ── A — the ONE fence predicate, as a unit table ─────────────────────────────
{
  const dir = "extension/src";
  const file = "extension/src/review-ledger-pass.ts";
  const rows: Array<[string, string, boolean]> = [
    [dir, file, true],
    [`${dir}/`, file, true],
    [`${dir}/*`, file, true],
    [`${dir}/**`, file, true],
    ["`extension/src/**`", file, true],
    ["extension/src/** (note)", file, true],
    ["**extension/src/**", file, true],
    ["./extension/src/**", file, true],
    // A real glob entry (a pathspec char survives the directory reading) goes
    // through the converge gate's OWN segment-anchored matcher.
    ["extension/src/review-*.ts", file, true],
    [file, file, true],
    // A `*` never spans a `/`, and a sibling named like the directory does not
    // fall inside it.
    ["extension/src/review-ledger-*.ts", "extension/src/deep/review-ledger-x.ts", false],
    ["extension/src", "extension/srcfoo/bar.ts", false],
    ["extension/src/review-ledger.ts", "extension/src/review-ledger-pass.ts", false],
    // An entry that normalises to nothing covers nothing — fail-closed, never
    // a whole-tree fence.
    ["", file, false],
    ["   ", file, false],
    ["*", file, false],
  ];
  let bad = "";
  for (const [entry, target, want] of rows) {
    const got = fenceMatches(entry, target);
    if (got !== want) bad += ` [${JSON.stringify(entry)} vs ${target}: ${got} ≠ ${want}]`;
  }
  assert(bad === "", `A: the ONE fence predicate answers every spelling as specified${bad}`);
}

// ── B — the table-driven PARITY case: both fences, same answer, per spelling ─
{
  // Same fence spellings, same workstream, same slot, same file — driven
  // through the fix fence (`fenceVerdict`) AND the develop gate
  // (`runScopeFanoutGate`). Row `fenced` is what ONE predicate must say; the
  // case is only green when BOTH gates agree with each other row by row —
  // two answers from one entry is exactly the drift this round closes.
  const rows: Array<{ entry: string; fenced: boolean }> = [
    { entry: "extension/src", fenced: true },
    { entry: "extension/src/", fenced: true },
    { entry: "extension/src/*", fenced: true },
    { entry: "extension/src/**", fenced: true },
    { entry: "`extension/src/**`", fenced: true },
    { entry: "extension/src/** (note)", fenced: true },
    { entry: "extension/src/review-*.ts", fenced: true },
    { entry: NEW_FILE, fenced: true },
    { entry: "docs", fenced: false },
  ];
  const specSource = spec([SLOT]);
  let drift = "";
  for (const row of rows) {
    // The fix fence: create the slot-matching file; a fenced file must park.
    const dir = repoDir(`parity-fix-${row.entry.replace(/\W+/g, "_")}`);
    const st = stateWith(dir, { outOfScope: [row.entry], specSource });
    const { parked } = await fenceVerdict(dir, st, [NEW_FILE]);
    const fixRefused = parked.includes(NEW_FILE);
    // The develop gate: same entry as the workstream's outOfScope fence, same
    // spec, the file changed undeclared. A fenced file must fail the gate.
    const failures: string[] = [];
    const notes: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: DECLARED, outOfScope: [row.entry] } },
      new Map([["default", new Set([...DECLARED, NEW_FILE])]]),
      failures,
      notes,
      undefined,
      undefined,
      { spec: specSource },
    );
    const gateRefused = failures.some(
      (f) => f.includes("declared fence violated") && f.includes(NEW_FILE),
    );
    if (fixRefused !== row.fenced)
      drift += ` [fix fence "${row.entry}": ${fixRefused} ≠ ${row.fenced}]`;
    if (gateRefused !== row.fenced)
      drift += ` [develop gate "${row.entry}": ${gateRefused} ≠ ${row.fenced}]`;
    if (fixRefused !== gateRefused)
      drift += ` [${row.entry}: the two fences DISAGREE (${fixRefused} vs ${gateRefused})]`;
    // The unfenced control must actually be ADMITTED, not merely un-refused —
    // a gate that quietly dropped the file would satisfy a boolean.
    if (!row.fenced && !notes.some((n) => n.includes(NEW_FILE) && n.includes("admitted by the spec")))
      drift += ` [develop gate "${row.entry}": unfenced but not admitted — ${JSON.stringify(notes)}]`;
    if (!row.fenced) {
      const dir2 = repoDir(`parity-admit-${row.entry.replace(/\W+/g, "_")}`);
      const st2 = stateWith(dir2, { outOfScope: [row.entry], specSource });
      const second = await fenceVerdict(dir2, st2, [NEW_FILE]);
      if (second.parked !== "")
        drift += ` [fix fence "${row.entry}": unfenced but parked — ${second.parked.slice(0, 80)}]`;
    }
  }
  assert(drift === "", `B: both fences answer every fence spelling identically${drift}`);
}

// ── C — the per-slot file cap: one slot is a bounded authorisation ──────────
{
  const slots = specPatternSlots(specWith([SLOT], "d1"));
  assert(slots.length === 1, `C: the fixture slot is detected — got ${JSON.stringify(slots)}`);
  const files = ["a", "b", "c", "d", "e"].map((x) => `extension/src/review-ledger-${x}.ts`);
  const admitted: string[] = [];
  const admit = createSpecAdmitter({
    slots,
    source: "unit-cap",
    onAdmit: (_id, file) => admitted.push(file),
  });
  const decisions = files.map((f) => admit.admit("ws", f, DECLARED));
  assert(
    decisions.filter((d) => d.admitted).length === SPEC_SLOT_MAX_FILES &&
      admitted.length === SPEC_SLOT_MAX_FILES,
    `C: one slot admits exactly SPEC_SLOT_MAX_FILES (${SPEC_SLOT_MAX_FILES}) files, no more — got ${admitted.length}`,
  );
  assert(
    !decisions[3]?.admitted &&
      !decisions[3]?.admitted === true &&
      !decisions[4]?.admitted &&
      !decisions[3]?.admitted &&
      (decisions[3] as { refused?: string }).refused === "slot-full" &&
      (decisions[4] as { refused?: string }).refused === "slot-full",
    `C: the fourth and fifth files are refused with kind slot-full — got ${JSON.stringify(decisions[3])}, ${JSON.stringify(decisions[4])}`,
  );
  assert(
    admitted.length === 3 && !admitted.includes(files[3] ?? ""),
    "C: the refused files are not in the admitted set (an authorisation cannot leak past its cap)",
  );
  // The denominator grows per ADMITTING SLOT, never per file.
  assert(
    admit.admittedSlotCount("ws") === 1 && admit.admittedFiles("ws").length === 3,
    `C: the bound grows by ONE admitting slot for three files — got ${admit.admittedSlotCount("ws")} slots / ${admit.admittedFiles("ws").length} files`,
  );
  // A second slot is a second, separate budget.
  const two = createSpecAdmitter({
    slots: [...slots, ...specPatternSlots(specWith(["extension/src/other-*.ts"], "d2"))],
    source: "unit-cap-2",
  });
  for (const f of files) two.admit("ws", f, DECLARED);
  const other = two.admit("ws", "extension/src/other-x.ts", DECLARED);
  assert(
    other.admitted && two.admittedSlotCount("ws") === 2,
    `C: a second matching slot is a second authorisation (two admitting slots) — got ${two.admittedSlotCount("ws")}`,
  );
  // Memoised: a repeated question never double-charges the budget.
  const memo = createSpecAdmitter({ slots, source: "unit-memo" });
  const first = memo.admit("ws", files[0] ?? "", DECLARED);
  const again = memo.admit("ws", files[0] ?? "", DECLARED);
  assert(
    first.admitted &&
      again.admitted &&
      memo.admittedFiles("ws").length === 1 &&
      memo.admittedSlotCount("ws") === 1,
    "C: the same (workstream, file) pair is decided once — a repeat cannot spend budget twice",
  );
  // The cap is per workstream: the same slot budgets a sibling separately.
  const shared = createSpecAdmitter({ slots, source: "unit-shared" });
  for (const f of files) shared.admit("a", f, DECLARED);
  const bSide = shared.admit("b", files[0] ?? "", DECLARED);
  assert(
    bSide.admitted,
    "C: one workstream cannot exhaust another's slot budget (the cap is per workstream)",
  );
}

// ── D — refusal kinds, at the admitter and in the fix pass park reason ──────
{
  const slots = specPatternSlots(specWith([SLOT], "d1"));
  const kinds = createSpecAdmitter({
    slots,
    source: "unit-kinds",
    isFenced: (_id, file) => file === "extension/src/review-ledger-fenced.ts",
  });
  const fenced = kinds.admit("ws", "extension/src/review-ledger-fenced.ts", DECLARED);
  assert(
    !fenced.admitted && fenced.refused === "fenced",
    `D: the fence is judged FIRST — the admitter itself refuses a fenced file — got ${JSON.stringify(fenced)}`,
  );
  const prot = kinds.admit("ws", ".github/ci-new.yml", [".github/ci.yml"]);
  assert(
    !prot.admitted && prot.refused === "protected",
    `D: a protected path is refused with kind protected (the protected gate owns that halt) — got ${JSON.stringify(prot)}`,
  );
  const none = kinds.admit("ws", "docs/nothing.ts", DECLARED);
  assert(
    !none.admitted && none.refused === "no-slot",
    `D: no matching slot is refused with kind no-slot — got ${JSON.stringify(none)}`,
  );

  // The fix pass surfaces the kind in the PARK REASON: an operator reading the
  // handoff must be able to answer "why is this file outside?" without
  // re-deriving it. Here the fourth file under one slot parks on slot-full.
  const dir = repoDir("kinds-slot-full");
  const st = stateWith(dir, { specSource: specWith([SLOT], "d1") });
  const four = ["a", "b", "c", "d"].map((x) => `extension/src/review-ledger-${x}.ts`);
  const { parked } = await fenceVerdict(dir, st, four);
  assert(
    parked.includes(four[3] ?? "") && parked.includes(String(SPEC_SLOT_MAX_FILES)),
    `D: the fix pass parks the fourth file by name, naming the slot budget — got ${parked.slice(0, 160)}`,
  );
  assert(
    parked.includes("bounded authorisation") || parked.includes("skeleton key"),
    `D: the park reason says WHY (a bounded authorisation), not merely "outside" — got ${parked.slice(0, 200)}`,
  );
  // A fenced stray names the fence as the refusal, not "no finding names it".
  const dir2 = repoDir("kinds-fenced");
  const st2 = stateWith(dir2, { outOfScope: ["extension/src"], specSource: specWith([SLOT], "d1") });
  const fencedPark = await fenceVerdict(dir2, st2, [NEW_FILE]);
  assert(
    fencedPark.parked.includes(NEW_FILE) && fencedPark.parked.includes("outOfScope fence"),
    `D: a fenced stray names the fence as its refusal kind — got ${fencedPark.parked.slice(0, 160)}`,
  );
  // A no-slot stray names that too.
  const dir3 = repoDir("kinds-noslot");
  const st3 = stateWith(dir3, { specSource: specWith([SLOT], "d1") });
  const noSlotPark = await fenceVerdict(dir3, st3, ["docs/stray.md"]);
  assert(
    noSlotPark.parked.includes("docs/stray.md") && noSlotPark.parked.includes("no spec pattern slot"),
    `D: a stray with no matching slot names kind no-slot in the park reason — got ${noSlotPark.parked.slice(0, 160)}`,
  );
}

// ── E — one slot plus N files cannot defeat a tight bound ───────────────────
{
  // The HIGH the review measured: the denominator grew per admitted FILE, so
  // one slot and ten files bought ten units of bound. Under the tightest
  // tunables (factor 1, floor 1) one declared path plus ONE admitting slot
  // must bound the whole changed set — the refused files count toward the
  // numerator like any other undeclared change, and the failure text reports
  // the denominator ACTUALLY used.
  const base = "extension/src/base.ts";
  const slot = "extension/src/ledger-*.ts";
  const many = ["a", "b", "c", "d", "e"].map((x) => `extension/src/ledger-${x}.ts`);
  const failures: string[] = [];
  const notes: string[] = [];
  const records: FenceViolationRecord[] = [];
  withTightFanout(() =>
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: [base], outOfScope: [] } },
      new Map([["default", new Set([base, ...many])]]),
      failures,
      notes,
      records,
      undefined,
      { spec: specWith([slot], "d1") },
    ),
  );
  const fanout = failures.find((f) => f.startsWith("scope fanout:"));
  assert(
    failures.length > 0 && !!fanout,
    `E: one slot plus five files still breaks a tight bound — got ${JSON.stringify(failures)}`,
  );
  assert(
    !!fanout &&
      fanout.includes("admitting spec slots 1") &&
      fanout.includes("declared paths 1") &&
      !fanout.includes("admitting spec slots 3"),
    `E: the failure reports the denominator ACTUALLY used — 1 path + 1 slot, never the file count — got ${fanout ?? "none"}`,
  );
  assert(
    notes.filter((n) => n.includes("admitted by the spec")).length === SPEC_SLOT_MAX_FILES,
    `E: exactly the capped three files are disclosed as admitted — got ${notes.filter((n) => n.includes("admitted by the spec")).length}`,
  );
  assert(
    records.filter((r) => r.kind === "undeclared").length === many.length - SPEC_SLOT_MAX_FILES,
    `E: the refused files are UNDECLARED records, exactly as before admission existed — got ${records.filter((r) => r.kind === "undeclared").length}`,
  );
}

// ── F — the admission note sanitises untrusted spec prose ───────────────────
{
  const slot: SpecPatternSlot = {
    deliverableId: `d\u0000x\u001b[31m${"y".repeat(200)}`,
    slot: "extension/src/review-<name>-*.ts",
    glob: "extension/src/review-ledger-*.ts",
  };
  const note = admissionNote("ws", "extension/src/review-ledger-pass.ts", slot);
  assert(
    !note.includes("\u0000") && !note.includes("\u001b"),
    `F: an ESC/NULL sequence in the deliverable id never reaches the note — got ${JSON.stringify(note.slice(0, 120))}`,
  );
  const idShown = note.slice(note.indexOf("deliverable") + "deliverable".length).trimStart();
  assert(
    !idShown.includes("y".repeat(121)),
    "F: the deliverable id is capped at 120 chars in the note (no paragraph smuggling)",
  );
  assert(
    note.includes("extension/src/review-ledger-*.ts") &&
      !note.includes("<name>"),
    "F: the note interpolates the VALIDATED glob, never the raw template slot — got the glob",
  );
  // The unit predicate: control chars out, cap with a visible marker.
  assert(
    sanitizeSlotText("a\u0001b\u007fc") === "abc" &&
      sanitizeSlotText("z".repeat(150)).length === 120 &&
      sanitizeSlotText("short") === "short",
    "F: sanitizeSlotText strips control characters and caps at 120 with a marker",
  );
  // The trace line carries the same sanitisation (it reaches a terminal).
  // The spec-built slot cannot itself carry control chars (`specPatternSlots`
  // normalises), so the poisoned rendering is pinned through the same
  // `sanitizeSlotText` the trace calls — and a real admission's trace is
  // asserted to stay silent-but-clean, and short.
  const slots = specPatternSlots(specWith([SLOT], "d1"));
  const { traces } = captureTracesSync(() => {
    const admit = createSpecAdmitter({ slots, source: "unit-sanitise" });
    return admit.admit("ws", NEW_FILE, DECLARED);
  });
  assert(
    traces.length === 1 &&
      !traces[0]?.includes("\u0000") &&
      !traces[0]?.includes("\u001b") &&
      traces[0]!.includes(SLOT),
    `F: the trace line stays clean and names the validated glob — got ${JSON.stringify(traces[0]?.slice(0, 120))}`,
  );
  const poisoned = createSpecAdmitter({ slots: [slot], source: "unit-poisoned" });
  const poisonedRun = captureTracesSync(() =>
    poisoned.admit("ws", "extension/src/review-ledger-pass.ts", DECLARED),
  );
  assert(
    poisonedRun.traces.length === 1 &&
      !poisonedRun.traces[0]?.includes("\u0000") &&
      !poisonedRun.traces[0]?.includes("\u001b") &&
      !poisonedRun.traces[0]?.includes("y".repeat(121)),
    `F: a hand-edited state file's control chars never reach the trace — got ${JSON.stringify(poisonedRun.traces[0]?.slice(0, 120))}`,
  );
}

for (const dir of REPO_DIRS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

process.exit(exit);
