/**
 * #1437 round 4 — the shapes a refused verb reaches the binary through once the
 * guard reads a rendering of the command rather than the command.
 *
 * Split from `test-memory-write-guard.ts` at the round's seam: that file owns the
 * predicate's bare-verb and flag behaviour, this one owns the two classes the six
 * lens passes found in round 3, both of which are failures of RENDERING rather than
 * of parsing.
 *
 *   1. A refused verb QUOTED AS ONE WHOLE TOKEN. `stripQuotedSegments` deletes a
 *      quoted run and leaves its delimiters, so `vipune "delete" 42` reduces to
 *      `vipune  42` — no verb exists for the skeleton pass to name — and clap still
 *      gets `delete`. `vipune "export" rows.jsonl` was verified to export the whole
 *      plaintext store. The guard's de-quoted pass existed but checked only update
 *      flags, so every one of these was allowed.
 *   2. A wrapper's UNRECOGNISED `-option` (`env -i`, `timeout -k 5`, `nohup -a`).
 *      The wrapper scan stopped at the first flag outside its vocabulary and read the
 *      word after it as the command, so `env -i vipune delete 42` named `-i` as the
 *      program and lost the invocation.
 *
 * And the two canaries on the allowed side, which are what made (1) hard: a quoted
 * run that is a memory BODY must stay inert even when it literally spells
 * `vipune delete`, because the driver writes memory through `vipune add` and a guard
 * that reads the first word of a quoted sentence as a command refuses its own writes.
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

// ---------------------- a refused verb quoted as one whole token is still refused
{
  // Each of these ran the binary pre-fix. The primary pass read the quote-STRIPPED
  // skeleton (the verb disappears with the run's contents) and the de-quoted pass
  // checked only update flags, so nothing named the verb at all. Quote removal is
  // the one operation that turns a quoted word back into an argument clap dispatches
  // on — which is why the scan that must see a verb runs on the raw text.
  const cases: Array<[string, string]> = [
    ['vipune "delete" 42', "delete"],
    ["vipune 'delete' 42", "delete"],
    ['vipune "export" rows.jsonl', "export"],
    ['vipune "prune"', "prune"],
    ['vipune "mcp"', "mcp"],
    ['vipune "promote" 7', "promote"],
    ['vipune "backup" snap.db', "backup"],
    ['vipune "import" rows.jsonl', "import"],
    ['vipune "reindex"', "reindex"],
    ['vipune "project" list', "project"],
    // A quoted verb after a granted one in the same clause: the skeleton pass
    // resolves the first invocation and closes command position for the rest, so
    // this second one is invisible to it.
    ['vipune search q vipune "delete" 1', "delete"],
    ['vipune get 7 vipune "prune"', "prune"],
    // A quoted verb behind a global option, and behind a privilege wrapper.
    ['vipune --json "delete" 42', "delete"],
    ['sudo vipune "delete" 42', "delete"],
    ['env FOO=1 vipune "prune"', "prune"],
    ['/usr/local/bin/vipune "export" rows.jsonl', "export"],
    // The refused verb as an option's VALUE on a mutating verb — the value slot the
    // verb scan stops short of, refused conservatively as it is in the bare form.
    ['vipune "update" 12 -p export x', "export"],
    // `vipune hook` stays exempt in its quoted form too: the binary invokes it from
    // a hook, and refusing it from inside that child refuses plumbing.
  ];
  for (const [cmd, verb] of cases) {
    assert(refusesMemoryWrite(cmd) === verb, `quoted verb refused as \`${verb}\` — ${cmd}`);
  }
  assert(
    refusesMemoryWrite('vipune "hook" session-start') === undefined,
    "the `hook` exemption survives quoting — it is the binary's own lifecycle handler",
  );
}

// ------------------- a quoted memory BODY stays inert however it spells itself
{
  // This is the whole difficulty of the fix above, and the reason a naive
  // de-quote-and-rescan is wrong: `deQuoteKeepingQuotedRuns` removes the quote
  // characters and LEAVES the spaces inside the run, so a scan over it sees
  // `vipune`, `delete`, `is`, `denied', …` as bare words and finds a second
  // invocation that bash never ran. Measured, that scan refused all three of these
  // — including the third, which is the shape the driver writes memory with.
  for (const cmd of [
    "vipune add 'vipune delete is denied'",
    "vipune add 'vipune delete is denied to every role'",
    'vipune add "gotchas: vipune prune demotes candidates"',
    "vipune add 'a note about prune and export' --memory-type fact",
    "vipune add 'say update --status please'",
    "vipune add 'note: --status and update are flags on the update verb'",
    // A multi-word quoted run is prose even when its FIRST word is a refused verb
    // and even when it sits directly after the binary's verb slot.
    "vipune add 'export the whole store please' --memory-type fact",
    // A quoted argument to a granted verb is data, not a second command.
    "vipune search 'prune and export are operator verbs' --limit 5",
  ]) {
    assert(refusesMemoryWrite(cmd) === undefined, `allowed — ${cmd}`);
  }
}

// ---------------- a collapsed UPDATE verb must reach the mutating-flag check
{
  // Round 3's lens named the verb half of this (`del""ete`) and left the flag half:
  // the skeleton reads `upd""ate` as an EMPTY verb slot, so a comparison against the
  // skeleton's reading skipped the flag branch entirely and `--status` — which clap
  // does honour, quote removal being what it is — mutated the row.
  const cases: Array<[string, string]> = [
    ['vipune upd""ate 1 --status active', "update <flag>"],
    ['vipune upd""ate 1 -t new', "update <flag>"],
    ["vipune upd''ate 1 --memory-type fact", "update <flag>"],
    ["vipune upd\\ate 1 --importance high", "update <flag>"],
  ];
  for (const [cmd, verdict] of cases) {
    assert(refusesMemoryWrite(cmd) === verdict, `collapsed update refused — ${cmd}`);
  }
  // And `update` with no mutating flag still does nothing, in any spelling.
  for (const cmd of ['vipune upd""ate 1', "vipune update 12"]) {
    assert(refusesMemoryWrite(cmd) === undefined, `inert update allowed — ${cmd}`);
  }
}

// ------- an unrecognised `-option` after a wrapper must not drop command position
{
  // The wrapper scan consumed the wrapper word and its KNOWN arguments, then stopped
  // at the first flag it did not recognise — and the outer loop read the word AFTER
  // that flag as the command. `env -i vipune delete 42` named `-i` as the program.
  // Each of these ran the binary. The rule that closes them is asymmetric on
  // purpose: an unknown option consumes only itself, so the word after it is still
  // read as the command; assuming a value is what loses an invocation, and only the
  // options the table names (`-k 5`, `timeout -k 5 30`) may consume one.
  const cases: Array<[string, string]> = [
    ["env -i vipune delete 42", "delete"],
    ["env --unset=FOO vipune delete 42", "delete"],
    ["timeout -k 5 30 vipune delete 42", "delete"],
    ["timeout --foreground 30 vipune delete 42", "delete"],
    ["nohup -a vipune delete 42", "delete"],
    ["env -i -u vipune prune", "prune"],
    ["nohup -a --foreground vipune mcp", "mcp"],
    ["timeout -k 5 30 vipune 'export' rows.jsonl", "export"],
  ];
  for (const [cmd, verb] of cases) {
    assert(refusesMemoryWrite(cmd) === verb, `wrapper option refused as \`${verb}\` — ${cmd}`);
  }
}

// ---------------------------------- the wrappers that resolve, rather than exec
{
  // `command -v`, `command -V` and `builtin -n` print a NAME and run nothing, so the
  // word after the option is the option's operand, not an invocation. Left allowed by
  // the same rule that refuses the five above, and pinned here because the two rules
  // live in one loop: a loosening that reopens `env -i` would look exactly like
  // "fixing the `command -v` case".
  for (const cmd of [
    "command -v vipune /usr/bin/vipune",
    "command -v vipune",
    "command -V vipune",
    "builtin -n vipune",
    // The operand IS the name, and `command -v` takes several names, so what
    // follows is another name to look up rather than a verb: this prints a path
    // twice and runs nothing.
    "command -v cat grep",
    "command -v vipune awk",
  ]) {
    assert(refusesMemoryWrite(cmd) === undefined, `resolving wrapper, not a command — ${cmd}`);
  }
  // A resolving wrapper that EXECUTES is not that rule: `-p` prepends a path and
  // runs the command, so the delete still happens.
  assert(
    refusesMemoryWrite("command -p /opt/bin vipune delete 42") === "delete",
    "`command -p` execs — refused where `-v` only prints",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
