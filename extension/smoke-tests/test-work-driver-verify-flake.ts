#!/usr/bin/env bun
/**
 * #782 — the consolidated-tree verify gate's single bounded flake retry.
 *
 * Three cases (N=2 for cases 1–2, N=1 for case 3):
 *
 *   case 1 — fail-then-pass: the verify command passes in each worktree's
 *     tree (content check: export count < 4) and in the consolidated tree
 *     fails on the first run (count = 4, no flag), then passes on the
 *     second (flag exists). The flag is at a relative path in the
 *     consolidated tree, which is NOT in the worktrees (separate checkouts).
 *     Asserts: gate.ok, flakeRetry = {retries:1, recovered:true}, and a
 *     verify-flake-recovered event with step "develop".
 *
 *   case 2 — fail-both: the verify command passes in each worktree's tree
 *     (count < 4) and fails in the consolidated tree on BOTH runs (count = 4,
 *     stateless — no flag). Asserts: gate NOT ok, flakeRetry =
 *     {retries:1, recovered:false}, NO verify-flake-recovered event, and a
 *     classification label in the failure.
 *
 *   case 3 — N=1 invariant: the retry must NOT fire for N=1 (a no-op
 *     consolidation). Asserts: gate NOT ok, flakeRetry is undefined (no
 *     retry ran), NO verify-flake-recovered event.
 *
 * All commands are deterministic (no sleep-based flakes) per AGENTS.md §1.
 * The stateful flag (case 1) is at a relative path in the consolidated tree
 * (repoRoot, checked out to the scratch branch) and is untracked, so it does
 * not trip the dirty-root preflight (which runs before the scratch checkout).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const realExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    e.stdout = e.stdout ?? "";
    e.stderr = e.stderr ?? (err as unknown as { stderr?: string }).stderr ?? "";
    throw e;
  }
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-782-flake-"));

async function fixture(name: string, ids: string[], seed: Record<string, string>) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) writeFileSync(path.join(repo, rel), body);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
    worktrees[id] = wt;
  }
  const pi = path.join(repo, ".pi");
  mkdirSync(pi, { recursive: true });
  return { repo, baseSha, worktrees, originDir };
}

function commitIn(wt: string, msg: string) {
  return execFileP("git", ["add", "."], { cwd: wt }).then(() =>
    execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }),
  );
}

type Workstream = { id: string; scope: string; paths: string[]; outOfScope: string[] };

function makeState(
  issue: number,
  baseSha: string,
  worktrees: Record<string, string>,
  workstreams: Record<string, Workstream>,
) {
  let s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: `feature/issue-${issue}`,
      baseSha,
      worktrees,
      workstreams,
    },
  };
}

/**
 * Verify command that counts exports in file-a.ts and file-b.ts separately
 * (handling missing files with `|| echo 0`), and:
 *   - exits 0 if count < 4 (per-worktree case: one file present, 2 exports)
 *   - if count >= 4 (consolidated: both files, 4 exports):
 *       - if STATEFUL and flag absent: touch flag, exit 1 (first run)
 *       - if STATEFUL and flag present: exit 0 (second run)
 *       - if STATELESS: exit 1 (both runs)
 */
function buildVerifyCmd(stateful: boolean): string {
  const countExpr =
    "ca=$(grep -c export file-a.ts 2>/dev/null || echo 0); cb=$(grep -c export file-b.ts 2>/dev/null || echo 0); c=$((ca+cb))";
  const statefulPart = stateful
    ? "if [ -f .flake-recovered ]; then exit 0; fi; touch .flake-recovered; exit 1"
    : "exit 1";
  return `sh -c '${countExpr}; if [ "$c" -lt 4 ]; then exit 0; fi; ${statefulPart}'`;
}

try {
  // --------------------------------------------------------------- case 1
  // fail-then-pass: per-worktree passes (count=2 < 4), consolidated fails
  // on first run (count=4, no flag), passes on second (flag exists).
  {
    const f = await fixture("flake-fail-then-pass", ["a", "b"], {
      "file-a.ts": "export const a = 1;\n",
      "file-b.ts": "export const b = 2;\n",
    });
    writeFileSync(
      path.join(f.worktrees.a, "file-a.ts"),
      "export const a = 1;\nexport function aFn() { return a; }\n",
    );
    await commitIn(f.worktrees.a, "task-a: add aFn");
    writeFileSync(
      path.join(f.worktrees.b, "file-b.ts"),
      "export const b = 2;\nexport function bFn() { return b; }\n",
    );
    await commitIn(f.worktrees.b, "task-b: add bFn");

    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${buildVerifyCmd(true)}\n`);

    const s = makeState(782, f.baseSha, f.worktrees, {
      a: { id: "a", scope: "add aFn", paths: [], outOfScope: [] },
      b: { id: "b", scope: "add bFn", paths: [], outOfScope: [] },
    });
    const events: WorkEvent[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 782,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop", events);

    assert(
      gate.ok,
      `#782 case 1 (fail-then-pass): gate OK (got failures: ${gate.failures.join("; ").slice(0, 200)})`,
    );
    assert(
      gate.flakeRetry !== undefined && gate.flakeRetry.recovered === true,
      `#782 case 1: flakeRetry.recovered === true (got: ${JSON.stringify(gate.flakeRetry)})`,
    );
    assert(
      gate.flakeRetry !== undefined && gate.flakeRetry.retries === 1,
      `#782 case 1: flakeRetry.retries === 1 (got: ${JSON.stringify(gate.flakeRetry)})`,
    );
    const flakeEvent = events.find((e) => e.kind === "verify-flake-recovered");
    assert(
      flakeEvent !== undefined,
      `#782 case 1: verify-flake-recovered event emitted (kinds: ${events.map((e) => e.kind).join(", ")})`,
    );
    if (flakeEvent && flakeEvent.kind === "verify-flake-recovered") {
      assert(
        flakeEvent.step === "develop",
        `#782 case 1: event step is develop (got: ${flakeEvent.step})`,
      );
    }
  }

  // --------------------------------------------------------------- case 2
  // fail-both: per-worktree passes (count=2 < 4), consolidated fails on
  // BOTH runs (count=4, stateless — no flag, no recovery).
  {
    const f = await fixture("flake-fail-both", ["a", "b"], {
      "file-a.ts": "export const a = 1;\n",
      "file-b.ts": "export const b = 2;\n",
    });
    writeFileSync(
      path.join(f.worktrees.a, "file-a.ts"),
      "export const a = 1;\nexport function aFn() { return a; }\n",
    );
    await commitIn(f.worktrees.a, "task-a: add aFn");
    writeFileSync(
      path.join(f.worktrees.b, "file-b.ts"),
      "export const b = 2;\nexport function bFn() { return b; }\n",
    );
    await commitIn(f.worktrees.b, "task-b: add bFn");

    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${buildVerifyCmd(false)}\n`);

    const s = makeState(782, f.baseSha, f.worktrees, {
      a: { id: "a", scope: "add aFn", paths: [], outOfScope: [] },
      b: { id: "b", scope: "add bFn", paths: [], outOfScope: [] },
    });
    const events: WorkEvent[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 782,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop", events);

    assert(
      !gate.ok,
      `#782 case 2 (fail-both): gate NOT ok (got ok: ${gate.ok}, failures: ${gate.failures.join("; ").slice(0, 200)})`,
    );
    assert(
      gate.flakeRetry !== undefined && gate.flakeRetry.recovered === false,
      `#782 case 2: flakeRetry.recovered === false (got: ${JSON.stringify(gate.flakeRetry)})`,
    );
    assert(
      gate.flakeRetry !== undefined && gate.flakeRetry.retries === 1,
      `#782 case 2: flakeRetry.retries === 1 (got: ${JSON.stringify(gate.flakeRetry)})`,
    );
    const flakeEvent = events.find((e) => e.kind === "verify-flake-recovered");
    assert(
      flakeEvent === undefined,
      `#782 case 2: NO verify-flake-recovered event (got: ${events.map((e) => e.kind).join(", ")})`,
    );
    const classified = gate.failures.some((fl) =>
      /\[(consolidation-created|per-workstream-defect|needs-human-decision)\]/.test(fl),
    );
    assert(
      classified,
      `#782 case 2: failure is classified (got: ${gate.failures.join("; ").slice(0, 240)})`,
    );
  }

  // --------------------------------------------------------------- case 3
  // N=1 invariant: the retry must NOT fire for N=1. Per-worktree verify
  // fails (count=2 > 1), so the precondition (per-worktree passes) is not
  // met, and the retry is skipped.
  {
    const f = await fixture("flake-n1-invariant", ["default"], {
      "single.ts": "export const x = 1;\n",
    });
    writeFileSync(
      path.join(f.worktrees.default, "single.ts"),
      "export const x = 1;\nexport const y = 2;\n",
    );
    await commitIn(f.worktrees.default, "task-default: add y");

    const verifyCmd = "sh -c 'test $(grep -c export single.ts 2>/dev/null) -le 1'";
    writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${verifyCmd}\n`);

    const s = makeState(782, f.baseSha, f.worktrees, {
      default: { id: "default", scope: "add y", paths: [], outOfScope: [] },
    });
    const events: WorkEvent[] = [];
    const ctx: DriverContext = {
      pi: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: f.repo,
      issue: 782,
      verifyExecFn: realExec,
    };
    const gate = await verifyStepOutcome(ctx, s, "develop", events);
    assert(!gate.ok, `#782 case 3 (N=1): gate NOT ok (got ok: ${gate.ok})`);
    assert(
      gate.flakeRetry === undefined,
      `#782 case 3: N=1 must NOT retry — got: ${JSON.stringify(gate.flakeRetry)}`,
    );
    const flakeEvent = events.find((e) => e.kind === "verify-flake-recovered");
    assert(
      flakeEvent === undefined,
      `#782 case 3: N=1 must NOT emit verify-flake-recovered (got: ${events.map((e) => e.kind).join(", ")})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
