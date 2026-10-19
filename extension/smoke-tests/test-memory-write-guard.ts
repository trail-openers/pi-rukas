#!/usr/bin/env bun
/**
 * memory-write-guard (#1666) — every shape that must refuse a destructive
 * `vipune update … -t`, and the shapes that must stay allowed.
 *
 * Offline: drives the pure matcher and the registered tool_call hook with a fake
 * ExtensionAPI. The guard is a guardrail against accidental rewrites, not a
 * security boundary (docs/headless.md), so this file pins the shapes it claims.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchBashSubcommand } from "../src/bash-command-parser.ts";
import { isDestructiveWrite, simpleCommands } from "../src/bash-destructive-write.ts";
import { bashCommandOf, registerMemoryWriteGuard } from "../src/memory-write-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

// ── 1. Refused: the destructive forms, each one a shape the guard must see through.
const refused: Array<[string, string]> = [
  ["bare -t", `vipune update 12 -t "rewritten"`],
  ["bare --text", "vipune update 12 --text x"],
  ["--text=value", "vipune update 12 --text=x"],
  ["env prefix assignment", "FOO=1 vipune update 12 -t x"],
  ["two env prefix assignments", "A=1 B=2 vipune update 12 -t x"],
  ["env wrapper", "env -i vipune update 12 --text=x"],
  ["env -u wrapper", "env -u HOME vipune update 12 -t x"],
  ["command wrapper", "command vipune update 12 -t x"],
  ["exec wrapper", "exec vipune update 12 -t x"],
  ["subshell", "(vipune update 12 -t x)"],
  ["command substitution", "echo $(vipune update 12 -t x)"],
  ["backticks", "echo `vipune update 12 -t x`"],
  ["command substitution inside double quotes", 'echo "$(vipune update 12 -t x)"'],
  ['attached value -t"x"', 'vipune update 12 -t"x"'],
  ["attached value -tx", "vipune update 12 -txyz"],
  ["bash -c body", `bash -c "vipune update 12 -t x"`],
  ["sh -lc body", `sh -lc 'vipune update 12 --text x'`],
  ["eval body", `eval "vipune update 12 -t x"`],
  ["chained &&", "true && vipune update 12 --text x"],
  ["chained ;", "echo hi; vipune update 12 -t x"],
  ["write after a closed substitution in quotes", 'echo "$(true)" && vipune update 12 -t x'],
  ["path-qualified binary", "/usr/local/bin/vipune update 12 -t x"],
  ["env -S payload", "env -S 'vipune update 12 -t x'"],
  ["env -S attached", 'env -S"vipune update 12 -t x"'],
  ["env --split-string", "env --split-string='vipune update 12 -t x'"],
  ["timeout duration", "timeout 5 vipune update 12 -t x"],
  ["timeout -s option", "timeout -s KILL 5 vipune update 12 -t x"],
  ["nohup wrapper", "nohup vipune update 12 -t x"],
  ["sudo -u wrapper", "sudo -u root vipune update 12 -t x"],
  ["xargs wrapper", "xargs vipune update 12 -t x"],
  ["xargs -I option", "xargs -I {} vipune update {} -t x"],
  ["nice -n option", "nice -n 10 vipune update 12 -t x"],
  ["nice legacy -N option", "nice -5 vipune update 12 -t x"],
  ["stdbuf -o option", "stdbuf -o L vipune update 12 -t x"],
  ["stdbuf attached option", "stdbuf -oL vipune update 12 -t x"],
  ["time -f option", "time -f '%e' vipune update 12 -t x"],
  ["time -o option", "time -o /tmp/t vipune update 12 -t x"],
  ["setsid wrapper", "setsid -w vipune update 12 -t x"],
  ["nice wrapping env wrapping vipune", "nice -n 5 env -i vipune update 12 --text=x"],
  ["delete", "vipune delete 12"],
  ["delete with env prefix", "FOO=1 vipune delete 12"],
  ["delete behind timeout", "timeout 5 vipune delete 12"],
  ["delete in bash -c body", `bash -c "vipune delete 12"`],
  ["prune", "vipune prune --count 5 --age-days 30"],
  ["prune in a chain", "true && vipune prune"],
  ["loop delete", "for id in 1 2; do vipune delete $id; done"],
  ["brace group prune", "{ vipune prune; }"],
  ["if-then delete", "if vipune delete 1; then echo ok; fi"],
  ["negated prune", "! vipune prune"],
  ["backslash-newline before verb", "vipune \\\n  delete 12"],
  ["caffeinate wrapper", "caffeinate -dimsu vipune delete 1"],
  ["gtimeout wrapper", "gtimeout 5 vipune prune"],
  ["doas wrapper", "doas -u root vipune delete 1"],
  ["stderr redirect before delete", "2>/dev/null vipune delete 12"],
  ["stdout redirect before prune", "> out vipune prune"],
  ["redirect with separate target", "< in vipune delete 1"],
  ["find -exec delete", "find . -exec vipune delete {} \\;"],
  ["find -exec behind timeout", "find . -name x -exec timeout 5 vipune prune {} +"],
  ["watch delete", "watch -n 5 vipune delete 1"],
  ["watch single-word body", "watch 'vipune delete 1'"],
  ["script -c delete", 'script -qc "vipune delete 1" /dev/null'],
  ["fd dup 2>&1 before delete", "2>&1 vipune delete 12"],
  ["fd dup >&2 before prune", ">&2 vipune prune"],
  ["&> redirect before delete", "&>out vipune delete 1"],
  ["background & before delete", "true & vipune delete 1"],
  ["escaped \\> does not make & a redirect", "echo \\>&vipune delete 1"],
];
for (const [name, cmd] of refused) {
  assert(isDestructiveWrite(cmd), `1: refused: ${name} (${cmd})`);
}

// ── 2. Allowed: status-only updates, adds, and text that is only quoted data.
const allowed: Array<[string, string]> = [
  ["status-only update", "vipune update 12 --status active"],
  ["add with supersedes", "vipune add 'corrected statement' --supersedes 12"],
  ["search", "vipune search 'topic' --json"],
  ["echo of the command text", 'echo "vipune update 12 -t x"'],
  ["single-quoted literal", "echo '$(vipune update 12 -t x)'"],
  ["unrelated command", "npm run typecheck"],
  ["env -S status-only", "env -S 'vipune update 12 --status active'"],
  ["timeout search", "timeout 5 vipune search 'topic'"],
  ["nice status-only", "nice -n 10 vipune update 12 --status active"],
  ["time search", "time -p vipune search 'topic'"],
  ["stdbuf search", "stdbuf -oL vipune search 'topic'"],
  ["empty", ""],
  ["get", "vipune get 12 --json"],
  ["list", "vipune list --json"],
  ["search for the word delete", "vipune search 'delete old rows' --json"],
  ["echo of a delete", 'echo "vipune delete 12"'],
  ["stderr redirect on search", "vipune search 'x' 2>/dev/null"],
  ["find without exec", "find . -name '*.ts'"],
  ["find -exec echo", "find . -exec echo {} \\;"],
  ["watch search", "watch -n 5 vipune search 'delete'"],
  ["search with fd dup 2>&1", "vipune search x 2>&1"],
];
for (const [name, cmd] of allowed) {
  assert(!isDestructiveWrite(cmd), `2: allowed: ${name} (${cmd})`);
}

// ── 3. The argument splitter: quotes are words, separators end commands.
{
  const cmds = simpleCommands(`a "b;c" 'd e' | f && g $(h i) \`j k\``);
  const flat = cmds.map((c) => c.join(" "));
  assert(flat.includes("a b;c d e"), "3: a quoted ; stays inside its word");
  assert(
    flat.includes("f") && flat.includes("g") && flat.includes("h i") && flat.includes("j k"),
    "3: pipes, &&, $( ) and backticks each start a command",
  );
}

// ── 4. A non-string command reads as empty and never throws.
assert(bashCommandOf({ command: 5 }) === "", "4: a numeric command reads as empty");
assert(bashCommandOf({ command: ["vipune"] }) === "", "4: an array command reads as empty");
assert(bashCommandOf(undefined) === "", "4: a missing input reads as empty");
assert(bashCommandOf({ command: "ls" }) === "ls", "4: a string command is read as-is");

// ── 5. The registered hook: refuses a destructive write, allows a status change.
type Handler = (event: unknown, ctx: unknown) => unknown;
{
  const handlers: Handler[] = [];
  const fake = {
    on: (name: string, fn: Handler) => {
      if (name === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  registerMemoryWriteGuard(fake);
  const run = async (toolName: string, input: unknown): Promise<unknown> => {
    for (const h of handlers) {
      const r = (await h({ toolName, input }, {})) as { block?: boolean } | undefined;
      if (r?.block) return r;
    }
    return undefined;
  };
  const blocked = (await run("bash", { command: "vipune update 12 -t x" })) as
    | { block?: boolean; reason?: string }
    | undefined;
  assert(blocked?.block === true, "5: the hook blocks a destructive vipune write");
  assert(
    typeof blocked?.reason === "string" && blocked.reason.includes("--supersedes"),
    "5: the refusal names the supersedes correction path",
  );
  assert(
    (await run("bash", { command: "vipune update 12 --status active" })) === undefined,
    "5: the hook allows a status-only update",
  );
  assert(
    (await run("bash", { command: 5 })) === undefined,
    "5: a non-string command is not blocked",
  );
  assert(
    (await run("read", { command: "vipune update 12 -t x" })) === undefined,
    "5: only bash tool calls are inspected",
  );
}

// ── 6. One owner: the allowlist matcher refuses through the same predicate.
{
  const allow = { "vipune *": "allow" };
  for (const cmd of [
    "env -S 'vipune update 12 -t x'",
    "timeout 5 vipune update 12 -t x",
    "nohup vipune update 12 -t x",
    "vipune delete 12",
    "vipune prune --count 5",
  ]) {
    assert(matchBashSubcommand(cmd, allow) === "deny", `6: the allowlist denies ${cmd}`);
  }
  assert(
    matchBashSubcommand("vipune update 12 --status active", allow) === "allow",
    "6: a status-only update still follows the allowlist",
  );
}

// ── 7. Layering: the predicate module stays Pi-free, so the allowlist matcher can import it.
{
  const src = readFileSync(new URL("../src/bash-destructive-write.ts", import.meta.url), "utf8");
  assert(!/@earendil-works/.test(src), "7: bash-destructive-write.ts imports no Pi package");
  assert(!/from "\.\/trace\.ts"/.test(src), "7: bash-destructive-write.ts imports no trace module");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
