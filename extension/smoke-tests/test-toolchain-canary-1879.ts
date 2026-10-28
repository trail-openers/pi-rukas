#!/usr/bin/env bun
/**
 * #1879 — the compiler-integrity canary, PART 1 of 2: the canary and the
 * guarded call sites.
 *
 * The incident: a read-only reviewer child overwrote the shared
 * `extension/node_modules/typescript/bin/tsc` with a `sleep 9.5; exit 0` stub,
 * and for eleven minutes every local typecheck exited 0 on any tree. A check
 * that cannot fail cannot pass, so before any tier is trusted as GREEN the
 * driver asks the pinned compiler to reject a file with one known type error.
 *
 * Groups (the other three are in `test-toolchain-canary-1879-cap.ts`; the pair
 * is split along the AGENTS.md §12 file-size cap — run BOTH):
 *
 *   1. the canary itself — a STUB compiler (fixture tree under os.tmpdir) fails
 *      it, and this repo's REAL compiler passes it;
 *   2. each guarded call site refuses a green from a stub compiler: the develop
 *      gate parks with `toolchain-unsound`, the ci tier fails, the cap
 *      checkpoint reports "could not run" — never a pass;
 *   3. the escape hatch skips the canary and the note says so.
 *
 * Nothing here writes into the repo's own `node_modules` or any linked tree:
 * every stub lives in a fixture under `os.tmpdir()`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { runCiVerifyFull } from "../src/work-driver-ci-verify.ts";
import {
  CANARY_SKIPPED_NOTE,
  guardCompilerIntegrity,
  isToolchainUnsoundFailure,
  resetToolchainCanaryCache,
  toolchainCanary,
  usesPinnedCompiler,
} from "../src/work-driver-toolchain-canary.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { runVerifyCommandGate } from "../src/work-driver-verify-verify-cmd.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { assert } from "./lib/toolchain-canary-assert.ts";
import {
  REPO,
  SOUND,
  STUB,
  cleanupOnExit,
  ctxFor,
  fixtureRoot,
  packageWithCompiler,
  pexec,
  realExec,
  recording,
  rmTree,
} from "./lib/toolchain-canary-support.ts";

cleanupOnExit();

// ─────────────────────────────────────────────────────────────────────────────
console.log("1. the canary separates a stub compiler from one that judges");
{
  // A stub: exit 0, no output — the exact shape of the incident.
  const root = fixtureRoot("stub");
  const pkg = packageWithCompiler(root, STUB);
  resetToolchainCanaryCache();
  const { exec, ran } = recording();
  const outcome = await toolchainCanary(pkg, exec);
  assert(outcome.ok === false, `a stub that exits 0 FAILS the canary (got ${outcome.ok})`);
  assert(
    outcome.ok === false && /exited 0/.test(outcome.why),
    `the reason says the compiler exited 0 (got: ${outcome.ok === false ? outcome.why : ""})`,
  );
  assert(
    ran.length > 0 && ran[0]?.includes(`${LOCAL_TSC_CMD.split(" ").pop()}`) === true,
    `the canary ran the pinned compiler from the cwd (got: ${ran[0]})`,
  );
  // The canary file never lands inside the tree it is checking.
  const stray = await pexec("find", [root, "-name", "*canary*.ts"]).catch(() => null);
  assert(stray === null || stray.stdout.trim() === "", "no canary file left under the repo");
}
{
  // A compiler that rejects with the right diagnostic: pass.
  const root = fixtureRoot("sound");
  const pkg = packageWithCompiler(root, SOUND);
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(pkg, realExec);
  assert(
    outcome.ok === true,
    `a compiler that prints TS2322 and exits 2 PASSES (got ${outcome.ok})`,
  );
}
{
  // Non-zero but the WRONG diagnostic is not a pass: the compiler must refuse
  // THIS error, not merely be unhappy.
  const root = fixtureRoot("wrong-diagnostic");
  const pkg = packageWithCompiler(
    root,
    "process.stderr.write('error TS1234: something else\\n');process.exit(2);\n",
  );
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(pkg, realExec);
  assert(
    outcome.ok === false,
    `a non-zero run without TS2322 does not pass the canary (got ${outcome.ok})`,
  );
}
{
  // This repo's own compiler — read-only use of the real node_modules.
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(path.join(REPO, "extension"), realExec);
  assert(
    outcome.ok === true,
    `this repo's real compiler passes the canary (got ${outcome.ok}: ${outcome.ok !== true ? outcome.why : ""})`,
  );
}
{
  // Cache: one identity is asked once.
  const root = fixtureRoot("cache");
  const pkg = packageWithCompiler(root, SOUND);
  resetToolchainCanaryCache();
  const { exec, ran } = recording();
  await toolchainCanary(pkg, exec);
  const after = ran.length;
  await toolchainCanary(pkg, exec);
  assert(
    ran.length === after,
    `the second call is served from the cache (${after} → ${ran.length})`,
  );
}
{
  // Only commands with the pinned spelling are canaried.
  assert(
    usesPinnedCompiler(`cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`),
    "the pinned spelling is recognised",
  );
  assert(!usesPinnedCompiler("bun run test"), "a command without it is not canaried");
  const root = fixtureRoot("not-pinned");
  const pkg = packageWithCompiler(root, STUB);
  resetToolchainCanaryCache();
  const guarded = await guardCompilerIntegrity({
    cmd: "bun run typecheck",
    cwd: pkg,
    where: "a tier that does not use the pinned compiler",
    run: realExec,
  });
  assert(guarded === undefined, "a command without the pinned spelling is not guarded at all");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("2. each guarded call site refuses a green from a stub compiler");

/**
 * A fixture whose verify command IS the pinned compiler, with `node_modules`
 * provisioned from the main checkout into the worktree the way
 * worktree-provision.ts does it — so the stub is reached through the same link
 * shape the incident used.
 */
async function gateFixture(body: string): Promise<{
  root: string;
  wt: string;
  cmd: string;
}> {
  const root = fixtureRoot("gate");
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
  // The compiler is installed after the commit: gitignored, like a real install.
  packageWithCompiler(root, body);
  const wt = path.join(root, ".worktrees", "issue-1879-default");
  await git("worktree", "add", "-q", "--detach", wt, "HEAD");
  await pexec("ln", [
    "-s",
    path.join(root, "extension", "node_modules"),
    path.join(wt, "extension", "node_modules"),
  ]);
  // The gate runs its command with cwd = the WORKTREE, so that is what the
  // fixture hands back as the tier's root.
  return { root: wt, wt, cmd: `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json` };
}

{
  // The develop gate: the canary parks with its own cap, never verify-failed.
  const { root, wt, cmd } = await gateFixture(STUB);
  try {
    resetToolchainCanaryCache();
    const failures: string[] = [];
    const notes: string[] = [];
    const state = {
      eventLog: [],
      pipelineState: { worktrees: { default: wt } },
    } as unknown as WorkState;
    const ran: string[] = [];
    await runVerifyCommandGate({
      execFn: async (c, o) => {
        const line = o?.argv ? [c, ...o.argv].join(" ") : c;
        if (!line.startsWith("git ")) ran.push(line);
        return realExec(c, o);
      },
      cmd,
      ctx: ctxFor(root),
      state,
      worktrees: { default: wt },
      baseSha: undefined,
      changedWorktrees: [wt],
      workstreamBaseShas: undefined,
      failures,
      notes,
    });
    assert(
      failures.length === 1 && isToolchainUnsoundFailure(failures[0] ?? ""),
      `the develop gate fails on the canary alone, not on the code (failures: ${failures.length}: ${String(failures[0])?.slice(0, 90)})`,
    );
    assert(
      ran.every((r) => !r.includes("tsc --noEmit")),
      `the project's verify command was never run — an unsound compiler is decided first (ran: ${ran.join(" | ")})`,
    );
    assert(
      verifyCapFor("develop", failures) === "verify-failed:develop",
      "a canary failure is a plain failure string; the CAP is the router's decision, made once at the park site",
    );
  } finally {
    rmTree(root);
  }
}
{
  // The ci tier: an unsound compiler fails the run; it never reports success.
  const root = fixtureRoot("ci");
  const pkg = packageWithCompiler(root, STUB);
  const primary = root; // the worktree: runCiVerifyFull runs in `<worktree>/extension`
  try {
    resetToolchainCanaryCache();
    const state = { eventLog: [], pipelineState: {} } as unknown as WorkState;
    const run = await runCiVerifyFull(
      ctxFor(root),
      state,
      primary,
      `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json && bun run test`,
      60_000,
      realExec,
    );
    assert(run.outcome === "failure", `the ci tier fails on a stub compiler (got ${run.outcome})`);
    assert(
      isToolchainUnsoundFailure(run.output),
      "the ci tier's evidence names the canary as the reason",
    );
    assert(run.anchorOffset === 0, "the marker leads the output so the evidence cut keeps it");
  } finally {
    rmTree(root);
  }
}
{
  // The cap checkpoint: "could not run", never "typecheck passed".
  const { typecheckWorktree } = await import("../src/work-driver-cap-checkpoint-typecheck.ts");
  const root = fixtureRoot("checkpoint");
  const pkg = packageWithCompiler(root, STUB);
  try {
    resetToolchainCanaryCache();
    const outcome = await typecheckWorktree(root, realExec);
    assert(
      outcome.verdict === undefined,
      `an unsound compiler gives the checkpoint NO verdict, not a pass (got verdict ${String(outcome.verdict)})`,
    );
    assert(
      outcome.verdict === undefined && /not sound/.test(outcome.why),
      `the reason says the compiler is not sound (got: ${outcome.verdict === undefined ? outcome.why : ""})`,
    );
  } finally {
    rmTree(root);
  }
}
{
  // The same checkpoint with a sound compiler still reports a real verdict —
  // the guard does not simply refuse everything.
  const { typecheckWorktree } = await import("../src/work-driver-cap-checkpoint-typecheck.ts");
  const root = fixtureRoot("checkpoint-sound");
  const pkg = packageWithCompiler(root, SOUND);
  try {
    resetToolchainCanaryCache();
    const outcome = await typecheckWorktree(root, realExec);
    assert(
      outcome.verdict === false,
      `a sound compiler still reaches a verdict on the tree (got ${String(outcome.verdict)})`,
    );
  } finally {
    rmTree(root);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("3. the escape hatch skips the canary and SAYS so");
{
  const root = fixtureRoot("hatch");
  const pkg = packageWithCompiler(root, STUB);
  const prev = process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY;
  process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = "0";
  try {
    resetToolchainCanaryCache();
    const guarded = await guardCompilerIntegrity({
      cmd: `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`,
      cwd: pkg,
      where: "the develop verify gate",
      run: realExec,
    });
    assert(
      guarded?.failure === undefined && guarded?.note === CANARY_SKIPPED_NOTE,
      `with the hatch at 0 nothing is asked and the note says "${CANARY_SKIPPED_NOTE}" (got ${JSON.stringify(guarded)})`,
    );
    assert(
      CANARY_SKIPPED_NOTE === "compiler integrity not checked",
      "the note is the exact documented wording",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = "";
    else process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = prev;
    rmTree(root);
  }
}
