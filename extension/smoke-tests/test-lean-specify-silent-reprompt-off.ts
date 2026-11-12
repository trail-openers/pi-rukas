#!/usr/bin/env bun
/**
 * #2212 / R5 — the silent child's decline with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`.
 *
 * Split from `test-lean-specify-silent-reprompt.ts`, which holds the switch-on
 * cases (1)–(7). Those drive the retry machinery with the switch at its default;
 * the two cases here drive the SAME fixture with the env var pinned to `0`, and
 * each is the mirror of a case in that file — same repo shape, same child
 * behaviour, same expectations except the WORDING. The pairing is the assertion:
 * R5 says the switch moves only the generic decline rule, so the silence predicate
 * and its single retry must come out identical on both sides, and a case that
 * checked the off arm in isolation could pass with the retry silently disabled.
 *
 *   (8) mirrors (2) — silent twice: still two dispatches, still the nudge on the
 *       second prompt, still `no-red-test` with the retry marker, and every rule
 *       v0.14.71's `criterion AC1 has no red test` rather than the never-submitted
 *       clause;
 *   (9) mirrors (1) — silent once, submits on the nudge: the test still freezes,
 *       which is the retry's machinery demonstrably shared rather than merely
 *       counted.
 *
 * The probe and the submodule init are switched too, so "no probe argv" would be
 * true of the shape and not of the switch; what is asserted is the rule text,
 * which the switch is the only thing that moves.
 *
 * Real temp repos, real git, the real `execp`; the fake child is the only stub.
 */

import { rmSync } from "node:fs";
import {
  ROOTS,
  type RunResult,
  configWith,
  makeRepo,
  redScript,
  runSpecify,
  submit,
  report as reportShared,
} from "./lib/lean-specify-fixture.ts";
import { withEnv } from "./lib/env-scope.ts";
// The shared constants and helpers live in the fixture both files import, so the
// pair cannot drift apart and disagree about what the nudge text or the retry marker
// is — a pair that disagrees about its needle asserts nothing about the pair.
import {
  CONFIG,
  NEVER_SUBMITTED,
  NUDGE,
  RETRY_NOTE,
  TEST_REL,
  writeTest,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
/** The one assertion both files share, on this file's own tally. */
function report(r: RunResult, label: string): void {
  reportShared(r, label, assert);
}
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (8) case (2)'s silent child, with the switch at 0, gets (2)'s rules and v0.14.71's wording
{
  // R5's wording arm, on the retry path rather than the plain decline. Two things
  // must both hold with the switch at `0`, and neither is covered by any case in
  // the switch-on file: the retry GATE still fires (the silence predicate and its
  // single retry are NOT switched — they exist in v0.14.71 and only the rule that
  // WORDS them is), and the decline's WORDING is v0.14.71's, which means the
  // never-submitted clause is GONE and every rule is the coverage rule.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  let r: RunResult | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    r = await runSpecify({
      repoRoot,
      baseSha,
      issue: 18,
      config: CONFIG,
      prompts,
      writes: (wt) => {
        writeTest(wt, redScript());
      },
      toolUses: () => [],
    });
  });
  report(r!, "(8)");
  assert(
    r!.dispatched === 2,
    `(8) the retry gate is not switched: a silent child is still re-dispatched once (got ${r!.dispatched})`,
  );
  assert(
    prompts[1]?.includes(NUDGE) === true,
    "(8) and the re-prompt still carries the nudge — the retry's PROMPT is not switched either",
  );
  assert(
    r!.outcome?.kind === "no-red-test",
    `(8) the run still declines (got ${r!.outcome?.kind})`,
  );
  assert(
    (r!.outcome?.failedRules ?? []).every((x) => x.startsWith("criterion AC1 has no red test")),
    `(8) with the switch at 0 every rule is v0.14.71's coverage rule (got ${JSON.stringify(r!.outcome?.failedRules)})`,
  );
  assert(
    (r!.outcome?.failedRules ?? []).every((x) => !x.startsWith(NEVER_SUBMITTED)),
    `(8) and the never-submitted clause is gone from every rule (got ${JSON.stringify(r!.outcome?.failedRules)})`,
  );
  assert(
    (r!.outcome?.reason ?? "").includes(NEVER_SUBMITTED) === false,
    `(8) the reason does not claim it either (got ${r!.outcome?.reason})`,
  );
  assert(
    r!.outcome?.reason?.includes(RETRY_NOTE) === true,
    `(8) and the retry marker is still there — the retry happened, the WORDING is what changed (got ${r!.outcome?.reason})`,
  );
}

// ── (9) case (1)'s child, with the switch at 0, still gets its test frozen on the re-prompt
{
  // R5's other half, on the arm where the retry SUCCEEDS. The switch moves the
  // decline's wording only, so a child that is silent once and submits on the
  // nudge must still freeze its test with the switch at 0: same two dispatches,
  // same nudge on the second prompt, same frozen path. Asserted against case (1)
  // rather than restated, because the pair is what shows the retry's MACHINERY is
  // shared — an off arm that silently stopped re-dispatching would fail here and
  // not in (8), where the child never submits anything either way.
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const prompts: string[] = [];
  let r: RunResult | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    r = await runSpecify({
      repoRoot,
      baseSha,
      issue: 19,
      config: CONFIG,
      prompts,
      writes: (wt, dispatch) => {
        writeTest(wt, redScript());
        if (dispatch === 1) return;
      },
      toolUses: (dispatch) => (dispatch === 1 ? [] : [submit("AC1", [TEST_REL])]),
    });
  });
  report(r!, "(9)");
  assert(
    r!.dispatched === 2,
    `(9) the re-prompt fires with the switch at 0 too (got ${r!.dispatched})`,
  );
  assert(
    r!.outcome?.kind === "ok",
    `(9) and the test it finally submits freezes (got ${r!.outcome?.kind})`,
  );
  assert(
    Object.keys(r!.outcome?.frozen ?? {}).join() === TEST_REL,
    `(9) at the submitted path (got ${Object.keys(r!.outcome?.frozen ?? {}).join()})`,
  );
  assert(
    prompts.length === 2 && prompts[0]?.includes(NUDGE) !== true,
    "(9) the first prompt carries no nudge, as with the switch on",
  );
  assert(prompts[1]?.includes(NUDGE) === true, "(9) and the second one carries it");
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
