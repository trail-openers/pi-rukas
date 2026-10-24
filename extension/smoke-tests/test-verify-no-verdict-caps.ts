#!/usr/bin/env bun
/**
 * #1349 — parks that reached no verdict on the code no longer share
 * `verify-failed:<step>` with a real code failure.
 *
 *   - verifyCapFor: an environment failure parks verify-env, a red baseline
 *     whose failures are the only ones parks verify-baseline-red, and one
 *     real failure among them keeps verify-failed
 *   - verifyDevelopOutcome reports baseline-red-only only when the verify
 *     command's failures are the gate's only ones
 *   - the fix-pass, commit-pr re-entry and PR-gone parks carry their own caps
 *   - each new cap is published, validated, explained and mapped to a queue action
 *   - a state file written before #1349 still renders as it did
 *
 * Offline: temp git repos and a stub verify command.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CAP_TEMPLATES, FIXED_CAPS, capStep } from "../src/headless/caps.ts";
import { prGoneRefusal } from "../src/work-driver-commit-reentry.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { HOST_EXHAUSTION_LABEL } from "../src/work-driver-exec-error.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { VERIFY_TIMEOUT_LABEL, verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { FIX_PASS_EVIDENCE_PREFIX, PR_NOT_OPEN_MARKER } from "../src/workflow-state-cap.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import type { VerifyEvidenceOrigin } from "../src/workflow-state-schema-verify.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ENV = `${HOST_EXHAUSTION_LABEL} consolidated verify could not run: /bin/sh: 1: Cannot fork`;
const TIMEOUT = `${VERIFY_TIMEOUT_LABEL} verify command \`x\` exceeded its 10-min timeout`;
const BASE = `${BASELINE_RED_MARKER} verify command \`x\` ALSO FAILS on a clean checkout`;
const REAL = "verify command `x` failed in worktree default: expected 1, got 2";

// ── verifyCapFor.
{
  assert(verifyCapFor("develop", [ENV]) === "verify-env:develop", "env only → verify-env");
  assert(
    verifyCapFor("develop", [ENV, TIMEOUT]) === "verify-env:develop",
    "env plus a timeout → verify-env (neither judged the code)",
  );
  assert(
    verifyCapFor("develop", [ENV, REAL]) === "verify-failed:develop",
    "one real failure among env failures → verify-failed",
  );
  assert(
    verifyCapFor("develop", [TIMEOUT]) === "verify-timeout:develop",
    "timeouts only → verify-timeout (unchanged)",
  );
  assert(
    verifyCapFor("develop", [BASE, REAL], true) === "verify-baseline-red:develop",
    "baseline-red only → verify-baseline-red",
  );
  assert(
    verifyCapFor("develop", [BASE, REAL], false) === "verify-failed:develop",
    "a red baseline next to another check's failure → verify-failed",
  );
  assert(
    verifyCapFor("develop", [`${BASE} ${VERIFY_TIMEOUT_LABEL}`, TIMEOUT], true) ===
      "verify-timeout:develop",
    "timed out at base and on the change → verify-timeout (the bound, not the base)",
  );
  assert(
    verifyCapFor("develop", [REAL]) === "verify-failed:develop",
    "a real failure → verify-failed",
  );
}

// ── verifyDevelopOutcome reports baseline-red-only.
const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) => execFileP("/bin/sh", ["-c", cmd], { cwd });
const root = mkdtempSync(path.join(tmpdir(), "pi-no-verdict-"));
const CARGO = "running 41 tests\nerror: test failed, to rerun pass `--bin console`\n";

/** How the verify command fails at the base commit. */
type Base = "green" | "same" | "different" | "no-assertion" | "timeout";
const BASE_OUTPUT: Record<Exclude<Base, "green" | "timeout">, string> = {
  same: CARGO,
  different: "running 7 tests\nerror: test failed, to rerun pass `--bin other`\n",
  "no-assertion": "something went wrong\n",
};

async function develop(name: string, base: Base | boolean, strayUncommitted: boolean) {
  const baseRed = base !== false && base !== "green";
  const baseKind: Base = base === true ? "same" : base === false ? "green" : base;
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "bash scripts/verify.sh\n");
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\ntmp/\n");
  const wts: Record<string, string> = {};
  for (const id of strayUncommitted ? ["a", "b"] : ["a"]) {
    const wt = path.join(repo, ".worktrees", `issue-9-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    writeFileSync(path.join(wt, `${id}.txt`), "new\n");
    // Workstream b leaves its change uncommitted: a failure of its own.
    if (id === "a") {
      await git(wt, ["add", "."]);
      await git(wt, ["commit", "-q", "-m", "change"]);
    }
    wts[id] = wt;
  }
  const baselineDir = path.join(repo, ".worktrees", "baseline-verify-9");
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    cmd = commandOf(cmd, o);
    if (!cmd.includes("scripts/verify.sh"))
      return { stdout: (await sh(o?.cwd ?? repo, cmd)).stdout };
    const atBase = o?.cwd === baselineDir;
    if (atBase && !baseRed) return { stdout: "" };
    const e = new Error(`Command failed: ${cmd}`) as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (atBase && baseKind === "timeout") e.killed = true;
    e.stdout =
      atBase && baseKind !== "timeout" && baseKind !== "green" ? BASE_OUTPUT[baseKind] : CARGO;
    e.stderr = "";
    throw e;
  };
  const state = initialState(9);
  state.pipelineState.worktrees = wts;
  state.pipelineState.baseSha = baseSha;
  // The #1765 mixed set: a scope/fanout fence violation pushed by the gate
  // BEFORE the verify chain (the fence-first shape, where `before !== 0` defeated
  // the old length rule), plus an uncommitted workstream whose own tree fails.
  if (name === "fence-first") {
    state.pipelineState.workstreams = {
      a: { id: "a", paths: [], description: "a" },
      b: { id: "b", paths: ["extension/src/owned-by-a.ts"], description: "b" },
    } as never;
  }
  const failures: string[] = [];
  let baselineRedOnly = false;
  // #1765 — the CAP's claim travels through `reportBaselineLeg`, not through
  // `onBaselineRedOnly`: the excuse claim (above) is voided by one foreign
  // entry, and pricing the cap on it is what spent three develop rounds on a
  // base nothing could pass. So this counts the ESTABLISHED callback, which is
  // what the three cap call sites read.
  let baselineRedEstablished = false;
  await verifyDevelopOutcome(
    { host: {} as unknown as DriverContext["host"], repoRoot: repo, issue: 9 } as DriverContext,
    state,
    execFn,
    failures,
    [],
    {
      onBaselineRedOnly: () => {
        baselineRedOnly = true;
      },
      onBaselineRedEstablished: () => {
        baselineRedEstablished = true;
      },
    },
  );
  return { failures, baselineRedOnly, baselineRedEstablished };
}

{
  const red = await develop("red", true, false);
  assert(
    red.failures[0]?.startsWith(BASELINE_RED_MARKER) === true,
    "red at base: the probe finding leads",
  );
  assert(red.baselineRedOnly, "red at base, verify failures only → baseline-red-only reported");
  // #1765 — the established claim reaches the caller through the gate's own
  // tail (`reportBaselineLeg`), not just the excuse claim beside it.
  assert(
    red.baselineRedEstablished,
    "red at base: onBaselineRedEstablished fired through reportBaselineLeg",
  );
  const green = await develop("green", false, false);
  assert(
    green.failures.length > 0 && !green.baselineRedOnly,
    "green at base → not baseline-red-only",
  );
  assert(
    !green.baselineRedEstablished,
    "green at base: no established claim — the gate did not blame the base",
  );
  const mixed = await develop("mixed", true, true);
  // #1765 — the inverted pin. The old rule required the `[baseline-red]` entry
  // to be the gate's ONLY failure, so a workstream's own failure beside it
  // produced `verify-failed:develop` — the one cap a corrective round may earn
  // — and one measured cycle paid three develop rounds on a base nothing could pass. The
  // rule is now attribution: the entry names the command the probe re-ran, so
  // it wins the cap and the other entry travels as secondary evidence.
  assert(
    mixed.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)) && mixed.baselineRedOnly,
    `red at base plus another check's failure → the baseline-red entry still wins the cap (${mixed.failures.length} failures)`,
  );
  assert(
    mixed.failures.length > 1,
    "red at base plus another failure → the other failure is kept as evidence, not excused",
  );
  assert(
    verifyCapFor("develop", mixed.failures, mixed.baselineRedOnly) ===
      "verify-baseline-red:develop",
    "the mixed set caps verify-baseline-red:develop, not verify-failed:develop",
  );
  assert(
    mixed.baselineRedEstablished,
    "mixed set: onBaselineRedEstablished still fired — the foreign entry voids the excuse, not the base claim",
  );
  // The fence-first shape: the foreign failure is pushed BEFORE the verify chain,
  // so the old `before === 0` half of the rule failed as well as the length
  // half. Attribution by command does not care about either.
  const fenceFirst = await develop("fence-first", true, true);
  assert(
    fenceFirst.baselineRedOnly &&
      fenceFirst.failures.some((f) => f.startsWith(BASELINE_RED_MARKER)) &&
      fenceFirst.failures.length > 1,
    `a fence failure pushed before the verify chain still lets the probe win the cap (${fenceFirst.failures.length} failures)`,
  );
  assert(
    fenceFirst.baselineRedEstablished,
    "fence-first: onBaselineRedEstablished fired for the gate's whole failure list, not just the verify leg",
  );
}

// A red base excuses the change only when it demonstrably fails the same way.
for (const [base, why] of [
  ["different", "base and change fail on different assertions"],
  ["no-assertion", "the base assertion could not be extracted"],
  ["timeout", "the base timed out while the change fails on a real assertion"],
] as const) {
  const r = await develop(base, base, false);
  assert(
    r.failures[0]?.startsWith(BASELINE_RED_MARKER) === true,
    `${why}: the baseline finding still leads the evidence`,
  );
  const cap = verifyCapFor("develop", r.failures, r.baselineRedOnly);
  assert(cap === "verify-failed:develop", `${why}: parks verify-failed:develop (got ${cap})`);
}
rmSync(root, { recursive: true, force: true });

// ── The parks that never judged the change carry their own caps.
{
  const s = initialState(9002, 1000);
  s.pipelineState.branchName = "feat/x";
  const { haltedAfter } = prGoneRefusal(s, 12, "feat/x", "MERGED");
  const cap = [...haltedAfter.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "pr-not-open:commit-pr",
    "the commit-pr re-entry refusal parks pr-not-open:commit-pr",
  );
  const text = explainCap("pr-not-open:commit-pr", haltedAfter);
  assert(
    /no longer open/.test(text) && text.includes("PR #12"),
    "pr-not-open: the refusal is explained",
  );
  assert(!/outcome-verification gate rejected/.test(text), "pr-not-open: no gate claim");
}

function capped(
  cap: WorkCapLiteral,
  step: string,
  failures: string[],
  origin?: VerifyEvidenceOrigin,
) {
  let s: WorkState = initialState(9003, 1000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      verifyEvidence: { step: step as "develop", failures, at: 0, ...(origin ? { origin } : {}) },
    },
  };
  return appendEvent(s, { kind: "cap-hit", at: 1, cap, reviewRound: 0, nextStep: "handoff" });
}

{
  const env = explainCap("verify-env:develop", capped("verify-env:develop", "develop", [ENV]));
  assert(
    /could not run/.test(env) && env.includes(ENV),
    "verify-env: explained as the gate not running",
  );
  const base = explainCap(
    "verify-baseline-red:develop",
    capped("verify-baseline-red:develop", "develop", [BASE, REAL]),
  );
  assert(
    /already fails at the cycle's base commit/.test(base) && base.includes(REAL),
    "verify-baseline-red: explained as red at base, failures listed",
  );
  const reason = `${FIX_PASS_EVIDENCE_PREFIX}the fix pass removed 3 origin/main comment line(s)`;
  const fix = explainCap("fix-pass-park", capped("fix-pass-park", "develop", [reason], "fix-pass"));
  assert(
    /adversarial fix pass did not clear/.test(fix) && fix.includes(reason),
    "fix-pass-park: explained as the fix pass's own park",
  );
  // A state file written before #1349 still routes on origin.
  const old = explainCap(
    "verify-failed:develop",
    capped("verify-failed:develop", "develop", [reason], "fix-pass"),
  );
  assert(
    /adversarial fix pass did not clear/.test(old),
    "a pre-#1349 fix-pass park still renders as before",
  );
  const oldPr = explainCap(
    "verify-failed:commit-pr",
    capped(
      "verify-failed:commit-pr",
      "commit-pr",
      [`${PR_NOT_OPEN_MARKER} PR #3 is CLOSED`],
      "pr-not-open",
    ),
  );
  assert(/no longer open/.test(oldPr), "a pre-#1349 pr-not-open park still renders as before");
}

// ── Published, validated, and mapped to a queue action.
{
  for (const t of ["verify-env", "verify-baseline-red", "pr-not-open"]) {
    assert(t in CAP_TEMPLATES, `${t}: is a published template`);
    assert(capStep(`${t}:develop`) === "develop", `${t}: names its step`);
  }
  assert((FIXED_CAPS as readonly string[]).includes("fix-pass-park"), "fix-pass-park is published");
  for (const cap of [
    "verify-env:develop",
    "verify-baseline-red:develop",
    "pr-not-open:ci",
    "fix-pass-park",
  ] as const) {
    const findings = validateDiscriminants(capped(cap, "develop", []));
    assert(findings.length === 0, `${cap}: validates (${findings.join("; ")})`);
  }
  const action = (cap: string) => humanActionFor(`cap ${cap}`, 7);
  assert(
    /free processes on the host/.test(action("verify-env:develop")),
    "queue: verify-env → the host",
  );
  assert(
    /base commit/.test(action("verify-baseline-red:develop")),
    "queue: baseline-red → the base",
  );
  assert(/no longer open/.test(action("pr-not-open:commit-pr")), "queue: pr-not-open → the PR");
  assert(/fix pass/.test(action("fix-pass-park")), "queue: fix-pass-park → the fix pass's reason");
  assert(
    /inspect #7's diff/.test(action("verify-failed:develop")),
    "queue: verify-failed → the diff",
  );
}

process.exit(exit);
