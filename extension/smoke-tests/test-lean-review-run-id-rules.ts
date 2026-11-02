#!/usr/bin/env bun
/**
 * lean/review — the fix-run-id rules that need TWO grammars visible at once (#1930).
 *
 * Split from `test-lean-review-row-roundtrip.ts`, which had passed the 500-line
 * ratchet. The seam is real: the cases that stayed assert that ONE binding governs
 * the field across the write, the fold and the load. The cases here assert the two
 * rules that must NOT be merged with each other — the fold SKIPS a bad row and the
 * loader REFUSES the whole record — plus the reader that decides which tree a
 * resumed attempt re-enters. Each is a claim about the relationship between two
 * grammars, which is the thing a single-grammar file cannot state.
 *
 *   (5b) SKIP, do not REJECT — a valid row survives beside a malformed sibling.
 *   (8)  the RESUME path reads the field back through the validator's own grammar.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { errorOutcome } from "../src/lean/error-outcome.ts";
import { saveRun } from "../src/lean/state.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { FIXTURE_BASE_SHA, makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  FIXER_ROLE,
  cleanupRoots,
  makeRepo,
  setup,
} from "./lib/lean-review-fixtures.ts";
import {
  fixRoundRows,
  fixerOf,
  runWithRows,
  tryLoad,
} from "./lib/lean-review-roundtrip-helpers.ts";

const { assert, failures } = makeAssert();

// ── (5b) SKIP, do not REJECT: one malformed row must not take the array with it ─
//
// Case (1) claimed to tell "a validator that refused the WHOLE array" from "one
// row missing", and could not: under its fixture both produced the identical
// observable — the fixer row absent — so no change to `validatedDispatches` could
// have failed it. Two lenses raised this independently. This case is row-granular:
// a VALID `adversarial-loop` row sits beside a fixer row carrying a malformed
// `runId`, and the assertion is that the valid row SURVIVES while only the fixer is
// dropped. That is the observable separating a per-row `continue` from a whole-array
// `return []`, and it is the one (1) could not see.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const rows = await fixRoundRows(repoRoot, baseSha);
  const adversarial = rows.find((r) => r.role === ADVERSARIAL_GATE_ROLE);
  assert(
    adversarial !== undefined,
    `(5b) precondition: the run billed an ${ADVERSARIAL_GATE_ROLE} row to stand beside the fixer (${JSON.stringify(rows.map((r) => r.role))})`,
  );
  const poisoned = rows.map((r) =>
    r.role === FIXER_ROLE ? { ...r, runId: "not-a-run-id" as DispatchUsageRow["runId"] } : r,
  );
  // (a) the fold, on the path the loader and `errorOutcome` both use.
  const { validatedDispatches } = await import("../src/lean/state-dispatches.ts");
  const kept = validatedDispatches(poisoned);
  assert(
    kept.some((r) => r.role === ADVERSARIAL_GATE_ROLE),
    `(5b) THE VALID ROW SURVIVES a sibling's malformed id: a per-row skip drops the bad row and keeps the good one, where a whole-array refusal drops both — and every other assertion in this file is blind to the difference because they all look at the fixer (${JSON.stringify(kept.map((r) => r.role))} of ${JSON.stringify(poisoned.map((r) => r.role))})`,
  );
  assert(
    kept.some((r) => r.role === FIXER_ROLE) === false,
    "(5b) and the malformed fixer row is the one that went, not merely a row of the same count",
  );
  assert(
    kept.length === poisoned.length - 1,
    `(5b) and exactly ONE row was lost, which is what makes this row-granular rather than array-level (in ${String(poisoned.length)} / out ${String(kept.length)})`,
  );
  // The surviving row is the SAME row, not a re-derived lookalike: its role, its
  // duration and its usage all came from the input that validated cleanly.
  const surviving = kept.find((r) => r.role === ADVERSARIAL_GATE_ROLE);
  assert(
    surviving?.ms === adversarial?.ms && surviving?.usage.cost === adversarial?.usage.cost,
    `(5b) and the surviving row kept what it went in with, so a sibling's refusal is not silently re-writing its numbers (${JSON.stringify([surviving?.ms, surviving?.usage.cost])})`,
  );
  // (b) the same claim through the ERROR path, which folds through the same
  // validator off an untrusted throw — the place a whole-array refusal would cost
  // the operator every child the step paid for, not just the one that was malformed.
  const oc = errorOutcome("review", Object.assign(new Error("x"), { dispatches: poisoned }));
  assert(
    (oc.dispatches ?? []).some((r) => r.role === ADVERSARIAL_GATE_ROLE),
    `(5b) and the error path keeps the valid row too — a whole-array refusal here un-bills the reviewer as well as the fixer (${JSON.stringify((oc.dispatches ?? []).map((r) => r.role))})`,
  );
  assert(
    fixerOf(oc.dispatches ?? []) === undefined,
    "(5b) and still drops the malformed fixer rather than recording a tree name nothing can name",
  );
  // (c) and the harsher path, where a refusal THROWS: `assertRun` rejects the whole
  // record for a malformed row, which is correct there and deliberately NOT the
  // fold's behaviour. Asserting both keeps the two rules from being merged.
  saveRun(repoRoot, runWithRows(poisoned, baseSha));
  const { thrown } = tryLoad(repoRoot, 7);
  assert(
    (thrown as Error)?.name === "LeanStateError" &&
      /runId must be a decimal epoch-millisecond string/.test((thrown as Error)?.message ?? ""),
    `(5c) \`loadRun\` still refuses the WHOLE record for a malformed row — the fold skips and the loader refuses, and collapsing those two would either launder a bad id or lose a whole run over one row (${String(thrown)})`,
  );
}

// ── (8) the RESUME path reads the field back through the validator's own grammar ─
//
// `fixRunIdFromLog` decides which tree a resumed attempt re-enters, and until now
// NOTHING drove it: no case in any suite put a review step with a fixer row in front
// of it. It also carried its own grammar — `Number.isSafeInteger(Number(id.slice(0,
// 17).split("-")[0]))` plus a floor check — which ACCEPTED what `FIX_RUN_ID` refuses,
// so its own comment ("already checked by the validator on the way in") was false and
// a resumed attempt could adopt a tree no writer minted. It now asks `isRunId`, the
// validator's predicate, so the claim holds by construction. These cases are what make
// the routing observable rather than merely true.
{
  const { fixRunIdFromLog } = await import("../src/lean/review-log.ts");
  const { FIX_RUN_ID: SHAPE } = await import("../src/lean/state-dispatches.ts");
  /** A step log holding one decided `review` step whose fixer row carries `runId`. */
  const logWith = (runId: string | undefined) =>
    runWithRows(
      [
        {
          role: FIXER_ROLE,
          ms: 10,
          ok: true,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
          ...(runId === undefined ? {} : { runId: runId as DispatchUsageRow["runId"] }),
        },
      ],
      FIXTURE_BASE_SHA,
    ).steps;

  // The resume case that must work: the composite the writer mints is read back
  // whole, so the resumed attempt names the tree its killed self left.
  const composite = "1793451347919-l-2-0";
  assert(
    fixRunIdFromLog(logWith(composite)) === composite,
    `(8) a resumed attempt reads its OWN composite tree id back off the log and re-enters the tree its killed self left (${String(fixRunIdFromLog(logWith(composite)))} vs ${composite})`,
  );
  // The values the OLD reader accepted and the validator refuses. Each must now
  // answer `undefined` — the step mints a fresh id rather than adopting a tree name
  // nothing wrote. This is the half the false comment papered over.
  for (const acceptedByTheOldGrammarButNotByTheValidator of [
    "1e12",
    "-1793451347919",
    "1793451347919.5",
    "1793451347919-../x",
  ]) {
    assert(
      !SHAPE.test(acceptedByTheOldGrammarButNotByTheValidator),
      `(8) precondition: the validator refuses ${JSON.stringify(acceptedByTheOldGrammarButNotByTheValidator)}`,
    );
    assert(
      fixRunIdFromLog(logWith(acceptedByTheOldGrammarButNotByTheValidator)) === undefined,
      `(8) and the READER now refuses it too, so the resume mints a fresh tree instead of adopting a name no writer minted (read ${JSON.stringify(acceptedByTheOldGrammarButNotByTheValidator)} as ${String(fixRunIdFromLog(logWith(acceptedByTheOldGrammarButNotByTheValidator)))})`,
    );
  }
  // No row, and a row with no id, both answer undefined — the safe direction, and
  // the one that keeps a first attempt from borrowing a stranger's tree.
  assert(
    fixRunIdFromLog(logWith(undefined)) === undefined,
    "(8) a fixer row with no id does not answer, so the step mints a fresh one",
  );
  assert(
    fixRunIdFromLog([]) === undefined,
    "(8) and neither does a log with no review step at all",
  );
}
cleanupRoots();
process.exit(failures());
