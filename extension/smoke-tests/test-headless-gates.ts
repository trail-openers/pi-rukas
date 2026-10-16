#!/usr/bin/env bun
/**
 * Headless S5 (#1025) — the headless gate and permission policy.
 *
 * Three contracts, all pre-existing behaviour this test pins as the contract
 * for the headless surface (it changes none of them):
 *
 *   1. **No `--merge`, no `--sandboxed` on the headless CLI.** Both are rejected
 *      on purpose: a flag an agent can pass is a flag an agent can pass, and
 *      `--merge` would clear the policy judge while `--sandboxed` would claim a
 *      trust mode the sandbox image never granted. Trust comes only from
 *      `PI_ENSEMBLE_SANDBOX_MODE=1`, which `.devcontainer/Dockerfile` bakes into
 *      the image; merge authority comes only from the project's doctrine read at
 *      the cycle's base commit, and `gh` merge evidence is required either way.
 *   2. **The composition still refuses.** A cycle parked at the merge step, in a
 *      repo with no doctrine grant, exits 10 and runs no forge merge — with the
 *      `exec` seam answering every `gh` call green. A green PR is not permission
 *      (#380), and the headless runner has no flag that manufactures it.
 *   3. **The exit-code mapping**: merged → 0, no grant → 10, doctrine absent →
 *      10, intent park → 11 with numbered questions.
 *
 * "Process test" in the issue's sense: the runner's own composition (`cli.ts` →
 * `runHeadless` → the driver → the state file → the exit code), exercised
 * in-process with the seams the runner already exposes (`driverSeams`,
 * `verifyExecFn`). Spawning a real Pi child per case needs a live provider —
 * `*-live.ts` territory, which AGENTS.md §1 keeps out of the pre-push set. The
 * spawn-side half of the trust / fail-closed contract is covered by
 * test-headless-permission-policy.ts.
 *
 * Merge commands are never spelled as literals in this file or its fixture: the
 * mode-independent merge guard reads the bash command text of every tool call,
 * and a test that quotes the forbidden form trips it for a reason that has
 * nothing to do with what the test asserts (#1390 / #1417).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { parseHeadlessArgs } from "../src/headless/cli.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { projectIssue } from "../src/headless/result.ts";
import { runHeadless } from "../src/headless/run.ts";
import {
  type WorkState,
  appendEvent,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";
import {
  FIXTURE_PR,
  MERGE_GRANT,
  type MergeExecLog,
  type MergeVerdict,
  headlessRepo,
  mergeExec,
  okResult,
} from "./lib/headless-s5-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
// Nothing in the offline suite reaches a provider or a forge.
process.env.PI_ENSEMBLE_FORBID_LIVE_SPAWN = "1";
// The handoff channel is not what these cases assert; `host` keeps the cycle off
// the real forge (no comment, no label, no gh).
process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
// The judge child is spawnSpecialist's, and DriverContext has no seam for it.
// With the judge disabled the gate denies from the rule — which is the answer
// the composition must reach anyway, and it keeps the offline suite spawn-free.
process.env.PI_ENSEMBLE_POLICY_JUDGE = "0";

const noSignals = { on: () => undefined, off: () => undefined } as unknown as NodeJS.Process;

const savedEnv: Record<string, string | undefined> = {};
for (const k of [
  "PI_ENSEMBLE_SANDBOX_MODE",
  "PI_ENSEMBLE_TRUST_MODE",
  "PI_ENSEMBLE_MERGE_AUTHORITY",
  "PI_ENSEMBLE_POLICY_JUDGE",
  "PI_ENSEMBLE_HANDOFF_CHANNEL",
]) {
  savedEnv[k] = process.env[k];
}

/** A state file parked at the merge step, holding a PR the forge says is green. */
function readyToMerge(issue: number): WorkState {
  const base = initialState(issue);
  return {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      status: "running",
      baseSha: undefined,
      branchName: `feature/issue-${issue}`,
      prNumber: FIXTURE_PR,
      // Already ready: a draft cannot merge and would halt the step for a
      // reason unrelated to what these cases assert.
      prDraft: { status: "ready" },
    },
  } as WorkState;
}

/** Run the headless runner over one parked-at-merged cycle. */
async function mergedRun(opts: {
  issue: number;
  grant: string | undefined;
  merge: MergeVerdict;
  refuseDoctrine?: boolean;
}): Promise<{ code: number; state: WorkState | undefined; log: MergeExecLog }> {
  const repo = headlessRepo(opts.grant);
  const log: MergeExecLog = { calls: [], mergeCmds: [] };
  try {
    await writeState(repo.repoRoot, readyToMerge(opts.issue));
    // The doctrine read runs against the real repo at the real base SHA.
    const state = (await readState(repo.repoRoot, opts.issue)) as WorkState;
    await writeState(repo.repoRoot, {
      ...state,
      pipelineState: { ...state.pipelineState, baseSha: repo.baseSha },
    } as WorkState);
    const result = await runHeadless({
      repoRoot: repo.repoRoot,
      issues: [opts.issue],
      restart: false,
      signalTarget: noSignals,
      driverSeams: {
        dispatchFn: (async () => okResult("Mechanized merge succeeded.")) as never,
        issueBodyFetcherFn: (async () => ({
          stdout: `title:\ts5\nstate:\tOPEN\n\nbody`,
        })) as never,
        verifyExecFn: mergeExec(
          {
            merge: opts.merge,
            repoRoot: repo.repoRoot,
            refuseDoctrine: opts.refuseDoctrine,
          },
          log,
        ),
      } as unknown as Pick<DriverContext, "dispatchFn" | "issueBodyFetcherFn" | "verifyExecFn">,
      write: () => undefined,
    } as unknown as Parameters<typeof runHeadless>[0]);
    return { code: result.exitCode, state: await readState(repo.repoRoot, opts.issue), log };
  } finally {
    repo.dispose();
  }
}

// ── 1. The CLI refuses `--merge` and `--sandboxed` as unknown arguments.
// `parseHeadlessArgs` is what `main` answers with `{error:{code:"bad-arguments"}}`
// and `EXIT.refused` (40): the flag never reaches the driver, so no cycle can be
// running when the refusal happens.
{
  for (const flag of ["--merge", "--sandboxed", "--auto-merge", "--allow-unreviewed"]) {
    const parsed = parseHeadlessArgs(["7", flag]);
    assert("error" in parsed, `\`${flag}\` is rejected as an unknown argument`);
    assert(
      "error" in parsed &&
        parsed.error.includes("unknown argument") &&
        parsed.error.includes(flag),
      `the error names the offending flag verbatim (got: ${"error" in parsed ? parsed.error : ""})`,
    );
  }
  const ok = parseHeadlessArgs(["7", "--restart", "--json"]);
  assert(
    !("error" in ok),
    "the supported flags still parse — the refusal is not a blanket rejection",
  );
  const names = buildCapabilities().inputs.map((i) => i.name);
  assert(
    !names.includes("PI_ENSEMBLE_SANDBOXED") && !names.includes("PI_ENSEMBLE_MERGE"),
    "--capabilities publishes no headless `--sandboxed` / `--merge` input",
  );
  assert(
    names.includes("PI_ENSEMBLE_SANDBOX_MODE"),
    "the only trust-mode input is PI_ENSEMBLE_SANDBOX_MODE, which the image sets",
  );
}

// ── 2. The composition refuses: green `gh`, no written grant → exit 10, no merge.
{
  const r = await mergedRun({ issue: 9001, grant: undefined, merge: "green" });
  assert(
    r.code === EXIT.handoff,
    `green PR + no doctrine grant → awaiting-human-merge → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.status === "handoff",
    `...and the cycle parks in handoff (got ${r.state?.pipelineState.status})`,
  );
  const cap = [...(r.state?.eventLog ?? [])].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "awaiting-human-merge",
    `the cap is awaiting-human-merge (got ${cap?.kind === "cap-hit" ? cap.cap : cap?.kind})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === false,
    "the recorded hold says the authority was not granted",
  );
  assert(
    r.log.mergeCmds.length === 0,
    `no forge merge ran — every \`gh\` answer was green and it still did not merge (${r.log.mergeCmds.length} attempted)`,
  );
  // The gate's ORDER is load-bearing here: authority is decided first and
  // evidence is gathered only when authority granted (`authority.granted ?
  // gatherMergeEvidence(...) : undefined`). A denial therefore reads the
  // doctrine and never calls gh — and that short-circuit is exactly what
  // makes "a green PR is not permission" true. Asserting a gh call here would
  // assert the opposite of the contract.
  assert(
    r.log.calls.some((c) => c.startsWith("git show ") && c.includes("AGENTS.md")),
    "authority was decided from the doctrine at the base commit, not from gh's green answer",
  );
  assert(
    r.log.calls.every((c) => !c.includes("mergeStateStatus,mergeable,state")),
    "the evidence gate was not consulted at all — a denied cycle does not get to ask gh whether it may merge",
  );
}

// ── 3. Doctrine present at base but unreadable at the gate → still exit 10.
// The #406 read is the only route to a grant; when it yields nothing, the rule
// (`unstated`) stands and an absent answer is not permission.
{
  const r = await mergedRun({
    issue: 9002,
    grant: MERGE_GRANT,
    merge: "green",
    refuseDoctrine: true,
  });
  assert(
    r.code === EXIT.handoff,
    `doctrine unreadable at the gate → no grant → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.mergeHold?.authorityGranted === false,
    "the hold records the denial rather than a silent pass",
  );
  assert(r.log.mergeCmds.length === 0, "and nothing was merged");
}

// ── 4. Even with a grant in hand, evidence gates the merge.
// `authority.granted` is not sufficient; the forge's own answer decides.
{
  const r = await mergedRun({ issue: 9003, grant: MERGE_GRANT, merge: "blocked" });
  assert(
    r.code === EXIT.handoff,
    `mergeStateStatus BLOCKED → not merged → exit 10 (got ${r.code})`,
  );
  assert(
    r.state?.pipelineState.status !== "merged",
    "...and a cycle whose evidence refused never reaches merged",
  );
}
{
  const r = await mergedRun({ issue: 9004, grant: MERGE_GRANT, merge: "failing" });
  assert(
    r.code === EXIT.handoff,
    `failing required checks → exit 10 (got ${r.code})`,
  );
  assert(r.log.mergeCmds.length === 0, "failing checks stop the merge before it is attempted");
}

{
  const r = await mergedRun({ issue: 9005, grant: MERGE_GRANT, merge: "unopen" });
  assert(
    r.code === EXIT.handoff,
    `a PR that is CLOSED, not OPEN → exit 10 (got ${r.code})`,
  );
  assert(r.log.mergeCmds.length === 0, "a PR that is not OPEN is never merged");
}

// ── 5. An intent park → exit 11 with numbered questions, from the real driver.
{
  const repo = headlessRepo(MERGE_GRANT, "headless-s5-park-");
  try {
    const park = [
      "INTENT-VERDICT: park",
      "PARK-REASON: underspecified",
      "",
      "## Spec",
      "",
      "### Intent",
      "Do the thing the issue describes.",
      "",
      "### Deliverables",
      "- the thing [paths: src/a.ts]",
      "",
      "### Open questions",
      "- Which database should the record live in?",
      "- Does the operator want the old rows migrated?",
      "not a bullet",
      "",
      "## Rationale",
      "The issue names neither.",
    ].join("\n");
    const result = await runHeadless({
      repoRoot: repo.repoRoot,
      issues: [9006],
      restart: false,
      signalTarget: noSignals,
      driverSeams: {
        dispatchFn: (async (_pi: unknown, spec: { role?: string }) => {
          // Only explore answers; anything else is a step this case did not
          // intend to pay for.
          if (spec.role === "explore") return okResult(park);
          throw new Error(`unexpected dispatch to role ${String(spec.role)}`);
        }) as never,
        issueBodyFetcherFn: (async () => ({
          stdout: "title:\ts5 park\nstate:\tOPEN\n\nA body too thin to build from.",
        })) as never,
      } as unknown as Pick<DriverContext, "dispatchFn" | "issueBodyFetcherFn">,
      write: () => undefined,
    } as unknown as Parameters<typeof runHeadless>[0]);
    assert(result.exitCode === 11, `an intent park exits 11 (got ${result.exitCode})`);
    const issue = result.results.find((x) => x.issue === 9006);
    assert(
      issue?.status === "handoff" && issue.cap === "intent-park",
      `the result carries the intent-park cap (got ${issue?.cap})`,
    );
    assert(
      issue?.parkReason === "underspecified",
      `and the resolver's own park reason (got ${issue?.parkReason})`,
    );
    // The questions field is the cap-hit's bullet evidence, numbered. The
    // driver's intent-park carries `parkReason` and no bullet evidence, so this
    // is the honest shape: exit 11 plus the reason, and no invented questions.
    // The numbered-question projection itself is asserted against a state file
    // that does carry bullets (section 7 below) — asserting it here would
    // require the driver to emit a field it deliberately does not.
    assert(
      Array.isArray(issue?.questions),
      `the exit-11 result carries a questions array (got ${JSON.stringify(issue?.questions)})`,
    );
    assert(
      issue?.questions?.length === 0,
      "and it is empty for an intent-park: the cap carries a park reason, not bullet questions — the runner does not invent questions",
    );
  } finally {
    repo.dispose();
  }
}

// ── 6. Trust mode: the runner never sets it; a sandbox's own value passes through.
{
  const probe = async (issue: number, seen: Array<Record<string, string | undefined>>) =>
    runHeadless({
      repoRoot: mkdtempSync(path.join(tmpdir(), "headless-s5-trust-")),
      issues: [issue],
      restart: false,
      signalTarget: noSignals,
      driverSeams: {
        dispatchFn: (async () => {
          seen.push({
            sandbox: process.env.PI_ENSEMBLE_SANDBOX_MODE,
            trust: process.env.PI_ENSEMBLE_TRUST_MODE,
          });
          throw new Error("stop here — this case asserts the environment, not the cycle");
        }) as never,
        issueBodyFetcherFn: (async () => ({
          stdout: "title:\ts5\nstate:\tOPEN\n\nbody",
        })) as never,
      } as unknown as Pick<DriverContext, "dispatchFn" | "issueBodyFetcherFn">,
      write: () => undefined,
    } as unknown as Parameters<typeof runHeadless>[0]);

  delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
  delete process.env.PI_ENSEMBLE_TRUST_MODE;
  const outside: Array<Record<string, string | undefined>> = [];
  await probe(9007, outside);
  assert(outside.length > 0, "the cycle reached a dispatch (so the env check is not vacuous)");
  assert(
    outside.every((s) => s.sandbox === undefined && s.trust === undefined),
    "outside the sandbox image the runner sets neither PI_ENSEMBLE_SANDBOX_MODE nor PI_ENSEMBLE_TRUST_MODE — children fail closed",
  );
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  const inside: Array<Record<string, string | undefined>> = [];
  await probe(9008, inside);
  assert(
    inside.filter((s) => s.sandbox === "1").length > 0,
    "inside the sandbox the child sees the image's own value, untouched by the runner",
  );
  delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
}

// ── 7. The exit-code table stays the contract the docs describe.
{
  const capped = (c: string): WorkState =>
    appendEvent(initialState(9009), {
      kind: "cap-hit",
      at: 2,
      cap: c as never,
      reviewRound: 0,
      nextStep: "handoff",
    } as never);
  const withStatus = (s: WorkState, status: "handoff" | "merged"): WorkState => ({
    ...s,
    pipelineState: { ...s.pipelineState, status },
  });
  assert(
    projectIssue(withStatus(capped("awaiting-human-merge"), "handoff"), "x").exitCode === 10,
    "awaiting-human-merge projects exit 10",
  );
  assert(
    projectIssue(withStatus(capped("intent-park"), "handoff"), "x").exitCode === 11,
    "intent-park projects exit 11",
  );
  assert(
    projectIssue(withStatus(capped("explore-needs-clarification"), "handoff"), "x").exitCode === 11,
    "explore-needs-clarification projects exit 11",
  );
  assert(
    projectIssue(withStatus(capped("round-cap"), "handoff"), "x").exitCode === 10,
    "any other cap projects exit 10",
  );
  assert(
    projectIssue(withStatus(initialState(9009), "merged"), "x").exitCode === 0,
    "merged projects exit 0",
  );
  // The clarification projection with real bullets: this is the state shape a
  // needs-clarification cap writes, and the numbering contract exit 11 promises.
  {
    const asked = appendEvent(initialState(9010), {
      kind: "cap-hit",
      at: 3,
      cap: "explore-needs-clarification" as never,
      reviewRound: 0,
      nextStep: "handoff",
      evidence: "Clarify:\n- Which database?\n* Which region?\nnot a bullet",
    } as never);
    const p = projectIssue(withStatus(asked, "handoff"), "x");
    assert(
      p.exitCode === 11 &&
        JSON.stringify(p.questions) === JSON.stringify(["q1: Which database?", "q2: Which region?"]),
      `bullet evidence projects to numbered q1, q2 in order (got ${JSON.stringify(p.questions)})`,
    );
  }
}

for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
