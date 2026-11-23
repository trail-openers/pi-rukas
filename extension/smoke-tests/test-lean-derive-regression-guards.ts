#!/usr/bin/env bun
/**
 * #2415 — derive sets a ticket line that only asks existing checks to keep passing
 * beside the criteria as a regression guard, so `specify` never demands a red test a
 * guard cannot have, and the run's full verify tier is what enforces it.
 *
 * The field shape: a prose ticket ending "The existing colour check and the build
 * still pass." became its own criterion, its test exited 0 on base, and specify
 * refused the run `not-ready` at exit 11. The cases drive the mapper, the persisted
 * record's gate, the intake's guards-only decline, the real `specify` step over a real
 * git repo, and `ci`'s full tier. The split ships always-on — its off arm was the
 * defect this retires — so every case runs on the ambient environment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/lean/config.ts";
import { GUARDS_ONLY_RULE, isRegressionGuard } from "../src/lean/derive-guards.ts";
import { derivePrompt, parseDerivedBlock } from "../src/lean/spec-derive.ts";
import { contractOf } from "../src/lean/spec-intake.ts";
import { derivedSpecProblem } from "../src/lean/state-derived-spec.ts";
import type { DerivedSpec } from "../src/lean/state-derived-spec.ts";
import { cleanUp, run as runCi } from "./lib/lean-ci-recorder.ts";
import { deriveReply } from "./lib/lean-spec-intake-fixtures.ts";
import { removeDir } from "./lib/lean-spec-intake-fixtures.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  greenScript,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

const GUARD = "The existing colour check and the build still pass.";
const NEW = "retries a transient failure twice before failing";
const REPLY = deriveReply([NEW, GUARD]);

// ── AC1: the mapper turns the guard line into a guard, not a red-test criterion.
{
  assert(
    derivePrompt({ title: "t", body: "b" }).includes('"guards"'),
    "on: the brief asks for guards",
  );
  const c = parseDerivedBlock(REPLY);
  assert(
    c?.spec.criteria.length === 1 && c.spec.criteria[0]?.text === NEW,
    `on: only the new behaviour is a criterion (${JSON.stringify(c?.spec.criteria)})`,
  );
  assert(c?.guards?.[0]?.text === GUARD && c.guards.length === 1, "on: the line is a guard");
  assert(
    derivedSpecProblem({ ...c, model: "", at: 0 }) === undefined,
    "on: the record with its guard passes the persisted-contract gate",
  );
  const mixed = "the helper returns 3 and the existing build still passes";
  assert(!isRegressionGuard(mixed), "a mixed sentence keeps its new-behaviour criterion");
  for (const s of ["No regressions.", "Nothing else changes", "All existing tests keep passing."])
    assert(isRegressionGuard(s), `"${s}" is a guard`);
  // The child may list guards itself; the band counts criteria plus guards.
  const listed = deriveReply(["a", "b", "c"]).replace(
    '"size"',
    '"guards": ["the other pages still work"], "size"',
  );
  const l = parseDerivedBlock(listed);
  assert(
    l?.guards?.[0]?.text === "the other pages still work" && l.spec.size === "M",
    `a child-listed guard rides beside the criteria and counts toward size (${JSON.stringify(l)})`,
  );
  if (l !== undefined) {
    const stamped = derivedSpecProblem({ ...l, spec: { ...l.spec, size: "S" }, model: "", at: 0 });
    assert(
      stamped?.includes("1 guards") === true,
      `a band that ignores the guard is refused (${stamped})`,
    );
  }
  // A listed guard the child also left in criteria — one the classifier misses, one it
  // matches with other trailing punctuation — is one guard each: six features plus two stay M.
  const keep = "The existing tests still pass";
  const both = deriveReply([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "The build stays green.",
    `${keep}.`,
  ]).replace('"size"', `"guards": ["The build stays green", "${keep}"], "size"`);
  const d = parseDerivedBlock(both);
  assert(
    d?.spec.criteria.length === 6 && d.guards?.length === 2 && d.spec.size === "M",
    `a guard listed in both fields counts once, as a guard (${JSON.stringify(d)})`,
  );
  // The match ignores case: a child that capitalises the guard it lists differently from the
  // criterion it left behind still gets one guard, not a no-red criterion beside it.
  const cased = parseDerivedBlock(
    deriveReply(["a", "b", "the build stays green."]).replace(
      '"size"',
      '"guards": ["The Build stays green"], "size"',
    ),
  );
  assert(
    cased?.spec.criteria.length === 2 && cased.guards?.length === 1,
    `a listed guard matches its criterion whatever the case (${JSON.stringify(cased)})`,
  );
  assert(!isRegressionGuard("The other tabs still work."), "an 'other' subject stays a criterion");
  assert(
    derivedSpecProblem({ ...c, guards: [], model: "", at: 0 }) !== undefined,
    "an empty guards field is not one derive writes",
  );
}

// ── R5: a ticket that is only guards declines with its own reason, never as a missing red test.
{
  const out = await contractOf(
    "/nonexistent",
    7,
    "prose",
    { baseSha: "b", specIntake: "derive" },
    defaultConfig(),
    {
      issueTitle: async () => "t",
      loadConfig: async () => defaultConfig(),
      dispatch: async () => ({
        role: "explore",
        ok: true,
        text: deriveReply([GUARD]),
        toolUses: [],
        exitCode: 0,
        ms: 1,
      }),
    },
  );
  assert(
    "rule" in out && out.rule === GUARDS_ONLY_RULE && out.infra !== true,
    `guards only: a not-ready decline naming its cause (${JSON.stringify(out)})`,
  );
}

// ── AC2: specify, driven with the derived contract, never refuses over the guard.
async function specifyArm() {
  const contract = parseDerivedBlock(REPLY);
  if (contract === undefined) throw new Error("no contract");
  const derivedSpec: DerivedSpec = { ...contract, model: "", at: 0 };
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  // The guard's own test is green on base: the colour check and the build already pass.
  const guardTest: { criterionId: string; testFiles: string[] }[] = [];
  return runSpecify({
    repoRoot,
    baseSha,
    issue: 2415,
    config: configWith({ fast: "true", test: RUNNER }),
    specBody: "A prose ticket with no block.",
    derivedSpec,
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      writeFileSync(path.join(wt, "tests/AC2-guard.test.sh"), greenScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"]), ...guardTest],
  });
}
{
  const ok = await specifyArm();
  assert(
    ok.outcome?.kind === "ok",
    `specify freezes the red test and never asks one of the guard (${JSON.stringify(ok.outcome ?? ok.threw?.message)})`,
  );
}

// ── AC3: the guard still runs. The broken-build case pins the pre-existing invariant the split
// relies on (a failing full tier is red whatever the contract); the no-tier case is this change's.
{
  const contract = parseDerivedBlock(REPLY);
  const derivedSpec = contract === undefined ? undefined : { ...contract, model: "", at: 0 };
  const broken = await runCi({ full: "tier", tierExit: 3, derivedSpec });
  assert(
    broken.outcome?.kind === "red",
    `a run that breaks the build is sent back (${broken.outcome?.reason})`,
  );
  const none = await runCi({ derivedSpec });
  assert(
    none.outcome?.kind === "red" && (none.outcome.reason ?? "").includes(GUARD),
    `no full tier: the refusal names the guard it is needed for (${none.outcome?.reason})`,
  );
}

cleanUp();
for (const r of ROOTS) removeDir(r);
if (failed !== 0) process.exit(1);
console.log("All derive regression-guard checks passed.");
