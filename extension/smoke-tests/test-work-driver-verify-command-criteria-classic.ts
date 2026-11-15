#!/usr/bin/env bun
/**
 * #2283 — the classic `/work` command-criteria tier.
 *
 * The lean engine has run `verify: "command"` criteria since the tier was written. Classic
 * `/work` never had a call site, so a cycle filed against a spec carrying them ran none and
 * reported the develop step green — and a project whose verify command `verifyCmdFor` cannot
 * discover (the normal shape for a language the chain does not know) ran no command at all in
 * that step.
 *
 * The wiring MIRRORS lean by calling the same two functions (`specCriteriaFor`,
 * `commandCriteriaOutcome`); it does not re-implement them and it does not change lean's
 * behaviour. These cases drive the real `verifyDevelopOutcome` over real git, and pin four
 * things the issue makes load-bearing:
 *
 *   - **independent of `plan.cmd`** — the arms differ by the DISCOVERED verify command being
 *     absent, and the criteria still run (the control proves the chain really was skipped);
 *   - **a red criterion fails verify** — with `ok:false`, the criterion's own id in the
 *     failure, and no cap-routing marker anywhere in it;
 *   - **a not-runnable criterion is disclosed, never red** — a note naming the criterion, and
 *     the step still passing;
 *   - **a missing `verify.test` template is a named blocking failure** whose string is not
 *     the `[toolchain-unsound]` label and carries none of the `verifyCapFor` markers.
 *
 * Also pinned: the issue body comes from the cached artifact only (a missing or out-of-state
 * artifact is a named note, never a network read), and the two gates report independently —
 * a run with a red criterion AND an absent provenance path reports both.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_RESIDUE_LABEL } from "../src/work-driver-dirty-root-classify.ts";
import { HOST_EXHAUSTION_LABEL } from "../src/work-driver-exec-error.ts";
import { TOOLCHAIN_UNSOUND_LABEL } from "../src/work-driver-toolchain-canary.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import {
  COMMAND_CRITERIA_CHECKED_NOTE_PREFIX,
  COMMAND_CRITERIA_PREFIX,
  MISSING_VERIFY_TEST_TEMPLATE_FAILURE,
} from "../src/work-driver-verify-develop-command-criteria.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";
import { PROVENANCE_FAILURE_PREFIX } from "../src/work-driver-verify-develop-provenance.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./lib/verify-develop-provenance-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One criterion's spec block, in the shape `parsePiSpec` accepts. */
function specBody(criteria: Record<string, unknown>[]): string {
  return `Add a quota check to the meter.\n\n\`\`\`pi-spec v1\n${JSON.stringify(
    { problem: "The meter must refuse an over-quota draw.", criteria, size: "S" },
    null,
    2,
  )}\n\`\`\`\n`;
}

const GREEN_CRITERION = {
  id: "AC1",
  text: "The existing suite still passes.",
  verify: "command",
  command: "tests/quota.test.ts",
};

/** The chain's own "nothing to run" note, read rather than restated as a literal a drift in
`work-driver-verify-develop-cmd.ts` would silently retire. */
// The chain's own "nothing to run" note. The fixture passes an empty `verifyCmd` to make the
// chain skip: `cmd: ""` is falsy, so the gate records its skipped arm and says so, where an
// absent key would take the default-`npm test` arm and report a real (red) run instead.
const CHAIN_SKIPPED_NOTE = "no verify command discoverable";

/** The tier's executed-pass note, asserted with its counts so "ran nothing" can never print
 * the same sentence as "ran everything". */
const CRITERIA_RAN_NOTE = "command criteria: 1 of 1 command criteria run, none failed";

/** A runner template the config validator accepts: argv form, one whole-word `{file}`. */
const RUNNER_TEMPLATE = "sh tests/run.sh {file}";

/** The project's per-file runner: exits 0 unless the file's own bytes say FAIL, and echoes
 * the filename on failure — the shape `runTestFile` needs to call a run red rather than
 * "unclear". argv form, so no shell re-parses the criterion's path. */
const RUNNER_SCRIPT =
  '#!/bin/sh\nif grep -q FAIL "$1"; then echo "FAILED: $1" >&2; exit 1; fi\nexit 0\n';

interface Run {
  failures: string[];
  notes: string[];
  ok: boolean;
  f: ProvenanceFixture;
  mine: string[];
}

/**
 * Drive the develop gate once.
 *
 * `verifyCmd` deliberately controls ONLY the discovered verify command: when absent, the
 * chain prints "no verify command discoverable" and runs nothing, which is the state the
 * criteria must survive. The runner script and the criterion's test file are committed at
 * the base either way, because the tier's own rule is that a command criterion's file must
 * be byte-identical to base.
 */
async function run(opts: {
  criteria?: Record<string, unknown>[];
  /** Contents for the criterion's test file; a file containing FAIL makes the runner exit 1. */
  testFileContent?: string;
  workJson?: Record<string, unknown> | null;
  /** `""` makes the chain skip entirely; undefined lets the fixture default it to "". */
  verifyCmd?: string;
  body?: string | null;
  extraDevelopFiles?: Record<string, string>;
}): Promise<Run> {
  const f = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: {
      ...(opts.workJson === null
        ? {}
        : {
            ".pi/work.json": JSON.stringify(
              opts.workJson ?? {
                version: 1,
                autoMerge: false,
                budgets: {},
                verify: { test: RUNNER_TEMPLATE },
              },
              null,
              2,
            ),
          }),
      "tests/run.sh": RUNNER_SCRIPT,
      "tests/quota.test.ts": opts.testFileContent ?? "ok\n",
      ...(opts.verifyCmd === undefined ? {} : { ".pi/verify-cmd": `${opts.verifyCmd}\n` }),
    },
    // One committed file always: the develop gate's own hollow-diff rule refuses a run whose
    // every worktree is empty, and that failure is not what these cases are about.
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      ...(opts.extraDevelopFiles ?? {}),
    },
    // "" is the caller's own command string, forwarded verbatim so the harness's argv-prefix
    // match never fires and the chain sees exactly what the fixture's .pi/verify-cmd holds.
    verifyCommand: opts.verifyCmd ?? "",
  });
  const artifact = writeBodyArtifact(f, opts.criteria, opts.body);
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(
    f.ctxFor(),
    f.stateFor(artifact === undefined ? {} : { issueBodyArtifact: artifact }),
    f.execFn,
    failures,
    notes,
    {},
  );
  return {
    failures,
    notes,
    ok: failures.length === 0,
    f,
    mine: failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)),
  };
}

/** Write the composite body the explore step would have written, under the state dir. */
function writeBodyArtifact(
  f: ProvenanceFixture,
  criteria: Record<string, unknown>[] | undefined,
  body: string | null | undefined,
): string | undefined {
  if (body === null) return undefined;
  const text = body ?? specBody(criteria ?? [GREEN_CRITERION]);
  const rel = `.pi/work-state/2283/issue-body.txt`;
  mkdirSync(path.join(f.repo, ".pi", "work-state", "2283"), { recursive: true });
  writeFileSync(path.join(f.repo, rel), text);
  return rel;
}

const cleanup = async (r: Run): Promise<void> => {
  const { rmSync } = await import("node:fs");
  rmSync(r.f.root, { recursive: true, force: true });
};

// ── 1. the green arm: a runnable command criterion runs, and the step passes ───────────────
{
  const r = await run({ criteria: [GREEN_CRITERION] });
  assert(
    r.mine.length === 0,
    `green: a runnable command criterion does not fail the step (got: ${r.mine.join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === true,
    `green: the tier SAYS it ran — an executed pass is distinguishable from a pass that ran nothing (got: ${r.notes.join(" | ")})`,
  );
  await cleanup(r);
}

// ── 2. independent of plan.cmd: no discoverable verify command, criteria still run ─────────
{
  // The control first: with NO criteria at all and no discoverable command, the chain is
  // skipped and nothing runs. Without this arm, "the criteria ran" below could be the verify
  // command's own doing rather than this tier's.
  // `verifyCmd: undefined` puts no `.pi/verify-cmd`, no package.json and no Cargo.toml in the
  // fixture, so `verifyCmdFor` discovers nothing and the whole per-worktree chain is skipped.
  // The control asserts that skip from the SAME arm's notes, so "the criteria ran" below is a
  // statement about this tier and not about a verify command nobody disabled.
  const control = await run({ criteria: [], verifyCmd: undefined });
  assert(
    control.notes.some((n) => n.includes(CHAIN_SKIPPED_NOTE)) === true &&
      control.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === false,
    `control: with no criteria and no discoverable command, the chain is skipped AND no criterion claims to have run (got: ${control.notes.filter((n) => n.includes("verify command")).join(" | ")})`,
  );
  await cleanup(control);

  const r = await run({ criteria: [GREEN_CRITERION], verifyCmd: undefined });
  assert(
    r.notes.some((n) => n.includes(CHAIN_SKIPPED_NOTE)) === true,
    `the verify-command chain really was skipped — no discoverable command in this arm (got: ${r.notes.filter((n) => n.includes("verify command")).join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === true,
    `and the criteria ran ANYWAY, which is the whole point of wiring them beside the ratchet gates rather than inside the chain (got: ${r.notes.join(" | ")})`,
  );
  await cleanup(r);
}

// ── 3. a red criterion fails verify, and the cap it routes to is verify-failed:develop ─────
{
  const r = await run({ criteria: [GREEN_CRITERION], testFileContent: "FAIL\n" });
  assert(
    r.ok === false,
    `red: a criterion whose file exits non-zero fails the develop step (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.mine.length === 1 && r.mine[0]?.includes("AC1") === true,
    `red: the failure names the criterion id (got: ${r.mine.join(" | ")})`,
  );
  assert(
    verifyCapFor("develop", r.failures) === "verify-failed:develop",
    `red: the cap is the ordinary verify-failure cap (got ${verifyCapFor("develop", r.failures)})`,
  );
  await cleanup(r);
}

// ── 4. a missing verify.test template is a named blocking failure ──────────────────────────
{
  const r = await run({ criteria: [GREEN_CRITERION], workJson: null });
  assert(
    r.ok === false,
    `no template: the step FAILS rather than passing over criteria nobody ran (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.mine[0] === MISSING_VERIFY_TEST_TEMPLATE_FAILURE,
    `no template: the failure is the named constant, byte-for-byte (got: ${r.mine[0]})`,
  );
  assert(
    r.mine[0]?.includes(TOOLCHAIN_UNSOUND_LABEL) === false &&
      r.mine[0]?.includes(VERIFY_TIMEOUT_LABEL) === false &&
      r.mine[0]?.includes(BASELINE_RED_MARKER) === false &&
      r.mine[0]?.includes(HOST_EXHAUSTION_LABEL) === false &&
      r.mine[0]?.includes(BUILD_RESIDUE_LABEL) === false,
    "no template: the string carries neither the toolchain-unsound label nor any no-verdict marker, so it cannot be routed to another cap",
  );
  assert(
    verifyCapFor("develop", r.failures) === "verify-failed:develop",
    `no template: and the cap router sends it to verify-failed:develop (got ${verifyCapFor("develop", r.failures)})`,
  );
  await cleanup(r);
}

// ── 5. not-runnable is disclosed, never red ────────────────────────────────────────────────
{
  // A `command` that is not a plain repo-relative file is the spec's own defect: the tier
  // declines it, the step stays green, and the reason reaches the notes.
  const r = await run({
    criteria: [
      { id: "AC9", text: "Not a file at all.", verify: "command", command: "sh -c 'exit 1'" },
      GREEN_CRITERION,
    ],
  });
  assert(
    r.ok === true,
    `not-runnable: a refused criterion never fails the step (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n.includes("criterion AC9 not run")) === true,
    `not-runnable: the refusal is DISCLOSED per criterion, with its reason (got: ${r.notes.filter((n) => n.includes("AC9")).join(" | ")})`,
  );
  assert(
    r.notes.some((n) =>
      n.includes("command criteria: 1 of 2 command criteria run, none failed"),
    ) === true,
    "and the runnable criterion beside it still ran, so a refusal cannot hide a pass or a red (the note counts 1 of 2)",
  );
  await cleanup(r);
}

// ── 6. a criterion whose file changed since base is not-runnable, not red ──────────────────
{
  const r = await run({
    criteria: [GREEN_CRITERION],
    extraDevelopFiles: { "tests/quota.test.ts": "rewritten by the develop child\n" },
  });
  assert(
    r.ok === true &&
      r.notes.some(
        (n) => n.includes("criterion AC1 not run") && n.includes("changed since base"),
      ) === true,
    `a preservation criterion whose file the change rewrote is declined, not judged red (ok ${String(r.ok)}; got: ${r.notes.filter((n) => n.includes("AC1")).join(" | ")})`,
  );
  await cleanup(r);
}

// ── 7. the issue body comes from the cached artifact, never the network ────────────────────
{
  const missing = await run({ criteria: [GREEN_CRITERION], body: null });
  assert(
    missing.ok === true &&
      missing.notes.some((n) => n.includes("NOT CHECKED") && n.includes("no cached issue body")) ===
        true,
    `no artifact: a named note, not a pass-by-silence and not a failure (ok ${String(missing.ok)}; got: ${missing.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(missing);

  // An artifact outside the cycle's state dir is refused by `readCachedBody`; the tier then
  // says it could not read the block rather than fetching the issue over the network.
  const outside = await run({ criteria: [GREEN_CRITERION] });
  const rel = ".pi/outside-body.txt";
  writeFileSync(path.join(outside.f.repo, rel), specBody([GREEN_CRITERION]));
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(
    outside.f.ctxFor(),
    outside.f.stateFor({ issueBodyArtifact: rel }),
    outside.f.execFn,
    failures,
    notes,
    {},
  );
  assert(
    failures.length === 0 &&
      notes.some((n) => n.includes("NOT CHECKED") && n.includes("artifact")) === true,
    `an artifact outside .pi/work-state/ is a named note — the block is never read from a path the driver did not write (got: ${notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(outside);
}

// ── 8. an unparsable spec block is a note, not a failure and not a pass-by-silence ─────────
{
  const r = await run({ criteria: undefined, body: "prose only, no block at all\n" });
  assert(
    r.ok === true && !r.notes.some((n) => n.includes(COMMAND_CRITERIA_CHECKED_NOTE_PREFIX)),
    "a body with no pi-spec block is an ordinary run that asked for nothing: no criteria, no note claiming any ran",
  );
  await cleanup(r);
  const broken = await run({ criteria: undefined, body: "```pi-spec v1\n{not json\n```\n" });
  assert(
    broken.ok === true &&
      broken.notes.some((n) => n.includes("NOT CHECKED") && n.includes("spec")) === true,
    `an unparsable block is a named note, never a verdict (ok ${String(broken.ok)}; got: ${broken.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(broken);
}

// ── 9. independence: a red criterion and an absent provenance path report BOTH ─────────────
{
  const both = await run({
    criteria: [GREEN_CRITERION],
    testFileContent: "FAIL\n",
    extraDevelopFiles: {
      "tasks/record.json": '{"source":"results/never-measured.ndjson","rows":[]}\n',
    },
  });
  const prov = both.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX));
  const crit = both.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX));
  assert(
    prov.length === 1 && crit.length === 1,
    `both gates report on the same run — neither suppresses the other (provenance ${String(prov.length)}, criteria ${String(crit.length)})`,
  );
  await cleanup(both);

  const onlyProv = await run({
    criteria: [GREEN_CRITERION],
    extraDevelopFiles: { "tasks/record.json": '{"source":"results/never-measured.ndjson"}\n' },
  });
  assert(
    onlyProv.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX)).length === 1 &&
      onlyProv.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).length === 0,
    "with only the provenance defect, only that gate reports",
  );
  await cleanup(onlyProv);

  const onlyCrit = await run({ criteria: [GREEN_CRITERION], testFileContent: "FAIL\n" });
  assert(
    onlyCrit.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX)).length === 0 &&
      onlyCrit.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).length === 1,
    "with only the criterion defect, only that gate reports",
  );
  await cleanup(onlyCrit);
}

// ── 10. the tier's own wording survives drift against the lean module it mirrors ───────────
{
  const { readFileSync } = await import("node:fs");
  const lean = readFileSync(
    path.join(import.meta.dir, "..", "src", "lean", "verify-commands.ts"),
    "utf8",
  );
  assert(
    lean.includes("no verify.test runner template is configured"),
    "the missing-template signature this tier matches on is still the string lean/verify-commands.ts throws — the two cannot drift in silence",
  );
  assert(
    MISSING_VERIFY_TEST_TEMPLATE_FAILURE.includes("verify.test"),
    "and the blocking failure names the config key the operator has to set",
  );
}

// ── 11. the doctrine both gates rest on is actually shipped to the reviewers ───────────────
{
  // These two modules exist because "a record that round-trips through its own generator"
  // was being accepted as evidence. That judgement lives in the prompt layer, so a reviewer
  // is only told to make it if the sentence is still in the assembled modules — a reworded
  // or deleted module would leave both gates enforcing a rule nobody states.
  const { readFileSync } = await import("node:fs");
  const doctrine = ["../modules/domains/adversarial-criteria.md", "../modules/workflows/quality-gates.md"];
  for (const rel of doctrine) {
    const text = readFileSync(path.join(import.meta.dir, "..", rel), "utf8");
    assert(
      text.includes("round-trips through its own generator") &&
        text.includes("met only by evidence that it executed"),
      `${rel} still carries the evidence-not-claims rule these two gates enforce`,
    );
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
