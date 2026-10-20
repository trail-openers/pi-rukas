#!/usr/bin/env bun
/**
 * #1404 — the gate that must not become a no-op: a consolidated verify failure
 * the change CAUSED still halts commit-pr, terminal, at `integration-verify-failed`,
 * and never reaches the ops fallback.
 *
 * #1404 added a path that pushes on a red consolidated gate (every failing test
 * also fails at the cycle's base commit). That path is one misplaced `if` away
 * from being the whole behaviour: if the caller ever treats a red consolidated
 * verify as "not my problem", the mechanized path hands over to the LLM ops
 * dispatch, which commits and pushes the same broken tree — the textbook #328
 * gate-that-cannot-fail. The attribution cases live in
 * `test-integration-verify-baseline-probe.ts`; THIS file pins the other side of
 * the seam, which no test covered:
 *
 *  - a probe that excuses SOME names (mixed) → terminal, and the park names
 *    only the tests the change caused, and nothing is pushed;
 *  - a probe whose base verdict is unreadable → terminal (absence is never
 *    innocence), so a broken probe cannot launder a real failure;
 *  - the source canaries that keep the terminal branch in front of the ops
 *    fallback, and keep the new continue path gated on the probe's own verdict.
 *
 * Offline: real git in temp dirs, the suite's own verify-loop fixtures, no
 * network, no model. The gate is the real `verify-loop.sh` so the `FAILED:`
 * markers the attribution parser reads are the ones the loop really emits.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execp as realExec } from "../src/exec.ts";
import { mechanizedCommitPr } from "../src/work-driver-commit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { preExistingFailuresSectionOf } from "../src/work-driver-pr-body-definition.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { addLocalRemote, fixture, git, mkResult } from "./helpers-integrate-pin-realgit.ts";
import { commandOf } from "./lib/argv-shell.ts";

process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-intverify-terminal-"));
const ISSUE = 1404;
const BRANCH = `feature/issue-${ISSUE}-x`;
const PR = 501;

const LOOP = path.join(import.meta.dirname, "lib", "verify-loop.sh");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "verify-loop");

/**
 * The project's gate as one `.pi/verify-cmd` line over an explicit fixture list.
 * Paths resolve against the SCRIPT's own directory, never the cwd: the baseline
 * probe runs this SAME line in a different tree, and a cwd-relative list would
 * have the change run and the base run judge two different things.
 */
function loopCmd(files: string[]): string {
  const listed = files.map((f) => `"$DIR/${f}"`).join(" ");
  return ["#!/bin/sh", 'DIR="$(cd "$(dirname "$0")" && pwd)"', `exec bash ${LOOP} ${listed}`].join(
    String.fromCharCode(10),
  );
}

/** Copy a suite fixture (which decides pass/fail) to an absolute path. */
function putFixture(abs: string, fixtureBase: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  copyFileSync(path.join(FIXTURES, fixtureBase), abs);
}

/**
 * A repo whose base commit carries a gate that is ALREADY red (`test-red.ts`)
 * plus a base-owned green test (`test-green.ts`). The workstream commits
 * `change`, and anything in `breaks` is turned from the green fixture to the
 * red one — the shape that yields a mixed consolidated run.
 */
async function redGateCycle(
  name: string,
  opts: { change: Record<string, string>; breaks?: string[] },
) {
  const { repo } = await fixture(root, name);
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  putFixture(path.join(repo, "tests", "test-red.ts"), "fixture-1.ts");
  putFixture(path.join(repo, "tests", "test-green.ts"), "fixture-2.ts");
  writeFileSync(path.join(repo, "gate.sh"), loopCmd(["tests/test-red.ts", "tests/test-green.ts"]), {
    mode: 0o755,
  });
  chmodSync(path.join(repo, "gate.sh"), 0o755);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "sh gate.sh\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "--amend", "-m", "base: a gate already red at base"]);
  const base = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  await addLocalRemote(root, repo);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-default`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, base]);
  for (const [rel, body] of Object.entries(opts.change)) {
    mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    writeFileSync(path.join(wt, rel), body);
  }
  for (const rel of opts.breaks ?? []) putFixture(path.join(wt, rel), "fixture-3.ts");
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "-q", "-m", "developer: the change"]);
  // #1240's device, used here on purpose: a clean worktree whose tree EQUALS
  // the integration tree lets commit-pr's verify SKIP its run (the develop gate
  // already judged that content) and the gate under test would never be asked.
  // Unstaged residue makes that identity unprovable, so the consolidated run
  // always happens.
  writeFileSync(path.join(wt, "scratch-unstaged.txt"), "not staged\n");

  let pr: "OPEN" | undefined;
  const gh: string[] = [];
  let fallbackDispatched = false;
  const exec: NonNullable<DriverContext["verifyExecFn"]> = async (raw, o) => {
    const cmd = commandOf(raw, o);
    if (!cmd.startsWith("gh ")) return realExec(raw, o);
    gh.push(cmd);
    if (cmd.startsWith("gh pr list")) {
      return {
        stdout: JSON.stringify(pr === "OPEN" ? [{ number: PR, headRefName: BRANCH }] : []),
      };
    }
    if (cmd.startsWith("gh pr view")) {
      return { stdout: JSON.stringify({ number: PR, state: pr, headRefName: BRANCH }) };
    }
    if (cmd.startsWith("gh repo view")) return { stdout: "main\n" };
    if (cmd.startsWith("gh pr create")) {
      pr = "OPEN";
      return { stdout: `https://github.com/o/r/pull/${PR}\n` };
    }
    return { stdout: "" };
  };
  const ctx = {
    host: {},
    repoRoot: repo,
    issue: ISSUE,
    verifyExecFn: exec,
    // The ops fallback is the thing this test proves is NEVER reached on a
    // verify verdict: reached or not, it commits and pushes the tree the gate
    // rejected. Recorded rather than asserted-only-so-it-passes.
    dispatchFn: (async () => {
      fallbackDispatched = true;
      return mkResult({ role: "ops", text: `branch: ${BRANCH}\n\npr: ${PR}` });
    }) as unknown as DriverContext["dispatchFn"],
  } as unknown as DriverContext;

  const state0 = initialState(ISSUE, 1000);
  const initial: WorkState = {
    ...state0,
    pipelineState: {
      ...state0.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      branchName: BRANCH,
      baseSha: base,
      worktrees: { default: wt },
    },
  };

  const pushed = async (): Promise<string> =>
    (
      await git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${BRANCH}`]).catch(
        () => ({ stdout: "" }),
      )
    ).stdout.trim();

  /** The base commit with a gate that fails having named NO test — the shape
   *  that must never read as "green base, so nothing here is your fault". */
  const sabotageBase = async (): Promise<string> => {
    const baseWt = path.join(root, `${name}-base-wt`);
    await git(repo, ["worktree", "add", "--detach", baseWt, base]);
    writeFileSync(path.join(baseWt, "gate.sh"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    chmodSync(path.join(baseWt, "gate.sh"), 0o755);
    await git(baseWt, ["add", "-A"]);
    await git(baseWt, ["commit", "-q", "-m", "base with an unreadable gate"]);
    const sha = (await git(baseWt, ["rev-parse", "HEAD"])).stdout.trim();
    await git(repo, ["worktree", "remove", "--force", baseWt]);
    return sha;
  };

  return {
    repo,
    base,
    ctx,
    initial,
    gh,
    pushed,
    sabotageBase,
    /** Point the cycle's probe at a different commit (the sabotaged base). */
    probeAt: (sha: string) => {
      initial.pipelineState.baseSha = sha;
    },
    wasFallbackDispatched: () => fallbackDispatched,
  };
}

// ═══════════ 1. a change-caused failure still halts, terminal, at the cap ═══════════
//
// The gate is red at base AND the change broke the test that was green there.
// The probe excuses `test-red.ts` and must NOT excuse `test-green.ts`, so the
// cycle parks — with the park naming only the test the change caused.
{
  const c = await redGateCycle("mixed", {
    change: { "notes.md": "a change that broke a passing test\n" },
    breaks: ["tests/test-green.ts"],
  });
  const res = await mechanizedCommitPr(c.ctx, c.initial, 2000);
  assert(res.ok === false, "mixed: a consolidated failure the change caused is not a success");
  assert(
    res.ok === false && res.terminal === true,
    `mixed: the verify verdict is TERMINAL — only a terminal failure keeps ops from shipping the broken tree (got terminal=${JSON.stringify(res.ok ? undefined : res.terminal)})`,
  );
  assert(
    !c.wasFallbackDispatched(),
    "mixed: the ops fallback was never dispatched — a gate that hands a red tree to ops is a gate that cannot fail (#328)",
  );
  assert(
    res.ok === false && /test-green\.ts/.test(res.reason),
    `mixed: the park names the test the change caused (got "${res.ok ? "" : res.reason.slice(0, 200)}")`,
  );
  assert(
    res.ok === false &&
      /are pre-existing/.test(res.reason) &&
      !/CAUSED are: [^—]*\/test-red\.ts/.test(res.reason),
    `mixed: …and the base-red test is excused by name, never listed as caused (got "${res.ok ? "" : res.reason.slice(0, 300)}")`,
  );
  const at = await c.pushed();
  assert(
    at === "",
    `mixed: nothing was pushed${at ? ` — origin holds ${at.slice(0, 8)}, the tree the gate rejected` : ""}`,
  );
}

// ═══════════ 2. an unreadable probe never launders a real failure ═══════════
//
// The commit the probe checks out exits non-zero having named no test. Nothing
// was established, so nothing is excused: the cycle halts exactly as if no
// probe existed.
{
  const c = await redGateCycle("unreadable", {
    change: { "notes.md": "x\n" },
    breaks: ["tests/test-green.ts"],
  });
  c.probeAt(await c.sabotageBase());
  const res = await mechanizedCommitPr(c.ctx, c.initial, 2000);
  assert(
    res.ok === false && res.terminal === true,
    `unreadable base: the probe established nothing, so the cycle still halts terminal (got ${JSON.stringify(res.ok ? "ok" : { terminal: res.terminal })})`,
  );
  assert(
    !c.wasFallbackDispatched(),
    "unreadable base: an unreadable probe does not hand the red tree to ops",
  );
  assert(
    (await c.pushed()) === "",
    "unreadable base: absence of evidence is not evidence of innocence — nothing was pushed",
  );
}

// ═══════════ 3. a continued cycle says so in the PR body ═══════════
//
// The other half of #1404's AC: when the probe excuses every name and the
// cycle pushes, the PR says which tests the gate was already red on. A silent
// continue would leave the next reviewer (and the next cycle) to rediscover
// that the gate, not the diff, is broken.
{
  const section = preExistingFailuresSectionOf(["tests/test-red.ts", "tests/test-old.ts"]);
  assert(
    /## Pre-existing test failures/.test(section) &&
      section.includes("`tests/test-red.ts`") &&
      section.includes("`tests/test-old.ts`"),
    `the section names every excused test (got ${JSON.stringify(section.slice(0, 120))})`,
  );
  assert(
    preExistingFailuresSectionOf(undefined) === "" && preExistingFailuresSectionOf([]) === "",
    "…and is absent entirely when the gate was green or nothing was excused — no empty heading in a PR body",
  );
  const commit = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-commit.ts"),
    "utf8",
  );
  assert(
    /preExistingFailuresSectionOf\(res\.preExistingFailures\)/.test(commit),
    "canary: the mechanized PR body is built from the probe's names — the record is not just a state-file field",
  );
}

// ═══════════ 4. the source canaries #1404 must not have weakened ═══════════
//
// Both branches — the terminal early return AND the new `preExistingOnly`
// continue — live under the same verify tag. If the new branch is ever hoisted
// above the verify check, every verify failure becomes continuable.
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const read = (f: string) =>
    readFileSync(path.join(SRC, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
  // #1439 — the terminal return shape moved into `terminalCommitPrFailure` (the verify
  // and push-refusal branches now share one builder, so it lives with its siblings in
  // the commit helpers). Read all three: the canary asks about the whole path.
  const combined = `${read("work-driver-commit.ts")} ${read("work-driver-commit-lock.ts")} ${read("work-driver-commit-helpers.ts")}`;

  assert(
    // #1439 — the terminal literal now comes from the ONE builder both terminal branches
    // call, so the canary checks the two halves of the invariant separately: the verify
    // branch routes through the builder, and the builder is what stamps `terminal: true`.
    // An `if` that drops either half still fails here.
    /res\.failure === "verify"[\s\S]{0,300}?terminalCommitPrFailure\(/.test(combined) &&
      /function terminalCommitPrFailure\([\s\S]{0,600}?terminal: true/.test(combined),
    "canary: a verify failure is marked terminal — every other failure still falls back",
  );
  const mechIdx = combined.indexOf("const mech = await mechanizedCommitPr");
  const terminalIdx = combined.indexOf("mech.terminal", mechIdx);
  const fallbackIdx = combined.indexOf("dispatchCommitPrFallback", mechIdx);
  assert(
    mechIdx >= 0 && terminalIdx > mechIdx && terminalIdx < fallbackIdx,
    "canary: the terminal branch is checked before the ops fallback is reached",
  );
  assert(
    // #1439 — the cap selection moved into `pushTerminalCap`, so the literal now lives
    // in that helper rather than inline at the call site. Both spellings still have to
    // name a cap: the canary's point is that a terminal halt is never evidence-less.
    /cap: (?:mech\.timedOut \? "verify-timeout:commit-pr" : )?"integration-verify-failed"|return mech\.timedOut \? "verify-timeout:commit-pr" : "integration-verify-failed"|pushTerminalCap\(/.test(
      combined,
    ),
    "canary: it halts with a named cap rather than failing silently",
  );
  const explain = readFileSync(path.join(SRC, "work-driver-explain.ts"), "utf8");
  assert(
    /case "integration-verify-failed"/.test(explain),
    "the cap has an operator-facing explanation — an unexplained cap reads as a crash",
  );
  // #1404's continue path is produced on the verify side and only there:
  // `verifyIntegration` yields the pre-existing names ONLY when the probe's own
  // verdict says every name is red at base, and `integrate()` derives the
  // continue flag from those names alone. There is no third way in.
  const verifyStep = read("work-driver-integrate-verify-step.ts");
  assert(
    /vr\.preExistingOnly === true[\s\S]{0,220}?preExistingFailures/.test(verifyStep),
    "canary: the only continue path is gated on the probe's own verdict — no probe verdict, no continue",
  );
  const integrateSrc = read("work-driver-integrate.ts");
  assert(
    /preExistingOnly: true/.test(integrateSrc) &&
      /verifyPreExisting !== undefined/.test(integrateSrc),
    "canary: integrate() sets the continue flag from the probe's names alone — nothing else can mark a red gate continuable",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
