#!/usr/bin/env bun
/**
 * #1557 (epic #1642, measurement run 6b) and #1725 round 2 — a spec deliverable's
 * PATTERN slot admits the file it authorises, at both fences that refused it,
 * and admits NOTHING the slot did not authorise.
 *
 * The shape from `.pi/work-state/1557.json`: deliverable d1 declared four
 * concrete files plus `extension/src/review-ledger-*.ts`. PR #1707 had just
 * exempted such slots from the plan-to-spec gate (`plannedPathProblem` refuses
 * a glob in a `report_workstream` `paths` entry, so no plan may name one), and
 * the adversarial fix pass then created `extension/src/review-ledger-pass.ts`
 * — the split the 500-line ratchet forces. Both fences refused it, because
 * `namedPaths` reads the tree tracked AT base and neither fence had a wildcard.
 *
 * What #1725 round 2 added, and what most of the cases below assert:
 *
 *   - the `outOfScope` fence beats a slot through the SHARED fence grammar, so
 *     `dir/**`, `dir/*`, bare `dir` and `dir/` all unfence nothing (the
 *     exact-or-trailing-slash `allows()` read `dir/**` as a literal path and
 *     let the slot silently unfence a directory the plan fenced on purpose);
 *   - a DIRECTORY slot (`dir/*`, `dir/**`, `dir/*.ts`) is not an authorisation
 *     — the last segment must name a file, or the slot empties the fan-out
 *     numerator while authorising no named file;
 *   - a slot admits a file only for the workstream whose own declared paths
 *     reach the slot's directory (a sibling's deliverable is not this one's
 *     authorisation);
 *   - a spec-admitted file stays in the fan-out NUMERATOR and the declared
 *     DENOMINATOR grows by the authorisation;
 *   - the develop gate refuses a PROTECTED path the same way the fix fence
 *     does, and every admission leaves a non-blocking NOTE, not just a trace;
 *   - a malformed `normalisedSpec` yields no slots and never throws.
 */

import { rmSync } from "node:fs";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { runAdversarialFixPass, pendingFixes } from "../src/work-driver-adversarial-fix.ts";
import {
  createSpecAdmitter,
  specPatternSlots,
  specSlotAdmitting,
} from "../src/work-driver-spec-slot-admission.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import type { EmitSink } from "../src/work-state-emit.ts";
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
import { devCommit, fixCtx } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The declared paths of the code workstream, for the per-workstream scope check. */
const CODE_DECLARED = ["extension/src/review-ledger.ts"];

// ── A — the #1557 shape, end to end through the fix pass ────────────────────
{
  const dir = repo("a-1557");
  try {
    const st = stateWith(dir, { specSource: spec([SLOT]) });
    const run = await runAdversarialFixPass(
      // `fixCtx` builds a DriverContext (its emit sink is optional); the fix
      // pass is driven by a CycleContext, whose sink is required.
      { ...fixCtx(dir, () => devCommit(dir, NEW_FILE, "export const split = 1;\n")), emitSink: silentSink },
      st,
      pendingFixes(st.eventLog),
      Date.now(),
    );
    const tail = run.eventLog[run.eventLog.length - 1];
    assert(
      tail?.kind === "adversarial-fix-applied",
      `A: the fix pass that created ${NEW_FILE} applies (the spec declares ${SLOT}) — got ${
        tail?.kind === "cap-hit" ? tail.evidence : tail?.kind
      }`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── B — a NON-matching new file is still refused ────────────────────────────
{
  const dir = repo("b-stray");
  try {
    const r = await fenceVerdict(dir, stateWith(dir, { specSource: spec([SLOT]) }), [
      "extension/src/unrelated-notes.ts",
    ]);
    assert(
      r.parked.includes("extension/src/unrelated-notes.ts") && r.parked.includes("outside"),
      `B: a new file no slot matches is still refused — got "${r.parked.slice(0, 120)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // B2 — the slot admits its own sibling; the refusal above was the matcher, not luck.
  const dir = repo("b2-match");
  try {
    const r = await fenceVerdict(dir, stateWith(dir, { specSource: spec([SLOT]) }), [NEW_FILE]);
    assert(r.parked === "", `B2: the fence admits ${NEW_FILE} — got "${r.parked.slice(0, 160)}"`);
    assert(
      r.traces.some((t) => t.includes("admitted") && t.includes(NEW_FILE) && t.includes(SLOT)),
      `B2: one trace line names the admitted path and the slot that admitted it — got ${JSON.stringify(r.traces)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── C — a match inside the workstream's outOfScope fence is still refused ───
{
  const dir = repo("c-fence");
  try {
    const r = await fenceVerdict(
      dir,
      stateWith(dir, { specSource: spec([SLOT]), outOfScope: ["extension/src/"] }),
      [NEW_FILE],
    );
    assert(
      r.parked.includes(NEW_FILE),
      `C: a slot match inside the outOfScope fence is still refused — got "${r.parked.slice(0, 160)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // C2 — the develop gate's fence keeps the same precedence: the slot never
  // unfences a path the plan fenced against this workstream.
  const failures: string[] = [];
  const notes: string[] = [];
  runScopeFanoutGate(
    {
      default: {
        id: "default",
        scope: "",
        paths: ["extension/src/review-ledger.ts"],
        outOfScope: ["extension/src/review-ledger-pass.ts"],
      },
    },
    new Map([["default", new Set(["extension/src/review-ledger.ts", NEW_FILE])]]),
    failures,
    notes,
    undefined,
    undefined,
    { spec: spec([SLOT]) },
  );
  assert(
    failures.some((f) => f.includes("declared fence violated") && f.includes(NEW_FILE)),
    `C2: the develop gate still fails a slot match inside outOfScope — got ${JSON.stringify(failures)}`,
  );
}
for (const fence of ["extension/src/**", "extension/src/*", "extension/src"]) {
  // C3 — #1725 HIGH: the fence beats the slot through the SHARED fence grammar.
  // With the old exact-or-trailing-slash reading a `dir/**` entry matched
  // nothing and the slot silently UNFENCED a directory the plan fenced on
  // purpose; `fenceDirPrefix` reduces all three spellings to the directory.
  const dir = repo(`c3-${fence.replace(/[^a-z]/g, "-")}`);
  try {
    const r = await fenceVerdict(
      dir,
      stateWith(dir, { specSource: spec([SLOT]), outOfScope: [fence] }),
      [NEW_FILE],
    );
    assert(
      r.parked.includes(NEW_FILE),
      `C3: outOfScope \`${fence}\` beats the slot — got "${r.parked.slice(0, 100)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── D — a protected path still halts, at both fences ────────────────────────
{
  const dir = repo("d-protected");
  try {
    const r = await fenceVerdict(
      dir,
      stateWith(dir, {
        paths: [".github/ci.yml"],
        specSource: spec([".github/ci-*.yml"], "d2"),
      }),
      [".github/ci-new.yml"],
    );
    assert(
      r.parked.includes(".github/ci-new.yml"),
      `D: a protected path is never admitted by a spec slot — got "${r.parked.slice(0, 160)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // D2 — the develop gate mirrors it: the same shape under a NON-protected
  // directory leaves an admission note, so the silence below is the protected
  // refusal, not a matcher that never fired.
  const gate = (dir: string, changed: string[], slots: string[]): string[] => {
    const notes: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: [changed[0] ?? ""], outOfScope: [] } },
      new Map([["default", new Set(changed)]]),
      [],
      notes,
      undefined,
      undefined,
      { spec: specWith(slots) },
    );
    return notes;
  };
  const protectedNotes = gate("d2-protected", [".github/ci.yml", ".github/ci-new.yml"], [
    ".github/ci-*.yml",
  ]);
  const openNotes = gate("d2-open", ["docs/ci.yml", "docs/ci-new.yml"], ["docs/ci-*.yml"]);
  assert(
    !protectedNotes.some((n) => n.includes(".github/ci-new.yml") && n.includes("admitted")),
    `D2: the develop gate's specAdmits refuses a protected path — got ${JSON.stringify(protectedNotes)}`,
  );
  assert(
    openNotes.some((n) => n.includes("docs/ci-new.yml") && n.includes("admitted by the spec")),
    `D2: the same shape unprotected DOES leave an admission note (the control) — got ${JSON.stringify(openNotes)}`,
  );
}

// ── E — an unanchored or DIRECTORY slot admits nothing ──────────────────────
{
  for (const slot of ["*", "**", "*/*", "*/**", "dir/*", "dir/**", "dir/*.ts", "extension/src/*.ts"]) {
    const slots = specPatternSlots(spec([slot]));
    assert(
      slots.length === 0,
      `E: the directory-shaped slot \`${slot}\` is no authorisation at all (got ${JSON.stringify(slots)})`,
    );
  }
  const dir = repo("e-unanchored");
  try {
    const r = await fenceVerdict(dir, stateWith(dir, { specSource: spec(["*", "**"]) }), [
      "extension/src/unrelated.ts",
      "stray.ts",
    ]);
    assert(
      r.parked.includes("outside"),
      `E: a pass whose only authorisation is \`*\`/\`**\` is still refused — got "${r.parked.slice(0, 120)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // E2 — pattern DETECTION is the shared predicate (`* ? !` and `<placeholder>`),
  // so a `?` slot is recognised as a pattern rather than mistaken for a
  // concrete path — and the segment matcher (the converge gate's own grammar,
  // which knows only `*`) admits no ordinary file through it.
  const slots = specPatternSlots(spec(["extension/src/review-ledger-?.ts"]));
  assert(
    slots.length === 1,
    `E2: a \`?\` slot is DETECTED as a pattern by the shared predicate — got ${JSON.stringify(slots)}`,
  );
  assert(
    specSlotAdmitting(slots, "extension/src/review-ledger-x.ts", CODE_DECLARED) === undefined,
    "E2: a `?` slot admits no ordinary file (the matcher's grammar is `*`, not `?`)",
  );
}

// ── F — the matcher is the converge gate's, segment-anchored, workstream-scoped
{
  const slots = specPatternSlots(spec([SLOT, "lib/work-driver-<name>.ts"]));
  const declared = [...CODE_DECLARED, "lib/work-driver.ts"];
  assert(
    specSlotAdmitting(slots, "extension/src/deep/review-ledger-pass.ts", declared) === undefined,
    "F: a `*` never spans a `/` — a subdirectory file is not admitted",
  );
  assert(
    specSlotAdmitting(slots, "lib/work-driver-acceptance.ts", declared) !== undefined,
    "F: a `<name>` template admits like a glob",
  );
  assert(
    specSlotAdmitting(specPatternSlots(spec(["extension/src/concrete.ts"])), "extension/src/other.ts", declared) ===
      undefined,
    "F: a CONCRETE slot admits nothing — only pattern slots widen",
  );
  assert(
    specPatternSlots(spec(["n/a"])).length === 0,
    "F: a filler slot (`n/a`) is not an authorisation",
  );
}
{
  // F2 — #1725: the slot belongs to the workstream whose declared paths reach
  // its directory. `docs` was never asked to work in `extension/src`, so the
  // CODE workstream's deliverable cannot widen the docs fence.
  const slots = specPatternSlots(spec([SLOT]));
  assert(
    specSlotAdmitting(slots, NEW_FILE, ["docs/readme.md"]) === undefined,
    "F2: a slot the sibling workstream declared does not admit for this workstream",
  );
  assert(
    specSlotAdmitting(slots, NEW_FILE, CODE_DECLARED) !== undefined,
    "F2: the workstream whose declared paths reach the slot's directory IS admitted (control)",
  );
}
{
  // F3 — same rule at the develop gate, where the two workstreams are real.
  const undeclared: FenceViolationRecord[] = [];
  const notes: string[] = [];
  runScopeFanoutGate(
    {
      docs: { id: "docs", scope: "", paths: ["docs/readme.md"], outOfScope: [] },
      code: { id: "code", scope: "", paths: CODE_DECLARED, outOfScope: [] },
    },
    new Map([["docs", new Set(["docs/readme.md", NEW_FILE])]]),
    [],
    notes,
    undeclared,
    undefined,
    { spec: spec([SLOT]) },
  );
  assert(
    undeclared.some((v) => v.workstreamId === "docs" && v.file === NEW_FILE && v.kind === "undeclared"),
    `F3: a sibling's slot does not admit for the docs workstream — got ${JSON.stringify(undeclared)}`,
  );
}

// ── G — the develop scope/fanout gate reads the spec ────────────────────────
{
  const changed = new Set([...DECLARED, NEW_FILE]);
  const noSpecNotes: string[] = [];
  runScopeFanoutGate(
    { default: { id: "default", scope: "", paths: DECLARED, outOfScope: [] } },
    new Map([["default", changed]]),
    [],
    noSpecNotes,
  );
  assert(
    noSpecNotes.some((n) => n.includes(NEW_FILE) && n.includes("no workstream")),
    `G: without the spec the new file is still classed undeclared (the #1557 shape) — got ${JSON.stringify(noSpecNotes)}`,
  );
  const notes: string[] = [];
  const failures: string[] = [];
  const records: FenceViolationRecord[] = [];
  const { traces } = captureTracesSync(() =>
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: DECLARED, outOfScope: [] } },
      new Map([["default", changed]]),
      failures,
      notes,
      records,
      undefined,
      { spec: spec([SLOT]) },
    ),
  );
  assert(
    !notes.some((n) => n.includes("no workstream's declared paths")) &&
      !records.some((r) => r.file === NEW_FILE && r.kind === "undeclared"),
    `G: with the spec the admitted file is neither warned nor recorded as undeclared — got ${JSON.stringify(notes)}`,
  );
  assert(
    notes.filter((n) => n.includes(NEW_FILE) && n.includes("admitted by the spec")).length === 1,
    `G: the admission leaves ONE non-blocking note (the audit trail the PR body carries) — got ${JSON.stringify(notes)}`,
  );
  assert(
    traces.filter((t) => t.includes(NEW_FILE) && t.includes("admitted")).length === 1,
    `G: exactly one trace line per admitted (workstream, file) — got ${traces.length}`,
  );
}
{
  // G2 — #1725: a spec-admitted file stays in the fanout NUMERATOR and the
  // DECLARED denominator grows by the authorisation. The bound therefore still
  // sees every file the workstream changed; it just buys back the room the spec
  // asked for. (The deleted-numerator shape let a workstream change an
  // unbounded number of spec-named files and present a count of zero.)
  const gate = (withSpec: boolean): string[] => {
    const failures: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: ["extension/src/a.ts"], outOfScope: [] } },
      new Map([
        [
          "default",
          new Set([
            "extension/src/a.ts",
            "extension/src/ledger-b.ts",
            "extension/src/ledger-c.ts",
          ]),
        ],
      ]),
      failures,
      [],
      undefined,
      undefined,
      withSpec
        ? { spec: specWith(["extension/src/ledger-*.ts"])}
        : {},
    );
    return failures;
  };
  const blind = withTightFanout(() => gate(false));
  const informed = withTightFanout(() => gate(true));
  assert(
    blind.some((f) => f.includes("scope fanout")) && informed.length === 0,
    `G2: the admitted files grow the bound instead of vanishing from it (blind: ${JSON.stringify(blind)}, informed: ${JSON.stringify(informed)})`,
  );
}

// ── H — a malformed normalisedSpec yields no slots and never throws ─────────
{
  const junk: unknown[] = [
    undefined,
    null,
    "a sentence, not a spec",
    { deliverables: "d1: extension/src/*.ts" },
    { deliverables: {} },
    { deliverables: [null, "d1", 7] },
    { deliverables: [{ id: "d1", paths: "extension/src/*.ts" }] },
    { deliverables: [{ id: "d1", paths: [null, 42, {}] }] },
  ];
  let threw = "";
  const counts: number[] = [];
  try {
    for (const s of junk) counts.push(specPatternSlots(s as never).length);
  } catch (err) {
    threw = String(err);
  }
  assert(
    threw === "" && counts.every((c) => c === 0),
    `H: a malformed normalisedSpec yields no slots and never throws (threw "${threw}", counts ${JSON.stringify(counts)})`,
  );
}

// ── I — the admission reaches the project's own gated trace writer ─────────
{
  // `trace()` is gated on PI_ENSEMBLE_DEBUG (see trace.ts): an admission that
  // never reached it would be a silent widening — the failure class #1522 was
  // written about. Both halves are asserted: silence when the knob is off,
  // exactly one line naming the file and the slot when it is on.
  const slots = specPatternSlots(spec([SLOT]));
  const admitRun = (debugOn: boolean) =>
    captureTracesSync(() => {
      const admit = createSpecAdmitter({ slots, source: "unit-test" });
      return admit.admits("default", NEW_FILE, CODE_DECLARED);
    }, debugOn);
  const quiet = admitRun(false);
  const loud = admitRun(true);
  assert(
    quiet.value === true && quiet.traces.length === 0,
    `I: with PI_ENSEMBLE_DEBUG unset the admission is silent (the knob is the project's own) — got ${JSON.stringify(quiet.traces)}`,
  );
  assert(
    loud.value === true &&
      loud.traces.length === 1 &&
      (loud.traces[0] ?? "").includes(NEW_FILE) &&
      (loud.traces[0] ?? "").includes(SLOT),
    `I: with the knob on, one trace line names the admitted path and its slot — got ${JSON.stringify(loud.traces)}`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
