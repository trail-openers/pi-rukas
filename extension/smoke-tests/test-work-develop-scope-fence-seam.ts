#!/usr/bin/env bun
/**
 * The issue-fenced scope lift (#1405, epic #1642), offline.
 *
 *   - the deterministic Test-surface precheck admits the #1187 shape with no model;
 *   - a path the body names only outside the Test surface is not admitted, and
 *     the model is asked (logged, never acted on);
 *   - a protected path is never admitted and never asked about;
 *   - shadow mode never lifts, even with the mode env set to enforce;
 *   - under enforce, the evidence check refuses a fabricated quote and a quote
 *     from a section the seam does not admit (Context);
 *   - a lift admits exactly its own (workstream, file) pair: a second fenced file
 *     from the same workstream still fails;
 *   - a grouped cycle lifts nothing and asks nothing; a body artifact outside
 *     `.pi/work-state/` is refused; model asks are capped at five per gate.
 *
 * Canary (run by hand, recorded in the PR): making `testSurfaceNames` return
 * undefined turns the #1187 assertion red.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CycleContext } from "../src/work-driver-context.ts";
import { decide } from "../src/decision-seam.ts";
import {
  type FenceLift,
  issueSections,
  scopeFenceLift,
  scopeFenceRequest,
  testSurfaceNames,
} from "../src/work-develop-scope-fence-seam.ts";
import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import { isProtectedPath } from "../src/work-driver-doctrine.ts";
import { recordDevelopGateEvents } from "../src/work-driver-verify-events.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { makeAssert, stubBackend } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

const ISSUE = 1187;
const ENV = "PI_ENSEMBLE_DECISION_MODE_SCOPE_FENCE";
const TEXT_FLATTEN = "extension/smoke-tests/test-text-flatten.ts";
const SCOPE_FANOUT = "extension/src/work-driver-scope-fanout.ts";
const CI_YML = ".github/workflows/ci.yml";

// A synthetic issue body with every shape the seam must tell apart: a Test-surface
// bullet (#1187), a path only in References, a path only in Out of scope, a path
// only in Context, and a protected path named in the Test surface.
const BODY = `# Title

## Context

extension/smoke-tests/test-text-flatten.ts pins the flattener, and this sentence is liftable-shaped.

## Test surface

- \`extension/smoke-tests/test-text-flatten.ts\` — a bidi override and a zero-width joiner still match their own path.
- \`${CI_YML}\` — pins the workflow.

## References

- \`${SCOPE_FANOUT}\` — the fence gate.

## Acceptance criteria

- The fence admits a path the Test surface names.

## Out of scope

- \`extension/smoke-tests/test-other.ts\` is out of scope.
`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Every temp repo a fixture creates; removed once the run ends. */
const roots: string[] = [];

/**
 * A fixture repo whose cached body is written under `.pi/work-state/` (where the
 * driver writes it), or directly under the repo root when `where` says so, which
 * the lift must refuse. `issues` makes a grouped cycle when it has two entries.
 */
function fixture(
  body: string | undefined,
  opts: { issues?: number[]; where?: "state" | "root" } = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "scope-fence-seam-"));
  roots.push(root);
  let artifact: string | undefined;
  if (body !== undefined) {
    artifact =
      opts.where === "root"
        ? path.join(root, "issue-body.md")
        : path.join(root, ".pi", "work-state", String(ISSUE), "issue-body.txt");
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, body);
  }
  const ctx = { repoRoot: root } as unknown as CycleContext;
  const cycle = {
    issue: ISSUE,
    issues: opts.issues ?? [ISSUE],
    pipelineState: { issueBodyArtifact: artifact },
  } as unknown as WorkState;
  const lifts: FenceLift[] = [];
  return { root, lifts, lift: scopeFenceLift(ctx, cycle, lifts) };
}

const decisionsFile = (root: string) =>
  path.join(root, ".pi", "work-state", String(ISSUE), "decisions.jsonl");

/** The fence gate for one workstream fencing `files`, with the lift under test. */
function gate(files: string[], lift?: (workstreamId: string, file: string) => boolean): string[] {
  const failures: string[] = [];
  runScopeFanoutGate(
    {
      default: {
        id: "default",
        scope: "test",
        paths: ["extension/src/unrelated-declared.ts"],
        outOfScope: files,
      },
    },
    new Map([["default", new Set(files)]]),
    failures,
    [],
    undefined,
    lift,
  );
  return failures;
}

/** Wait until the decision log holds `needle`, or give up after a few seconds. */
async function logHolds(root: string, needle: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (existsSync(decisionsFile(root)) && readFileSync(decisionsFile(root), "utf8").includes(needle))
      return true;
    await settle();
  }
  return false;
}

async function main() {
  // --- The deterministic precheck (acts) -----------------------------------
  const a = fixture(BODY);
  assert(
    testSurfaceNames(issueSections(BODY).testSurface, TEXT_FLATTEN) !== undefined,
    "the Test-surface bullet names the #1187 path",
  );
  assert(
    testSurfaceNames(issueSections(BODY).testSurface, "extension/smoke-tests/test-text-flatten") ===
      undefined,
    "a path that is only a prefix of a named path is not a token match",
  );
  assert(
    testSurfaceNames(issueSections(BODY).testSurface, "text-flatten.ts") === undefined,
    "a bare basename does not match a fenced path spelled in full",
  );
  assert(
    testSurfaceNames(
      issueSections("## Test surface\n\n- ./extension/src/x.ts (new)\n").testSurface,
      "extension/src/x.ts",
    ) !== undefined,
    "a ./ spelling and an annotation still match the fenced path",
  );
  assert(
    gate([TEXT_FLATTEN], a.lift).length === 0,
    "#1187 shape: the precheck admits the issue-fenced path",
  );
  // A bullet that forbids or only pins the path does not admit it (round 2).
  const negated = `## Test surface\n\n- \`${SCOPE_FANOUT}\` — must not change; pinned by the tests\n- \`${TEXT_FLATTEN}\` — existing behaviour must still pass\n`;
  assert(
    testSurfaceNames(issueSections(negated).testSurface, SCOPE_FANOUT) === undefined,
    "a negated Test-surface bullet (must not change) does not admit the path",
  );
  assert(
    testSurfaceNames(issueSections(negated).testSurface, TEXT_FLATTEN) === undefined,
    "a verification-only Test-surface bullet (must still pass) does not admit the path",
  );
  assert(
    gate([TEXT_FLATTEN]).length === 1 && /issue-fenced/.test(gate([TEXT_FLATTEN])[0] ?? ""),
    "baseline: the same hit without the lift is an issue-fenced failure",
  );
  assert(
    a.lifts.length === 1 && a.lifts[0]?.file === TEXT_FLATTEN && !!a.lifts[0]?.line.includes(TEXT_FLATTEN),
    "the admission is returned with the path and the Test-surface line that named it",
  );
  const recorded = recordDevelopGateEvents(
    { eventLog: [], pipelineState: {} } as unknown as WorkState,
    { fenceLifts: a.lifts },
  );
  assert(
    recorded.eventLog.some(
      (e) => e.kind === "fence-lifted" && e.file === TEXT_FLATTEN && e.source === "precheck",
    ),
    "the admission becomes a fence-lifted event in the state's event log",
  );
  await settle();
  assert(!existsSync(decisionsFile(a.root)), "a precheck admission asks no model");

  // --- A path named only outside the Test surface ---------------------------
  const b = fixture(BODY);
  assert(
    gate([SCOPE_FANOUT], b.lift).length === 1,
    "a path named only in References is not admitted by the precheck",
  );
  assert(
    await logHolds(b.root, '"seam":"scope-fence"'),
    "the model is asked for a path the precheck did not admit, and the ask is logged",
  );

  const outOfScopeOnly = fixture(BODY);
  assert(
    gate(["extension/smoke-tests/test-other.ts"], outOfScopeOnly.lift).length === 1,
    "a path named only under Out of scope is not admitted",
  );

  // --- Protected paths --------------------------------------------------------
  const p = fixture(BODY);
  assert(isProtectedPath(CI_YML), "the workflow file is a protected path");
  assert(
    gate([CI_YML], p.lift).length === 1,
    "a protected path named in the Test surface is never admitted",
  );
  await settle();
  assert(!existsSync(decisionsFile(p.root)), "a protected path is never asked about");

  // --- No body, nothing admitted --------------------------------------------
  const none = fixture(undefined);
  assert(gate([TEXT_FLATTEN], none.lift).length === 1, "no cached body: the fence stands");
  const empty = fixture("   \n");
  assert(gate([TEXT_FLATTEN], empty.lift).length === 1, "an empty cached body: the fence stands");

  // An artifact outside .pi/work-state/ is refused: the body is the lift's authority.
  const outside = fixture(BODY, { where: "root" });
  assert(
    gate([TEXT_FLATTEN], outside.lift).length === 1 && outside.lifts.length === 0,
    "a body artifact outside .pi/work-state/ is refused, so the fence stands",
  );

  // An empty or blank path names nothing: the empty pattern would match every line.
  assert(
    testSurfaceNames(issueSections(BODY).testSurface, "") === undefined &&
      testSurfaceNames(issueSections(BODY).testSurface, "   ") === undefined,
    "an empty or whitespace-only path names no Test-surface line",
  );

  // --- Grouped cycle: the precheck is skipped, nothing is asked ---------------
  const grouped = fixture(BODY, { issues: [ISSUE, 1188] });
  assert(
    gate([TEXT_FLATTEN], grouped.lift).length === 1 && grouped.lifts.length === 0,
    "a grouped cycle is never lifted by the precheck: the fence stands",
  );
  await settle();
  assert(!existsSync(decisionsFile(grouped.root)), "a grouped cycle asks no model");

  // --- Shadow asks are capped per develop gate -------------------------------
  const capped = fixture(BODY);
  gate(
    ["extension/src/c1.ts", "extension/src/c2.ts", "extension/src/c3.ts", "extension/src/c4.ts", "extension/src/c5.ts", "extension/src/c6.ts"],
    capped.lift,
  );
  assert(
    await logHolds(capped.root, '"seam":"scope-fence"'),
    "the first model asks are logged",
  );
  await settle();
  const asked = readFileSync(decisionsFile(capped.root), "utf8")
    .split("\n")
    .filter((line) => line.includes('"seam":"scope-fence"')).length;
  assert(asked === 5, `at most 5 model asks per develop gate (saw ${asked})`);

  // --- Shadow never lifts ---------------------------------------------------
  const prior = process.env[ENV];
  process.env[ENV] = "enforce";
  try {
    const s = fixture(BODY);
    assert(
      gate([SCOPE_FANOUT], s.lift).length === 1,
      "shadow never lifts: a model-only hit stays a failure under the enforce env",
    );
    assert(
      await logHolds(s.root, "configured to enforce"),
      "the refused shadow call is logged as a refusal, not silently dropped",
    );

    // Under enforce, decide() itself would act, so the evidence check is exercised
    // directly here: this is the verification a later enforce ticket depends on.
    const sections = issueSections(BODY);
    const ask = (file: string, quote: string) =>
      decide("scope-fence", scopeFenceRequest(sections, file), {
        backends: [stubBackend({ ok: true, answer: "true", quote, cited: undefined })],
        repoRoot: s.root,
        issues: [ISSUE],
      });

    const verbatim = await ask(SCOPE_FANOUT, `\`${SCOPE_FANOUT}\``);
    assert(
      verbatim.evidence?.passed === true && verbatim.answer === "true",
      "a verbatim quote from References verifies (the evidence check works on real text)",
    );
    const fabricated = await ask(SCOPE_FANOUT, "the planner may change anything in this repository");
    assert(
      fabricated.evidence?.passed === false && fabricated.answer === "false",
      "a fabricated quote is recorded as evidence.passed=false and the fence stands",
    );
    const context = await ask(TEXT_FLATTEN, "extension/smoke-tests/test-text-flatten.ts pins the flattener");
    assert(
      context.evidence?.passed === false && context.answer === "false",
      "a quote from Context is not evidence: only Test surface, References and Acceptance criteria count",
    );
  } finally {
    if (prior === undefined) delete process.env[ENV];
    else process.env[ENV] = prior;
  }

  // --- Per-pair admission ---------------------------------------------------
  const pair = fixture(BODY);
  const two = gate([TEXT_FLATTEN, "extension/smoke-tests/test-other.ts"], pair.lift);
  assert(
    two.length === 1 && two[0]?.includes("test-other.ts"),
    "a lift admits only its own file: the second fenced file from the same workstream still fails",
  );

  // Two workstreams both fence the same named file: neither side is admitted
  // (the #444 collision shape), so both still fail.
  const shared = fixture(BODY);
  const sharedFailures: string[] = [];
  runScopeFanoutGate(
    {
      a: { id: "a", scope: "t", paths: ["extension/src/a-own.ts"], outOfScope: [TEXT_FLATTEN] },
      b: { id: "b", scope: "t", paths: ["extension/src/b-own.ts"], outOfScope: [TEXT_FLATTEN] },
    },
    new Map([
      ["a", new Set([TEXT_FLATTEN])],
      ["b", new Set([TEXT_FLATTEN])],
    ]),
    sharedFailures,
    [],
    undefined,
    shared.lift,
  );
  assert(sharedFailures.length === 2, "two workstreams fencing the same named file: both still fail");

}

try {
  await main();
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
