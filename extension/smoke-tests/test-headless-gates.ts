#!/usr/bin/env bun
/**
 * Headless S5 (#1025) — the headless CLI, trust-env and exit-code contracts.
 *
 * Three contracts, all pre-existing behaviour this test pins for the headless
 * surface (it changes none of them):
 *
 *   1. **No `--merge`, no `--sandboxed` on the headless CLI.** Both are rejected
 *      on purpose: a flag an agent can pass is a flag an agent can pass, and
 *      `--merge` would clear the policy judge while `--sandboxed` would claim a
 *      trust mode the sandbox image never granted. Trust comes only from
 *      `PI_ENSEMBLE_SANDBOX_MODE=1`, which `.devcontainer/Dockerfile` bakes into
 *      the image.
 *   2. **Trust mode is an environment fact.** The runner never sets
 *      `PI_ENSEMBLE_SANDBOX_MODE`/`PI_ENSEMBLE_TRUST_MODE` itself; a sandbox's
 *      own value passes through to the child untouched.
 *   3. **The exit-code mapping**: merged → 0, no grant → 10, intent park → 11
 *      with numbered questions.
 *
 * The merge-gate cases (a cycle parked at `merged`, green `gh`, no doctrine
 * grant → refused) live in `test-headless-merge-authority.ts`; they were split
 * out when the file grew past the 500-line cap. Both files share
 * `lib/headless-s5-harness.ts`.
 *
 * "Process test" in the issue's sense: the runner's own composition
 * (`cli.ts` → `runHeadless` → the driver → the state file → the exit code),
 * exercised in-process with the seams the runner already exposes. The
 * spawn-side half of the trust / fail-closed contract is covered by
 * test-headless-permission-policy.ts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import { parseHeadlessArgs } from "../src/headless/cli.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { EXIT } from "../src/headless/exit-code.ts";
import { projectIssue } from "../src/headless/result.ts";
import { runHeadless } from "../src/headless/run.ts";
import { appendEvent, initialState, type WorkState } from "../src/workflow-state.ts";
import { MERGE_GRANT, capHitEvent, headlessRepo, okResult } from "./lib/headless-s5-fixture.ts";
import { initEnv, noSignals, restoreEnv, type DriverSeams } from "./lib/headless-s5-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

initEnv();

// ── 1. The CLI refuses `--merge` and `--sandboxed` as unknown arguments.
// `parseHeadlessArgs` is what `main` answers with `{error:{code:"bad-arguments"}}`
// and `EXIT.refused` (40): the flag never reaches the driver, so no cycle can be
// running when the refusal happens.
{
  for (const flag of ["--merge", "--sandboxed", "--auto-merge", "--allow-unreviewed"]) {
    const parsed = parseHeadlessArgs(["7", flag]);
    assert("error" in parsed, `\`${flag}\` is rejected as an unknown argument`);
    assert(
      "error" in parsed && parsed.error.includes("unknown argument") && parsed.error.includes(flag),
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

// ── 2. An intent park → exit 11, from the real driver.
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
        dispatchFn: async (_h: unknown, spec: { role?: string }) => {
          // Only explore answers; anything else is a step this case did not
          // intend to pay for.
          if (spec.role === "explore") return okResult(park);
          throw new Error(`unexpected dispatch to role ${String(spec.role)}`);
        },
        issueBodyFetcherFn: async () => ({
          stdout: "title:\ts5 park\nstate:\tOPEN\n\nA body too thin to build from.",
        }),
      } satisfies DriverSeams,
      write: () => undefined,
    });
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
    // that does carry bullets (section 4 below) — asserting it here would
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

// ── 3. Trust mode: the runner never sets it; a sandbox's own value passes through.
{
  const probe = async (issue: number, seen: Array<Record<string, string | undefined>>) =>
    runHeadless({
      repoRoot: mkdtempSync(path.join(tmpdir(), "headless-s5-trust-")),
      issues: [issue],
      restart: false,
      signalTarget: noSignals,
      driverSeams: {
        dispatchFn: async (_h: unknown, spec: { role?: string }) => {
          seen.push({
            sandbox: process.env.PI_ENSEMBLE_SANDBOX_MODE,
            trust: process.env.PI_ENSEMBLE_TRUST_MODE,
          });
          throw new Error("stop here — this case asserts the environment, not the cycle");
        },
        issueBodyFetcherFn: async () => ({
          stdout: "title:\ts5\nstate:\tOPEN\n\nbody",
        }),
      } satisfies DriverSeams,
      write: () => undefined,
    });

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

// ── 4. The exit-code table stays the contract the docs describe.
{
  const capped = (c: WorkCapLiteral): WorkState =>
    appendEvent(initialState(9009), capHitEvent(c, { at: 2 }));
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
    const asked = appendEvent(
      initialState(9010),
      capHitEvent("explore-needs-clarification", {
        at: 3,
        evidence: "Clarify:\n- Which database?\n* Which region?\nnot a bullet",
      }),
    );
    const p = projectIssue(withStatus(asked, "handoff"), "x");
    assert(
      p.exitCode === 11 &&
        JSON.stringify(p.questions) ===
          JSON.stringify(["q1: Which database?", "q2: Which region?"]),
      `bullet evidence projects to numbered q1, q2 in order (got ${JSON.stringify(p.questions)})`,
    );
  }
}

restoreEnv();

console.log(`\nexit ${exit}`);
process.exit(exit);
