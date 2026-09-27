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
 * The companion registers EXACTLY those three (in that order), NOT the #716
 * oo-rewrite guard that the shared block also carries for strict/headless
 * children: activating oo-rewrite inside trust-mode children would be a
 * behaviour change outside #926's scope.
 *
 * This test loads the companion's DEFAULT EXPORT into a fake pi (the
 * fakePi `on`-capture pattern from test-oo-rewrite-guard.ts) and asserts:
 *
 *   1. Loading with no PI_ENSEMBLE_SUBAGENT_MODE registers THREE tool_call
 *      hooks (destructive-git, issue-creation, merge — the three
 *      mode-independent guards, same order as the subagent path's shared
 *      block minus the deliberately-excluded oo-rewrite) and no
 *      tools/commands; driving
 *      them through a stubbed exec refuses `gh pr merge 5 --squash` (no
 *      ledger → refused) and `gh issue create -t x`, and ignores
 *      `gh pr view 5`.
 *   2. The destructive-git guard (the refused-example from its own test):
 *      `git reset --hard` is refused.
 *   3. PI_ENSEMBLE_SUBAGENT_MODE=1 → ZERO hooks registered (the full pi-rukas
 *      extension registers the guards there; a second set would double-run
 *      the merge guard's gh/git exec chain).
 *   4. Canary — the EXACT expected set {registerMergeGuard,
 *      registerIssueCreationGuard, registerDestructiveGitGuard} is the
 *      shared block's contents (subagent-guard-guards.ts), the companion
 *      calls that block, and the explicit exclusions {registerPmBashGuard,
 *      registerOoRewriteGuard} are NOT registered by the companion. Fails
 *      in both directions.
 *   5. The pre-spawn stat now lives in spawn.ts (spawnSpecialistInner, the
 *      #893 reporter-preflight pattern): the named error format and the
 *      use of the exported CHILD_GUARDS_PATH are canaried against its
 *      source, and the PI_ENSEMBLE_SUBAGENT_MODE assignment is pinned
 *      inside the subagentGuardEnabled branch (the companion's no-op
 *      depends on exactly that).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_GUARDS_PATH, childGuardsArgs, failClosedPi } from "../src/child-guards.ts";
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

/**
 * Given the index of an opener `{` in `src`, return the index just PAST its
 * matching `}` (brace counting; spawn.ts has no string literals containing
 * braces, so no string-awareness is needed).
 */
function braceMatchEnd(src: string, openerIdx: number): number {
  let depth = 0;
  for (let i = openerIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

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
// 1. Loading with no SUBAGENT_MODE: exactly THREE tool_call hooks (the
//    three mode-independent guards; oo-rewrite deliberately excluded), no
//    tools, no commands.
// ============================================================
{
  const fake = makeFakePi();
  childGuards(fake as unknown as ExtensionAPI);
  const n = fake.handlers["tool_call"]?.length ?? 0;
  assert(
    n === 3,
    `registers exactly 3 tool_call hooks (the three mode-independent guards, oo-rewrite excluded; got ${n})`,
  );
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
// 2a. Fail-closed wrapper (#926 fix round): a guard whose tool_call handler
//     THROWS must never let a command through — Pi's emitToolCall has no
//     per-handler try/catch, so the companion wraps the guard pi with
//     failClosedPi and a thrown handler becomes a { block: true, reason }
//     refusal, not an aborted turn. Here: a fake pi whose every handler
//     throws is loaded through the companion; every resulting hook must
//     refuse with the fail-closed reason naming the thrown error.
// ============================================================
{
  // Drive the wrapper directly: the wrapper wraps the handler itself, so the
  // captured handler (the wrapped one) must catch the throw and return a
  // fail-closed refusal. The "block" and "inert" cases verify that non-error
  // results pass through unchanged.
  // Drive the wrapper directly: pass a throwing/blocking/inert handler
  // through failClosedPi and verify the wrapped handler's behaviour.
  const makeWrapped = (behaviour: "throw" | "block" | "inert") => {
    const handlers: Handler[] = [];
    const spyPi: any = {
      on(event: string, fn: any) {
        if (event === "tool_call") handlers.push(fn);
      },
    };
    // The underlying handler that the wrapper will wrap.
    const underlying: Handler = () => {
      if (behaviour === "throw") throw new Error("boom-guard");
      if (behaviour === "block") return { block: true, reason: "the-guard-blocked" } as never;
      return undefined;
    };
    const wrappedPi = failClosedPi(spyPi as unknown as ExtensionAPI);
    // Register the underlying handler via the wrapped pi — the wrapper wraps
    // it and passes the wrapped version to spyPi.on (the spy).
    wrappedPi.on("tool_call", underlying);
    return handlers.map((wrapped) => async (cmd: string) =>
      wrapped({ toolName: "bash", input: { command: cmd } }, {}),
    );
  };

  // Throwing: the wrapped handler must catch the throw and return a
  // fail-closed refusal naming the error — never rethrow.
  const throwing = makeWrapped("throw");
  assert(throwing.length === 1, "fail-closed: one wrapped handler registered");
  const rThrow = await throwing[0]("true");
  const oThrow = rThrow as { block?: boolean; reason?: string } | undefined;
  assert(
    oThrow?.block === true && /fail-closed/.test(oThrow?.reason ?? "") && /boom-guard/.test(oThrow?.reason ?? ""),
    "fail-closed: a throwing guard → block with the reason naming the error, never a rethrow",
  );

  // Blocking: a well-behaved guard's refusal passes through unchanged.
  const blocking = makeWrapped("block");
  const rBlock = await Promise.all(blocking.map((h) => h("x")));
  assert(
    rBlock.every((res) => {
      const o = res as { block?: boolean; reason?: string } | undefined;
      return o?.block === true && o.reason === "the-guard-blocked";
    }),
    "fail-closed: a well-behaved guard's refusal passes through unchanged",
  );

  // Inert: a no-op handler still returns undefined.
  const inert = makeWrapped("inert");
  const rInert = await Promise.all(inert.map((h) => h("x")));
  assert(
    rInert.every((res) => res === undefined),
    "fail-closed: a no-op handler still returns undefined (the wrapper only converts thrown errors)",
  );
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
//    registerIssueCreationGuard, registerDestructiveGitGuard} is the shared
//    block's contents (subagent-guard-guards.ts); the companion calls that
//    block (no direct guard calls, no duplicates), and the explicit
//    exclusions {registerPmBashGuard, registerOoRewriteGuard} are NOT
//    registered by the companion — the strict/headless path registers
//    oo-rewrite in permission-subagent-guard.ts, right after its own shared
//    block call (pinned in test-oo-rewrite-guard.ts). Fails in both
//    directions.
// ============================================================
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const src = readFileSync(path.join(SRC, "child-guards.ts"), "utf8");
  const shared = readFileSync(path.join(SRC, "subagent-guard-guards.ts"), "utf8");
  const expected = [
    "registerMergeGuard",
    "registerIssueCreationGuard",
    "registerDestructiveGitGuard",
  ];
  // The companion delegates to the shared block — the single list.
  assert(
    /registerModeIndependentGuards\s*\(failClosedPi\s*\(pi\s*\)\s*\)/.test(src),
    "canary: the companion calls the shared block registerModeIndependentGuards(failClosedPi(pi))",
  );
  assert(
    /function failClosedPi/.test(src),
    "canary: the fail-closed wrapper exists in the companion (#926 fix round)",
  );
  for (const name of expected) {
    assert(
      !new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(src),
      `canary: the companion does NOT register ${name} directly (no duplicate of the shared block)`,
    );
  }
  // The shared block contains EXACTLY the three guards.
  for (const name of expected) {
    assert(
      new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(shared),
      `canary: the shared block registers ${name}(pi)`,
    );
  }
  const notInShared = ["registerPmBashGuard", "registerOoRewriteGuard"];
  for (const name of notInShared) {
    assert(
      !new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(shared),
      `canary: the shared block does NOT register ${name} (oo-rewrite: strict path only; pm-bash: parent-only)`,
    );
  }
  // The companion never registers the exclusions either.
  for (const name of notInShared) {
    assert(
      !new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(src),
      `canary: the companion does NOT register ${name}`,
    );
  }
  const notEntrypoints = ["registerSubagentGuard", "registerPermissionGuard"];
  for (const name of notEntrypoints) {
    assert(
      !new RegExp(`(^|[^\\w])${name}\\s*\\(`).test(src),
      `canary: the companion does NOT call ${name} (it registers the guard block, not the entry points)`,
    );
  }
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
  // #926 fix round — the path is DERIVED via
  // path.dirname(fileURLToPath(import.meta.url)) (the lens-review.ts seam):
  // assert it names an existing file ending in child-guards.ts, and canary
  // that the bare-__dirname literal form is gone (bare __dirname does not
  // exist in ESM — it only resolved under the jiti CJS shim).
  assert(/child-guards\.ts$/.test(CHILD_GUARDS_PATH), "CHILD_GUARDS_PATH ends with child-guards.ts");
  assert(existsSync(CHILD_GUARDS_PATH), "CHILD_GUARDS_PATH exists on disk");
  const src6 = readFileSync(path.resolve(import.meta.dirname, "..", "src", "child-guards.ts"), "utf8");
  assert(
    src6.includes("path.dirname(fileURLToPath(import.meta.url))"),
    "canary: CHILD_GUARDS_PATH is derived via path.dirname(fileURLToPath(import.meta.url))",
  );
  assert(
    /const __dirname = path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(src6),
    "canary: the module-scope __dirname IS the ESM derivation (no bare-literal form)",
  );
}

// ============================================================
// 7. Preflight (the #893 reporter-preflight pattern): the argv names
//    CHILD_GUARDS_PATH, so a missing companion must be a named error before
//    spawn — never a silently unguarded child. The check lives in
//    preflightChildGuards() (child-guards.ts), called from spawn.ts before
//    the child starts; the named-error format, the ANY-failure throw, and
//    the call site are canaried against the sources. The
//    PI_ENSEMBLE_SUBAGENT_MODE assignment is pinned inside the
//    subagentGuardEnabled branch — the companion's no-op depends on exactly
//    that.
// ============================================================
{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const guardsSrc = readFileSync(path.join(SRC, "child-guards.ts"), "utf8");
  const spawnSrc = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  assert(
    guardsSrc.includes("export function preflightChildGuards(): void"),
    "canary: child-guards.ts exports preflightChildGuards() (the pre-spawn check)",
  );
  assert(
    guardsSrc.includes("statSync(CHILD_GUARDS_PATH)"),
    "canary: the preflight stat is a plain statSync of the exported CHILD_GUARDS_PATH (no `?? \"\"` fallback)",
  );
  assert(
    guardsSrc.includes("child-guards extension unavailable at ${CHILD_GUARDS_PATH}"),
    "canary: the named error format is `child-guards extension unavailable at <path>: <reason>`",
  );
  assert(
    guardsSrc.includes("run ./install.sh"),
    "canary: the named error carries the remedy (run ./install.sh)",
  );
  // ANY stat failure throws: no filtering by error code (ENOENT, EACCES, …).
  const helper = guardsSrc.slice(guardsSrc.indexOf("export function preflightChildGuards"));
  assert(
    !/err\.code/.test(helper),
    "canary: the preflight does not filter by error code (ANY stat failure throws)",
  );
  assert(
    spawnSrc.includes("preflightChildGuards()"),
    "canary: spawn.ts calls preflightChildGuards() before building the child",
  );
  // PI_ENSEMBLE_SUBAGENT_MODE=1 is assigned inside the subagentGuardEnabled
  // branch only — a trust-mode child (the `} else if (parentTrustMode)`
  // branch) must not carry it. Locate the enclosing `if (subagentGuardEnabled) {
  // block by BRACE MATCHING from its opener (lastIndexOf comparisons misplace
  // the boundary once the branch body contains nested braces) and assert the
  // assignment lies within that block's span.
  const assignIdx = spawnSrc.indexOf('childEnv.PI_ENSEMBLE_SUBAGENT_MODE = "1"');
  assert(assignIdx > 0, "canary: spawn.ts assigns PI_ENSEMBLE_SUBAGENT_MODE = \"1\" in the childEnv");
  const openerIdx = spawnSrc.lastIndexOf("if (subagentGuardEnabled) {");
  assert(openerIdx > 0, "canary: spawn.ts contains the `if (subagentGuardEnabled) {` branch opener");
  const blockEnd = braceMatchEnd(spawnSrc, openerIdx + "if (subagentGuardEnabled) {".length - 1);
  assert(blockEnd > assignIdx, "canary: a brace-matched span exists for the subagentGuardEnabled branch");
  assert(
    openerIdx < assignIdx && assignIdx < blockEnd,
    "canary: the PI_ENSEMBLE_SUBAGENT_MODE = \"1\" assignment lies within the subagentGuardEnabled block's span (the trust-mode branch must not set it)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
