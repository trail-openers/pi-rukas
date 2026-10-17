#!/usr/bin/env bun
/**
 * #1437 — the vipune memory-write boundary has a code refusal that trust and
 * sandbox mode cannot skip.
 *
 * The gap: the old `isDestructiveMemoryWrite` predicate (since renamed
 * `refusesMemoryWrite`) matched only `vipune update` with
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
  refusesMemoryWrite,
  registerMemoryWriteGuard,
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
  // ------------------------------------------------------ round 3 (adversarial)
  // Separators outside `[ \t]`. bash's IFS is `$' \t\n\v\f\r'`, so a tokeniser that
  // splits on only space and tab reads the verb with a separator glued to it and
  // matches nothing. One refused case per separator.
  "vipune\vdelete 42",
  "vipune\fdelete 42",
  "vipune\rdelete 42",
  "vipune delete\v42",
  "vipune delete\f42",
  "vipune delete\r42",
  // Privilege / session wrappers and the brace group. Each ran the binary pre-fix.
  "sudo vipune delete 42",
  "sudo -E vipune delete 42",
  "sudo -u postgres vipune delete 42",
  "sudo -E -u postgres vipune delete 42",
  "doas vipune delete 42",
  "pkexec vipune delete 42",
  "setsid vipune delete 42",
  "nsenter vipune delete 42",
  "{ vipune delete 42; }",
  "{vipune delete 42;}",
  // Quoted flag names. Quote removal hands clap the flag, so the row is mutated:
  // measured, `vipune update 1 "--status" active` gets past clap's own argument
  // parser to `Memory not found`, i.e. it parsed `--status`.
  'vipune update 1 "--status" active',
  'vipune update 1 --"status" active',
  'vipune update 1 "--status active"',
  'vipune update 1 "--memory-type" fact',
  'vipune update 1 "-t" new-text',
  // ------------------------------------------- round 3 lens findings (six-pass)
  // Quote-split and backslash-escaped VERBS. bash removes quotes and backslashes
  // before the word reaches clap, so all three dispatch the real verb — the
  // quote-STRIPPED skeleton reads them as a nonsense verb and lets them through.
  'vipune del""ete 42',
  "vipune dele''te 42",
  "vipune de\\lete 42",
  'vipune exp""ort rows.jsonl',
  'vipune update 12 --st""atus active',
  // A refused verb sitting in an option's VALUE slot. `-p` consumed `export`, so
  // the verb scan never names it; refused because a destructive verb handed to a
  // value-taking flag of a mutating verb is not a shape to trust.
  "vipune update 12 -p export x",
  "vipune update 12 --db-path prune",
  // A second, ungranted invocation after a granted one in the same clause: the
  // first clears command position for the rest of the segment, so the verb scan
  // cannot see the second.
  "vipune search q vipune delete 1",
  "vipune get 7 vipune prune",
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
  // The value-slot refusal is bounded to REFUSED verbs: `vipune update 12 -p
  // other x` is a real command that writes nothing, and the same slot holding
  // `export` is refused. Only the verb-shaped value is conservative about.
  "vipune update 12 -p other x",
  // A GRANTED verb keeping its own value slot — `--memory-type`'s value is a type
  // name, and `add` is never refused, so a granted verb's arguments stay arguments.
  "vipune add 'a fact' --memory-type fact --status candidate",
  // An argument that merely MENTIONS a refused verb is not a second invocation:
  // the stray scan starts after the resolved invocation's verb and needs a binary
  // token before the verb it reports, so a bare word cannot be promoted to one.
  // (`vipune search --filter delete` is the opposite case and IS refused — see
  // the value-slot block: `--filter` is unknown to vipune's option table, so the
  // verb scan treats `delete` as the verb of the invocation rather than as data.)
  "vipune add 'a note about prune and export' --memory-type fact",
  "vipune search q vipune get 7",
  // Quote-split spellings of a GRANTED verb stay allowed — the collapse is a read,
  // not a widening of what is refused.
  'vipune se""arch topic',
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
  // A memory body may MENTION a flag. The prose here names `update` AND `--status`
  // and is still allowed, which is the canary that the de-quoted second pass reads
  // flag NAMES, not substrings — a body that merely spells them is not a write.
  "vipune add 'say update --status please'",
  "vipune add 'note: --status and update are flags on the update verb'",
  // `sudo`/`doas` in an ARGUMENT position stay arguments — the privilege widening
  // is command-position-scoped, exactly like the wrapper set it joins.
  "echo sudo vipune delete 42",
  "grep 'sudo vipune delete' notes.txt",
  "echo doas vipune prune",
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

// ---------------------------------------- global-option arity follows the binary

{
  // `-p/--project` and `--db-path` take a value; `--json`/`-h`/`-V` do not. A
  // table that disagrees with the binary makes the verb unfindable: treat `-p`
  // as valueless and `other` becomes the verb; treat `--json` as taking one and
  // `delete` gets swallowed. Pinned against `vipune --help` below.
  assert(refusesMemoryWrite("vipune -p proj delete 42") === "delete", "-p consumes its value");
  assert(
    refusesMemoryWrite("vipune -p delete 42") === undefined,
    "…so `delete` after a bare -p is its VALUE, not a verb",
  );
  assert(refusesMemoryWrite("vipune --json delete 42") === "delete", "--json consumes nothing");
  assert(refusesMemoryWrite("vipune --json prune") === "prune", "…and the verb is still found");
  assert(
    refusesMemoryWrite("vipune --verbose delete 42") === "delete",
    "an unknown flag consumes nothing — fails toward refusing",
  );
}

// ------------------------- the two sets are disjoint, and `hook` is the only exemption

{
  assert(REFUSED_VIPUNE_VERBS.length > 0, "the refused verb set is non-empty");
  assert(
    EXEMPT_VIPUNE_VERBS.length === 1 && EXEMPT_VIPUNE_VERBS[0] === "hook",
    "hook is the sole exemption",
  );
  for (const v of EXEMPT_VIPUNE_VERBS) {
    assert(
      !REFUSED_VIPUNE_VERBS.includes(v),
      `canary: ${v} is exempt, not refused — the binary invokes it from a hook`,
    );
  }
  assert(
    /hook/.test(
      readFileSync(path.resolve(import.meta.dirname, "..", "src", "memory-write-guard.ts"), "utf8"),
    ),
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
  assert(
    /supersedes/.test(del?.reason ?? ""),
    "...which points at `add --supersedes`, not just 'no'",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_MEMORY_WRITES/.test(del?.reason ?? ""),
    "...and names the operator escape hatch",
  );

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
  assert(
    (await drive("vipune search 'x'")) === undefined,
    "trust mode: `vipune search` still passes",
  );
  delete process.env.PI_ENSEMBLE_TRUST_MODE;
  process.env.PI_ENSEMBLE_SANDBOX_MODE = "1";
  assert((await drive("vipune mcp"))?.block === true, "sandbox mode: `vipune mcp` refused");
  delete process.env.PI_ENSEMBLE_SANDBOX_MODE;

  const guard = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "memory-write-guard.ts"),
    "utf8",
  );
  assert(
    !/PI_ENSEMBLE_TRUST_MODE|PI_ENSEMBLE_SANDBOX_MODE|PI_ENSEMBLE_SUBAGENT_MODE|PI_ENSEMBLE_ROLE/.test(
      guard,
    ),
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
