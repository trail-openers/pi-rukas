#!/usr/bin/env bun
/**
 * broadcast-kill-guard (#2381) — every shape that must refuse a signal to every
 * process of the uid, and the shapes that must stay allowed.
 *
 * Offline: drives the pure predicate and the registered tool_call hook with a fake
 * ExtensionAPI. The guard is a guardrail against a child's own bad judgement, not a
 * security boundary, so this file pins the shapes it claims.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { broadcastKillVerdictOf, isBroadcastKill } from "../src/bash-broadcast-kill.ts";
import { registerBroadcastKillGuard } from "../src/broadcast-kill-guard.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

// ── 1. Refused: a `kill` whose target is -1, in every spelling and wrapper.
const refusedAll: Array<[string, string]> = [
  ["bare -- -1", "kill -- -1"],
  ["signal name then -1", "kill -TERM -1"],
  ["signal number then -1", "kill -9 -1"],
  ["HUP spelled -1 then -1", "kill -1 -1"],
  ["-s SIG then -1", "kill -s TERM -1"],
  ["-s SIG then -- -1", "kill -s KILL -- -1"],
  ["--signal=SIG then -1", "kill --signal=TERM -1"],
  ["path-qualified binary", "/bin/kill -TERM -1"],
  ["builtin wrapper", "builtin kill -TERM -1"],
  ["command wrapper", "command kill -- -1"],
  ["timeout wrapper", "timeout 5 kill -TERM -1"],
  ["sudo wrapper", "sudo kill -9 -1"],
  ["env prefix assignment", "FOO=1 kill -TERM -1"],
  ["chained &&", "true && kill -TERM -1"],
  ["chained ;", "echo hi; kill -TERM -1"],
  ["subshell", "(kill -TERM -1)"],
  ["command substitution", "echo $(kill -TERM -1)"],
  ["backticks", "echo `kill -TERM -1`"],
  ["bash -c body", `bash -c "kill -TERM -1"`],
  ["sh -c body", `sh -c 'kill -- -1'`],
  ["eval body", `eval "kill -TERM -1"`],
  ["env -S payload", "env -S 'kill -TERM -1'"],
  ["heredoc script run by bash", "bash <<'EOF'\necho cleaning\nkill -TERM -1\nEOF"],
  ["find -exec kill", "find . -name x -exec kill -9 -1 \\;"],
  ["xargs kill with -1 target", "echo | xargs kill -TERM -- -1"],
  ["quoted target", `kill -TERM -- "-1"`],
  ["killall5", "killall5"],
  ["killall5 with signal", "killall5 -15"],
  ["loop body", "for s in TERM KILL; do kill -$s -1; done"],
];
for (const [name, cmd] of refusedAll) {
  const v = broadcastKillVerdictOf(cmd);
  assert(v?.kind === "all", `1: refused (all): ${name} — got ${JSON.stringify(v)}`);
}

// ── 2. Refused: a user-scoped pkill / killall.
const refusedUser: Array<[string, string]> = [
  ["pkill -u", "pkill -u alice"],
  ["pkill -U", "pkill -U 1000"],
  ["pkill -TERM -u", "pkill -TERM -u $USER"],
  ["pkill --uid", "pkill --uid 1000"],
  ["pkill --euid=", "pkill --euid=1000 sleep"],
  ["pkill cluster -fu", "pkill -fu alice pytest"],
  ["killall -u", "killall -u alice"],
  ["killall --user", "killall --user alice"],
  ["pkill behind timeout", "timeout 5 pkill -u alice"],
  ["pkill in bash -c", `bash -c 'pkill -u alice'`],
];
for (const [name, cmd] of refusedUser) {
  const v = broadcastKillVerdictOf(cmd);
  assert(v?.kind === "user", `2: refused (user): ${name} — got ${JSON.stringify(v)}`);
}

// ── 3. Refused: an interpreter one-liner or heredoc that calls kill(-1) / killpg(1).
const refusedInterp: Array<[string, string]> = [
  ["python os.killpg(1, 15)", `python3 -c "import os; os.killpg(1, 15)"`],
  ["python os.kill(-1, 15)", `python3 -c "import os, signal; os.kill(-1, signal.SIGTERM)"`],
  ["python heredoc", "python3 - <<'PY'\nimport os\nos.killpg(1, 15)\nPY"],
  ["python heredoc behind timeout", "timeout 120 python3 - <<'PY'\nimport os\ntry:\n    os.killpg(1, 15)\nexcept PermissionError as e:\n    print(e)\nPY"],
  ["node process.kill(-1)", `node -e 'process.kill(-1)'`],
  ["bun process.kill(-1, 0)", `bun -e 'process.kill(-1, 0)'`],
  ["perl kill TERM => -1", `perl -e 'kill TERM => -1'`],
  ["perl kill 'TERM', -1", `perl -e "kill 'TERM', -1"`],
  ["ruby Process.kill", `ruby -e 'Process.kill("TERM", -1)'`],
];
for (const [name, cmd] of refusedInterp) {
  const v = broadcastKillVerdictOf(cmd);
  assert(v?.kind === "all", `3: refused (interpreter): ${name} — got ${JSON.stringify(v)}`);
}

// ── 4. Refused as unresolved: a negative kill target the guard cannot read.
const refusedUnresolved: Array<[string, string]> = [
  ["-$PGID", "kill -TERM -$PGID"],
  ["-- -$pgid", 'kill -- -"$pgid"'],
  ["-${N}", "kill -9 -${N}"],
  ["-$(cat pid)", "kill -TERM -$(cat run.pid)"],
];
for (const [name, cmd] of refusedUnresolved) {
  const v = broadcastKillVerdictOf(cmd);
  assert(v?.kind === "unresolved", `4: refused (unresolved): ${name} — got ${JSON.stringify(v)}`);
}

// ── 5. Allowed: a signal to a pid or a literal group, and everything that is not a kill.
const allowed: Array<[string, string]> = [
  ["SIGHUP (-1) to one pid", "kill -1 1234"],
  ["signal name to one pid", "kill -TERM 1234"],
  ["signal to several pids", "kill -9 1234 5678"],
  ["literal negative group", "kill -TERM -- -1234"],
  ["literal negative group, no --", "kill -TERM -1234"],
  ["-s SIG to one pid", "kill -s TERM 1234"],
  ["job spec", "kill %1"],
  ["bare -1 with no target", "kill -1"],
  ["kill -l", "kill -l"],
  ["kill -l 15", "kill -l 15"],
  ["pid from a variable", 'kill -TERM "$pid"'],
  ["pkill by parent", "pkill -P $$ sleep"],
  ["pkill by name", "pkill -f 'while :; do'"],
  ["killall by name", "killall sleep"],
  ["pgrep -u is a read", "pgrep -u alice"],
  ["xargs kill of listed pids", "cat pids | xargs kill -TERM"],
  ["python killpg of a variable", `python3 -c "import os; os.killpg(pgid, 15)"`],
  ["python killpg of getpgid", `python3 -c "import os; os.killpg(os.getpgid(p.pid), 15)"`],
  ["python kill of a pid", `python3 -c "import os; os.kill(1234, 15)"`],
  ["node child.kill()", `node -e 'child.kill("SIGTERM")'`],
  ["grep for the pattern", `rg -n "kill -TERM -1" src/`],
  ["grep for the call", `rg -n "os.killpg\\(1," scripts/`],
  ["prose mentioning kill -1", `echo "never run kill -1 here"`],
  ["skill named kill", "cat docs/kill-switch.md"],
  ["git log grep", "git log --grep='kill -1' --oneline"],
  ["terminate_group of a real pid", `python3 -c "from scripts import k; k.terminate_group(424242)"`],
  ["empty", ""],
];
for (const [name, cmd] of allowed) {
  const v = broadcastKillVerdictOf(cmd);
  assert(v === undefined, `5: allowed: ${name} — got ${JSON.stringify(v)}`);
}
assert(isBroadcastKill("kill -TERM -1") && !isBroadcastKill("kill -TERM 1234"), "5: boolean wrapper");

// ── 6. The registered hook: refuses a broadcast kill, allows a targeted one, inspects bash only.
type Handler = (event: unknown, ctx: unknown) => unknown;
{
  const handlers: Handler[] = [];
  const fake = {
    on: (name: string, fn: Handler) => {
      if (name === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  registerBroadcastKillGuard(fake);
  assert(handlers.length === 1, "6: registers exactly one tool_call hook");
  const run = async (toolName: string, input: unknown): Promise<unknown> => {
    for (const h of handlers) {
      const r = (await h({ toolName, input }, {})) as { block?: boolean } | undefined;
      if (r?.block) return r;
    }
    return undefined;
  };
  const blocked = (await run("bash", { command: "kill -TERM -1" })) as
    | { block?: boolean; reason?: string }
    | undefined;
  assert(blocked?.block === true, "6: the hook blocks `kill -TERM -1`");
  assert(
    typeof blocked?.reason === "string" &&
      blocked.reason.includes("every process") &&
      blocked.reason.includes("killpg(1"),
    "6: the refusal names the rule and the killpg(1) spelling",
  );
  const probe = (await run("bash", {
    command: `timeout 120 python3 -c "\nimport os\ntry:\n    os.killpg(1, 15)\nexcept PermissionError as e:\n    print(e)\n"`,
  })) as { block?: boolean } | undefined;
  assert(probe?.block === true, "6: the hook blocks the field probe (python killpg(1) in a -c body)");
  assert(
    (await run("bash", { command: "kill -TERM 1234" })) === undefined,
    "6: the hook allows a signal to one pid",
  );
  assert((await run("bash", { command: 5 })) === undefined, "6: a non-string command is not blocked");
  assert(
    (await run("read", { command: "kill -TERM -1" })) === undefined,
    "6: only bash tool calls are inspected",
  );
}

// ── 7. Layering: the predicate module stays Pi-free.
{
  const src = readFileSync(new URL("../src/bash-broadcast-kill.ts", import.meta.url), "utf8");
  assert(!/@earendil-works/.test(src), "7: bash-broadcast-kill.ts imports no Pi package");
  assert(!/from "\.\/trace\.ts"/.test(src), "7: bash-broadcast-kill.ts imports no trace module");
}

// ── 8. Nesting is bounded: a deeply nested benign body terminates and is allowed.
{
  let deep = "echo hello";
  for (let i = 0; i < 12; i++) deep = `bash -c ${JSON.stringify(deep)}`;
  const t0 = Date.now();
  assert(broadcastKillVerdictOf(deep) === undefined, "8: a deeply nested benign body is allowed");
  assert(Date.now() - t0 < 2000, "8: and judged quickly");
}

process.exit(exit);
