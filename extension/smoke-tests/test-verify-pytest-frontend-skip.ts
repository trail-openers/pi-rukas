#!/usr/bin/env bun
/**
 * #2282 — the frontend-only skip applied to the Python verify arm.
 *
 * #1012's skip is not Python-specific: it fires on the union of paths the
 * develop gate read from git, for any **derived** verify command — a CSS-only
 * change must not trigger a backend build, and equally must not trigger a pytest
 * run. What this file pins is that the new Python arm rides that path instead of
 * opening a second one, in both directions:
 *
 *   - a **source** change in a Python repo runs the discovered command even with
 *     the globs set — the arm is not skipped merely because the operator opted
 *     into the classification;
 *   - a **CSS-only** diff in the same repo does NOT run it, and the skip is
 *     recorded in notes rather than taken silently (a green that hides a check
 *     which never ran is the failure mode this repo polices everywhere);
 *   - an **explicit `.pi/verify-cmd`** still runs on that same CSS-only diff —
 *     the skip is derived-only, so operator intent outranks classification;
 *   - with the arm switched **off**, the same CSS-only tree runs nothing and
 *     earns no frontend-only note: the arm's absence is a discovery result, and
 *     dressing it as a classification would be a confident wrong answer.
 *
 * The gate is driven directly, with no real tree, because the claim is about
 * what the driver *classifies* — not about what git reports about a fixture. The
 * status/diff/rev-list reads are answered from a table in the driver's own argv
 * form (`commandOf`, so an argv call and a shell call match alike), and every
 * other command the gate would run is recorded, which is what makes "skipped"
 * observable as "the project command never appears in the record".
 *
 * The switch helper is shared with `test-verify-pytest-switch.ts` through
 * `lib/verify-pytest-switch.ts`; the command string is asserted as the literal
 * here as well, since this file's whole claim is about that one string running
 * or not running.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulDiffRead, isNulStatusRead, nulStatus } from "./lib/nul-porcelain.ts";
import {
  PY_CMD,
  pythonRepo,
  withEnv,
} from "./lib/verify-pytest-switch.ts";
import { VERIFY_PYTEST_ENV } from "../src/work-driver-verify-cmd.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";

// A pyproject repo that names pytest: the shape `verifyCmdFor` resolves to
// `python3 -m pytest -q`. No `.pi/verify-cmd`, so any command the gate runs is
// derived and therefore eligible for the skip.
const pyRoot = pythonRepo({ prefix: "verify-pytest-cls-" });

/** The gate's own parameter type, derived rather than transcribed (the shape
 * `test-verify-run-events.ts` uses for the same call): `verifyStepOutcome` takes
 * a `CycleContext`, whose one required field beyond `DriverContext` is the
 * cycle's emit sink — so the sink is a real one from `createEmitSink`, drained
 * to nothing. A `DriverHost` is structural (`sendUserMessage` + `emit`) and a
 * test host records nothing on either, so it satisfies the type as written. */
const mkCtx = (
  exec: NonNullable<DriverContext["verifyExecFn"]>,
): Parameters<typeof verifyStepOutcome>[0] =>
  ({
    host: { sendUserMessage: () => {}, emit: () => {} },
    issue: 2282,
    repoRoot: pyRoot,
    verifyExecFn: exec,
    emitSink: createEmitSink(() => undefined),
  }) as Parameters<typeof verifyStepOutcome>[0];

const clsState = () => {
  const s = initialState(2282, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: "feature/issue-2282",
      baseSha: "0".repeat(40),
      worktrees: { default: pyRoot },
      workstreams: { default: { id: "default", scope: "s", paths: [], outOfScope: [] } },
    },
  };
};

/** One gate drive: answer git from a table so the touched-path union is exactly
 * `paths`, and record every other command the gate tried to run. */
async function classify(paths: string[]) {
  const commands: string[] = [];
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    const line = commandOf(cmd, o);
    if (isNulStatusRead(line)) return { stdout: nulStatus(...paths.map((p) => ` M ${p}`)) };
    if (line.startsWith("git rev-list --count")) return { stdout: "1\n" };
    if (isNulDiffRead(line)) return { stdout: "" };
    if (line === "git" || line.startsWith("git ")) return { stdout: "" };
    commands.push(line);
    return { stdout: "" };
  };
  const gate = await verifyStepOutcome(mkCtx(exec), clsState(), "develop");
  return { gate, commands };
}

const prevGlobs = process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS;
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = GLOBS;
try {
  // A source change runs the discovered command — the arm is not skipped just
  // because the operator opted into the frontend-only classification.
  const src = await withEnv(VERIFY_PYTEST_ENV, undefined, () => classify(["app.py"]));
  assert(
    src.commands.includes(PY_CMD),
    `classification: a .py change runs the discovered command (commands: ${JSON.stringify(src.commands)})`,
  );
  assert(
    !src.gate.notes.some((n) => /frontend-only diff/.test(n)),
    "classification: a source change never takes the frontend-only skip",
  );

  // A CSS-only diff skips the DERIVED command, visibly. Same tree, same switch,
  // one field different: the touched paths.
  const css = await withEnv(VERIFY_PYTEST_ENV, undefined, () => classify(["styles.css"]));
  assert(
    !css.commands.includes(PY_CMD),
    `classification: a CSS-only diff did not run the derived pytest command (commands: ${JSON.stringify(css.commands)})`,
  );
  assert(
    css.gate.notes.some((n) => /frontend-only diff/.test(n)),
    `classification: the skip is recorded in notes, not taken silently (notes: ${JSON.stringify(css.gate.notes.filter((n) => /frontend/.test(n)))})`,
  );

  // The same CSS-only diff with an explicit `.pi/verify-cmd` still runs.
  mkdirSync(path.join(pyRoot, ".pi"), { recursive: true });
  writeFileSync(path.join(pyRoot, ".pi", "verify-cmd"), `${PY_CMD}\n`);
  const explicit = await withEnv(VERIFY_PYTEST_ENV, undefined, () => classify(["styles.css"]));
  assert(
    explicit.commands.includes(PY_CMD),
    `classification: an explicit .pi/verify-cmd runs on a CSS-only diff — explicit intent beats the skip (commands: ${JSON.stringify(explicit.commands)})`,
  );
  assert(
    !explicit.gate.notes.some((n) => /frontend-only diff/.test(n)),
    "classification: an explicit command's run is not reported as a skip",
  );
  rmSync(path.join(pyRoot, ".pi"), { recursive: true, force: true });

  // With the arm off the same CSS-only tree has no command to skip at all, so it
  // must not acquire a frontend-only note: absence and skip are different facts.
  const offCss = await withEnv(VERIFY_PYTEST_ENV, "0", () => classify(["styles.css"]));
  assert(
    offCss.commands.length === 0,
    `classification off: the gate ran no project command (commands: ${JSON.stringify(offCss.commands)})`,
  );
  assert(
    !offCss.gate.notes.some((n) => /frontend-only diff/.test(n)),
    `classification off: no frontend-only note dresses up an arm that is switched off (notes: ${JSON.stringify(offCss.gate.notes.filter((n) => /frontend/.test(n)))})`,
  );
  assert(
    offCss.gate.notes.some((n) => n.startsWith("no verify command discoverable")),
    "classification off: the gate says plainly that discovery found no command",
  );
} finally {
  if (prevGlobs === undefined) delete process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS;
  else process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = prevGlobs;
  rmSync(pyRoot, { recursive: true, force: true });
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
