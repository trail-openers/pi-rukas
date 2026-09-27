#!/usr/bin/env bun
/**
 * #926 — the child-guards companion extension: the file that carries the
 * mode-independent tool_call guards into spawned subagents in EVERY mode.
 *
 * The bug: the three mode-independent guards (registerMergeGuard #912,
 * registerIssueCreationGuard #598, registerDestructiveGitGuard) were
 * registered only inside the full pi-rukas extension, which spawn.ts
 * forwarded to children only in strict/headless mode. A trust-mode child got
 * none of them — live-proven by an ops child's `gh pr merge 999999 --squash`
 * reaching gh.
 *
 * This test loads the companion's DEFAULT EXPORT into a fake pi (the
 * fakePi `on`-capture pattern from test-oo-rewrite-guard.ts) and asserts:
 *
 *   1. Loading with no PI_ENSEMBLE_SUBAGENT_MODE registers FOUR tool_call
 *      hooks (the mode-independent guards, identical to the subagent path's
 *      registerModeIndependentGuards block) and no tools/commands; driving
 *      them through a stubbed exec refuses `gh pr merge 5 --squash` (no
 *      ledger → refused) and `gh issue create -t x`, and ignores
 *      `gh pr view 5`.
 *   2. The destructive-git guard (the refused-example from its own test):
 *      `git reset --hard` is refused.
 *   3. PI_ENSEMBLE_SUBAGENT_MODE=1 → ZERO hooks registered (the full pi-rukas
 *      extension registers the guards there; a second set would double-run
 *      the merge guard's gh/git exec chain).
 *   4. Canary — the EXACT expected set {registerMergeGuard,
 *      registerIssueCreationGuard, registerDestructiveGitGuard} is
 *      registered by the companion's call graph, and the explicit exclusion
 *      registerPmBashGuard is NOT. Fails in both directions.
 *   5. The pre-spawn stat: a missing companion is a named error (the #893
 *      reporter-preflight pattern), never a silently unguarded child.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GUARDS_PATH, childGuardsArgs, statChildGuardsPath } from "../src/child-guards.ts";
import childGuards from "../src/child-guards.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";

// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the merge refusal runs offline, without a real remote.
process.env.PI_ENSEMBLE_FORGE = "github";
delete process.env.PI_ENSEMBLE_SUBAGENT_MODE;
delete process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
delete process.env.PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE;
delete process.env.PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface FakePi {
  on: (name: string, fn: Handler) => void;
  registeredTools: string[];
  registeredCommands: string[];
}

function makeFakePi(): FakePi & { handlers: Record<string, Handler[]> } {
  const handlers: Record<string, Handler[]> = {};
  const fake: FakePi & { handlers: Record<string, Handler[]> } = {
    handlers,
    on(name, fn) {
      (handlers[name] ??= []).push(fn);
    },
    registeredTools: [],
    registeredCommands: [],
  };
  (
    fake as unknown as Record<string, unknown> as { registerTool: (t: { name: string }) => void }
  ).registerTool = (t) => fake.registeredTools.push(t.name);
  (
    fake as unknown as Record<string, unknown> as { registerCommand: (c: { name: string }) => void }
  ).registerCommand = (c) => fake.registeredCommands.push(c.name);
  return fake;
}

async function dispatch(
  fake: { handlers: Record<string, Handler[]> },
  toolName: string,
  command: string,
): Promise<unknown> {
  const event = { toolName, input: { command } };
  const results = await Promise.all((fake.handlers["tool_call"] ?? []).map((h) => h(event, {})));
  // A refusal is the FIRST { block: true } — the hook that answers first
  // wins, mirroring how Pi applies tool_call hooks.
  for (const r of results) {
    const o = r as { block?: boolean; reason?: string } | undefined;
    if (o && typeof o === "object" && o.block === true) return o;
  }
  return undefined;
}

/** Stub exec: gh pr view 5 fails (no PR / no ledger → the guard refuses),
 * everything else succeeds with empty output. */
const stubExec = async (cmd: string): Promise<{ stdout: string }> => {
  if (cmd.includes("gh pr view")) throw new Error("gh: no pull requests found (stub: no ledger)");
  return { stdout: "" };
};

// ============================================================
// 1. Loading with no SUBAGENT_MODE: exactly four tool_call hooks (the
//    mode-independent guard set), no tools, no commands.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers["tool_call"]?.length ?? 0;
  assert(n === 4, `registers exactly 4 tool_call hooks (the mode-independent guard set; got ${n})`);
  assert(fake.registeredTools.length === 0, "registers no tools (hook-only companion)");
  assert(fake.registeredCommands.length === 0, "registers no commands");
}

// ============================================================
// 2. The loaded hooks refuse the merge (no ledger, real exec → gh fails
//    offline → fail-closed refusal) and the issue creation; they ignore the
//    PR read.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);

  const merge = await dispatch(fake, "bash", "gh pr merge 5 --squash");
  const m = merge as { block?: boolean; reason?: string } | undefined;
  assert(
    m?.block === true,
    "loaded hooks refuse `gh pr merge 5 --squash` (no ledger → refused, real exec fails closed)",
  );
  assert(
    m && m.reason !== undefined && m.reason.length > 0,
    "the merge refusal carries a reason (fail-closed message)",
  );

  const issue = await dispatch(fake, "bash", "gh issue create -t x");
  const i = issue as { block?: boolean } | undefined;
  assert(i?.block === true, "loaded hooks refuse `gh issue create -t x`");

  const view = await dispatch(fake, "bash", "gh pr view 5");
  assert(view === undefined, "loaded hooks ignore `gh pr view 5` (a read stays open)");
}

// ============================================================
// 2b. The merge refusal through the GUARD'S OWN EXEC SEAM (stubbed): no
//     ledger → gh pr view fails → refused. This is the same hook body the
//     companion registers, driven offline exactly as test-merge-guard.ts
//     drives it.
// ============================================================
{
  const fake = makeFakePi();
  registerMergeGuard(fake as unknown as ExtensionAPI, { execFn: stubExec as never });
  const merge = await dispatch(fake, "bash", "gh pr merge 5 --squash");
  const m = merge as { block?: boolean; reason?: string } | undefined;
  assert(
    m?.block === true,
    "merge guard (stubbed exec, no ledger) refuses `gh pr merge 5 --squash`",
  );
  assert(
    m !== undefined &&
      m.reason !== undefined &&
      /refus|override|could not|failed/.test(m.reason ?? ""),
    "the stubbed-exec refusal is fail-closed with a named reason",
  );
}

// ============================================================
// 3. Destructive git: the refused-example from the destructive guard's own
//    test (test-subagent-git-guard.ts) is refused by the loaded set.
// ============================================================
{
  const fake = makeFakePi();
  const { registerDestructiveGitGuard } = await import("../src/permission-subagent-guard.ts");
  registerDestructiveGitGuard(fake as unknown as ExtensionAPI);
  const r = await dispatch(fake, "bash", "git reset --hard");
  const o = r as { block?: boolean } | undefined;
  assert(o?.block === true, "loaded hooks refuse `git reset --hard` (destructive git)");
  const ok = await dispatch(fake, "bash", "git status --porcelain");
  assert(ok === undefined, "loaded hooks allow `git status --porcelain` (a read stays open)");
}

// ============================================================
// 4. NO-OP: PI_ENSEMBLE_SUBAGENT_MODE=1 → zero hooks registered (the full
//    pi-rukas extension registers the guards there).
// ============================================================
{
  process.env.PI_ENSEMBLE_SUBAGENT_MODE = "1";
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers["tool_call"]?.length ?? 0;
  assert(n === 0, `no-op under PI_ENSEMBLE_SUBAGENT_MODE=1: zero hooks registered (got ${n})`);
  assert(
    fake.registeredTools.length === 0 && fake.registeredCommands.length === 0,
    "no-op registers nothing else",
  );
  delete process.env.PI_ENSEMBLE_SUBAGENT_MODE;
}

// ============================================================
// 5. Canary — the EXACT expected set {registerMergeGuard,
//    registerIssueCreationGuard, registerDestructiveGitGuard} is registered
//    by the companion's call graph (directly or via the shared
//    registerModeIndependentGuards block), and the explicit exclusion
//    registerPmBashGuard is NOT. Fails in both directions.
// ============================================================
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const src = readFileSync(path.join(SRC, "child-guards.ts"), "utf8");
  const shared = readFileSync(path.join(SRC, "subagent-guard-guards.ts"), "utf8");
  const usesSharedBlock = /registerModeIndependentGuards\s*\(/.test(src);
  const registered = (name: string) =>
    usesSharedBlock
      ? new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(shared)
      : new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(src);
  const expected = [
    "registerMergeGuard",
    "registerIssueCreationGuard",
    "registerDestructiveGitGuard",
  ];
  for (const name of expected) {
    assert(
      registered(name),
      `canary: the companion registers ${name}(pi) (directly or via the shared block)`,
    );
  }
  const excluded = ["registerPmBashGuard", "registerSubagentGuard", "registerPermissionGuard"];
  for (const name of excluded) {
    const inShared = new RegExp(`(^|[^\\w])${name}\\s*\\(`).test(shared);
    assert(
      !registered(name) && !inShared,
      `canary: the companion does NOT register ${name} (parent/subagent-path only)`,
    );
  }
  // The shared block itself must carry the three mode-independent guards.
  for (const name of expected) {
    assert(
      new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(shared),
      `canary: the shared block registers ${name}(pi)`,
    );
  }
  assert(
    !/registerPmBashGuard\s*\(/.test(shared),
    "canary: the shared block does NOT register registerPmBashGuard (parent-only)",
  );
}

// ============================================================
// 6. argv shape: childGuardsArgs() is `--extension <this file>` and the
//    companion's own path constant points at this source file.
// ============================================================
{
  const args = childGuardsArgs();
  assert(args.length === 2, "childGuardsArgs() is exactly [--extension, <path>]");
  assert(args[0] === "--extension", "childGuardsArgs() flag is --extension");
  assert(args[1] === CHILD_GUARDS_PATH, "childGuardsArgs() path equals CHILD_GUARDS_PATH");
  const st = statChildGuardsPath;
  assert(typeof st === "function", "statChildGuardsPath is exported (the pre-spawn check)");
}

// ============================================================
// 7. Preflight: a missing companion is a named error (the #893 pattern),
//    never a silently unguarded child. Injectable check — no filesystem.
// ============================================================
{
  const rejectStat = async () => {
    throw new Error("ENOENT (stub)");
  };
  try {
    await statChildGuardsPath("/nonexistent/child-guards.ts", rejectStat);
    assert(false, "preflight: a missing companion must throw the named error");
  } catch (err) {
    const msg = (err as Error).message;
    assert(
      msg.includes("child-guards extension missing:") && msg.includes("run ./install.sh"),
      `preflight: named error names the file and the remedy (got: ${msg})`,
    );
  }
  const okStat = async () => "ok";
  await statChildGuardsPath(CHILD_GUARDS_PATH, okStat);
  assert(true, "preflight: an existing companion passes the check");
  // And the REAL path exists (no inject): the shipped companion is there.
  try {
    await statChildGuardsPath(CHILD_GUARDS_PATH);
    assert(true, "preflight: the shipped companion file exists on disk");
  } catch (err) {
    assert(false, `preflight: the shipped companion file is missing (${(err as Error).message})`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
