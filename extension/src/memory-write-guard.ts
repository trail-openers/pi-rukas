/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses the
 * vipune verbs no role is granted (#1437).
 *
 * The gap: `isDestructiveMemoryWrite` (bash-pattern-wildcard.ts) matched only
 * `vipune update` carrying `-t`/`--text`, and its single caller is
 * `matchBashSubcommand` — reached from the permission layers, which trust mode
 * (the interactive default) and sandbox mode (the container default) both skip,
 * and from `pm-bash-guard.ts`, which is parent-PM only. A trust- or sandbox-mode
 * subagent therefore had NO memory-write refusal at all: `vipune delete <id>`
 * reached the binary, and the verb is irreversible with no confirmation flag.
 * Doctrine said "denied to every role"; in the mode that is the default, nothing
 * enforced it.
 *
 * The fix follows `registerDestructiveGitGuard` / `registerIssueCreationGuard`:
 * a `tool_call` hook registered inside `registerModeIndependentGuards`
 * (subagent-guard-guards.ts), which the child-guards companion loads into every
 * child in every mode. Predicates live in this module — not in
 * `matchBashSubcommand` — because the prefix matcher's `vipune *` catch-all
 * resolves an ungranted verb to "allow" before any extra refusal could run
 * ahead of it, and the matcher is skipped outright in trust/sandbox mode.
 *
 * What is refused, and why it is that set: every verb `vipune --help` lists
 * MINUS every verb `agents.json` grants (`search`, `validate`, `add`, `get`,
 * `list`, `doctor`, `version`) — so `delete`, `prune`, `promote`, `export`,
 * `backup`, `import`, `reindex`, `project`, `mcp` — plus `update` carrying any
 * flag that mutates a row (`-t`/`--text`, `-m`/`--metadata`, `--memory-type`,
 * `--status`, `--importance`; prefix and `=` forms). `test-vipune-argv.ts`
 * asserts both equations against the installed binary and `agents.json`, so a
 * future grant of a refused verb fails the gate instead of silently
 * contradicting the refusal here.
 *
 * `vipune hook` is deliberately NOT refused, while the rest of the set is. It is
 * the agent-lifecycle hook handler (vipune issue #191): the binary invokes it
 * FROM a hook, and refusing it from inside the child that calls it is a refusal
 * of plumbing, not of a memory write. `test-memory-write-guard.ts` pins the
 * exclusion so the two lists cannot quietly reconverge.
 *
 * `vipune add` must never be refused: the driver writes memory through
 * `vipuneAdd` (vipune.ts) and `memory-write.ts` / `guard-memory-write.ts` pass
 * `--memory-type` and `--status` on the ADD verb. That is why the mutating-flag
 * clause binds to `update` first — a predicate that scanned for flags without
 * binding them to a verb would break every driver write and the develop brief.
 *
 * ADVISORY, not a security boundary — the same honest framing as
 * `review-accept-guard.ts`. Every rule is a string match on the quote-stripped
 * command. An agent determined to bypass it can write its own argv or call the
 * binary through another route; this stops an agent that is not trying to
 * bypass it, and it closes the accidental case (an agent following an outdated
 * prompt) that trust mode used to leave wide open.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripQuotedSegments } from "./bash-command-parser.ts";
import { trace } from "./trace.ts";

/** Opt-out for an operator who genuinely needs an ungranted verb from an agent. */
function memoryWritesAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_MEMORY_WRITES === "1";
}

/**
 * Verbs `vipune --help` lists that no role is granted. The authoritative list
 * lives here; `test-memory-write-guard.ts` cross-checks it against
 * `vipune --help` minus the `agents.json` grants, and against the exemption
 * below.
 */
export const REFUSED_VIPUNE_VERBS: readonly string[] = [
  "delete",
  "prune",
  "promote",
  "export",
  "backup",
  "import",
  "reindex",
  "project",
  "mcp",
];

/**
 * `vipune hook` — excluded from the refused set on purpose. See the module
 * header: it is the lifecycle-hook handler the binary itself runs from a hook.
 */
export const EXEMPT_VIPUNE_VERBS: readonly string[] = ["hook"];

/**
 * Flags that change an existing row. `update` alone is inert (it requires at
 * least one of these to do anything), so the clause that tests them binds to
 * the `update` verb first.
 */
const MUTATING_UPDATE_FLAGS: readonly string[] = [
  "-t",
  "--text",
  "-m",
  "--metadata",
  "--memory-type",
  "--status",
  "--importance",
];

// `vipune` in command position: at the start of the string, or after a shell
// operator, with the optional `oo ` wrapper the allowlist grants carry. The
// leading group is an ANCHOR, not `\b` — `\b` would also match inside
// `mcp__codebase_memory__vipune`, which is not a vipune invocation.
const VIPUNE_AT = String.raw`(?:^|(?<=[;&|\n]))\s*(?:oo\s+)?vipune\s+(\w+)`;

/** The refused invocation when this command runs an ungranted vipune verb. */
export function refusesMemoryWrite(command: string): string | undefined {
  // Quoted segments are stripped first — scan-not-anchor, exactly like
  // discardsUncommittedWork / createsIssue — so a memory body that merely
  // MENTIONS `vipune delete` is not refused.
  const c = stripQuotedSegments(command);
  const re = new RegExp(VIPUNE_AT, "g");
  for (let m = re.exec(c); m !== null; m = re.exec(c)) {
    const verb = m[1] ?? "";
    const rest = c.slice((m.index ?? 0) + m[0].length);
    if (REFUSED_VIPUNE_VERBS.includes(verb)) return m[0].trim();
    if (verb === "update" && hasMutatingFlag(rest)) return m[0].trim();
  }
  return undefined;
}

/**
 * The old rule (`vipune update` carrying `-t`/`--text`) widened to every
 * row-mutating flag. Kept as a delegating export so the permission-layer
 * caller (`matchBashSubcommand`) keeps its original semantics — this refusal
 * is a superset of it, never a narrowing.
 */
export function isDestructiveMemoryWrite(command: string): boolean {
  return refusesMemoryWrite(command) !== undefined;
}

// True when the argument span following `vipune update` carries a row-mutating
// flag, in prefix (`--status active`) or `=` (`--status=active`) form. The span
// stops at the next shell operator, so a chained command cannot borrow a flag
// from a different invocation — `vipune update 12 && cp --status x` is not a
// mutating update.
//
// Matching on TOKENS, not on a `(^|\s)flag(\s|=)` regex: the argument span
// reaches the next `&`, so the common `&&` chain (`vipune update 12 -t x && git
// add -A`) leaves trailing `& ` characters on the span, and a regex anchored on
// a whitespace-or-`=` boundary would MISS the exact shape the guard exists for.
// A flag is one whole whitespace-delimited token, or one whose `=` separates it
// from its value; a memory body cannot forge either, because quoted segments are
// stripped before this runs.
function hasMutatingFlag(rest: string): boolean {
  const span = rest.split(/[;&|\n]/)[0] ?? "";
  const tokens = span.split(/\s+/).filter((t) => t !== "");
  for (const token of tokens) {
    const name = token.split("=")[0] ?? "";
    if (MUTATING_UPDATE_FLAGS.includes(name)) return true;
  }
  return false;
}

export function registerMemoryWriteGuard(pi: ExtensionAPI): void {
  if (memoryWritesAllowed()) {
    trace(
      "memory-write-guard: PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1 — ungranted vipune verbs permitted",
    );
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    const refused = refusesMemoryWrite(command);
    if (!refused) return;
    trace(`memory-write-guard: BLOCKED memory write (mode-independent) — ${refused}`);
    return {
      block: true,
      reason: `Memory writes are gated. \`${refused}\` is a vipune verb no role is granted — an operator runs it in a terminal. Correct a memory with \`vipune add '<new>' --supersedes <id> --memory-type <type>\`, which preserves the original row and stays auditable; never \`vipune update\` (it replaces content in place under the same id, so every prior citation silently points at new text) and never \`vipune delete\` (irreversible, no confirmation). To promote or prune candidates, ask the operator — /audit lists candidates with their ids for that decision. If you genuinely need this verb, the operator can set PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1.`,
    };
  });
}
