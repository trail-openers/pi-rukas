#!/usr/bin/env bun
/**
 * #2341 — the stale-base arm of the baseline-red handoff: a base that is red
 * only because it predates commits already on the default branch. Real git,
 * real bare origin, `main` advanced past the cycle's base; the [baseline-red]
 * finding must NAME the divergence and the missing commits and must NOT
 * advise fixing the gate at the base commit (an unactionable demand when no
 * change on that base can make it green). The shared builder lives in
 * `lib/verify-baseline-red-harness.ts`; the classic arms stay in
 * `test-verify-baseline-red.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  BASELINE_RED_MARKER,
  BASELINE_STALE_BASE_MARKER,
} from "../src/work-driver-verify-baseline.ts";
import { appendEvent } from "../src/workflow-state.ts";
import {
  runGateFixture,
  type Outcome,
} from "./lib/verify-baseline-red-harness.ts";
import { RUST_CARGO_STREAM } from "./lib/verify-failure-shapes-fixtures.ts";

const run = (
  name: string,
  outcomeFor: (where: "base" | "change", baseRun?: 1 | 2) => Outcome,
  baselineCallbacks: Parameters<typeof runGateFixture>[3] = {},
  opts: { originAhead?: number } = {},
) => runGateFixture(root, name, outcomeFor, baselineCallbacks, opts);

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
const root = mkdtempSync(path.join(tmpdir(), "pi-baseline-stale-"));
const CARGO = `${RUST_CARGO_STREAM}\n`;

// 6 — #2341 AC3/AC5/AC8: a base that is red only because it predates commits
// already on the default branch. Real origin, main advanced 3 commits past the
// cycle's base; the handoff must NAME the divergence and the missing commits
// and must NOT advise fixing the gate at the base commit (nessie 1415: that
// advice was unactionable, and it made an operator-authored acceptance
// criterion impossible to satisfy).
{
  const r = await run("stale-base", () => ({ ok: false, stdout: CARGO }), {}, {
    originAhead: 3,
  });
  const first = r.failures[0] ?? "";
  assert(
    first.startsWith(BASELINE_RED_MARKER) && first.includes(BASELINE_STALE_BASE_MARKER),
    `stale base: the baseline-red finding carries the stale-base marker (got ${first.slice(0, 200)})`,
  );
  assert(
    first.includes("trails main by 3 commits") &&
      first.includes("fix(session): repair fast path bound 3") && // newest-first
      first.includes("fix(session): repair fast path bound 2") &&
      first.includes("(+1 more)"),
    `stale base: the finding names the behind-count and the missing commits, disclosing the cap (got ${first.slice(0, 700)})`,
  );
  assert(
    first.includes("panicked at src/session/fastpath_tests.rs:91:5"),
    "stale base: the finding still quotes the real panic as the assertion at base",
  );
  assert(
    !first.includes("Fix the gate at the base commit"),
    "stale base: the finding does NOT advise fixing the gate at the base commit",
  );
  assert(
    first.includes("divergence, not cause"),
    "stale base: the finding states the causation the probe does NOT claim",
  );
  assert(
    first.length <= 800,
    `stale base: the finding survives the 800-char evidence bound (${first.length})`,
  );
  let st = appendEvent(r.state, {
    kind: "cap-hit",
    at: 0,
    cap: "verify-baseline-red:develop",
    reviewRound: 0,
    nextStep: "handoff",
    evidence: first,
  });
  st = {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      verifyEvidence: { step: "develop", failures: r.failures, at: 0 },
    },
  };
  const explained = explainCap("verify-baseline-red:develop", st);
  assert(
    !explained.includes("Fix the gate at the base commit"),
    `stale base: explainCap(verify-baseline-red) omits the fix-the-base instruction (got ${explained.slice(0, 300)})`,
  );
  assert(
    explained.includes("default branch"),
    "stale base: the handoff names the default branch as what to re-run against",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
