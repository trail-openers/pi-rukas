#!/usr/bin/env bun
/**
 * #1557 (epic #1642, measurement run 6b) — a spec deliverable's PATTERN slot
 * admits the file it authorises, at both fences that refused it.
 *
 * The shape from `.pi/work-state/1557.json`: deliverable d1 declared four
 * concrete files plus `extension/src/review-ledger-*.ts`. PR #1707 had just
 * exempted such slots from the plan-to-spec gate (`plannedPathProblem` refuses
 * a glob in a `report_workstream` `paths` entry, so no plan may name one), and
 * the adversarial fix pass then created `extension/src/review-ledger-pass.ts`
 * — the split the 500-line ratchet forces. Both fences refused it:
 *
 *   default changed extension/src/review-ledger-pass.ts — outside its declared
 *   paths and the files the findings name … a named file widens only when it is
 *   tracked at base …
 *
 * `namedPaths` reads the tree tracked AT base, so a file the pass created can
 * never widen onto it, and both fences match declared paths with exact /
 * directory-prefix string equality — no wildcard anywhere. The fix threads the
 * cycle's own spec (driver state, never issue prose) into both, judged by the
 * converge gate's segment-anchored matcher.
 *
 * What must stay refused, and is asserted here: a non-matching new file, a
 * match inside the workstream's `outOfScope` fence, a protected path, and a
 * slot with nothing literal anchoring it (`*`, `**`).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trace } from "../src/trace.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { planFixPass, postPassFault } from "../src/work-driver-adversarial-fix-scope.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { specPatternSlots, specSlotAdmitting } from "../src/work-driver-spec-slot-admission.ts";
import type { PipelineState } from "../src/workflow-state-schema.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { devCommit, fixCtx, fixState, git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Put an env var back the way it was — absent stays absent. */
function restoreEnv(key: string, was: string | undefined): void {
  if (was === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = was;
}

/** The slot the 500-line ratchet forced and `plannedPathProblem` forbids declaring. */
const SLOT = "extension/src/review-ledger-*.ts";
const NEW_FILE = "extension/src/review-ledger-pass.ts";
/** The four concrete files the same deliverable declared. */
const LEDGER_FILES = ["extension/src/review-ledger.ts", "extension/src/adversarial-ledger.ts"];
/** The rest of the workstream's declared scope. */
const DECLARED = [...LEDGER_FILES, "extension/src/adversarial.ts", "a.txt"];

function spec(slots: string[], id = "d1"): { deliverables: { id: string; paths: string[] }[] } {
  return {
    deliverables: [{ id, description: "the deliverable", paths: [...LEDGER_FILES, ...slots] }],
  };
}

/** The repo the cycle 1557 shape needs: the declared files tracked at base. */
function repo(label: string, extra: Record<string, string> = {}): string {
  const dir = repoWithFile(label);
  for (const f of [...DECLARED, ...Object.keys(extra)]) {
    mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(dir, f), extra[f] ?? "export {};\n");
  }
  git(dir, "add -A");
  git(dir, 'commit -q -m "the declared scope"');
  return dir;
}

function stateWith(
  dir: string,
  opts: {
    paths?: string[];
    outOfScope?: string[];
    specSource?: { deliverables: { id: string; paths: string[] }[] };
    findings?: string;
  },
): WorkState {
  const st = fixState(dir, opts.paths ?? DECLARED, opts.findings ?? `${LEDGER_FILES[0]}: split it`);
  return {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      worktrees: { default: dir },
      workstreams: {
        default: {
          id: "default",
          scope: "row identity",
          paths: opts.paths ?? DECLARED,
          outOfScope: opts.outOfScope ?? [],
        },
      },
      ...(opts.specSource ? { normalisedSpec: opts.specSource as never } : {}),
    },
  };
}

/** The fence alone: pre-pass plan, the developer's new file, the post-pass verdict. */
async function fenceVerdict(
  dir: string,
  st: WorkState,
  created: string[],
): Promise<{ parked: string; traces: string[] }> {
  const ps = st.pipelineState as PipelineState;
  const planned = await planFixPass(defaultExec, dir, ps, [
    { workstreamId: "default", findings: "the finding" },
  ]);
  if (!planned.ok) return { parked: planned.reason, traces: [] };
  for (const f of created) {
    mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    devCommit(dir, f, "export const split = 1;\n");
  }
  const real = process.stderr.write.bind(process.stderr);
  const traces: string[] = [];
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traces.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  let post: { reason?: string; diffs: Record<string, string> } = { diffs: {} };
  try {
    post = await postPassFault(defaultExec, planned.value, ps.baseSha ?? "");
  } finally {
    process.stderr.write = real;
    restoreEnv("PI_ENSEMBLE_DEBUG", debug);
  }
  return { parked: post.reason ?? "", traces };
}

// ── A — the #1557 shape, end to end through the fix pass ────────────────────
{
  const dir = repo("a-1557");
  try {
    const st = stateWith(dir, { specSource: spec([SLOT]) });
    // The developer stub creates the file the slot authorises, as the real pass did.
    const run = await runAdversarialFixPass(
      fixCtx(dir, () => devCommit(dir, NEW_FILE, "export const split = 1;\n")),
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

// ── D — a protected path still halts ────────────────────────────────────────
{
  const dir = repo("d-protected");
  try {
    const r = await fenceVerdict(
      dir,
      stateWith(dir, {
        paths: [".github/workflows/ci.yml"],
        specSource: spec([".github/*.yml"], "d2"),
      }),
      [".github/new-ci.yml"],
    );
    assert(
      r.parked.includes(".github/new-ci.yml"),
      `D: a protected path is never admitted by a spec slot — got "${r.parked.slice(0, 160)}"`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── E — an unanchored wildcard admits nothing ───────────────────────────────
{
  for (const slot of ["*", "**", "*/*", "*/**"]) {
    const slots = specPatternSlots(spec([slot]));
    const admitted = specSlotAdmitting(slots, "extension/src/review-ledger-pass.ts");
    const rootAdmitted = specSlotAdmitting(slots, "anything.ts");
    assert(
      admitted === undefined && rootAdmitted === undefined,
      `E: the unanchored slot \`${slot}\` admits nothing (got ${JSON.stringify(slots)})`,
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

// ── F — the matcher is the converge gate's, segment-anchored ────────────────
{
  const slots = specPatternSlots(spec([SLOT, "lib/work-driver-<name>.ts"]));
  assert(
    specSlotAdmitting(slots, "extension/src/deep/review-ledger-pass.ts") === undefined,
    "F: a `*` never spans a `/` — a subdirectory file is not admitted",
  );
  assert(
    specSlotAdmitting(slots, "lib/work-driver-acceptance.ts") !== undefined,
    "F: a `<name>` template admits like a glob",
  );
  assert(
    specSlotAdmitting(
      specPatternSlots(spec(["extension/src/concrete.ts"])),
      "extension/src/other.ts",
    ) === undefined,
    "F: a CONCRETE slot admits nothing — only pattern slots widen",
  );
  assert(
    specSlotAdmitting(specPatternSlots(spec(["n/a"])), "n/a") === undefined &&
      specPatternSlots(spec(["n/a"])).length === 0,
    "F: a filler slot (`n/a`) is not an authorisation",
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
  const records: { workstreamId: string; file: string; kind: string }[] = [];
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  const real = process.stderr.write.bind(process.stderr);
  const traces: string[] = [];
  process.env.PI_ENSEMBLE_DEBUG = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traces.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  runScopeFanoutGate(
    { default: { id: "default", scope: "", paths: DECLARED, outOfScope: [] } },
    new Map([["default", changed]]),
    failures,
    notes,
    records,
    undefined,
    { spec: spec([SLOT]) },
  );
  process.stderr.write = real;
  restoreEnv("PI_ENSEMBLE_DEBUG", debug);
  assert(
    !notes.some((n) => n.includes(NEW_FILE)) &&
      !records.some((r) => r.file === NEW_FILE && r.kind === "undeclared"),
    `G: with the spec the admitted file is neither warned nor recorded as undeclared — got ${JSON.stringify(notes)}`,
  );
  assert(
    traces.filter((t) => t.includes(NEW_FILE) && t.includes("admitted")).length === 1,
    `G: exactly one trace line per admitted (workstream, file) — got ${traces.length}`,
  );
}
{
  // G2 — the admitted file is out of the fanout NUMERATOR: the bound catches a
  // workstream inventing scope, not one creating the file the spec asked for.
  const factor = process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR;
  const min = process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN;
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "1";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  const gate = (withSpec: boolean): string[] => {
    const failures: string[] = [];
    runScopeFanoutGate(
      { default: { id: "default", scope: "", paths: ["extension/src/a.ts"], outOfScope: [] } },
      new Map([
        ["default", new Set(["extension/src/a.ts", "extension/src/b.ts", "extension/src/c.ts"])],
      ]),
      failures,
      [],
      undefined,
      undefined,
      withSpec
        ? { spec: { deliverables: [{ id: "d", description: "", paths: ["extension/src/*.ts"] }] } }
        : {},
    );
    return failures;
  };
  const blind = gate(false);
  const informed = gate(true);
  restoreEnv("PI_ENSEMBLE_SCOPE_FANOUT_FACTOR", factor);
  restoreEnv("PI_ENSEMBLE_SCOPE_FANOUT_MIN", min);
  assert(
    blind.some((f) => f.includes("scope fanout")) && informed.length === 0,
    `G2: spec-admitted files are out of the fanout numerator (blind: ${JSON.stringify(blind)}, informed: ${JSON.stringify(informed)})`,
  );
}

// ── H — the trace is the project's own gated writer ─────────────────────────
{
  // `trace()` is gated on PI_ENSEMBLE_DEBUG; an admission that never reaches it
  // would be a silent widening (the failure #1522 was written about).
  let saw = "";
  const real = process.stderr.write.bind(process.stderr);
  const debug = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    saw += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    trace("probe");
  } finally {
    process.stderr.write = real;
    restoreEnv("PI_ENSEMBLE_DEBUG", debug);
  }
  assert(
    saw.includes("probe"),
    "H: the trace writer this module uses is live under PI_ENSEMBLE_DEBUG",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
