#!/usr/bin/env bun
/**
 * #1437 — the wrapper / path / global-option bypasses stay closed.
 *
 * Split from `test-memory-write-guard.ts` at the natural seam: that file asserts
 * what the PREDICATE refuses and allows; this one asserts the specific class of
 * shape that used to reach the binary because something sat between the shell
 * operator and `vipune` — a privilege wrapper, an env assignment, a path, `oo`,
 * a compound keyword, or one of vipune's own global options.
 *
 * Same predicate, same gate, one file each: the predicate's own behaviour and the
 * bypass class are two lists that change for different reasons, and the size
 * ratchet is what forced the seam into the open.
 */

import { refusesMemoryWrite } from "../src/memory-write-guard.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
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
    // The guard-local privilege set (#1437 round 3). Deliberately NOT the shared
    // COMMAND_WRAPPERS, whose other consumer must not collapse `sudo npm test` to
    // `npm test`. `sudo`'s option arguments are consumed, so the token after
    // `-u postgres` is still read as the command and not as its argument.
    ["sudo vipune delete 42", "delete"],
    ["sudo -E vipune delete 42", "delete"],
    ["sudo -u postgres vipune delete 42", "delete"],
    ["sudo --user postgres vipune delete 42", "delete"],
    ["doas vipune prune", "prune"],
    ["pkexec vipune delete 42", "delete"],
    ["setsid vipune delete 42", "delete"],
    ["nsenter vipune delete 42", "delete"],
    ["sudo -u postgres vipune update 7 --status active", "update <flag>"],
    // The brace group: `{` is a command-position starter, not junk.
    ["{ vipune delete 42; }", "delete"],
    ["{vipune delete 42;}", "delete"],
    ["cd extension && { vipune prune; }", "prune"],
    // Separators outside `[ \t]` — bash's IFS carries them, so the verb exists.
    ["vipune\vdelete 42", "delete"],
    ["vipune\fdelete 42", "delete"],
    ["vipune\rdelete 42", "delete"],
    ["vipune\vprune", "prune"],
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
console.log(`\nexit ${exit}`);
process.exit(exit);
