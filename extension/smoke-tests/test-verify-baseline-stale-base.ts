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
import { boundJoinFailures } from "../src/work-develop-cap-evidence.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import {
  BASELINE_RED_MARKER,
  BASELINE_STALE_BASE_MARKER,
  type BaseBehindDefaultBranch,
  type RedBaselineVerdict,
  baselineRedMessage,
} from "../src/work-driver-verify-baseline.ts";
import { appendEvent } from "../src/workflow-state.ts";
import {
  CMD,
  runGateFixture,
  type Outcome,
} from "./lib/verify-baseline-red-harness.ts";
import {
  NESSIE_TEST,
  RUST_CARGO_STREAM,
  RUST_PANIC_ASSERTION,
  RUST_PANIC_AT,
} from "./lib/verify-failure-shapes-fixtures.ts";

/** A fully-evidenced `red` arm carrying the stale-base answer under test. */
function redArm(
  assertion: string,
  staleBase?: BaseBehindDefaultBranch,
): RedBaselineVerdict {
  return {
    status: "red",
    assertion,
    rawStream: RUST_CARGO_STREAM,
    probed: true,
    exitCode: 101,
    ...(staleBase === undefined ? {} : { staleBase }),
  };
}

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

// 7 — #2341 round 1: THE 800-CHAR CAP-EVIDENCE BOUND IS ENFORCED, not
// asserted. The review measured the rendered message at 840–934 chars for a
// 267–400-char assertion (the store-site clip is 400, and the bound was a
// comment claiming it "stays well inside"), and `boundFailure`'s fallback for
// an unattributable single-line failure is a blind `slice(-800)` — so the
// `[baseline-red]` marker the cap routes on and the quoted command the #1765
// attribution reads were the parts amputated. Every arm is now composed to fit,
// at widths the 204-char nessie fixture never reaches, and the entry survives
// the real cap-evidence join.
{
  const longAssertion = `thread '${NESSIE_TEST}' panicked at ${RUST_PANIC_AT}: ${"m".repeat(400)}`;
  const arms: Array<[string, RedBaselineVerdict]> = [
    ["absent", redArm(longAssertion)],
    ["not-behind", redArm(longAssertion, { status: "not-behind" })],
    [
      "unknown",
      redArm(longAssertion, {
        status: "unknown",
        reason: "the ancestry read did not answer",
      }),
    ],
    [
      "behind",
      redArm(longAssertion, {
        status: "behind",
        branch: "main",
        commitsBehind: 3,
        commits: ["fix(a): 1", "fix(a): 2", "fix(a): 3"],
      }),
    ],
  ];
  for (const [arm, verdict] of arms) {
    const msg = baselineRedMessage(verdict, {
      cmd: CMD,
      baseSha: "0123456789abcdef0123456789",
      timeoutMs: 60_000,
      changeFailure: longAssertion,
    });
    assert(
      msg.length <= 800,
      `bound ${arm} (#2341): the rendered finding fits the 800-char cap-evidence bound (${msg.length})`,
    );
    const joined = boundJoinFailures([msg]);
    assert(
      joined.includes(BASELINE_RED_MARKER) && joined.includes(CMD),
      `bound ${arm} (#2341): the marker AND the quoted command survive the real cap-evidence join`,
    );
    assert(
      msg.startsWith(BASELINE_RED_MARKER) &&
        msg.includes("panicked at src/session/fastpath_tests.rs:91:5"),
      `bound ${arm} (#2341): the marker leads and the kept assertion names the test, the file and the line`,
    );
  }
  // The middle sentence is what buys the room, and it is the redundant half —
  // it restates the lead clause. At an ordinary width it stays, so the classic
  // handoff text is unchanged for the case the fixtures describe.
  const short = baselineRedMessage(redArm(RUST_PANIC_ASSERTION), {
    cmd: CMD,
    baseSha: "0123456789abcdef0123456789",
    timeoutMs: 60_000,
    changeFailure: RUST_PANIC_ASSERTION,
  });
  assert(
    short.includes("The gate was red before this change was written") &&
      short.includes("Fix the gate at the base commit") &&
      short.includes("which is over the 100 ms bound"),
    `bound short (#2341): an ordinary-length assertion keeps the full classic text (${short.length})`,
  );
  // The unknown arm renders the probe's FIXED VOCABULARY, never git's own error
  // text (the executor's message is `Command failed: git\n<stderr>`, which
  // carries local paths into a published handoff), and never clips mid-word.
  const unknownMsg = baselineRedMessage(
    redArm(RUST_PANIC_ASSERTION, {
      status: "unknown",
      reason: "the divergence read did not answer",
    }),
    { cmd: CMD, baseSha: "0123456789abcdef0123456789", timeoutMs: 60_000, changeFailure: "" },
  );
  assert(
    unknownMsg.includes(
      "staleness could not be established: the divergence read did not answer",
    ) && !unknownMsg.includes("Command failed"),
    `bound unknown (#2341): the unknown arm names a fixed reason, not git's own text (got ${unknownMsg.slice(-170)})`,
  );
}

// 8 — #2341 fix wave (M2): the `git log --oneline` subjects of the base's
// missing commits ride into a PUBLIC handoff, so each one is run through
// `redactSecrets` and a credential-shaped subject is DROPPED whole — the same
// screen `isNamedFailureLine` applies to gate output. Before it, a subject
// like `fix(auth): rotate leaked api_key = <secret>` was quoted verbatim into
// the `[baseline-red]` finding, its cap evidence and the issue handoff.
{
  const msg = baselineRedMessage(
    redArm(RUST_PANIC_ASSERTION, {
      status: "behind",
      branch: "main",
      commitsBehind: 3,
      commits: [
        "fix(auth): rotate leaked api_key = SuperSecretValue99",
        "chore: deploy with ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v0wXy",
        "fix(a): 3",
      ],
    }),
    { cmd: CMD, baseSha: "0123456789abcdef0123456789", timeoutMs: 60_000, changeFailure: "" },
  );
  assert(
    !msg.includes("SuperSecretValue99") && !msg.includes("ghp_"),
    `commit subjects (#2341 M2): no credential reaches the rendered handoff (got ${msg.slice(0, 400)})`,
  );
  assert(
    !msg.includes("rotate leaked api_key"),
    `commit subjects (#2341 M2): the credential-shaped subject is dropped, not quoted (got ${msg.slice(0, 400)})`,
  );
  assert(
    msg.includes("chore: deploy with [REDACTED]") && msg.includes("(+1 more)"),
    `commit subjects (#2341 M2): the surviving subject renders REDACTED and the cap is disclosed (got ${msg.slice(0, 400)})`,
  );
  assert(
    msg.length <= 800,
    `commit subjects (#2341 M2): the finding still fits the cap-evidence bound (${msg.length})`,
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
