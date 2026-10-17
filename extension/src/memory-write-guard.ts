/**
 * memory-write-guard — the mode-independent `tool_call` hook that refuses the
 * vipune verbs no role is granted (#1437).
 *
 * The gap: the old `isDestructiveMemoryWrite` predicate (since removed; it lived
 * in `bash-pattern-wildcard.ts` and is renamed here) matched only
 * `vipune update` carrying `-t`/`--text`, and its single caller was
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
 * flag that mutates a row. `test-vipune-argv.ts` asserts both equations against
 * the installed binary and `agents.json`, so a future grant of a refused verb
 * fails the gate instead of silently contradicting the refusal here.
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
 *
 * Out of scope by the same reasoning, and deliberately not attempted here:
 * re-scanning the payload of `sh -c '…'`, `eval '…'` or `$(…)` for a nested
 * vipune invocation, and memory writes made through a NON-bash tool (a
 * `write`/`edit` of a script that shells out to vipune, or an MCP tool that
 * calls the binary directly). Both are string- or tool-level problems the guard
 * would meet with more parsing than an advisory fence justifies; `command -v`,
 * `alias` and `xargs` are the other documented holes. An operator who needs a
 * hard boundary uses `agents.json` grants plus a confined sandbox, not this
 * hook. Refusal text names the VERB only, so a memory body — which can be
 * anything the agent typed — never reappears in the reason handed back to it.
 *
 * TWO further holes the six-pass review named and this guard deliberately does
 * NOT close, because both are granted verbs doing granted things — the guard's
 * question is "is this verb ungranted?", not "is this outcome one we like?", and
 * answering the second would make it a policy engine over the whole CLI:
 *
 *   - **Cross-project writes via a granted verb.** `vipune search 'x' -p
 *     other-project`, and the same `-p` on `add`, read and write a DIFFERENT
 *     project's store. `search` and `add` are granted, and `-p` is a legitimate
 *     global option the binary documents; refusing a project flag would refuse
 *     the feature. The `-p` value is not even the mutating part — `add` is.
 *   - **Promotion through `add`.** `vipune add '<copy>' --status active` creates
 *     a row already on the active tier, which is what `promote` — refused — does
 *     to an existing one. Refusing it would refuse the driver's own writes
 *     (`memory-write.ts` / `guard-memory-write.ts` pass `--status` on `add`), and
 *     the row it creates carries lineage a real `promote` does not.
 *
 * Both are the operator's `agents.json` and sandbox to decide, and both are
 * stated here so a future reader finds the decision rather than rediscovering it
 * as a bug.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  hasMutatingFlag,
  rawUpdateCarriesMutatingFlag,
  strayRefusedVerb,
} from "./memory-write-flags.ts";
import {
  SEGMENT_SEPARATOR,
  collapsedToken,
  deQuoteKeepingQuotedRuns,
  optionArity,
  stripQuotedCommand,
  verbsIn,
} from "./memory-write-tokenizer.ts";
import { traceWarn } from "./trace.ts";

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

/** The refused verb when this command runs an ungranted vipune command. */
export function refusesMemoryWrite(command: string): string | undefined {
  // The cheap gate first: almost no bash call mentions vipune at all, and the
  // lenses measured a 35x gap on large commands between this one `indexOf` and the
  // stripping and tokenising below. A string with no `vipune` substring cannot
  // contain a vipune invocation, and `indexOf` is a substring test, so
  // `mcp__codebase_memory__vipune` still reaches the whole-token comparison that
  // rejects it.
  if (command.indexOf("vipune") < 0) return undefined;
  // Quoted segments are stripped first — scan-not-anchor, exactly like
  // discardsUncommittedWork / createsIssue — so a memory body that merely MENTIONS
  // `vipune delete` is not refused. That stripping is also why the quoted flags in
  // finding 3 need a second pass: `"--status" active` leaves nothing behind, and
  // clap still sees `--status`.
  const c = stripQuotedCommand(command);
  // Segment by segment: a verb or flag cannot be borrowed across a shell operator,
  // so `vipune update 12 && cp --status x` is not a mutating update and
  // `vipune search 'x'; vipune delete 42` still refuses the second half.
  for (const segment of c.split(SEGMENT_SEPARATOR)) {
    const { tokens, hits } = verbsIn(segment);
    const collapsed = tokens.map(collapsedToken);
    for (const [i, verb, flags, collapsedVerb] of hits) {
      // The COLLAPSED verb, not `verb`: quote-split and backslash-escaped spellings
      // reach the binary as the real verb, and the stripped skeleton cannot see them.
      if (REFUSED_VIPUNE_VERBS.includes(collapsedVerb)) return collapsedVerb;
      // The tokens an option CONSUMED as its value, not the whole argument span:
      // `verbsIn` stops its scan at the first non-option, so `-p`'s value never
      // reaches `flags` and no other check can see it. `vipune update 12 -p export
      // x` therefore has `export` as `-p`'s VALUE and no scan names it — refused
      // anyway, conservative per PM, because a destructive verb handed to a
      // value-taking flag of a mutating verb is not a shape worth trusting.
      // `vipune update 12 -p other x` still runs: `other` is not a refused verb.
      // Scan the span the flag check already reads — same boundary, so the
      // `&&` chain in `vipune update 12 -p export && cp x` still cuts at `&&` and
      // `vipune update 12 && cp --status x` still does not borrow `--status`.
      for (const value of flags) {
        if (REFUSED_VIPUNE_VERBS.includes(value)) return value;
      }
      if (verb !== "update") {
        // Start the stray scan after this invocation's verb: a second command in
        // the same clause is the only thing it can legitimately find.
        const stray = strayRefusedVerb(tokens, collapsed, REFUSED_VIPUNE_VERBS, i + 1);
        if (stray !== undefined) return stray;
        continue;
      }
      // The quote-stripped tokens the verb scan saw catch the bare forms, and the
      // de-quoted span catches the three ways bash quote-removal hides a flag name
      // from a token test (`"--status" active`, `--"status" active`,
      // `"--status active"`) — all three hand clap `--status`, so all three mutate
      // the row. The span is everything after the binary's own token.
      if (hasMutatingFlag(tokens.slice(i + 1)) || hasMutatingFlag(flags)) {
        return "update <flag>";
      }
    }
  }
  // Second pass on the de-quoted raw command, scanned BEFORE bash's quote removal
  // deleted the flag names. Same segment discipline, and the clause still has to
  // name `vipune` and an `update` verb as separate WORDS, so a memory body cannot
  // forge it: `vipune add 'note: --status is a flag on update' --memory-type fact`
  // is refused anyway by the primary pass for its real flag, and
  // `vipune add 'say update --status please'` is not — the quoted body is one word
  // here, never a `vipune`-then-`update` pair.
  const raw = deQuoteKeepingQuotedRuns(command);
  if (raw.indexOf("vipune") >= 0) {
    for (const segment of raw.split(SEGMENT_SEPARATOR)) {
      if (rawUpdateCarriesMutatingFlag(segment)) return "update <flag>";
    }
  }
  return undefined;
}

export function registerMemoryWriteGuard(pi: ExtensionAPI): void {
  if (memoryWritesAllowed()) {
    // traceWarn, not trace: the opt-out is an operator-visible decision that
    // removes a refusal, and it should be findable in a log read for "what did
    // we turn off", not filed at the same level as routine steps.
    traceWarn(
      "memory-write-guard: PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1 — ungranted vipune verbs permitted",
    );
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    const refused = refusesMemoryWrite(command);
    if (!refused) return;
    // traceWarn for the same reason: a refusal an agent then routes around is
    // the single most useful line in the log when a cycle did something it
    // should not have.
    traceWarn(`memory-write-guard: BLOCKED memory write (mode-independent) — verb \`${refused}\``);
    return {
      block: true,
      reason: `Memory writes are gated. The vipune verb \`${refused}\` is granted to no role — an operator runs it in a terminal. Correct a memory with \`vipune add '<new>' --supersedes <id> --memory-type <type>\`, which preserves the original row and stays auditable; never \`vipune update\` (it replaces content in place under the same id, so every prior citation silently points at new text) and never \`vipune delete\` (irreversible, no confirmation). To promote or prune candidates, ask the operator — /audit lists candidates with their ids for that decision. If you genuinely need this verb, the operator can set PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1.`,
    };
  });
}
