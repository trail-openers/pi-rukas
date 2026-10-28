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
 *      it, a compiler that prints TS2322 passes it, and one that exits non-zero
 *      without the diagnostic is NOT judged (H1: only an exit-0 run is unsound);
 *      the per-identity cache expires on an age bound (H2);
 *   2. each guarded call site refuses a green from a stub compiler: the develop
 *      gate parks with `toolchain-unsound`, the ci tier fails, the cap
 *      checkpoint reports "could not run" — never a pass;
 *   3. the escape hatch skips the canary and the note says so.
 *
 * Nothing here writes into the repo's own `node_modules` or any linked tree:
 * every stub lives in a fixture under `os.tmpdir()`.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_TSC_CMD } from "../src/work-driver-cap-checkpoint-typecheck.ts";
import { runCiVerifyFull } from "../src/work-driver-ci-verify.ts";
import {
  CANARY_DIR_PREFIX,
  CANARY_NOT_JUDGED,
  CANARY_SKIPPED_NOTE,
  guardCompilerIntegrity,
  isToolchainUnsoundFailure,
  resetToolchainCanaryCache,
  toolchainCanary,
  toolchainCanaryEnabled,
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
  // M2 — the canary file is written in a PRIVATE per-process temp dir, not a
  // predictable name in the shared one (a predictable name is a symlink target
  // for another uid, and `writeFile` follows it). The dir is located from the
  // path the probe actually ran with, so the assertion names where the file
  // really was rather than where this process guesses `os.tmpdir()` points.
  resetToolchainCanaryCache();
  const root = fixtureRoot("private-dir");
  const pkg = packageWithCompiler(root, STUB);
  const { exec, ran } = recording();
  await toolchainCanary(pkg, exec);
  const probeArg = (ran[0] ?? "").split(" ").pop() ?? "";
  const dir = path.dirname(probeArg);
  const base = path.basename(dir);
  assert(
    probeArg !== "" &&
      base.startsWith(CANARY_DIR_PREFIX) &&
      new RegExp(`^${CANARY_DIR_PREFIX}[A-Za-z0-9_-]{6,}$`).test(base) &&
      path.dirname(dir) !== dir &&
      !path.basename(path.dirname(dir)).includes(String(process.pid)),
    `the canary file lives in one unguessable mkdtemp dir, not a per-pid name (got: ${dir || "no run"})`,
  );
  const mode = existsSync(dir) ? statSync(dir).mode & 0o777 : -1;
  assert(
    mode === 0o700 && readdirSync(dir).length === 0,
    `that dir is mode 0700 and emptied after the probe (mode ${mode.toString(8)})`,
  );
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
  // #1879 fix round (H1) — a non-zero run WITHOUT the diagnostic is NOT proof
  // of an unsound compiler: it is a crash or an environment fault, and a crash
  // says nothing about whether the compiler would refuse this assignment. Not
  // judged, so `guardCompilerIntegrity` records a note and lets the tier run —
  // never a park accusing a compiler it never got an answer from.
  const root = fixtureRoot("crash-no-diagnostic");
  const pkg = packageWithCompiler(
    root,
    "process.stderr.write('error TS1234: something else\\n');process.exit(2);\n",
  );
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(pkg, realExec);
  assert(
    outcome.ok === undefined,
    `a non-zero run without TS2322 is NOT judged, never reported unsound (got ${outcome.ok})`,
  );
  assert(
    outcome.ok === undefined && /without the expected TS2322/.test(outcome.why),
    `the note names the missing diagnostic as the reason (got: ${outcome.ok === undefined ? outcome.why : ""})`,
  );
  const guarded = await guardCompilerIntegrity({
    cmd: `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`,
    cwd: pkg,
    where: "a tier whose compiler crashed",
    run: realExec,
  });
  assert(
    guarded?.failure === undefined && guarded?.note !== undefined,
    `a crashed compiler never parks a tier, and the note says so (got ${JSON.stringify(guarded)})`,
  );
}
{
  // H1, third arm: a non-zero run that died with NO output at all is the same
  // answer — an environment fault, not a judgement.
  const root = fixtureRoot("crash-silent");
  const pkg = packageWithCompiler(root, "process.exit(1);\n");
  resetToolchainCanaryCache();
  const outcome = await toolchainCanary(pkg, realExec);
  assert(
    outcome.ok === undefined,
    `a non-zero run with no output at all is NOT judged (got ${outcome.ok})`,
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
  // Cache: one identity is asked once …
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
  // … and the cache EXPIRES. The identity key cannot catch every swap: the
  // pinned entry file is a launcher over lib/tsc.js, and the #1879 stub replaced
  // BOTH — a swap that leaves the entry file untouched changes no mtime and no
  // size, so an age bound is the only thing that re-asks.
  const root = fixtureRoot("cache-age");
  const pkg = packageWithCompiler(root, SOUND);
  resetToolchainCanaryCache();
  const { exec, ran } = recording();
  let clock = 1_000_000;
  const now = () => clock;
  await toolchainCanary(pkg, exec, now);
  const afterFirst = ran.length;
  await toolchainCanary(pkg, exec, now);
  assert(ran.length === afterFirst, "inside the age bound the verdict is still cached");
  clock += 10 * 60_000 + 1; // past CANARY_CACHE_MAX_AGE_MS
  await toolchainCanary(pkg, exec, now);
  assert(
    ran.length > afterFirst,
    `an identity whose verdict is older than the age bound is RE-PROBED (${afterFirst} → ${ran.length})`,
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
      verifyCapFor("develop", failures) === "toolchain-unsound",
      `the canary failure routes to its own cap, not verify-failed (got ${verifyCapFor("develop", failures)})`,
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

{
  // #1879 fix round (H3) — NO compiler under the cwd is not a finding about the
  // compiler. A fixture tree with no `node_modules` at all must not be reported
  // unsound: the tier runs, and its own command is what says the dependency
  // tree is missing.
  const root = fixtureRoot("absent");
  const pkg = path.join(root, "extension");
  mkdirSync(pkg, { recursive: true });
  try {
    resetToolchainCanaryCache();
    const { exec, ran } = recording();
    const outcome = await toolchainCanary(pkg, exec);
    assert(
      outcome.ok === undefined && outcome.why === CANARY_NOT_JUDGED,
      `no compiler is "${CANARY_NOT_JUDGED}", never a failure (got ${outcome.ok}: ${outcome.ok !== true ? outcome.why : ""})`,
    );
    assert(ran.length === 0, "and nothing was executed — there was no compiler to ask");
    const guarded = await guardCompilerIntegrity({
      cmd: `cd extension && ${LOCAL_TSC_CMD} --noEmit -p tsconfig.json`,
      cwd: pkg,
      where: "a tier whose dependencies were never installed",
      run: realExec,
    });
    assert(
      guarded?.failure === undefined,
      `an absent compiler never parks a tier (got failure: ${String(guarded?.failure)?.slice(0, 80)})`,
    );
    // The checkpoint keeps the opposite rule for the same answer: it records no
    // verdict rather than a pass, and it lets the command run so the real
    // reason ("could not run") is the one the operator reads.
    const { typecheckWorktree } = await import("../src/work-driver-cap-checkpoint-typecheck.ts");
    writeFileSync(path.join(pkg, "x.ts"), "export const a = 1;\n");
    writeFileSync(path.join(pkg, "tsconfig.json"), '{"compilerOptions":{}}\n');
    const { exec: cpExec, ran: cpRan } = recording();
    const outcome2 = await typecheckWorktree(root, cpExec);
    assert(
      cpRan.some((r) => r.includes("tsc --noEmit")),
      `the checkpoint still RUNS the typecheck when there is no compiler to canary (ran: ${cpRan.join(" | ") || "nothing"})`,
    );
    assert(
      outcome2.verdict !== true,
      `a missing compiler never reads as "typecheck passed" (got ${String(outcome2.verdict)})`,
    );
  } finally {
    rmTree(root);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("3. the escape hatch skips the canary and SAYS so");
{
  // The hatch accepts the repo's shared vocabulary — the same set
  // `consolidatedVerifySkipEnabled` and `gateReuseEnabled` accept — trimmed and
  // case-folded, and a malformed value keeps the check ON.
  const prev = process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY;
  const OFF = ["0", "false", "off", "no", "  OFF  ", "No", "FALSE"];
  const ON = ["1", "true", "yes", "", "banana"];
  try {
    for (const v of OFF) {
      process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = v;
      assert(
        toolchainCanaryEnabled() === false,
        `hatch value ${JSON.stringify(v)} turns the canary off`,
      );
    }
    for (const v of ON) {
      process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = v;
      assert(
        toolchainCanaryEnabled() === true,
        `hatch value ${JSON.stringify(v)} keeps the canary on (the safe side runs the check)`,
      );
    }
    delete process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY;
    assert(toolchainCanaryEnabled() === true, "unset keeps the canary on");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY;
    else process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY = prev;
  }
}
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
