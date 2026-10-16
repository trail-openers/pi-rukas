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
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  EXEMPT_VIPUNE_VERBS,
  REFUSED_VIPUNE_VERBS,
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
  // Measured against vipune 0.15.0: clap REJECTS abbreviated long flags
  // (`vipune update 1 --stat active` -> `error: unexpected argument '--stat'
  // found`), so these mutate nothing. Refusing them would report a threat the
  // binary cannot act on, and the module header, troubleshooting and the skill
  // say exact names and `=` forms for the same reason.
  "vipune update 12 --stat active",
  "vipune update 12 --stat=active",
  "vipune update 12 --imp high",
  "vipune update 12 --mem-t guard",
  "vipune update 12 --memorytyp=fact",
  "vipune update 12 --memory-t fact",
  // The granted verbs keep their own mutating flags — the reason the clause
  // binds flags to `update` and to nothing else.
  "vipune add 'x' --memory-type fact --status candidate",
]) {
  assert(refusesMemoryWrite(cmd) === undefined, `allowed — ${cmd}`);
}

// --------------------------------------- the argument positions are NOT refused

{
  // The command-position rule matches the SIBLING guards' shape and then some,
  // and the "some" is what these pin: a token that is not in command position is
  // not an invocation, even when the words read exactly like one. Measured
  // against the binary, none of these runs vipune at all — `grep` is the program,
  // `vipune` and `delete` are its operands, and `echo vipune delete > notes.txt`
  // is a write to `notes.txt` containing the literal text.
  //
  // This is the direction a guard must err in, and it is the reason the scan
  // tracks command position token by token instead of searching for the
  // `vipune delete` substring: a false refusal costs an agent one retyped
  // command, but refusing the shapes above means refusing the log read and the
  // note-taking, which agents do constantly and which have nothing to do with
  // memory. Pinned so a later loosening that reopens a REAL bypass
  // (`nohup vipune delete`) cannot be dressed up as "just fixing the grep case".
  for (const cmd of [
    "grep vipune delete file.log",
    "echo vipune delete 42",
    "echo vipune delete > notes.txt",
  ]) {
    assert(refusesMemoryWrite(cmd) === undefined, `argument position, not a command — ${cmd}`);
  }
}

// ---------------------------------- what the widening beyond -t/--text covers

{
  // The pre-#1437 rule was `vipune update` carrying `-t`/`--text` and nothing
  // else. Every shape below was a hole in it, and each is a write the binary
  // actually performs — the abbreviated-flag cases above are NOT, which is the
  // distinction the whole block turns on.
  for (const cmd of [
    // -m replaces metadata in place; --memory-type silently retypes a row out
    // of every typed read; --status moves it between the tiers.
    "vipune update 12 --status active",
    "vipune update 12 --memory-type fact",
    "vipune update 12 --importance high",
    // Clustered short flags: measured on 0.15.0, `vipune update <id> -tm`
    // reaches the database and rewrites the row with content `m`, because `t`
    // consumes `m` as --text's value. The `m` is invisible in the token.
    "vipune update 12 -tm",
    "vipune update 12 -mt",
    "vipune update 12 -tx",
    "vipune update 12 -tm && git status",
  ]) {
    assert(refusesMemoryWrite(cmd) !== undefined, `canary: the widening is real — ${cmd}`);
  }
  // `-t=x` is `--text` with value `x` — measured, it writes `x` into the row, so
  // it IS refused. It sits here rather than in the allowed list because the
  // distinction it draws is the one the cluster loop exists for: `=` neither
  // introduces a flag nor ends the scan (`-xm=1` mutates too).
  assert(refusesMemoryWrite("vipune update 12 -t=x") !== undefined, "`-t=x` writes `x` — refused");
}

// ---------------- the wrapper / path / global-option bypasses are closed

{
  // Each of these ran the binary pre-fix: the predicate anchored on
  // `(?:^|(?<=[;&|\n]))\s*(?:oo\s+)?vipune`, so anything between the operator
  // and `vipune` — a wrapper, an env assignment, a path, a global option — put
  // the verb out of reach of the match. They are refused now, and the refusal
  // names the VERB, never the command slice (a memory body can be arbitrary text
  // and must not come back in the reason the child is handed).
  const cases: Array<[string, string]> = [
    ["env FOO=1 vipune delete 42", "delete"],
    ["VIPUNE_DEBUG=1 vipune delete 5", "delete"],
    ["command vipune delete 42", "delete"],
    ["nohup vipune delete 42", "delete"],
    ["time vipune delete 42", "delete"],
    ["timeout 30 vipune delete 42", "delete"],
    ["nice -n 5 vipune delete 42", "delete"],
    ["exec vipune delete 42", "delete"],
    ["/usr/local/bin/vipune delete 42", "delete"],
    ["~/bin/vipune delete 42", "delete"],
    ["./vipune delete 42", "delete"],
    ["vipune --json delete 42", "delete"],
    ["vipune -p other delete 42", "delete"],
    ["vipune --db-path X delete 42", "delete"],
    ["if true; then vipune delete 42; fi", "delete"],
    ["for x in a; do vipune delete 42; done", "delete"],
    ["if true; then echo hi; else vipune delete 42; fi", "delete"],
    ["( vipune delete 42 )", "delete"],
    ["command vipune mcp", "mcp"],
    ["env FOO=1 vipune prune", "prune"],
  ];
  for (const [cmd, verb] of cases) {
    assert(refusesMemoryWrite(cmd) === verb, `canary: refused as \`${verb}\` — ${cmd}`);
  }

  // The path form requires a `/`; the whole-token comparison requires the token
  // to BE `vipune`. Together they are why the MCP tool name stays untouched.
  assert(
    refusesMemoryWrite("mcp__codebase_memory__vipune delete 42") === undefined,
    "canary: the MCP tool name is not an invocation, chained or not",
  );

  // The cheap gate must not change any verdict: identical results with and
  // without it, on the shapes a false negative there would be worst for.
  for (const [cmd, verb] of cases) {
    const noVipune = cmd.replace(/vipune/, "");
    assert(
      refusesMemoryWrite(noVipune) === undefined,
      `the indexOf fast path cannot invent a refusal — ${noVipune}`,
    );
    void verb;
  }
}

// ---------------------------------------- global-option arity follows the binary

{
  // `-p/--project` and `--db-path` take a value; `--json`/`-h`/`-V` do not. A
  // table that disagrees with the binary makes the verb unfindable: treat `-p`
  // as valueless and `other` becomes the verb; treat `--json` as taking one and
  // `delete` gets swallowed. Pinned against `vipune --help` below.
  assert(refusesMemoryWrite("vipune -p proj delete 42") === "delete", "-p consumes its value");
  assert(refusesMemoryWrite("vipune -p delete 42") === undefined, "…so `delete` after a bare -p is its VALUE, not a verb");
  assert(refusesMemoryWrite("vipune --json delete 42") === "delete", "--json consumes nothing");
  assert(refusesMemoryWrite("vipune --json prune") === "prune", "…and the verb is still found");
  assert(refusesMemoryWrite("vipune --verbose delete 42") === "delete", "an unknown flag consumes nothing — fails toward refusing");
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

// --------- the global-option arity table agrees with the installed binary

{
  // The verb is found by skipping the options before it, and the skip length is
  // "how many values does this option require". Get that wrong in either
  // direction and the predicate stops seeing verbs: `-p` treated as valueless
  // makes `vipune -p other delete 42` read `other` as the verb, `--json` treated
  // as taking a value makes `vipune --json delete 42` read `delete` as a value.
  // So the table is not allowed to be remembered — it is re-read from
  // `vipune --help`, the same way the verb sets are, and an upgrade that gives a
  // global option a value fails the gate instead of going quietly blind.
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "memory-write-guard.ts"),
    "utf8",
  );
  const tableMatch = /const GLOBAL_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\s*\];/.exec(src);
  assert(tableMatch !== null, "the global-option table is present and parseable");
  const declared = new Map<string, number>();
  if (tableMatch) {
    for (const m of tableMatch[1].matchAll(/flags:\s*\[([^\]]*)\],\s*values:\s*(\d+)/g)) {
      const values = Number(m[2]);
      for (const f of (m[1] ?? "").matchAll(/"([^"]+)"/g)) declared.set(f[1] ?? "", values);
    }
  }
  assert(declared.size > 0, "...and declares at least one option");

  let help: string | null = null;
  try {
    help = execFileSync("vipune", ["--help"], { encoding: "utf8", timeout: 10_000 });
  } catch {
    // No binary on this host (CI, a fresh container): the table still has to be
    // internally sound, which the assertions above already covered.
  }
  if (help !== null) {
    const block = help.slice(help.indexOf("Options:"));
    const fromBinary = new Map<string, number>();
    for (const m of block.matchAll(/^\s{2,}(-\w),?\s+(--?\w[\w-]*)?\s*(?:<[^>]+>)?/gm)) {
      const short = m[1];
      const long = m[2];
      const takesValue = /<[^>]+>/.test(m[0] ?? "") ? 1 : 0;
      if (short) fromBinary.set(short, takesValue);
      if (long) fromBinary.set(long, takesValue);
    }
    const mismatches: string[] = [];
    for (const [flag, values] of declared) {
      const actual = fromBinary.get(flag);
      if (actual !== undefined && actual !== values) mismatches.push(`${flag} ${values}!=${actual}`);
    }
    assert(
      mismatches.length === 0,
      `every declared arity matches \`vipune --help\`${mismatches.length ? ` — ${mismatches.join(", ")}` : ""}`,
    );
    // The options the binary says take a value must be in the table, or their
    // values get read as verbs.
    const missing = [...fromBinary].filter(([, v]) => v === 1).filter(([f]) => !declared.has(f));
    assert(
      missing.length === 0,
      `no value-taking global option is missing from the table${missing.length ? ` — ${missing.map(([f]) => f).join(", ")}` : ""}`,
    );
  } else {
    console.log("- vipune binary absent: arity table checked against itself only");
  }
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
