#!/usr/bin/env bun
/**
 * #2333 — the driver's own CI-wait comments must not prescribe the shape the
 * issue removes.
 *
 * The fix rewrote the doctrine (`agents-base/ops.md`,
 * `modules/workflows/ci-monitoring.md`, `pi-prompts/do.md`, PM base) and the
 * brief (`work-driver-ci-wait-brief.ts`) to the bounded `sleep 60` + read poll,
 * because a blocking `gh run watch` / `gh pr checks --watch` is the shape in
 * which an ops child ended its turn mid-wait and the merge never happened.
 *
 * What was missed is the driver's own source prose, which still told the next
 * reader that CI waiting is a blocking watch:
 *
 *   - `work-driver-stepback-ci.ts` — "Step 8 — CI monitoring. ops runs `gh run
 *     watch`", "PR15 — … `gh run watch` blocks until CI completes", and two
 *     "verify-full runs BEFORE the ops gh-run-watch dispatch".
 *   - `work-driver-ci-wait-brief.ts` — "the driver routes an absent `ci-status`
 *     to failure and has no `pending` arm". `routeCiTier` DOES have one
 *     (`ci-status{pending}` → stay at `ci`), verified by the probe below; the
 *     absent-marker half is true, and the two must not be collapsed.
 *   - `dispatch.ts` — the timeout-override note attributes `ciWatchTimeoutMs`
 *     to "`gh run watch` blocks for a real CI run".
 *
 * The prose is the reason the code exists, so a stale sentence here is how the
 * watch comes back: an agent or a maintainer reading "ops runs `gh run watch`"
 * has nothing in the file telling it otherwise, and
 * `test-ci-doctrine-poll.ts` reads only doctrine and the brief.
 *
 * **The classifier is the shipped one** (`blockingWatchPrescribed` from
 * `lib/ci-doctrine.ts`), so this gate reds on the same rule the doctrine gate
 * uses — plus the `pending`-arm check, which is the jsdoc counterpart: what a
 * comment asserts about the router is checked against the router.
 *
 * **Observed red**: on the commit that added this file, before the comment
 * fixes, all five assertions in the two blocks below fail.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { blockingWatchPrescribed } from "./lib/ci-doctrine.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";

const SELF = "test-ci-doctrine-driver-comments.ts";
const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

/** Driver modules whose prose describes the CI wait that #2333 changed. */
const DRIVER_FILES = [
  "extension/src/work-driver-stepback-ci.ts",
  "extension/src/work-driver-ci-wait-brief.ts",
  "extension/src/dispatch.ts",
];

for (const rel of DRIVER_FILES) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  const hits = blockingWatchPrescribed(text);
  assert(
    hits.length === 0,
    `${rel}: its comments describe the CI wait as the bounded poll, not a blocking watch${
      hits.length ? `:\n${hits.join("\n")}` : ""
    }`,
  );
  // The watch names survive only as negations ("never a blocking watch"), so the
  // bare "ops runs `gh run watch`" / "blocks until CI completes" phrasings must
  // be gone outright — those are the sentences that PRESCRIBE it in prose the
  // clause-scoped negation test cannot see as a prohibition.
  assert(
    !/ops runs `?gh run watch/i.test(text) && !/`gh run watch` blocks/i.test(text),
    `${rel}: no comment states that CI waiting IS a blocking \`gh run watch\``,
  );
}

// ------------------------------------------- the `pending`-arm claim, checked

{
  // What the brief's jsdoc asserts about the router, verified against the router:
  // an ABSENT marker routes to develop (burning a ci-retry), while an explicit
  // `ci-status: pending` has an arm that stays at `ci`. The two are different
  // facts and the comment may not collapse one into the other — "has no pending
  // arm" reads as "pending cannot happen", which is what let the doctrine skip
  // pinning the marker's LAST-line rule against the router.
  const base = initialState();
  const atCi = { ...base, pipelineState: { ...base.pipelineState, currentStep: "ci" as const } };
  const routeFor = (events: unknown[]) =>
    nextStep({ ...atCi, eventLog: events } as never) as { step?: string };

  const pending = routeFor([
    { kind: "dispatch-completed", at: 1, stage: "ci", summary: "ci-status: pending" },
    { kind: "ci-status", at: 2, status: "pending" },
  ]);
  const absent = routeFor([
    { kind: "dispatch-completed", at: 1, stage: "ci", summary: "no marker here" },
    { kind: "ci-status", at: 2, status: "failure" },
  ]);

  assert(
    pending.step === "ci",
    `the router DOES have a pending arm: ci-status{pending} routes to "${String(
      pending.step,
    )}" (stay at ci), not develop`,
  );
  assert(
    absent.step === "develop",
    `an absent marker is the failure path: ci-status{failure} routes to "${String(absent.step)}"`,
  );

  const briefSrc = readFileSync(
    path.join(ROOT, "extension/src/work-driver-ci-wait-brief.ts"),
    "utf8",
  );
  assert(
    !/has no `?pending`? arm/i.test(briefSrc),
    "work-driver-ci-wait-brief.ts: does not claim the router has no `pending` arm (routeCiTier has one)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
