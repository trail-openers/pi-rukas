#!/usr/bin/env bun
/**
 * Smoke test for the /work driver #672 regression cases.
 *
 * Covers the three sub-defects in `verifyDevelopOutcome`:
 *   1. Per-workstream changed-path Set isolation (cross-worktree contamination)
 *   2. Sibling-union fence widening (plan-wide declared set vs single slice)
 *   3. Inference-gated test-file exception (isTestPath + couplesTo)
 *
 * No real Pi spawn happens; all git output is faked via `verifyExecFn`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

process.env.PI_ENSEMBLE_VERIFY = "1";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

interface ScopeWorkstream {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
}

const previousScopeEnv = {
  gate: process.env.PI_ENSEMBLE_SCOPE_GATE,
  factor: process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR,
  minimum: process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN,
};

const dir = mkdtempSync(path.join(tmpdir(), "verify-672-"));
let filesByWorktree: Record<string, string[]> | undefined;
let committedByWorktree: Record<string, string[]> | undefined;
let worktreesForScope: ScopeWorkstream[] = [];

const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
  const worktree = opts?.cwd;
  const wsEntry = worktreesForScope.find((entry) => worktree?.endsWith(entry.id));
  const status = filesByWorktree?.[wsEntry?.id ?? ""] ?? [];
  const committed = committedByWorktree?.[wsEntry?.id ?? ""] ?? [];
  if (cmd === "git status --porcelain") {
    return { stdout: status.map((file) => ` M ${file}`).join("\n") };
  }
  if (cmd.startsWith("git rev-list --count")) {
    return { stdout: status.length > 0 || committed.length > 0 ? "1\n" : "0\n" };
  }
  if (cmd.startsWith("git diff --name-only")) {
    return { stdout: committed.join("\n") };
  }
  return { stdout: "" };
};

const stateFor = (workstreams: Record<string, ScopeWorkstream>) => {
  const state = initialState(998, 1000);
  worktreesForScope = Object.values(workstreams);
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      baseSha: "a".repeat(40),
      worktrees: Object.fromEntries(
        Object.entries(workstreams).map(([id, ws]) => [id, path.join(dir, ws.id)]),
      ),
      workstreams,
    },
  };
};

const ctx: DriverContext = {
  pi: makeFakePi().pi,
  repoRoot: dir,
  issue: 998,
  verifyExecFn: exec,
};

try {
  // Ensure the scope gate is enabled with default factor/minimum.
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_GATE");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_FACTOR");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_MIN");

  // #672-1 — Set isolation: two workstreams with disjoint changed
  // paths must evaluate their own fence against their own declared
  // paths. Before the fix, task-a's set held task-b's files too, so
  // task-a's gate failed with an out-of-scope/fanout error about a
  // path that belongs to task-b.
  filesByWorktree = { "task-a": ["src/a.ts"], "task-b": ["src/b.ts"] };
  const isolated = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      "task-b": { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] },
    }),
    "develop",
  );
  assert(
    isolated.ok,
    "#672-1: disjoint per-worktree changed sets pass — task-a's gate is not contaminated by task-b's paths",
  );
  assert(
    !isolated.failures.some((failure) => /task-a/.test(failure) && /src\/b\.ts/.test(failure)),
    "#672-1: task-a's failure list never mentions task-b's changed path",
  );

  // #672-2a — sibling-union widening (fence only): workstream A
  // touches a file legitimately declared by sibling B. The fence
  // must permit it; the fanout denominator stays A's own declared
  // count. #724 — the numerator now counts only undeclared files:
  // 7 changed files, 1 is sibling-declared (src/b.ts), so 6 undeclared.
  // Limit = max(1*3, 6) = 6. 6 > 6 is false → PASS (boundary case).
  // This is correct: the 6 extra files are within the factor tolerance.
  filesByWorktree = {
    "task-a": [
      "src/b.ts",
      "src/b-extra1.ts",
      "src/b-extra2.ts",
      "src/b-extra3.ts",
      "src/b-extra4.ts",
      "src/b-extra5.ts",
      "src/b-extra6.ts",
    ],
    "task-b": [],
  };
  const siblingWidened = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      "task-b": { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] },
    }),
    "develop",
  );
  assert(
    !siblingWidened.failures.some((failure) => /out-of-scope path src\/b\.ts/.test(failure)),
    "#672-2a: sibling-declared path is not an out-of-scope hit for workstream A",
  );
  assert(
    siblingWidened.ok,
    "#672-2a/#724: 6 undeclared files (of 7 changed) vs limit 6 → pass (boundary case, within factor tolerance)",
  );

  // #672-2b — the widening is scoped to the union of declared paths,
  // not a global loosening: an undeclared file (in no workstream) must
  // still fail, with the denominator still A's own count. Uses 7 files
  // to exceed the default fanout minimum of 6.
  filesByWorktree = {
    "task-a": [
      "src/rogue.ts",
      "src/rogue1.ts",
      "src/rogue2.ts",
      "src/rogue3.ts",
      "src/rogue4.ts",
      "src/rogue5.ts",
      "src/rogue6.ts",
    ],
    "task-b": [],
  };
  const siblingUndeclared = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/a.ts"], outOfScope: [] },
      "task-b": { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] },
    }),
    "develop",
  );
  const undecl = siblingUndeclared.failures.find(
    (failure) => /scope fanout/.test(failure) && /vs 1 declared/.test(failure),
  );
  assert(Boolean(undecl), "#672-2b: an undeclared file fails the gate");
  assert(
    Boolean(undecl) && /scope fanout: 7 undeclared file\(s\)/.test(undecl),
    "#724: fanout failure names the undeclared count (7), not the raw changed count",
  );
  assert(
    siblingUndeclared.failures.some((failure) => /src\/rogue\.ts/.test(failure)),
    "#672-2b: the failure names the undeclared file",
  );

  // #672-3a — test-file exception: the workstream declares its
  // production file; the developer adds the matching test file
  // (isTestPath, couplesTo the declared subject). The test file is
  // not declared anywhere, but it is coupled to the plan's declared
  // set, so the fence must permit it — no out-of-scope, no fanout.
  filesByWorktree = {
    "task-a": ["src/foo.ts", "smoke-tests/test-foo.ts"],
    "task-b": [],
  };
  const testFileOk = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/foo.ts"], outOfScope: [] },
      "task-b": { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] },
    }),
    "develop",
  );
  assert(
    testFileOk.ok,
    "#672-3a: coupled test file (test-foo.ts for declared src/foo.ts) passes the fence",
  );

  // #672-3b — the exception is inference-gated, not blanket:
  // an unrelated test-named file whose inferred subject is declared
  // by no workstream must still fail. Uses 8 files (including the
  // uncoupled test) to exceed the default fanout minimum of 6, so the
  // gate fires and names the uncoupled test file.
  // #724 — the 8th file (smoke-tests/test-foo.ts) is coupled to the
  // declared subject src/foo.ts and is therefore exempt from the
  // fanout numerator; the gate now counts undeclared files only, so
  // the 7 non-exempt files exceed the minimum of 6.
  filesByWorktree = {
    "task-a": [
      "src/foo.ts",
      "smoke-tests/test-rogue.ts",
      "smoke-tests/test-foo.ts",
      "src/x1.ts",
      "src/x2.ts",
      "src/x3.ts",
      "src/x4.ts",
      "src/x5.ts",
      "src/x6.ts",
    ],
    "task-b": [],
  };
  const testFileRogue = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/foo.ts"], outOfScope: [] },
      "task-b": { id: "task-b", scope: "b", paths: ["src/b.ts"], outOfScope: [] },
    }),
    "develop",
  );
  assert(
    testFileRogue.failures.some((failure) => /scope fanout/.test(failure)),
    "#672-3b: an uncoupled test-named file still fails the gate (5 undeclared vs limit 6 — needs one more)",
  );
  assert(
    testFileRogue.failures.some((failure) => /test-rogue\.ts/.test(failure)),
    "#672-3b: the failure names the uncoupled test file",
  );
  assert(
    testFileRogue.failures.every((failure) => !/test-foo\.ts/.test(failure)),
    "#724: the coupled test file (test-foo.ts) is exempt and not named in the failure",
  );
  assert(
    !testFileRogue.failures.some(
      (failure) => /out-of-scope/.test(failure) && /test-rogue\.ts/.test(failure),
    ),
    "#672-3b: the failure is fanout/undeclared, not out-of-scope (fence semantics unchanged)",
  );

  // #724 — the fanout NUMERATOR: a sibling-declared file in this workstream's
  // changed set must NOT count toward this workstream's fanout. #674 shape:
  // task-b (3 declared) touches 8 files, 4 of which are task-a's declared
  // files. 4 undeclared < limit max(3*3, 6)=9 → pass. (The raw count 8 < 9
  // also passes here, so this case also asserts the message shape below via
  // the sibling-heavy variant in #724-B.)
  filesByWorktree = {
    "task-a": [],
    "task-b": [
      "src/b1.ts",
      "src/b2.ts",
      "src/b3.ts",
      "src/a1.ts",
      "src/a2.ts",
      "src/a3.ts",
      "src/a4.ts",
      "src/a5.ts",
    ],
  };
  const numSibling = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": {
        id: "task-a",
        scope: "a",
        paths: ["src/a1.ts", "src/a2.ts", "src/a3.ts", "src/a4.ts", "src/a5.ts"],
        outOfScope: [],
      },
      "task-b": {
        id: "task-b",
        scope: "b",
        paths: ["src/b1.ts", "src/b2.ts", "src/b3.ts"],
        outOfScope: [],
      },
    }),
    "develop",
  );
  assert(
    numSibling.ok,
    "#724-A: sibling-declared files do not count toward this workstream's fanout numerator",
  );

  // #724 — the gate must not be inert: 10 undeclared files vs 3 declared
  // (limit 9) still fails, and the message reports the UNDECLARED count, not
  // the raw changed count (10 + 2 sibling-declared = 12 raw).
  filesByWorktree = {
    "task-a": [],
    "task-b": [
      "src/b1.ts",
      "src/rogue1.ts",
      "src/rogue2.ts",
      "src/rogue3.ts",
      "src/rogue4.ts",
      "src/rogue5.ts",
      "src/rogue6.ts",
      "src/rogue7.ts",
      "src/rogue8.ts",
      "src/rogue9.ts",
      "src/rogue10.ts",
      "src/a1.ts",
      "src/a2.ts",
    ],
  };
  const numInert = await verifyStepOutcome(
    ctx,
    stateFor({
      "task-a": { id: "task-a", scope: "a", paths: ["src/a1.ts", "src/a2.ts"], outOfScope: [] },
      "task-b": {
        id: "task-b",
        scope: "b",
        paths: ["src/b1.ts", "src/b2.ts", "src/b3.ts"],
        outOfScope: [],
      },
    }),
    "develop",
  );
  assert(
    numInert.failures.some((failure) =>
      /scope fanout: 10 undeclared file\(s\) changed vs 3 declared/.test(failure),
    ),
    "#724-B: the gate still fires on genuine fanout and reports the undeclared count (10), not raw (12)",
  );
} finally {
  if (previousScopeEnv.gate === undefined)
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_GATE");
  else process.env.PI_ENSEMBLE_SCOPE_GATE = previousScopeEnv.gate;
  if (previousScopeEnv.factor === undefined)
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_FACTOR");
  else process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = previousScopeEnv.factor;
  if (previousScopeEnv.minimum === undefined)
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_SCOPE_FANOUT_MIN");
  else process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = previousScopeEnv.minimum;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
