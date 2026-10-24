#!/usr/bin/env bun
/**
 * #926 — the child-guards companion extension: the file that carries the
 * mode-independent tool_call guards into spawned subagents in EVERY mode.
 *
 * The bug: the three mode-independent guards were registered only inside the
 * full pi-rukas extension, which spawn.ts forwarded to children only in
 * strict/headless mode. A trust-mode child got none of them.
 *
 * The companion registers EXACTLY those three (in that order), NOT the #716
 * oo-rewrite guard that the shared block also carries for strict/headless
 * children: activating oo-rewrite inside trust-mode children would be a
 * behaviour change outside #926's scope.
 *
 * Loads the companion's DEFAULT EXPORT into a fake pi and asserts:
 *
 *   1. Loading with no PI_ENSEMBLE_SUBAGENT_MODE registers THREE tool_call
 *      hooks (destructive-git, issue-creation, merge — the mode-independent
 *      guards, same order as the subagent path's shared block minus the
 *      deliberately-excluded oo-rewrite) and no tools/commands; driving them
 *      through a stubbed exec refuses `gh pr merge 5 --squash` (no ledger →
 *      refused) and `gh issue create -t x`, and ignores `gh pr view 5`.
 *   2. The destructive-git guard (the refused-example from its own test):
 *      `git reset --hard` is refused.
 *   3. PI_ENSEMBLE_SUBAGENT_MODE=1 → ZERO hooks registered (the full pi-rukas
 *      extension registers the guards there; a second set would double-run the
 *      merge guard's gh/git exec chain).
 *   4. Canary — the EXACT expected set {registerMergeGuard,
 *      registerIssueCreationGuard, registerDestructiveGitGuard} is the
 *      shared block's contents (subagent-guard-guards.ts), the companion
 *      calls that block, and the explicit exclusions {registerPmBashGuard,
 *      registerOoRewriteGuard} are NOT registered by the companion. Fails
 *      in both directions.
 *   5. The pre-spawn stat now lives in spawn.ts (spawnSpecialistInner, the
 *      #893 reporter-preflight pattern): the named error format and the
 *      exported CHILD_GUARDS_PATH are canaried against its source, and
 *      PI_ENSEMBLE_SUBAGENT_MODE is pinned inside the subagentGuardEnabled
 *      branch (the companion's no-op depends on exactly that).
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
 * From the index of an opener `{` in `src`, the index just PAST its matching
 * `}` (spawn.ts has no string literals containing braces, so no
 * string-awareness is needed).
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
    // #1113 — the one ROLE-scoped member: it refuses `git push` for
    // PI_ENSEMBLE_ROLE=developer only. It belongs in the shared block for the
    // same reason the other three do — trust and sandbox children get nothing
    // but this block — and its role clause keeps every other role inert.
    "registerDeveloperPushGuard",
    // #1666 — the destructive vipune write refusal, which trust children never got from agents.json.
    "registerMemoryWriteGuard",
    // #1788 — the public repository hygiene guard. Same placement reasoning as
    // the merge guard: the repository is public and the modes this must fire in
    // are the defaults, so a trust or sandbox child that got only this block
    // would otherwise publish private text unguarded.
    "registerPublicHygieneGuard",
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
  // The options alternative admits the hygiene guard's executor argument, and
  // the assert below refuses a registration that drops it (#1788 round 2 — with
  // no options the push scan ran no git at all).
  for (const name of expected) {
    assert(
      new RegExp(`(^|[^\\w])${name}\\s*\\(pi(,\\s*HYGIENE_OPTS)?\\)`).test(shared),
      `canary: the shared block registers ${name}(pi)`,
    );
  }
  assert(
    /registerPublicHygieneGuard\(pi,\s*HYGIENE_OPTS\)/.test(shared) &&
      /const HYGIENE_OPTS = \{ execFn: execp \}/.test(shared),
    "canary: the shared block registers the hygiene guard WITH the production executor",
  );
  // Fails in the other direction too: a guard added to the block without
  // joining `expected` is invisible to this test's refuse-table, which is how
  // a guard ships wired but untested.
  const registered = [...shared.matchAll(/(?:^|[^\w])(register\w+Guard)\s*\(pi\)/g)].map(
    (m) => m[1] as string,
  );
  // review-accept is registered from inside issue-creation, not the block.
  const strays = registered.filter((name) => !expected.includes(name as never));
  assert(
    strays.length === 0,
    `canary: the shared block registers nothing outside the expected set (unexpected: ${strays.join(", ") || "none"})`,
  );
  const notInShared = ["registerPmBashGuard", "registerOoRewriteGuard"];
  for (const name of notInShared) {
    assert(
      !new RegExp(`(^|[^\\w])${name}\\s*\\(pi\\)`).test(shared),
      `canary: the shared block does NOT register ${name} (oo-rewrite: strict path only; pm-bash: parent-only)`,
    );
  }
  // The companion never registers the exclusions or the entry points either:
  // it registers the block, not the entry points.
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
  assert(
    /child-guards\.ts$/.test(CHILD_GUARDS_PATH),
    "CHILD_GUARDS_PATH ends with child-guards.ts",
  );
  assert(existsSync(CHILD_GUARDS_PATH), "CHILD_GUARDS_PATH exists on disk");
  const src6 = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "child-guards.ts"),
    "utf8",
  );
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
    'canary: the preflight stat is a plain statSync of the exported CHILD_GUARDS_PATH (no `?? ""` fallback)',
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
  // #1666 — the assignment moved to spawn-permission.ts (applyChildPermissionEnv).
  const permSrc = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "spawn-permission.ts"),
    "utf8",
  );
  const assignIdx = permSrc.indexOf('childEnv.PI_ENSEMBLE_SUBAGENT_MODE = "1"');
  assert(
    assignIdx > 0,
    'canary: spawn-permission.ts assigns PI_ENSEMBLE_SUBAGENT_MODE = "1" in the childEnv',
  );
  const openerIdx = permSrc.lastIndexOf("if (plan.subagentGuardEnabled) {");
  assert(
    openerIdx > 0,
    "canary: spawn-permission.ts contains the `if (plan.subagentGuardEnabled) {` branch opener",
  );
  const blockEnd = braceMatchEnd(
    permSrc,
    openerIdx + "if (plan.subagentGuardEnabled) {".length - 1,
  );
  assert(
    blockEnd > assignIdx,
    "canary: a brace-matched span exists for the subagentGuardEnabled branch",
  );
  assert(
    openerIdx < assignIdx && assignIdx < blockEnd,
    'canary: the PI_ENSEMBLE_SUBAGENT_MODE = "1" assignment lies within the subagentGuardEnabled block\'s span (the trust-mode branch must not set it)',
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
