#!/usr/bin/env bun
/**
 * lean/review — the fixer's cost row SURVIVES the round trip to disk (#1930).
 *
 * This is the test the field did not have, and the reason it did not have one is
 * the defect: every prior assertion on `runId` (`test-lean-review-tree.ts` (s),
 * `test-lean-review-wiring.ts` (T1), and `lib/lean-review-fixtures.ts`'s
 * `fixRunId`) tested the value against `FIX_RUN_ID_SHAPE` imported from
 * `review-log.ts` — the PERMISSIVE of the two grammars, the one that had admitted
 * the composite in the first place. Writer and assertion agreed; neither agreed
 * with the loader, which held `/^[0-9]{13,17}(-[0-9]{1,9})?$/` and `continue`d
 * past the row. A review that fixed anything therefore reported a `developer`
 * total of zero while every test that was supposed to catch it stayed green.
 *
 * So this file asserts through the PRODUCTION path and nothing else, with no
 * regex constant in sight:
 *
 *   (1) the fixer's row is built by the real `fixRound` → `runFixer` →
 *       `dispatchUsageRow` chain — the step handler itself, against a real temp
 *       repo with a real fixer commit, the fixture's `dispatch` seam only standing
 *       in for the model — and then `saveRun`'d and `loadRun`'d. The `developer`
 *       row is asserted to be PRESENT afterwards, with the tree identity and the
 *       child's own duration intact. A validator that `continue`s past the row
 *       fails this case, which is exactly what the old assertions could not do.
 *   (2) the same on the engine's error path: `errorOutcome("review", err)` reads
 *       rows off an untrusted throw through `validatedDispatches`, so a refusal
 *       that lost the fixer is caught here too and not only on a clean `done`.
 *   (3) the `loadRun` → `assertRun` → `outcomeProblem` → `dispatchesProblem` path
 *       THROWS rather than dropping, so the pre-validation row is written raw and
 *       the file is asserted readable. This is the harsher half of the same
 *       disagreement: a writer that produces what the validator refuses turns the
 *       run's whole state file into an unreadable record.
 *   (4) per-role cost, folded by `leanUsage`, which is what the headless result
 *       reports as `usage.byRole`: the number under-billed by the defect.
 *   (5) the anti-self-reference check that earns its lines. The three other suites
 *       assert the field against a regex constant, so the one thing they can never
 *       catch is the constant and the validator disagreeing. Here the constant is
 *       pinned to the validator's OWN binding — a `===` on the two objects — and
 *       driven on both kinds of value a disagreement shows up in: the composite the
 *       writer mints must satisfy BOTH, and a malformed id must be refused by the
 *       production validator, by the constant, and by `loadRun`. If either grammar
 *       is edited away from the other, the shared-binding case goes red, which is
 *       precisely what the old trio could not do.
 *   (6) the writer's own form, recovered from the real tree path the fixer ran in:
 *       arm, round, attempt and epoch must all be present in the row's identity,
 *       because that suffix is what keeps the two arms of one round off one tree.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { errorOutcome } from "../src/lean/error-outcome.ts";
import { FIX_RUN_ID_SHAPE } from "../src/lean/review-log.ts";
import type { ReviewInfraError } from "../src/lean/review.ts";
import { FIX_RUN_ID } from "../src/lean/state-dispatches.ts";
import { createRun, leanStateFile, loadRun, saveRun } from "../src/lean/state.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { leanUsage } from "../src/lean/usage-sum.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { FIXTURE_BASE_SHA, makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  ADVERSARIAL_GATE_ROLE,
  BRANCH,
  FIXER_ROLE,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();
/**
 * The four fixtures both fix-run-id suites need — a step that buys exactly one
 * fixer, a record carrying given rows, and a `loadRun` that reports its throw —
 * now in `lib/lean-review-roundtrip-helpers.ts`, shared with
 * `test-lean-review-run-id-rules.ts` so neither suite keeps its own definition of
 * the shape the engine persists.
 */
import {
  FIXER_MS,
  FIXER_USAGE,
  fixRoundRows,
  fixerOf,
  runWithRows,
  tryLoad,
} from "./lib/lean-review-roundtrip-helpers.ts";

// ── (1)+(4) the durable round trip, through the engine's own write and read ─
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const rows = await fixRoundRows(repoRoot, baseSha);
  const before = fixerOf(rows);
  // Precondition, not a verdict: without a fixer row on the way IN, every
  // assertion below would pass on an empty array.
  assert(before !== undefined, `(1) precondition: the step billed a ${FIXER_ROLE} row at all`);
  assert(
    before?.runId?.includes("-") === true,
    `(1) precondition: the row carries a COMPOSITE tree identity — arm, round and attempt, not just the epoch (${String(before?.runId)})`,
  );
  assert(
    before?.ms === FIXER_MS,
    `(1) precondition: the row carries the child's own duration (${String(before?.ms)})`,
  );

  const beforeRoles = rows.map((r) => r.role);
  saveRun(repoRoot, runWithRows(rows, baseSha));
  const { loaded, thrown } = tryLoad(repoRoot, 7);
  assert(thrown === undefined, `(1) the state file the step produced loads (${String(thrown)})`);
  const after = fixerOf(loaded?.steps[0]?.outcome?.dispatches ?? []);
  // Absence decided twice, and both ways. First POSITIVELY: the row exists on the
  // way in (preconditions above) and the loader hands back an array that counts it,
  // so the count below can only fall short by the validator dropping it. Then the
  // assertion itself — the one that fails on a silent deletion.
  const afterRows = loaded?.steps[0]?.outcome?.dispatches ?? [];
  assert(
    afterRows.length === beforeRoles.length,
    `(1) every child the step paid for is in the record the loader handed back — the loader's answer to a disagreement is a SILENT deletion, since \`validatedDispatches\` \`continue\`s past a row it refuses rather than rejecting the array (in ${String(beforeRoles.length)} / out ${String(afterRows.length)}: ${JSON.stringify(afterRows.map((r) => r.role))})`,
  );
  assert(
    after !== undefined,
    `(1) THE FIXER'S ROW IS STILL THERE AFTER saveRun + loadRun — the assertion the three regex-constant tests could not make (${JSON.stringify(afterRows.map((r) => r.role))})`,
  );
  assert(
    after?.runId === before?.runId,
    `(1) and it comes back with the SAME tree identity it went in with, so a resumed attempt can still name the tree its killed self left (in ${String(before?.runId)} / out ${String(after?.runId)})`,
  );
  assert(
    after?.ms === FIXER_MS,
    `(1) and its duration survived too — not a 13-digit epoch smuggled through \`ms\` (${String(after?.ms)})`,
  );
  assert(
    after?.usage.cost === FIXER_USAGE.cost && after?.usage.input === FIXER_USAGE.input,
    `(1) and its usage survived, which is what \`usage.byRole\` sums (${JSON.stringify(after?.usage)})`,
  );
  // The adversarial/lens rows must be intact as well: a validator that refused the
  // WHOLE array would read as "no rows at all" rather than as one row missing, and
  // the two are different defects with different fixes.
  assert(
    rows.length > 0 && JSON.stringify(afterRows.map((r) => r.role)) === JSON.stringify(beforeRoles),
    `(1) and no OTHER row was lost on the way — the fixer was the only one at risk, so a whole-array refusal is a different bug and this tells them apart (in ${JSON.stringify(beforeRoles)} / out ${JSON.stringify(afterRows.map((r) => r.role))})`,
  );

  // (4) the number the defect actually got wrong: per-role cost, as the headless
  // result reports it in `usage.byRole`. It was zero for a step that paid for a
  // fixer, because the fold reads the rows the loader kept.
  const usage = leanUsage(loaded?.steps ?? []);
  const developer = usage.byRole[FIXER_ROLE];
  assert(
    developer !== undefined && developer.dispatches === 1,
    `(4) the fold sees the fixer at all: byRole.${FIXER_ROLE} holds one row (${JSON.stringify(developer)})`,
  );
  assert(
    developer?.cost === FIXER_USAGE.cost && developer?.input === FIXER_USAGE.input,
    `(4) and per-role cost is NOT understated — the under-billing T1 was written to eliminate (${String(developer?.cost)} vs ${String(FIXER_USAGE.cost)}; zero here is the bug)`,
  );
}

// ── (2) the same rows on the ERROR path, where the loader is not the guard ──
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const rows = await fixRoundRows(repoRoot, baseSha);
  // A throw carrying the rows is what a fix round that died still leaves behind,
  // and `errorOutcome` is the one thing that moves them onto the record. It reads
  // an UNTRUSTED throw through `validatedDispatches` — the same `continue`-past
  // logic — so a disagreement here loses the row on a path nobody reviews.
  const err = Object.assign(new Error("the fix child failed"), { dispatches: rows });
  const oc = errorOutcome("review", err);
  const kept = fixerOf(oc.dispatches ?? []);
  assert(
    kept !== undefined,
    `(2) the error path keeps the fixer's row too: a child that died still spent its tokens, and \`errorOutcome\` folding through the same validator is where a silent drop costs the most (${JSON.stringify((oc.dispatches ?? []).map((r) => r.role))})`,
  );
  assert(
    kept?.runId === fixerOf(rows)?.runId,
    `(2) and the identity is not rewritten on the way out (${String(kept?.runId)})`,
  );
  // And the record the error path wrote reads back, because this is what the
  // handoff prints and what a resume drives from.
  saveRun(repoRoot, runWithRows(oc.dispatches ?? [], baseSha));
  assert(
    fixerOf(tryLoad(repoRoot, 7).loaded?.steps[0]?.outcome?.dispatches ?? []) !== undefined,
    "(2) and the record the error path wrote reads back with its fixer row",
  );
}

// ── (3) the raw write, through the path that THROWS instead of dropping ─────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const rows = await fixRoundRows(repoRoot, baseSha);
  // The engine's `settle` folds through `validatedDispatches` before it saves, so
  // it escapes a rejecting validator. Anything that persists the writer's rows
  // RAW does not: `loadRun` → `assertRun` → `outcomeProblem` → `dispatchesProblem`
  // THROWS `LeanStateError`, which makes the run's whole state file unreadable —
  // the worse half of the same disagreement, and the half no regex-constant test
  // could see because none of them wrote a file.
  const file = leanStateFile(repoRoot, 7);
  saveRun(repoRoot, runWithRows(rows, baseSha));
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    steps: { outcome: { dispatches: unknown[] } }[];
  };
  assert(
    rows.length > 0 && raw.steps[0]?.outcome?.dispatches.length === rows.length,
    `(3) precondition: the file on disk holds the RAW rows the writer produced, un-folded (${String(raw.steps[0]?.outcome?.dispatches.length)} of ${String(rows.length)})`,
  );
  assert(
    raw.steps[0]?.outcome?.dispatches.some(
      (r) =>
        (r as DispatchUsageRow).role === FIXER_ROLE && (r as DispatchUsageRow).runId !== undefined,
    ) === true,
    "(3) precondition: the raw record carries the fixer row with its composite id",
  );
  const { loaded, thrown } = tryLoad(repoRoot, 7);
  assert(
    thrown === undefined,
    `(3) the state file the writer produced READS BACK — \`assertRun\` refuses a row its validator rejects, so before the grammars were one this made the entire record unreadable (${String(thrown)})`,
  );
  assert(
    fixerOf(loaded?.steps[0]?.outcome?.dispatches ?? []) !== undefined,
    "(3) and by the loader's own hand, not by a regex in this file",
  );
}

// ── (5) the two grammars are ONE binding, and both refuse what must be refused
{
  // The three other suites assert the field against a regex CONSTANT, which is a
  // shape no test can audit: if the constant and the validator's own literal
  // disagree — which is exactly what shipped — every assertion through the
  // constant agrees with the writer and none agrees with what the loader enforces.
  // So the constant is pinned to the validator's OWN binding, by identity rather
  // than by agreement, and then driven on both kinds of value a disagreement shows
  // up in. `===` on two regexes is true only for the same object, so re-exporting
  // one rule is the only way this case passes.
  assert(
    FIX_RUN_ID_SHAPE === FIX_RUN_ID,
    `(5) the constant the other three suites assert against IS the production validator's own rule, not a second literal that happens to agree (shape ${String(FIX_RUN_ID_SHAPE)} vs validator ${String(FIX_RUN_ID)}) — this is the assertion whose absence let a permissive constant and a digits-only validator coexist while every test stayed green`,
  );
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const rows = await fixRoundRows(repoRoot, baseSha);
  const id = fixerOf(rows)?.runId;
  assert(id !== undefined, "(5) precondition: the writer produced a tree identity to check");
  // The value the writer actually mints satisfies BOTH spellings of the rule —
  // production's, and the constant the other suites read.
  assert(
    FIX_RUN_ID.test(String(id)),
    `(5) the composite the writer mints passes the production validator (${String(id)})`,
  );
  assert(
    FIX_RUN_ID_SHAPE.test(String(id)),
    `(5) and the constant the other three suites assert against, which the digits-only copy refused (${String(id)})`,
  );
  // The negative the widening must NOT have lost: values `Number()` would happily
  // accept, and one path-shaped suffix, refused by the validator, by the constant,
  // and by `loadRun` — three independent readings of the same rule.
  for (const bad of ["1e12", "-1793451347919", "1793451347919.5", "1793451347919-../x"]) {
    assert(!FIX_RUN_ID.test(bad), `(5) the validator still refuses ${JSON.stringify(bad)}`);
    assert(
      !FIX_RUN_ID_SHAPE.test(bad),
      `(5) and so does the shared constant, so the two cannot disagree in either direction (${JSON.stringify(bad)})`,
    );
    const stray = rows.map((r) =>
      r.role === FIXER_ROLE ? { ...r, runId: bad as DispatchUsageRow["runId"] } : r,
    );
    saveRun(repoRoot, runWithRows(stray, baseSha));
    const { thrown } = tryLoad(repoRoot, 7);
    assert(
      (thrown as Error)?.name === "LeanStateError" &&
        /runId must be a decimal epoch-millisecond string/.test((thrown as Error)?.message ?? ""),
      `(5) and \`loadRun\` refuses a row carrying ${JSON.stringify(bad)} at load, naming the field — widening admitted the arm letters, it did not stop validating the field (${String(thrown)})`,
    );
  }
  // The malformed row must not be laundered into a cost record through the error
  // path either: the fold drops it rather than recording a tree name nothing owns.
  const oc = errorOutcome(
    "review",
    Object.assign(new Error("x"), {
      dispatches: rows.map((r) =>
        r.role === FIXER_ROLE ? { ...r, runId: "not-a-run-id" as DispatchUsageRow["runId"] } : r,
      ),
    }),
  );
  assert(
    fixerOf(oc.dispatches ?? []) === undefined,
    "(5) and the error path drops a malformed row rather than recording a tree name nothing can name",
  );
}

// ── (6) the writer's own form, recovered from the tree the fixer ran in ─────
{
  // `fixRound` mints `${runId}-${arm}-${round}-${attempt}`; the validator must keep
  // pace with any change there. Reading the real suffix out of the real tree path
  // the child was dispatched to is what makes this a check on the WRITER rather
  // than a hand-typed literal that could simply agree with whatever the validator
  // happens to be.
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  let seenTree = "";
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({
      adversarial: rejectsThenClears("1. silent catch"),
      dispatch: async (spec) => {
        const wt = spec.cwd as string;
        seenTree = path.basename(wt);
        put(wt, "fix.ts", "export const x = 1;\n");
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", "fix: the finding");
        return result({ role: FIXER_ROLE });
      },
    }),
  );
  assert(threw === undefined, `(6) the fix round completed (${threw?.message})`);
  const name = /^lean-7-fix-([al])-(\d+)-(\d+)-(\d{13,17})$/.exec(seenTree);
  assert(
    name !== null,
    `(6) precondition: the fixer ran in a tree named for arm/round/attempt/epoch (${seenTree})`,
  );
  const id = fixerOf(outcome?.dispatches ?? [])?.runId;
  assert(
    id !== undefined && id.split("-")[0] === name?.[4],
    `(6) the row's identity carries the attempt's epoch the tree is named for (${String(id)} vs ${seenTree})`,
  );
  assert(
    id?.endsWith(`-${name?.[1]}-${name?.[2]}-${name?.[3]}`) === true,
    `(6) and the arm/round/attempt suffix, which is what keeps the two arms of one round off one tree — the collision \`worktree add --force\` ADOPTS rather than refuses (${String(id)})`,
  );
}

// The field stays optional: a run that dispatched nothing must still load, so
// nothing above taught the loader to require an id.
{
  const { repoRoot, baseSha } = makeRepo();
  const rec = createRun({
    issue: 9,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: "x",
  });
  saveRun(repoRoot, { ...rec, issue: 9 });
  assert(
    loadRun(repoRoot, 9) !== undefined,
    "(7) a run with no dispatches at all still loads — `runId` is optional and stays so",
  );
}

cleanupRoots();
process.exit(failures());
