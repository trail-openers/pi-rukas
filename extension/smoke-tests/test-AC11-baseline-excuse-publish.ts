#!/usr/bin/env bun
/**
 * #2042 AC3 (second half) — `publish` discloses the tier `ci` excused, not just the
 * ones `verify` excused.
 *
 * `ci` grades the run's mergeability on the project's FULL tier, and it can excuse
 * that tier over the base commit exactly as `verify` excuses its own. Its proof is
 * recorded on the `ci` step, under its own tier key. The reader of the PR learns
 * about an excused tier from the `## Pre-existing test failures` section, so a body
 * that read only the newest decided `verify`'s record would print a fully-green PR
 * for a run whose full tier exited non-zero and was let go on the base commit's
 * colour — the disclosure `state-outcome.ts` already treats as belonging to BOTH
 * steps (`preexistingFailures: ["verify", "ci"]`) while the renderer looked at one.
 *
 * Four shapes:
 *
 *   (ci-only)  only `ci` excused -> the section prints, under `full`
 *   (both)     `verify` and `ci` each excused a tier -> both print
 *   (newest)   an older `verify` excused and the newest decided one did not -> the
 *              body follows the NEWEST decided verify, as `verifyKind` does
 *   (none)     nobody excused anything -> no heading at all
 */
import { rmSync } from "node:fs";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
import type { Outcome, Step } from "../src/lean/state.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";

const SELF = "test-AC11-baseline-excuse-publish.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** A recorded disclosure of the shape `verify`/`ci` write — head names, total, base sha. */
function rec(cmd: string, names: string[]): PreexistingTierRecord {
  return { cmd, names, total: names.length, baseSha: "b".repeat(40) };
}

const VERIFY_REC = { fast: rec("bun test", ["a.test.ts::t1"]) };
const CI_REC = { full: rec("bun run test:full", ["z_test.go::TestZ"]) };

/** The body the step handed the forge. */
function body(r: Awaited<ReturnType<typeof runPublish>>): string {
  return r.forge.prCreateCalls[0]?.body ?? "";
}

/** A `ci` step carrying the disclosure `ciOutcome` writes on an excused tier. */
function ciStep(outcome: Outcome | undefined): Step[] {
  return [
    {
      key: "9:ci:0",
      state: "ci",
      startedAt: 4,
      ...(outcome === undefined ? {} : { outcome }),
    },
  ];
}

const GREEN_CI = (preexistingFailures: Record<string, PreexistingTierRecord>): Outcome => ({
  kind: "green",
  reason: "required checks CLEAN — pre-existing failures on the base commit",
  preexistingFailures,
});

// ------------------------------------------------------------------- (ci-only)
{
  const r = await runPublish({ issue: 9, preexistingFailures: undefined, extraSteps: ciStep(GREEN_CI(CI_REC)) });
  const b = body(r);
  assert(
    b.includes("## Pre-existing test failures"),
    `(ci-only) a run whose full tier ci excused over the base still discloses it (${r.threw?.message ?? r.outcome?.kind ?? "?"})`,
  );
  assert(b.includes("### `full`"), `(ci-only) the tier is named under ci's own key (${b.slice(b.indexOf("## Pre-existing")).slice(0, 200)})`);
  assert(b.includes("`bun run test:full`"), "(ci-only) the tier's command is printed");
  assert(b.includes("`z_test.go::TestZ`"), "(ci-only) the base-failing name is printed");
}

// --------------------------------------------------------------------- (both)
{
  const r = await runPublish({
    issue: 10,
    // The green verify carries its own tier's disclosure; `ci` carries the full
    // tier's. Both are this run's claims, so both disclose.
    verify: { kind: "green", reason: "frozen tests and project tiers passed" },
    preexistingFailures: VERIFY_REC,
    extraSteps: ciStep(GREEN_CI(CI_REC)),
  });
  const b = body(r);
  assert(b.includes("### `fast`") && b.includes("### `full`"), `(both) both tiers disclose (${b.split("### ").length - 1} tier blocks)`);
  assert(
    b.includes("`a.test.ts::t1`") && b.includes("`z_test.go::TestZ`"),
    "(both) both records' names are printed",
  );
}

// ------------------------------------------------------------------- (newest)
{
  // An OLDER verify excused; the newest decided verify did not. The body follows
  // the newest, exactly as `verifyKind` does — an excuse from a superseded verdict
  // is not a claim this head can make.
  const stale: Step[] = [
    {
      key: "11:verify:0",
      state: "verify",
      startedAt: 1,
      outcome: {
        kind: "green",
        reason: "older verify",
        preexistingFailures: VERIFY_REC,
      },
    },
  ];
  const r = await runPublish({ issue: 11, preexistingFailures: undefined, extraSteps: stale });
  assert(
    !body(r).includes("## Pre-existing test failures"),
    "(newest) an excuse carried only by a SUPERSEDED verify is not disclosed",
  );
}

// --------------------------------------------------------------------- (none)
{
  const r = await runPublish({ issue: 12, extraSteps: ciStep({ kind: "green", reason: "clean" }) });
  assert(
    !body(r).includes("Pre-existing test failures"),
    "(none) a run nobody excused prints no heading",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
