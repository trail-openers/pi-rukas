#!/usr/bin/env bun
/**
 * #814 — develop-scope-fence attribution + sibling-declared blocking.
 *
 * The policy (PM comment on the issue, authoritative):
 *
 *   FENCE HITS (the workstream's own `outOfScope` fence, non-self,
 *   non-dependsOn-exempt) ALWAYS BLOCK — same as before #814 — and are
 *   attributed: SIBLING-DECLARED (the file is in ANOTHER workstream's
 *   `paths`; `declaredById` names the sibling) or ISSUE-FENCED (fenced but
 *   declared by no sibling — an issue-level exclusion; every N=1 fence hit
 *   is this). Both flip the workstream's branches-converged verdict to
 *   ok:false with a reason.
 *   UNDECLARED — computed from the changed set: a touched file in NO
 *   workstream's `paths` AND not in its own `outOfScope` (and not
 *   self/dependsOn-exempt): WARNS (a note + a structured record), never a
 *   failure.
 *   SELF-FENCE — unchanged (#784 demotion to a note, no record).
 *   dependsOn exemption — unchanged (#725 carve-out).
 *
 * The fence-violation string in `failures` now carries the workstream id,
 * the declaring sibling (for sibling-declared hits), and the kind. The
 * structured record lands on `verifyEvidence.fenceViolations` (additive
 * schema field, absent = none).
 *
 * The #792 fixture is reconstructed inline from the verbatim violation
 * strings quoted in the issue body (the state files are deleted).
 */

import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { applyFenceVerdicts } from "../src/work-develop-fence-verdicts.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type WS = {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
  dependsOn?: string[];
};

function run(
  workstreams: Record<string, WS>,
  changed: Record<string, string[]>,
): { failures: string[]; notes: string[]; records: FenceViolationRecord[] } {
  const failures: string[] = [];
  const notes: string[] = [];
  const records: FenceViolationRecord[] = [];
  runScopeFanoutGate(
    workstreams,
    new Map(Object.entries(changed).map(([k, v]) => [k, new Set(v)] as [string, Set<string>])),
    failures,
    notes,
    records,
  );
  return { failures, notes, records };
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — SIBLING-DECLARED: blocking + attribution
//
// Two workstreams, disjoint declared paths. B touches a file A declared.
// The failure string names B's id, the file, and A as the declaring sibling.
// The structured record is kind: "sibling-declared" with declaredById: "a".
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: WS = { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] };
  const { failures, records } = run({ a, b }, { b: ["src/a.ts"] });

  const fenceFail = failures.find((f) => f.includes("sibling-declared"));
  assert(
    !!fenceFail,
    `sibling-declared: a failure string is produced (got: ${failures.join("; ")})`,
  );
  assert(
    !!fenceFail && fenceFail.includes("b") && fenceFail.includes("src/a.ts") && fenceFail.includes("a"),
    `sibling-declared: the failure names the violating workstream (b), the file (src/a.ts), and the declaring sibling (a) (got: ${fenceFail})`,
  );
  assert(
    !!fenceFail && !fenceFail.includes("incoherent"),
    `sibling-declared: the failure does NOT say "incoherent" (got: ${fenceFail})`,
  );
  // Structured record
  assert(
    records.length === 1 && records[0].kind === "sibling-declared" &&
      records[0].workstreamId === "b" && records[0].file === "src/a.ts" &&
      records[0].declaredById === "a",
    `sibling-declared: structured record is correct (got: ${JSON.stringify(records)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — ISSUE-FENCED (BLOCKS) vs UNDECLARED (warns)
// A fence hit whose file no sibling declared is `issue-fenced` and BLOCKS
// (as before #814). An UNDECLARED hit is computed from the CHANGED SET —
// a touched file in no workstream's `paths` AND not in its own `outOfScope`
// — and WARNS (a note + a record, never a failure).
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: WS = { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/c.ts"] };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: [] };
  // a touches src/c.ts (fenced, declared by no sibling → issue-fenced → BLOCKS)
  // and src/rogue.ts (not fenced, declared by nobody → undeclared → WARNS). The
  // two are computed from different inputs: the fence hit from the fence, the
  // undeclared record from the changed set.
  const { failures, notes, records } = run({ a, b }, { a: ["src/c.ts", "src/rogue.ts"] });
  const fenceFail = failures.find((f) => f.includes("src/c.ts"));
  assert(
    !!fenceFail && fenceFail.includes("issue-fenced"),
    `issue-fenced: the fence hit BLOCKS with kind issue-fenced (got: ${failures.join("; ")})`,
  );
  const fenceRec = records.find((r) => r.file === "src/c.ts");
  assert(
    !!fenceRec && fenceRec.kind === "issue-fenced" &&
      fenceRec.workstreamId === "a" && fenceRec.declaredById === undefined,
    `issue-fenced: structured record (got: ${JSON.stringify(records)})`,
  );
  const undecl = records.find((r) => r.file === "src/rogue.ts");
  assert(
    !!undecl && undecl.kind === "undeclared" && undecl.declaredById === undefined,
    `undeclared: structured record kind=undeclared with no declaredById (got: ${JSON.stringify(records)})`,
  );
  assert(
    !failures.some((f) => f.includes("src/rogue.ts")),
    `undeclared: NO failure string (got: ${failures.join("; ")})`,
  );
  assert(
    notes.some((n) => n.includes("src/rogue.ts") && n.includes("undeclared")),
    `undeclared: a warning note is produced (got: ${notes.join("; ")})`,
  );
  assert(
    !records.some((r) => r.file === "src/c.ts" && r.kind === "undeclared"),
    `fence hits are not double-recorded as undeclared (got: ${JSON.stringify(records)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 3 — SELF-FENCE: note, no record
// A's fence includes a file A itself declared. Demoted to note; no record.
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: WS = { id: "a", scope: "x", paths: ["src/a.ts", "src/integrate.ts"], outOfScope: ["src/integrate.ts"] };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: [] };
  const { failures, notes, records } = run({ a, b }, { a: ["src/integrate.ts"] });
  assert(failures.length === 0, `self-fence: NO failure (got: ${failures.join("; ")})`);
  assert(notes.some((n) => n.includes("self-fence")), `self-fence: demotion note present (got: ${notes.join("; ")})`);
  assert(records.length === 0, `self-fence: NO structured record (got: ${JSON.stringify(records)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 4 — dependsOn exemption: no violation
// B dependsOn A. B's fence includes a file A declared. Exempt.
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: WS = { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: [] };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"], dependsOn: ["a"] };
  const { failures, records } = run({ a, b }, { b: ["src/a.ts"] });
  assert(failures.length === 0, `dependsOn exemption: NO failure (got: ${failures.join("; ")})`);
  assert(records.length === 0, `dependsOn exemption: NO structured record (got: ${JSON.stringify(records)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 5 — N=1 fence hit → issue-fenced, BLOCKS
//
// A single workstream with a fence hit: no sibling can declare the file, so
// the hit is attributed `issue-fenced` (an issue-level exclusion) — and it
// still BLOCKS, exactly as before #814. No sibling-declared misfire.
// ─────────────────────────────────────────────────────────────────────────────
{
  const solo: WS = { id: "default", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] };
  const { failures, records } = run({ default: solo }, { default: ["src/b.ts"] });
  assert(
    failures.some((f) => f.includes("src/b.ts") && f.includes("issue-fenced")),
    `N=1: the fence hit BLOCKS with kind issue-fenced (got: ${failures.join("; ")})`,
  );
  assert(
    records.some((r) => r.kind === "issue-fenced" && r.file === "src/b.ts"),
    `N=1: the fence hit is recorded as issue-fenced (got: ${JSON.stringify(records)})`,
  );
  assert(
    !records.some((r) => r.kind === "sibling-declared"),
    `N=1: no sibling-declared misfire (got: ${JSON.stringify(records)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 6 — Annotated paths "(new)": no false violation
// A's fence lists "src/b.ts (new)"; B's paths include "src/b.ts (new)".
// A touches src/b.ts. Normalisation strips both annotations; the hit is
// sibling-declared (B declared it). No false violation from the annotation.
// ─────────────────────────────────────────────────────────────────────────────
{
  const a: WS = {
    id: "a",
    scope: "x",
    paths: ["src/a.ts (new)"],
    outOfScope: ["src/b.ts (new)"],
  };
  const b: WS = { id: "b", scope: "y", paths: ["src/b.ts (new)"], outOfScope: [] };
  const { failures, records } = run({ a, b }, { a: ["src/b.ts"] });

  const fenceFail = failures.find((f) => f.includes("sibling-declared"));
  assert(
    !!fenceFail && fenceFail.includes("src/b.ts"),
    `annotated paths: sibling-declared hit fires on the normalised path (got: ${failures.join("; ")})`,
  );
  assert(
    records.length === 1 && records[0].file === "src/b.ts" && records[0].kind === "sibling-declared",
    `annotated paths: record uses the normalised file path (got: ${JSON.stringify(records)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 7 — #792 fixture: 5 workstreams, disjoint paths, 4 verbatim violations
// Reconstructed from the issue body. Path aliases (each under extension/src/):
// S=workflow-state-schema.ts, SC=workflow-state-schema-converge.ts,
// C=work-driver-converge.ts, T=work-develop-topological.ts,
// F=work-driver-scope-fanout.ts. Five workstreams, fully disjoint declared
// paths, cross-declared outOfScope fences (#572). The four violations
// (verbatim from the issue): task-d touched SC (declared by task-c), C
// (task-b), S (task-a); task-c touched C (task-b). Each is attributed and
// the explaining text does NOT say "incoherent".
// ─────────────────────────────────────────────────────────────────────────────
{
  const S = "extension/src/workflow-state-schema.ts";
  const SC = "extension/src/workflow-state-schema-converge.ts";
  const C = "extension/src/work-driver-converge.ts";
  const T = "extension/src/work-develop-topological.ts";
  const F = "extension/src/work-driver-scope-fanout.ts";
  const workstreams: Record<string, WS> = {
    "task-a": {
      id: "task-a",
      scope: "state schema",
      paths: [S],
      outOfScope: [C, SC],
    },
    "task-b": {
      id: "task-b",
      scope: "converge gate",
      paths: [C],
      outOfScope: [S, SC],
    },
    "task-c": {
      id: "task-c",
      scope: "converge schema",
      paths: [SC],
      outOfScope: [S, C],
    },
    "task-d": {
      id: "task-d",
      scope: "topological dispatch",
      paths: [T],
      outOfScope: [
        S,
        C,
        SC,
      ],
    },
    "task-e": {
      id: "task-e",
      scope: "fence attribution",
      paths: [F],
      outOfScope: [S, C],
    },
  };

  // The four violations (verbatim from the issue):
  // - task-d touched workflow-state-schema-converge.ts (task-c declared it)
  // - task-d touched work-driver-converge.ts (task-b declared it)
  // - task-d touched workflow-state-schema.ts (task-a declared it)
  // - task-c touched work-driver-converge.ts (task-b declared it)
  const changed: Record<string, string[]> = {
    "task-d": [
      T,
      SC,
      C,
      S,
    ],
    "task-c": [SC, C],
    "task-a": [S],
    "task-b": [C],
    "task-e": [F],
  };

  const { failures, records } = run(workstreams, changed);

  // Four sibling-declared violations (task-d × 3, task-c × 1)
  const siblingRecords = records.filter((r) => r.kind === "sibling-declared");
  assert(
    siblingRecords.length === 4,
    `#792 fixture: 4 sibling-declared records (got: ${siblingRecords.length})`,
  );

  // Each is attributed
  const taskD = siblingRecords.filter((r) => r.workstreamId === "task-d");
  assert(
    taskD.length === 3,
    `#792 fixture: task-d has 3 violations (got: ${taskD.length})`,
  );
  assert(
    taskD.some((r) => r.file === SC && r.declaredById === "task-c"),
    `#792 fixture: task-d / workflow-state-schema-converge.ts → declared by task-c`,
  );
  assert(
    taskD.some((r) => r.file === C && r.declaredById === "task-b"),
    `#792 fixture: task-d / work-driver-converge.ts → declared by task-b`,
  );
  assert(
    taskD.some((r) => r.file === S && r.declaredById === "task-a"),
    `#792 fixture: task-d / workflow-state-schema.ts → declared by task-a`,
  );

  const taskC = siblingRecords.filter((r) => r.workstreamId === "task-c");
  assert(
    taskC.length === 1 && taskC[0].file === C &&
      taskC[0].declaredById === "task-b",
    `#792 fixture: task-c / work-driver-converge.ts → declared by task-b`,
  );

  // Failure strings: each named, none says "incoherent"
  for (const f of failures.filter((f) => f.includes("sibling-declared"))) {
    assert(
      !f.includes("incoherent"),
      `#792 fixture: fence failure does not say "incoherent" (got: ${f})`,
    );
  }

  // ExplainCap with fenceViolations → fence attribution, not "incoherent"
  let s = initialState(792, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: {
        "task-a": "/w/a",
        "task-b": "/w/b",
        "task-c": "/w/c",
        "task-d": "/w/d",
        "task-e": "/w/e",
      },
      verifyEvidence: {
        step: "develop",
        failures: failures,
        at: 1,
        fenceViolations: records,
      },
    },
  };
  s.eventLog.push({
    kind: "cap-hit",
    at: 1,
    cap: "consolidated-verify-conflict",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: "cherry-pick conflict on work-driver-converge.ts",
  });
  const text = explainCap("consolidated-verify-conflict", s);
  assert(
    !text.includes("incoherent"),
    `#792 explainCap: does NOT say "incoherent" when fenceViolations are present (got: ${text.slice(0, 200)})`,
  );
  assert(
    text.includes("fence was violated") || text.includes("fence ALREADY predicted"),
    `#792 explainCap: names the fence violation (got: ${text.slice(0, 200)})`,
  );
  assert(
    text.includes("task-d"),
    `#792 explainCap: names the violating workstream task-d (got: ${text.slice(0, 200)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 8 — Genuinely overlapping declared paths: incoherent text preserved
//
// When fenceViolations is ABSENT (no fence violation), the pre-#814
// incoherent-decomposition text is still produced (it's true there).
// ─────────────────────────────────────────────────────────────────────────────
{
  let s = initialState(669, 1_000_000);
  s = { ...s, pipelineState: { ...s.pipelineState, worktrees: { a: "/w/a", b: "/w/b" } } };
  s.eventLog.push({ kind: "cap-hit", at: 1, cap: "consolidated-verify-conflict", reviewRound: 0, nextStep: "handoff", evidence: "cherry-pick conflict" });
  const text = explainCap("consolidated-verify-conflict", s);
  assert(text.includes("incoherent"), `no fenceViolations: incoherent text is preserved (got: ${text.slice(0, 200)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Case 9 — Undeclared-only records do NOT trigger the fence attribution
//
// When only undeclared records are present (no sibling-declared), the
// incoherent text is still used (the undeclared hit is a warning, not a
// blocking violation).
// ─────────────────────────────────────────────────────────────────────────────
{
  let s = initialState(669, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      verifyEvidence: { step: "develop", failures: [], at: 1, fenceViolations: [{ workstreamId: "a", file: "src/extra.ts", kind: "undeclared" }] },
    },
  };
  s.eventLog.push({ kind: "cap-hit", at: 1, cap: "consolidated-verify-conflict", reviewRound: 0, nextStep: "handoff", evidence: "cherry-pick conflict" });
  const text = explainCap("consolidated-verify-conflict", s);
  assert(text.includes("incoherent"), `undeclared-only: incoherent text is preserved (got: ${text.slice(0, 200)})`);
}

// ─────────────────────────────────────────────────────────────────────────
// Case 10 — #792 fixture through renderHandoffMarkdown: the attribution
// appears in the rendered handoff (not just in explainCap), and the
// "incoherent" claim does not.
// ─────────────────────────────────────────────────────────────────────────
{
  let s = initialState(792, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { a: "/w/a", b: "/w/b" },
      verifyEvidence: {
        step: "develop",
        failures: [
          "workstream task-d touched extension/src/work-driver-converge.ts declared by task-b — declared fence violated (sibling-declared)",
          "consolidated verify could not combine the workstreams' commits — cherry-pick / apply conflict (conflict at extension/src/work-driver-converge.ts)",
        ],
        at: 1,
        fenceViolations: [
          { workstreamId: "task-d", file: "extension/src/work-driver-converge.ts", declaredById: "task-b", kind: "sibling-declared" },
        ],
      },
    },
  };
  s.eventLog.push({ kind: "cap-hit", at: 1, cap: "consolidated-verify-conflict", reviewRound: 0, nextStep: "handoff", evidence: "cherry-pick conflict on work-driver-converge.ts" });
  const rendered = renderHandoffMarkdown(s);
  assert(
    rendered.includes("task-d") && rendered.includes("work-driver-converge.ts"),
    `#792 handoff: the attribution names the violating workstream and the file (got: ${rendered.slice(0, 200)})`,
  );
  assert(
    rendered.includes("fence") && rendered.includes("task-b"),
    `#792 handoff: the attribution names the declaring sibling (got: ${rendered.slice(0, 200)})`,
  );
  assert(
    !rendered.includes("incoherent"),
    `#792 handoff: the 'incoherent' claim does not appear when a sibling-declared record is present (got: ${rendered.slice(0, 200)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Case 11 — branches-converged verdict of a violator is not-ok, with a
// reason. runDevelopTopological replaces the violator's entry in the
// verdicts array via applyFenceVerdicts (both blocking kinds). A
// workstream whose only record is `undeclared` keeps its ok verdict.
// ─────────────────────────────────────────────────────────────────────────
{
  const gateFence: FenceViolationRecord[] = [
    { workstreamId: "b", file: "src/a.ts", declaredById: "a", kind: "sibling-declared" },
    { workstreamId: "c", file: "src/c.ts", kind: "issue-fenced" },
    { workstreamId: "e", file: "src/rogue.ts", kind: "undeclared" },
  ];
  const verdicts: Array<{ id: string; ok: boolean; reason?: string }> = [
    { id: "a", ok: true }, { id: "b", ok: true }, { id: "c", ok: true }, { id: "e", ok: true },
  ];
  // The real function runDevelopTopological calls (work-develop-fence-verdicts.ts).
  applyFenceVerdicts(verdicts, gateFence);
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  assert(byId.get("a")?.ok === true && byId.get("a")?.reason === undefined, `branches-converged: a clean workstream keeps its ok verdict (got: ${JSON.stringify(verdicts)})`);
  assert(byId.get("b")?.ok === false && (byId.get("b")?.reason ?? "").includes("src/a.ts") && (byId.get("b")?.reason ?? "").includes("declared by a"), `branches-converged: the sibling-declared violator is ok:false with an attributed reason (got: ${JSON.stringify(verdicts)})`);
  assert(byId.get("c")?.ok === false && (byId.get("c")?.reason ?? "").includes("src/c.ts"), `branches-converged: the issue-fenced violator is ok:false with a reason (got: ${JSON.stringify(verdicts)})`);
  assert(byId.get("e")?.ok === true, `branches-converged: an undeclared-only workstream is NOT flipped (got: ${JSON.stringify(verdicts)})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
