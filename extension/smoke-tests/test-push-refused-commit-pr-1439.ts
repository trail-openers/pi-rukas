#!/usr/bin/env bun
/**
 * #1439 — a push the FORGE refused is recognised, parks terminally, and says so.
 *
 * The measured shape is cycle 1439's own state file: `mechanizedCommitPr`'s push was
 * refused by GitHub push protection (`GH013: Repository rule violations … GITHUB PUSH
 * PROTECTION`), the failure was recorded as a commit-pr plumb-report with
 * `fallbackCause: "other"`, the ops fallback spent 40 minutes rediscovering a refusal it
 * cannot lift, and the cycle parked as `verify-failed:commit-pr` under a cause verdict of
 * `change` — "the verify command failed … fix the change", which is not what happened.
 *
 * Four layers, one block each, each tested at the seam that owns the behaviour:
 *   1. recognition — `PUSH_REFUSAL_MARK` says yes to GH013 / push-protection /
 *      repository-rules / non-fast-forward and NO to transport noise; the evidence
 *      extractor keeps the `remote:` lines (which carry the allow-the-secret URLs) and
 *      drops the rest;
 *   2. the typed failure — `integrate()`'s push catch produces
 *      `failure: "push-refused"`, and `mechanizedCommitPr` marks it `terminal: true`
 *      without re-deriving anything from prose;
 *   3. the STEP — `runCommitPr` records `push-refused:commit-pr` (not
 *      `verify-failed:commit-pr`), attaches the refusal as the cap's evidence, sets
 *      `verifyEvidence.origin: "push-refused"`, and DOES NOT dispatch the ops fallback.
 *      That dispatch is the 40 minutes, and the `next === undefined` test in
 *      `runCommitPrLocked` is what decides it;
 *   4. the cause — `issue`, quoting the refusal, with an operator action naming both
 *      real paths (allow the flagged content, or rewrite the fixture) and `/work --restart`.
 *
 * Layer 3 drives the real `runCommitPr` (lock + mechanized path + cap writer + fallback
 * gate) rather than the whole driver: a full cycle would need the develop/adversarial
 * chain to reach commit-pr at all, and what is under test is commit-pr's own decision.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { causeForCycle } from "../src/work-driver-cause-for.ts";
import { mechanizedCommitPr, runCommitPr } from "../src/work-driver-commit.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { isPushRefusal, pushRefusalEvidence } from "../src/work-driver-push-refusal.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const GH013 = [
  "remote: error: GH013: Repository rule violations found for refs/heads/feature/issue-1439-bug-extend-secret.",
  "remote: ",
  "remote: - GITHUB PUSH PROTECTION        ",
  "remote:   —————————————————————————————————————————",
  "remote:     Resolve the following violations before pushing:",
  "remote:     * Push the commit again to allow the secret: https://github.com/o/r/security/secret_scanning/unblock-secret/3Kvj3Vlk",
  "remote:     * Push the commit again to allow the secret: https://github.com/o/r/security/secret_scanning/unblock-secret/3Kvj3XSL",
  "hint: Updates were rejected because the remote contains work that you do not",
].join("\n");

// ---------------------------------------------------------------------------
// 1. Recognition. Tested directly so a marker change fails HERE rather than
//    silently turning the cause verdict back into `change`.

assert(isPushRefusal(GH013), "GH013 / GITHUB PUSH PROTECTION is recognised as a push refusal");
assert(
  isPushRefusal("remote: error: GH013: Repository rule violations found"),
  "the repository-rules wording alone is recognised",
);
assert(isPushRefusal("! [rejected] main -> main (non-fast-forward)"), "non-fast-forward is one");
assert(
  isPushRefusal("remote: ! [remote rejected] feature/x -> feature/x (non-fast-forward)"),
  "the `! [remote rejected]` shape is one",
);
assert(
  isPushRefusal(
    [
      "To https://github.com/o/r.git",
      " ! [rejected]        feature/x -> feature/x (non-fast-forward)",
      "error: failed to push some refs to 'https://github.com/o/r.git'",
    ].join("\n"),
  ),
  "git's own `! [rejected] … (non-fast-forward)` + `error: failed to push` shape is one",
);
assert(
  !isPushRefusal("fatal: could not read from remote repository"),
  "an SSH transport failure is NOT a refusal (that one IS the fallback's job)",
);
assert(!isPushRefusal(""), "empty text is not a refusal");
assert(!isPushRefusal(undefined), "undefined is not a refusal");
// #1702 — the matcher is anchored to the lines the FORGE wrote; the negative cases (and the
// redaction of the evidence the matcher produces) are pinned in
// `test-push-refusal-anchor-1702.ts`, which exists so this file stays under the §12 cap.

const refusalEvidence = pushRefusalEvidence(GH013);
assert(
  refusalEvidence.includes("GH013") && refusalEvidence.includes("unblock-secret/3Kvj3Vlk"),
  "the evidence keeps the refusal line AND the allow-the-secret URL (the operator's action)",
);
assert(
  !refusalEvidence.includes("hint: Updates were rejected"),
  "the evidence drops the non-`remote:` noise that carries no verdict",
);

// #1702 — the token is assembled from fragments at runtime, never a literal in this file:
// the fixtures rule this repo follows, and the very reason push protection is what refuses
// these commits. Its recognition-side and redaction-side cases live in
// `test-push-refusal-anchor-1702.ts`; this file keeps the STEP-level proof that every
// surface the driver writes is redacted.
const LEAKY_TOKEN = ["gh", "p_", "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v"].join("");
const GH013_WITH_TOKEN = `${GH013}\nremote:   flagged: ${LEAKY_TOKEN} in src/fixtures/stripe.ts`;


// ---------------------------------------------------------------------------
// The exec double for the push seam. Two behaviours, both real:
//   - `git push` answers the way GitHub does when push protection trips — non-zero exit,
//     the verdict on stderr with the `remote:` prefixes intact;
//   - the integrate-worktree creation REFUSES, exactly as `ensureIntegrateWorktree` does
//     when a cycle worktree holds work the driver did not write (a `DirtyWorktreeError`).
//     That refusal is the ONLY way to reach the terminal-cap writer in
//     `runCommitPrLocked` without driving the whole develop/adversarial chain, and it is
//     the same writer the push-refusal cap uses — which is what makes this a fair test of
//     "does a terminal mechanized failure dispatch the ops fallback".

const PICK_SHA = "3".repeat(40);

function mkExec(pushCalls: string[][]) {
  return async (
    cmd: string,
    o?: { cwd?: string; argv?: string[]; maxBuffer?: number },
  ): Promise<{ stdout: string }> => {
    const argv = o?.argv ?? [];
    const line = argv.length > 0 ? `${cmd} ${argv.join(" ")}` : cmd;
    if (cmd === "git" && argv[0] === "push") {
      pushCalls.push([cmd, ...argv]);
      const err = new Error("Command failed: git push -u origin feature/issue-1439-x") as Error & {
        stderr?: string;
      };
      // #1702 — the fixture carries an extra `remote:` line with a token built from
      // fragments at runtime (never a literal in this file): it is the case the redaction
      // exists for, and the assertion below is what notices if the write site forgets it.
      err.stderr = GH013_WITH_TOKEN;
      throw err;
    }
    // Make the consolidation REAL, so integrate() reaches its push instead of reporting
    // an empty integration: the worktree has a commit, that commit is not on the branch,
    // and the pick applies. Without these the batch dedups every pick as "already on
    // branch" and `git push` is never called at all.
    if (line.startsWith("git rev-list --reverse --first-parent"))
      return { stdout: `${PICK_SHA}\n` };
    if (line.startsWith("git rev-list --count HEAD..")) return { stdout: "1\n" };
    if (line.startsWith("git rev-list --count ")) return { stdout: "1\n" };
    if (line.startsWith("git cherry-pick")) return { stdout: "" };
    // The consolidation commit needs something staged, or integrate() commits nothing
    // and the tree reads empty again.
    if (line.startsWith("git diff --cached --name-only")) return { stdout: "src/a.rs\n" };
    // `git rev-parse HEAD` must look like a commit: integrate() records it as the new
    // HEAD and an unparseable value reads as "nothing was integrated".
    if (line === "git rev-parse HEAD") return { stdout: `${PICK_SHA}\n` };
    return { stdout: "" };
  };
}

function transportFailingExec(pushCalls: string[][]) {
  const answer = mkExec(pushCalls);
  return async (
    cmd: string,
    o?: { cwd?: string; argv?: string[] },
  ): Promise<{ stdout: string }> => {
    if (cmd === "git" && o?.argv?.[0] === "push") {
      pushCalls.push([cmd, ...(o?.argv ?? [])]);
      // Not a refusal: an environment failure the ops fallback CAN work around.
      throw new Error("ssh: connect to host github.com port 22: Operation timed out");
    }
    // The same consolidation answers as the refusal double — the ONLY difference under
    // test is what `git push` throws.
    return answer(cmd, o);
  };
}

function commitPrState(dir: string): WorkState {
  return {
    issue: 1439,
    eventLog: [],
    pipelineState: {
      currentStep: "adversarial",
      reviewRound: 0,
      // Present because `runCommitPrLocked`'s dispatch path appends to it; a state file
      // the driver wrote always has it, and a missing one would throw before the
      // behaviour under test is reached.
      inFlightJobIds: [],
      branchName: "feature/issue-1439-x",
      baseSha: "1111111111111111111111111111111111111111",
      worktrees: { a: path.join(dir, ".worktrees/issue-1439-task-a") },
      workstreams: { a: { scope: "fix module a", paths: ["src/a.rs"], outOfScope: ["docs"] } },
      // One commit ahead, so the cherry-pick batch has real work to consolidate and
      // integrate() reaches its push instead of reporting an empty integration.
      commitShas: { a: PICK_SHA },
    },
  } as unknown as WorkState;
}

// ---------------------------------------------------------------------------
// 2. The typed failure at the mechanized seam: `integrate()` names the cause, and
//    `mechanizedCommitPr` marks it terminal. Nothing here reads the reason string.

{
  const dir = mkdtempSync(path.join(tmpdir(), "push-unit-"));
  try {
    const pushCalls: string[][] = [];
    const ctx = {
      repoRoot: dir,
      issue: 1439,
      verifyExecFn: mkExec(pushCalls),
    } as unknown as DriverContext;
    const res = await mechanizedCommitPr(ctx, commitPrState(dir), Date.now());
    assert(res.ok === false, "unit: a refused push fails the mechanized commit-pr");
    assert(pushCalls.length > 0, "unit: the mechanized path reached `git push` (no pre-push bail)");
    assert(
      (res as { fallbackCause?: string }).fallbackCause === "push-refused",
      "unit: the failure carries the typed `push-refused` cause (no prose re-derivation)",
    );
    assert(
      (res as { terminal?: boolean }).terminal === true,
      "unit: the refusal is TERMINAL — this flag is what stops the ops fallback",
    );
    assert(
      /GH013|PUSH PROTECTION/i.test((res as { reason?: string }).reason ?? ""),
      "unit: the reason carries the refusal text (it becomes the cap's evidence)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. The STEP: `runCommitPr` (lock + mechanized path + cap writer + the fallback gate)
//    driven with a refused push. What #1439 is about, end to end: a `terminal` result
//    means NO ops dispatch, and the refusal text rides into the cap as its evidence.
//
// integrate() reaches its push because the state reports one commit ahead and the double
// answers every read clean up to that point — so this is the real path, not a stubbed one.

{
  const dir = mkdtempSync(path.join(tmpdir(), "push-step-"));
  try {
    const pushCalls: string[][] = [];
    let opsCommitPrDispatched = false;
    const ctx = {
      repoRoot: dir,
      issue: 1439,
      verifyExecFn: mkExec(pushCalls),
      dispatchFn: async (_pi: unknown, spec: { role: string }, dOpts?: { label?: string }) => {
        if ((dOpts?.label ?? spec.role) === "ops:commit-pr") {
          opsCommitPrDispatched = true;
          return {
            role: "ops",
            ok: true,
            text: "Committed and pushed.\npr: 771",
            toolUses: [],
            ms: 10,
            exitCode: 0,
            transcriptPath: "/tmp/stub.json",
          };
        }
        throw new Error(`unexpected dispatch: ${dOpts?.label ?? spec.role}`);
      },
    } as unknown as CycleContext;
    const after = await runCommitPr(ctx, commitPrState(dir), Date.now());

    // (3a) THE FALLBACK IS GONE — the 40 minutes. `runCommitPrLocked` dispatches ops
    // when the mechanized result leaves `next` unset; a terminal verdict must leave one.
    // This is the load-bearing assertion of the whole file.
    assert(
      !opsCommitPrDispatched,
      "#1439: a terminal mechanized failure does NOT dispatch the ops:commit-pr fallback",
    );

    // (3b) the cap + its evidence.
    const capHits = after.eventLog.filter((e) => e.kind === "cap-hit");
    const cap = capHits.find((e) => e.cap === "push-refused:commit-pr") as
      | Extract<(typeof after.eventLog)[number], { kind: "cap-hit" }>
      | undefined;
    assert(cap !== undefined, "#1439: recorded as `push-refused:commit-pr`");
    assert(
      !capHits.some((e) => e.cap === "verify-failed:commit-pr"),
      "#1439: no `verify-failed:commit-pr` for a push refusal (nothing came back verify-red)",
    );
    // #1064 — the cap is not the whole story: the park must carry the failure's own lines.
    const evidenceLines = [
      cap?.evidence ?? "",
      ...(cap?.failures ?? []),
      ...(after.pipelineState.verifyEvidence?.failures ?? []),
    ].join("\n");
    assert(
      /GH013|PUSH PROTECTION/i.test(evidenceLines),
      "#1439/#1064: the cap carries the refusal text as evidence, not just a cap name",
    );
    assert(
      evidenceLines.includes("unblock-secret/3Kvj3Vlk"),
      "#1439: the evidence carries the allow-the-secret URL the operator must open",
    );
    assert(
      after.pipelineState.verifyEvidence?.origin === "push-refused",
      '#1439: verifyEvidence.origin is the structured "push-refused", not a prose match',
    );
    assert(
      after.eventLog.some((e) => e.kind === "plumb-report" && e.fallbackCause === "push-refused"),
      "#1439: the plumb-report carries fallbackCause=push-refused (not `other`)",
    );
    assert(
      capHits.every((e) => e.nextStep === "handoff"),
      "#1439: the cap routes to handoff (park), not back to develop",
    );

    // (3c) #1702 — the three surfaces that persist the refusal text all redact it. The plumb
    // body is the one that used to carry `mech.reason` raw: it lands in `plumbReports` and
    // the handoff prints it, so an un-redacted copy is a secret published twice over.
    const plumb = after.eventLog.find(
      (e) => e.kind === "plumb-report" && e.fallbackCause === "push-refused",
    ) as Extract<(typeof after.eventLog)[number], { kind: "plumb-report" }> | undefined;
    assert(plumb !== undefined, "#1702: the terminal halt writes its plumb-report");
    assert(
      !(plumb?.body ?? "").includes(LEAKY_TOKEN) && (plumb?.body ?? "").includes("[REDACTED]"),
      "#1702: the plumb-report body redacts a token the forge quoted, rather than storing it",
    );
    assert(
      (plumb?.body ?? "").includes("unblock-secret/3Kvj3Vlk"),
      "#1702: the plumb body still names the operator's URL after redaction",
    );
    assert(
      (cap?.evidence ?? "").includes("[REDACTED]") && !(cap?.evidence ?? "").includes(LEAKY_TOKEN),
      "#1702: the cap's evidence is redacted too",
    );

    // (4) the cause verdict the operator actually reads — for the push refusal, which
    // the unit block above proves reaches `terminal: true`.
    const verdict = causeForCycle(after);
    assert(
      verdict !== undefined,
      "#1439: the parked cycle yields a cause verdict (not an absent one)",
    );
    assert(
      (verdict?.causeEvidence ?? []).length > 0,
      "#1064: the verdict carries evidence lines, not only the cap name",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. The CAUSE. Constructed from the same event shape the terminal halt writes — the
//    classifier's input is the state, and building it here tests the classifier (this
//    issue's defect: it said `change` / "the verify command failed") against the exact
//    record the driver now writes, without re-driving git.

{
  const dir = mkdtempSync(path.join(tmpdir(), "push-cause-"));
  try {
    const state = commitPrState(dir);
    const parked: WorkState = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        verifyEvidence: {
          step: "commit-pr",
          origin: "push-refused",
          at: Date.now(),
          failures: [
            `push refused by the remote for ${state.pipelineState.branchName}: ${refusalEvidence}`,
          ],
        },
      },
      eventLog: [
        {
          kind: "plumb-report",
          at: Date.now(),
          step: "commit-pr",
          role: "driver",
          body: `push refused: ${refusalEvidence}`,
          fallbackCause: "push-refused",
        },
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "push-refused:commit-pr",
          reviewRound: 0,
          nextStep: "handoff",
          evidence: `push refused by the remote: ${refusalEvidence}`,
          failures: [`push refused: ${refusalEvidence}`],
        },
      ] as unknown as WorkState["eventLog"],
    };
    const verdict = causeForCycle(parked);
    assert(
      verdict?.causeClass === "issue",
      "#1439: the cause is `issue` — the forge refused content, it did not find a broken change",
    );
    assert(
      (verdict?.causeReason ?? "").length > 0 &&
        !(verdict?.causeReason ?? "").toLowerCase().includes("verify command failed"),
      "#1439: the reason never says the verify command failed",
    );
    const action = verdict?.userAction ?? "";
    assert(
      /push protection|repository rules/i.test(action) &&
        /allow the flagged content/i.test(action) &&
        /fragments at runtime/i.test(action) &&
        /--restart/.test(action),
      "#1439: the user action names both operator paths and the re-run verb",
    );
    assert(
      (verdict?.causeEvidence ?? []).some((l) => /GH013|PUSH PROTECTION/i.test(l)),
      "#1439: the evidence lines quote the refusal, not the cap name alone",
    );

    // The control INSIDE the classifier: the same cap with no evidence at all must not
    // invent a refusal, and must not claim the verify command failed either.
    const bare: WorkState = {
      ...state,
      eventLog: [
        {
          kind: "cap-hit",
          at: Date.now(),
          cap: "push-refused:commit-pr",
          reviewRound: 0,
          nextStep: "handoff",
        },
      ] as unknown as WorkState["eventLog"],
    };
    const bareVerdict = causeForCycle(bare);
    assert(
      !(bareVerdict?.causeReason ?? "").toLowerCase().includes("verify command failed"),
      "#1064: a cap with no evidence never falls back to 'the verify command failed'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The control: a push that dies of an UNRELATED cause (a transport failure) is NOT a
// refusal — it keeps falling back to ops, which is the fallback's actual purpose
// (environment variance a child can work around), and keeps its previous classification.

{
  const dir = mkdtempSync(path.join(tmpdir(), "push-other-"));
  try {
    const pushCalls: string[][] = [];
    let opsCommitPrDispatched = false;
    const exec = async (
      cmd: string,
      o?: { cwd?: string; argv?: string[] },
    ): Promise<{ stdout: string }> => {
      if (cmd === "git" && o?.argv?.[0] === "push") {
        pushCalls.push([cmd, ...(o?.argv ?? [])]);
        // Not a refusal: an environment failure the ops fallback CAN work around.
        throw new Error("ssh: connect to host github.com port 22: Operation timed out");
      }
      return { stdout: "" };
    };
    const ctx = {
      repoRoot: dir,
      issue: 1439,
      verifyExecFn: transportFailingExec(pushCalls),
      dispatchFn: async (_pi: unknown, spec: { role: string }, dOpts?: { label?: string }) => {
        if ((dOpts?.label ?? spec.role) === "ops:commit-pr") {
          opsCommitPrDispatched = true;
          return {
            role: "ops",
            ok: true,
            text: "Committed and pushed.\npr: 771",
            toolUses: [],
            ms: 10,
            exitCode: 0,
            transcriptPath: "/tmp/stub.json",
          };
        }
        throw new Error(`unexpected dispatch: ${dOpts?.label ?? spec.role}`);
      },
    } as unknown as CycleContext;
    const after = await runCommitPr(ctx, commitPrState(dir), Date.now());
    assert(pushCalls.length > 0, "control: the push was attempted");
    assert(
      opsCommitPrDispatched,
      "control: a transport failure STILL falls back to ops (variance is the fallback's job)",
    );
    assert(
      !after.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "push-refused:commit-pr"),
      "control: a transport failure is NOT recorded as push-refused (the classifier stays honest)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
