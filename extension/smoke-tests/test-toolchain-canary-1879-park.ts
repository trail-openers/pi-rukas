#!/usr/bin/env bun
/**
 * #1879 fix round — the `toolchain-unsound` cap is REACHABLE.
 *
 * The adversarial review's H1: Part A shipped the failure string, the cap
 * literal, the explainer and the queue advice, but no code path ever RAISED the
 * cap. `verifyCapFor` had no arm for a canary failure, so
 * `appendDevelopVerifyFailure` parked `verify-failed:develop` with "inspect the
 * diff" advice about a diff the gate never judged — and a corrective developer
 * round was spent on it.
 *
 * Groups:
 *
 *   1. THE REAL DEVELOP FAILURE PATH: a stub compiler fixture under
 *      `os.tmpdir()` runs through the real develop gate, and the state that
 *      comes back from `appendDevelopVerifyFailure` carries the
 *      `toolchain-unsound` cap (not `verify-failed:develop`);
 *   2. no corrective round: `decideCorrectiveRound` declines it (and a control
 *      shows an ordinary failure still earns one);
 *   3. the ci tier: a `verify-full-status: failure` whose evidence is the
 *      canary parks at handoff through `nextStep`, and the ci STEP raises the
 *      cap itself rather than leaving a cap-insensitive tail;
 *   4. the cap checkpoint still reports "could not run", never a pass
 *      (brief item d — confirmed, unchanged);
 *   5. MUTATION CONTROL: with the `verifyCapFor` arm deleted (a real mutant,
 *      applied to the source and restored in the same block), group 1's
 *      assertion goes red.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { MAX_CI_RETRIES, nextStep } from "../src/work-driver-context.ts";
import { decideCorrectiveRound } from "../src/work-driver-corrective-decide.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { TOOLCHAIN_UNSOUND_CAP_ARM } from "../src/work-driver-verify-develop-helpers.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { assert, assertRed, exitCode } from "./lib/toolchain-canary-assert.ts";
import {
  REPO,
  STUB,
  cleanupOnExit,
  ctxFor,
  fixtureRoot,
  packageWithCompiler,
  pexec,
  realExec,
  rmTree,
} from "./lib/toolchain-canary-support.ts";

cleanupOnExit();

/**
 * A gate shaped the way the develop step hands one to the park site. `cmd` is
 * the command the run reports, and `raw` the consolidated stream — both must
 * carry the canary marker when the fixture is meant to be a canary park, or
 * `decideCorrectiveRound` declines for the "failure outside the run" reason
 * rather than the one under test.
 */
function gateFrom(failures: string[], raw?: string) {
  return {
    ok: false,
    failures,
    verifyRun: {
      status: "ran" as const,
      command: LOCAL_TSC_CMD,
      failures,
      perWorktree: [],
      ...(raw === undefined ? {} : { consolidatedRaw: raw }),
    },
  };
}

const baseState = (): WorkState =>
  ({
    issue: 1879,
    issues: [1879],
    pipelineState: {
      status: "running",
      currentStep: "develop",
      lastCompletedStep: "develop",
      reviewRound: 0,
      inFlightJobIds: [],
      worktrees: { default: "/tmp/does-not-matter" },
    },
    eventLog: [],
  }) as unknown as WorkState;

/** The incident's stub compiler in a git fixture whose worktree links it. */
async function stubFixture(tag: string): Promise<{ root: string; wt: string }> {
  const root = fixtureRoot(tag);
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\nextension/node_modules/\n.worktrees/\ntmp/\n",
    "extension/package.json": '{"name":"ext"}\n',
    "tracked.txt": "base\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const git = (...args: string[]) => pexec("git", args, { cwd: root });
  await git("init", "-q", "--initial-branch=main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  packageWithCompiler(root, STUB);
  const wt = path.join(root, ".worktrees", "issue-1879-default");
  await git("worktree", "add", "-q", "--detach", wt, "HEAD");
  await pexec("ln", [
    "-s",
    path.join(root, "extension", "node_modules"),
    path.join(wt, "extension", "node_modules"),
  ]);
  return { root, wt };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("1. the REAL develop gate parks toolchain-unsound, not verify-failed");
const fixture = await stubFixture("park");
const developed: string[] = [];
{
  const notes: string[] = [];
  await runVerifyCommandGate({
    execFn: realExec,
    cmd: `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`,
    ctx: ctxFor(fixture.root) as never,
    state: baseState(),
    worktrees: { default: fixture.wt },
    baseSha: undefined,
    changedWorktrees: [fixture.wt],
    workstreamBaseShas: undefined,
    failures: developed,
    notes,
  });
  assert(
    developed.length === 1 && developed[0] !== undefined && developed[0].includes("[toolchain-unsound]"),
    `the gate produced exactly the canary failure (got ${developed.length}: ${String(developed[0])?.slice(0, 80)})`,
  );
  assert(
    verifyCapFor("develop", developed) === "toolchain-unsound",
    `verifyCapFor raises the canary cap (got ${verifyCapFor("develop", developed)})`,
  );

  const parked = appendDevelopVerifyFailure(
    baseState(),
    gateFrom(developed, developed[0]) as never,
  );
  const tail = parked.eventLog[parked.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" && tail.cap === "toolchain-unsound",
    `the park site raises toolchain-unsound, not verify-failed:develop (got ${tail?.kind === "cap-hit" ? tail.cap : tail?.kind})`,
  );
  assert(tail?.kind === "cap-hit" && tail.nextStep === "handoff", "and the cap routes to handoff");
  const d = nextStep(parked);
  assert(
    d.kind === "step" && d.step === "handoff",
    `nextStep honours it (got ${d.kind === "step" ? d.step : d.kind})`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("2. no corrective developer round is spent on an unsound compiler");
{
  const decision = decideCorrectiveRound(gateFrom(developed, developed[0]) as never, {
    eventLog: [],
    worktrees: { default: fixture.wt },
  });
  assert(
    decision.round === false,
    `the corrective round declines an unsound compiler (got round: ${String(decision.round)})`,
  );
  // Control: the same shape WITHOUT the canary marker IS the case a round
  // answers, so the decline above is about the marker and not about the shape.
  const ordinary = decideCorrectiveRound(
    gateFrom(["consolidated verify failed"], "✗ b.test.ts: expected 0, got 1") as never,
    { eventLog: [], worktrees: { default: fixture.wt } },
  );
  assert(
    ordinary.round === true,
    `control: an ordinary verify failure still earns the round (got ${ordinary.round ? "round" : ordinary.reason})`,
  );
  rmTree(fixture.root);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("3. the ci tier parks rather than routing back to develop");
{
  const atCi = (evidenceTail: string | undefined, ciRetryCount = 0): WorkState =>
    ({
      issue: 1879,
      issues: [1879],
      pipelineState: {
        status: "running",
        currentStep: "ci",
        lastCompletedStep: "lens-review",
        reviewRound: 0,
        inFlightJobIds: [],
        ciRetryCount,
      },
      eventLog: [{ kind: "verify-full-status", at: 1, status: "failure", ms: 1000, evidenceTail }],
    }) as unknown as WorkState;

  const stepOf = (s: WorkState) => {
    const d = nextStep(s);
    return d.kind === "step" ? d.step : d.kind;
  };
  for (const count of [0, 1, MAX_CI_RETRIES]) {
    assert(
      stepOf(atCi(developed[0], count)) === "handoff",
      `a canary verify-full failure parks at ciRetryCount=${count} (got ${stepOf(atCi(developed[0], count))})`,
    );
  }
  assert(
    stepOf(atCi("FAIL suite: 3 tests failed", 0)) === "develop",
    `control: an ordinary verify-full failure still routes to develop (got ${stepOf(atCi("FAIL suite: 3 tests failed", 0))})`,
  );
}
{
  // The ci STEP raises the cap itself, so the log tail never becomes a
  // cap-insensitive verify-full-status that the router has to guess about.
  const { runCi } = await import("../src/work-driver-stepback-ci.ts");
  const root = fixtureRoot("ci-park");
  packageWithCompiler(root, STUB);
  mkdirSync(path.join(root, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, ".pi", "verify-cmd-full"),
    `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json\n`,
  );
  try {
    const st = baseState();
    const out = await runCi(
      ctxFor(root) as never,
      {
        ...st,
        pipelineState: { ...st.pipelineState, currentStep: "ci", worktrees: { default: root } },
      },
      Date.now(),
    );
    const caps = out.eventLog.filter((e) => e.kind === "cap-hit");
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "toolchain-unsound",
      `runCi raises toolchain-unsound as the LOG TAIL (got ${tail?.kind ?? "?"}${tail?.kind === "cap-hit" ? ` ${tail.cap}` : ""}; events ${out.eventLog.map((e) => e.kind).join(",")}; caps ${caps.map((c) => (c as { cap?: string }).cap).join(",")})`,
    );
    assert(
      out.eventLog.some((e) => e.kind === "ci-status" && e.status === "failure"),
      "and it records the ci-status audit event beside the cap",
    );
    assert(
      !out.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "ci-retry"),
      "no ci-retry cap is raised — the compiler is the finding, not the retries",
    );
  } finally {
    rmTree(root);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("4. the cap checkpoint still reports 'could not run', never a pass");
{
  const { typecheckWorktree } = await import("../src/work-driver-cap-checkpoint-typecheck.ts");
  const root = fixtureRoot("park-checkpoint");
  packageWithCompiler(root, STUB);
  try {
    const outcome = await typecheckWorktree(root, realExec);
    assert(
      outcome.verdict === undefined,
      `an unsound compiler gives the checkpoint no verdict (got ${String(outcome.verdict)})`,
    );
    assert(
      outcome.verdict === undefined && /not sound/.test(outcome.why),
      `and the reason says so (got ${outcome.verdict === undefined ? outcome.why : ""})`,
    );
  } finally {
    rmTree(root);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("5. mutation control: with the verifyCapFor arm removed, group 1 is red");
{
  // H1's defect spelled out: the leading arm deleted, so a canary failure falls
  // through to the plain code-verdict cap. Applied to the real source and
  // restored in `finally`, then re-verified — a mutant that was never restored
  // would be a worse bug than the one this proves.
  const file = path.join(REPO, "extension", "src", "work-driver-verify-develop-helpers.ts");
  const original = readFileSync(file, "utf8");
  const ARM = TOOLCHAIN_UNSOUND_CAP_ARM;
  if (!original.includes(ARM)) {
    assert(false, "MUTATION CONTROL: the arm under mutation was not found in the source");
  } else {
    writeFileSync(file, original.replace(ARM, ""));
    try {
      const mod = (await import(
        `../src/work-driver-verify-develop-helpers.ts?mutant=${Date.now().toString(36)}`
      )) as typeof import("../src/work-driver-verify-develop-helpers.ts");
      assertRed(
        mod.verifyCapFor("develop", developed) === "toolchain-unsound",
        "MUTATION CONTROL: with the arm deleted the cap is NOT toolchain-unsound (the assertion is red)",
      );
      assert(
        mod.verifyCapFor("develop", developed) === "verify-failed:develop",
        `…and it degrades to exactly the cap H1 reported (got ${mod.verifyCapFor("develop", developed)})`,
      );
    } finally {
      writeFileSync(file, original);
      assert(
        readFileSync(file, "utf8") === original,
        "the mutation is fully restored — the source on disk is the honest one",
      );
    }
  }
  assert(
    verifyCapFor("develop", developed) === "toolchain-unsound",
    "after the restore, the real verifyCapFor still raises the canary cap",
  );
}

const code = exitCode();
console.log(
  code === 0
    ? "\ntoolchain-canary-park: all groups passed"
    : `\ntoolchain-canary-park: FAILED (${code})`,
);
process.exit(code);
