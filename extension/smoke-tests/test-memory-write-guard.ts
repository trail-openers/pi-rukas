#!/usr/bin/env bun
/**
 * #1437 — the vipune memory-write boundary has a code refusal that trust and
 * sandbox mode cannot skip.
 *
 * The gap: `isDestructiveMemoryWrite` matched only `vipune update` with
 * `-t`/`--text`, and its single caller is `matchBashSubcommand` — reached from
 * the permission verdict path (which trust mode returns out of before any
 * gating, and sandbox mode too) and from `pm-bash-guard` (parent PM only). A
 * trust/sandbox subagent had no memory refusal at all: `vipune delete <id>` —
 * irreversible, no confirmation flag — reached the binary. Doctrine said
 * "denied to every role"; the default mode enforced none of it.
 *
 * The fix is a mode-independent `tool_call` hook in memory-write-guard.ts,
 * registered inside `registerModeIndependentGuards` (so the child-guards
 * companion loads it into every child) AND in the parent path above the sandbox
 * short-circuit (the shared block sits below it, so registering only there
 * would leave the container default unguarded).
 *
 * The refused set is an EQUATION, not a list someone liked: every verb
 * `vipune --help` lists minus every verb `agents.json` grants, plus `update`
 * with a row-mutating flag. `test-vipune-argv.ts` re-derives it from the binary
 * and the config; this file asserts the predicate's behaviour, the `hook`
 * exemption's reason, and the registration placement.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  EXEMPT_VIPUNE_VERBS,
  REFUSED_VIPUNE_VERBS,
  isDestructiveMemoryWrite,
  registerMemoryWriteGuard,
  refusesMemoryWrite,
} from "../src/memory-write-guard.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ it catches

for (const cmd of [
  // The ungranted verbs, in the shapes agents actually emit.
  "vipune delete 42",
  "vipune prune",
  "vipune promote",
  "vipune mcp",
  "vipune export rows.jsonl",
  "vipune backup snap.db",
  "vipune import rows.jsonl",
  "vipune reindex",
  "vipune project list",
  // The `oo` prefix — agents.json grants `oo <cmd>` shapes for other tools.
  "oo vipune delete 42",
  // Chained commands — the predicate scans, it does not anchor.
  "cd extension && vipune prune",
  "vipune search 'x'; vipune delete 42",
  "git status && vipune export rows.jsonl",
  // `update` carrying ANY row-mutating flag, prefix and `=` forms. This is the
  // original -t/--text rule widened: -m replaces metadata in place and
  // --memory-type silently retypes a row out of every typed read.
  "vipune update 12 -t 'new text'",
  "vipune update 12 --text 'new text'",
  "vipune update 12 --text=new",
  "vipune update 12 -m '{\"k\":1}'",
  "vipune update 12 --metadata '{\"k\":1}'",
  "vipune update 12 --memory-type fact",
  "vipune update 12 --memory-type=fact",
  "vipune update 12 --status active",
  "vipune update 12 --status=active",
  "vipune update 12 --importance high",
  "oo vipune update 12 --status active",
  "cd extension && vipune update 12 -t x",
  // The `&&` shape an agent actually emits: the argument span reaches the next
  // operator, so a boundary-anchored regex would miss it and the flag would
  // ride through on a chained command.
  "vipune update 12 -t x && git add -A",
  "vipune update 12 --status active; git status",
]) {
  assert(refusesMemoryWrite(cmd) !== undefined, `canary: refused — ${cmd}`);
}

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // The granted verbs — the whole reason the flag clause binds to `update`
  // first: the driver writes memory through `vipune add` carrying
  // --memory-type and --status (memory-write.ts, guard-memory-write.ts). A
  // predicate that scanned for mutating flags without binding them to a verb
  // would break every driver write and the develop brief.
  "vipune search 'topic' --no-hybrid --recency 0.0",
  "vipune validate 'some text'",
  "vipune add 'a durable fact' --memory-type fact",
  "vipune add 'x' --memory-type observation --status candidate",
  "vipune add 'x' --supersedes abc123 --memory-type guard",
  "vipune add 'x' -m '{\"issue\":1437}' --memory-type observation",
  "vipune get 42",
  "vipune list --limit 50",
  "vipune doctor",
  "vipune version",
  // `update` with no mutating flag does nothing, so it is not refused.
  "vipune update 12",
  // `vipune hook` is the lifecycle handler the binary itself invokes FROM a
  // hook — refusing it from inside the child that calls it refuses plumbing,
  // not a memory write. Pinned as an explicit exemption below.
  "vipune hook session-start",
  // A memory body that MENTIONS the refused verbs is a write, not a write.
  "vipune add 'vipune delete is denied to every role'",
  'vipune add "gotchas: vipune prune demotes candidates"',
  // An unrelated token that merely ENDS in `vipune` is not an invocation — the
  // anchor is a shell operator or the string start, not `\b`.
  "echo mcp__codebase_memory__vipune",
  // And a flag-looking word belonging to another command in the chain is not
  // borrowed by an update earlier in it.
  "vipune update 12 && cp --status x",
]) {
  assert(refusesMemoryWrite(cmd) === undefined, `allowed — ${cmd}`);
}

// ------------------------- the delegating export keeps the old rule's coverage

{
  // Every command the pre-#1437 regex refused must still be refused — the new
  // predicate is a superset, never a narrowing.
  for (const cmd of ["vipune update 12 -t x", "vipune update 12 --text x", "vipune update 1 --text=x"]) {
    assert(isDestructiveMemoryWrite(cmd) === true, `delegating export still refuses — ${cmd}`);
  }
  for (const cmd of ["vipune update 12", "vipune add 'x' --status candidate", "vipune search x"]) {
    assert(isDestructiveMemoryWrite(cmd) === false, `delegating export still allows — ${cmd}`);
  }
  assert(
    refusesMemoryWrite("vipune update 12 --status active") !== undefined,
    "canary: the widening beyond -t/--text is real — the old predicate allowed this, the new one refuses it",
  );
}

// ------------------------- the two sets are disjoint, and `hook` is the only exemption

{
  assert(REFUSED_VIPUNE_VERBS.length > 0, "the refused verb set is non-empty");
  assert(EXEMPT_VIPUNE_VERBS.length === 1 && EXEMPT_VIPUNE_VERBS[0] === "hook", "hook is the sole exemption");
  for (const v of EXEMPT_VIPUNE_VERBS) {
    assert(
      !REFUSED_VIPUNE_VERBS.includes(v),
      `canary: ${v} is exempt, not refused — the binary invokes it from a hook`,
    );
  }
  assert(
    /hook/.test(readFileSync(path.resolve(import.meta.dirname, "..", "src", "memory-write-guard.ts"), "utf8")),
    "the exemption carries its reason in the module's own jsdoc",
  );
}

// -------------------- the refusal is a mode-independent tool_call hook

{
  type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
  const handlers: Handler[] = [];
  const fake = {
    on: (event: string, fn: Handler) => {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  delete process.env.PI_ENSEMBLE_ALLOW_MEMORY_WRITES;
  registerMemoryWriteGuard(fake);
  assert(handlers.length === 1, "registers exactly one tool_call hook");

  const drive = async (toolName: string, command: string) =>
    (await handlers[0]({ toolName, input: { command } }, {})) as
      | { block?: boolean; reason?: string }
      | undefined;

  const del = await drive("bash", "vipune delete 42");
  assert(
    del?.block === true && (del.reason ?? "").length > 30,
    "the hook refuses `vipune delete 42` with a reason that names the way forward",
  );
  assert(/supersedes/.test(del?.reason ?? ""), "...which points at `add --supersedes`, not just 'no'");
  assert(/PI_ENSEMBLE_ALLOW_MEMORY_WRITES/.test(del?.reason ?? ""), "...and names the operator escape hatch");

  const add = await drive("bash", "vipune add 'a fact' --memory-type fact --status candidate");
  assert(add === undefined, "the hook allows the driver's own `vipune add` write");

  const nonBash = await drive("read", "vipune delete 42");
  assert(nonBash === undefined, "a non-bash tool is not the door this hook guards");

  // Escape hatch: checked at registration, so with it set NO handler is
  // installed — the same shape as issue-creation-guard's opt-out.
  process.env.PI_ENSEMBLE_ALLOW_MEMORY_WRITES = "1";
  const opted: Handler[] = [];
  registerMemoryWriteGuard({
    on: (event: string, fn: Handler) => {
      if (event === "tool_call") opted.push(fn);
    },
  } as unknown as ExtensionAPI);
  assert(opted.length === 0, "escape hatch: PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1 registers no hook");
  delete process.env.PI_ENSEMBLE_ALLOW_MEMORY_WRITES;
}

// ------------- it reaches a TRUST-MODE child: the gap this issue is about

{
  // The proof the pre-#1437 code could not make: with trust mode on and sandbox
  // mode unset — a trust-mode child's environment — `vipune delete` is refused
  // and `vipune search` passes. The guard body reads no mode variable at all,
  // so this is the same code path the child runs.
  type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
  const handlers: Handler[] = [];
  registerMemoryWriteGuard({
    on: (event: string, fn: Handler) => {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI);
  process.env.PI_ENSEMBLE_TRUST_MODE = "1";
  delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
  const drive = async (command: string) =>
    (await handlers[0]({ toolName: "bash", input: { command } }, {})) as
      | { block?: boolean }
      | undefined;
  assert((await drive("vipune delete 7"))?.block === true, "trust mode: `vipune delete 7` refused");
  assert((await drive("vipune prune"))?.block === true, "trust mode: `vipune prune` refused");
  assert((await drive("vipune search 'x'")) === undefined, "trust mode: `vipune search` still passes");
  delete process.env.PI_ENSEMBLE_TRUST_MODE;
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  assert((await drive("vipune mcp"))?.block === true, "sandbox mode: `vipune mcp` refused");
  delete process.env.PI_ENSEMBLE_SANDBOX_MODE;

  const guard = readFileSync(path.resolve(import.meta.dirname, "..", "src", "memory-write-guard.ts"), "utf8");
  assert(
    !/PI_ENSEMBLE_TRUST_MODE|PI_ENSEMBLE_SANDBOX_MODE|PI_ENSEMBLE_SUBAGENT_MODE|PI_ENSEMBLE_ROLE/.test(guard),
    "canary: the guard reads no mode or role variable — it is the hook before the bypasses, not a branch inside them",
  );
}

// ---------------- the shared block registers it, ahead of every bypass

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const block = readFileSync(path.join(SRC, "subagent-guard-guards.ts"), "utf8");
  const guardIdx = sub.indexOf("registerModeIndependentGuards(pi)");
  const sandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const trustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(
    block.includes("registerMemoryWriteGuard(pi)"),
    "canary: the shared block registers the memory-write guard, so the child-guards companion loads it into every child",
  );
  assert(
    guardIdx > 0 && guardIdx < sandboxIdx && guardIdx < trustIdx,
    `...and the block is called BEFORE both bypasses (guard=${guardIdx}, sandbox=${sandboxIdx}, trust=${trustIdx}) — after them it would never run`,
  );
  // The parent path registers its guards ABOVE the sandbox short-circuit and
  // the subagent firewall, so it must carry this one explicitly: the shared
  // block is unreachable there (it sits below both, on the subagent branch).
  const parent = readFileSync(path.join(SRC, "permission-guard.ts"), "utf8");
  const body = parent.slice(parent.indexOf("export function registerPermissionGuard"));
  const parentGuardIdx = body.indexOf("registerMemoryWriteGuard(pi)");
  const parentSandboxIdx = body.indexOf('if (process.env.PI_ENSEMBLE_SANDBOX_MODE === "1") {');
  const parentSubagentIdx = body.indexOf('if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1") {');
  assert(parentGuardIdx > 0, "canary: the parent path registers the memory-write guard");
  assert(
    parentGuardIdx >= 0 &&
      parentSandboxIdx > 0 &&
      parentGuardIdx < parentSandboxIdx &&
      parentGuardIdx < parentSubagentIdx,
    `...BEFORE the parent's sandbox short-circuit and the subagent firewall (guard=${parentGuardIdx}, sandbox=${parentSandboxIdx}, subagent=${parentSubagentIdx}) — the container default`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
