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
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  hasMutatingFlag,
  rawUpdateCarriesMutatingFlag,
  strayRefusedVerb,
} from "./memory-write-flags.ts";
import {
  SEGMENT_SEPARATOR,
  WORD_SEPARATOR,
  collapsedToken,
  deQuoteKeepingQuotedRuns,
  isBinaryToken,
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
  // finding 3, and the quoted VERBS below, need a second pass: `"--status" active`
  // and `"delete" 42` each leave nothing behind, and clap still sees them.
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
      if (verb !== "update" && collapsedVerb !== "update") {
        // Neither reading of the verb slot is `update`, so this invocation carries
        // no mutating flag to look for: the stray scan is all it can contribute.
        // Both readings are tested because `verb` is what the quote-STRIPPED
        // skeleton sees and `collapsedVerb` is what clap gets: `vipune upd""ate 1
        // --status active` has an empty string in the skeleton slot — so a
        // skeleton-only comparison skipped the flag branch entirely and the real
        // `--status` write ran — while the bare `vipune update 12 && cp --status x`
        // case still depends on `verb` being the exact word.
        //
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
  // Second pass over the command's raw text, scanned BEFORE bash's quote removal
  // deleted the flag names. Same segment discipline, and the clause still has to
  // name `vipune` and a verb as separate WORDS, so a memory body cannot forge it:
  // `vipune add 'note: --status is a flag on update' --memory-type fact` is
  // refused anyway by the primary pass for its real flag, and
  // `vipune add 'say update --status please'` is not — the quoted body is one word
  // here, never a `vipune`-then-`update` pair.
  //
  // The hole the skeleton pass cannot see, and the reason this pass exists at
  // all: `stripQuotedSegments` deletes a quoted run while leaving its delimiters
  // in place, so `vipune "delete" 42` reduces to `vipune  42` — no verb in
  // existence — and the whole store walked out of the machine (`vipune "export"
  // rows.jsonl` was verified to export it). Quote removal is the one operation
  // that turns a quoted word back into an argument clap dispatches on, so the scan
  // that must see a verb is the one that runs on the raw text. Every quoted form
  // the lens named is refused here: `vipune "delete" 42`, `vipune 'delete' 42`,
  // `vipune "export" rows.jsonl`, `vipune "prune"`, `vipune "mcp"`, and the quoted
  // verb of a second invocation in `vipune search q vipune "delete" 1`.
  //
  // The scan runs on the RAW cut — the one rendering in which quoting still
  // means anything — and qualifies every verb it reads with `singleWordQuoted`: a
  // token the agent wrapped in quotes as ONE word is an argument clap dispatches
  // on; a run of quoted words is prose. The obvious implementation, de-quoting the
  // command and rescanning it, was tried first and is wrong in the direction that
  // costs the most: `deQuoteKeepingQuotedRuns` removes the quote characters and
  // leaves the spaces inside the run, so
  // `vipune add 'vipune delete is denied to every role'` comes back as a run of
  // bare words, a scan finds a second binary token, and the predicate refuses the
  // driver's own kind of write. Quoting is the only thing that made that body
  // inert, so quoting is what this scan reads.
  //
  // The classifier is a property of the TOKEN rather than a span over a rendering
  // of the command, and that is not a style preference: `vipune add 'vipune delete
  // is denied'` splits to `vipune`, `add`, `'vipune`, `delete`, …, so a scan that
  // matched a binary token and then tested the token after it for quoting refused
  // it — the opening quote was on the token BEFORE the word it was classifying.
  // `quotedTokenSpans` answers "does any quoted run cover any byte of this word",
  // which is the question the raw text can actually answer.
  if (command.indexOf("vipune") >= 0) {
    // Segment on the RAW command: a quoted run is one argument to bash, so an
    // operator inside quotes cannot delimit a clause and must not split one here
    // either. De-quoting first would let a `;` inside a memory body cut the clause
    // in half and re-arrange which words look like a command.
    for (const cut of command.split(SEGMENT_SEPARATOR)) {
      if (cut.indexOf("vipune") < 0) continue;
      if (rawUpdateCarriesMutatingFlag(deQuoteKeepingQuotedRuns(cut))) return "update <flag>";
      // `verbsIn` itself decides where the binary and the verb are, on the raw
      // text — the same parser the primary pass uses, so the two cannot disagree
      // about a token's position or about what an option consumed.
      const { tokens, hits } = verbsIn(cut);
      const collapsed = tokens.map(collapsedToken);
      const consumed = consumedValueIndices(hits, tokens);
      const { quoted, quotedSingle } = quotedTokenSpans(cut);
      // The verb slot, read where the primary pass cannot read it. Two rules, both
      // load-bearing, and both about QUOTING — which is the only thing bash's word
      // splitting honours and the only thing every other rendering of this command
      // destroys:
      //
      //   - the word after the binary must be a quoted run of exactly ONE word, so
      //     `vipune "delete" 42` is refused and a memory body is not;
      //   - the binary token itself must NOT have come out of a quoted run: the raw
      //     split gives `vipune add 'vipune delete is denied'` the token `'vipune`
      //     followed by `delete`, a shape that reads as a second invocation and is
      //     nothing of the kind. A quoted binary is a word inside someone's sentence.
      //
      // `quotedSingle` is the only thing in this whole pass that may NAME a verb.
      // Every other name the verb could be reached by is disabled here on purpose:
      // `verbsIn`'s hits and `strayRefusedVerb` both read tokens the skeleton pass
      // had already made inert, and on the raw text those tokens are the words of a
      // quoted body — `vipune add "gotchas: vipune prune demotes candidates"` hands
      // `strayRefusedVerb` a bare `vipune` at one index and a bare `prune` at the
      // next, which is exactly the pair it exists to catch and exactly the row the
      // driver writes. Bare verbs in command position are the PRIMARY pass's
      // business; it reads the skeleton, where a quoted body is empty and cannot
      // produce that pair at all. This pass exists for the one shape the skeleton
      // erases, and it must read nothing else.
      for (let k = 0; k < tokens.length; k++) {
        if (consumed.has(k) || quoted.has(k) || !isBinaryToken(tokens[k] ?? "")) {
          continue;
        }
        // The verb may be one slot further along than `verbsIn` places it. That
        // scan reads the verb slot off the quote-STRIPPED skeleton, so a quoted
        // option (`vipune "--json" delete 42`) leaves an empty slot it does not
        // count, and every slot after it sits one place to the left of the word
        // clap actually dispatched. Stepping forward over the options clap would
        // have consumed is the read that matches the binary; it is bounded to
        // option-shaped tokens, so it can never walk off the end or past the verb.
        let vSlot = k + 1;
        while (vSlot < tokens.length && collapsed[vSlot]?.startsWith("-")) vSlot++;
        const v = collapsed[vSlot] ?? "";
        if (REFUSED_VIPUNE_VERBS.includes(v) && quotedSingle.has(vSlot)) {
          return v;
        }
        k = vSlot; // the verb slot is this invocation's own argument
      }
    }
  }
  return undefined;
}

/**
 * Token indices an option consumed as its VALUE, for one clause's token list.
 *
 * A value slot is data, never a verb — `vipune search --filter delete` names
 * `delete` as a flag's argument, not as a command — so both the verb scan and
 * `singleWordQuoted` consult this set rather than each keeping its own idea of
 * what an option swallowed. The skip follows the arity table `verbsIn` used to
 * place the verb in the first place; two tables would be two chances to disagree.
 */
function consumedValueIndices(
  hits: readonly (readonly [number, string, readonly string[], string])[],
  tokens: readonly string[],
): Set<number> {
  const consumed = new Set<number>();
  for (const [i] of hits) {
    let k = i + 1;
    while (k < tokens.length) {
      const arity = optionArity(tokens[k] ?? "");
      if (arity === undefined) break;
      for (let v = k + 1; v <= k + arity; v++) consumed.add(v);
      k += 1 + arity;
    }
  }
  return consumed;
}

/**
 * Which tokens of `cut` came out of a quoted run, and which of those are a run of
 * exactly ONE word. Indices are in `verbsIn`'s space, so they index `tokens`
 * directly.
 *
 * The RAW text is the only rendering where the distinction still exists, and both
 * of the others destroy it in the direction that costs a canary class:
 *
 *   - `stripQuotedSegments` deletes a quoted run outright, which is why the primary
 *     pass never sees `vipune "delete" 42` at all and the whole store exported;
 *   - `deQuoteKeepingQuotedRuns` removes the quote characters and LEAVES the spaces
 *     inside the run, so a scan over it cannot tell `vipune "delete" 42` from the
 *     seven words of `vipune add 'vipune delete is denied to every role'` —
 *     measured, a scan over that text refused the driver's own kind of write three
 *     ways at once.
 *
 * `quoted` is the wider set and `quotedSingle` the narrower one, and the caller
 * needs both: the wider one disqualifies a quoted binary token
 * (`'vipune` in `vipune add 'vipune delete is denied'`, which the raw split puts
 * next to `delete`), and the narrower one is the only thing that qualifies a verb.
 *
 * A run that opens mid-token (`de""lete`, `vipune'delete'`) is punctuation inside
 * someone else's word, so it marks nothing — that shape is the collapsed-verb
 * scan's business, not this one's.
 *
 * An unterminated quote marks nothing: the command is malformed,
 * `deQuoteKeepingQuotedRuns` leaves it as typed, and a classifier that guessed
 * where the quote ended would be inventing a boundary the agent never wrote.
 */
function quotedTokenSpans(cut: string): {
  quoted: Set<number>;
  quotedSingle: Set<number>;
} {
  const quoted = new Set<number>();
  const quotedSingle = new Set<number>();
  const n = cut.length;
  let i = 0;
  // The walk mirrors `verbsIn`'s own split — `tokenize` splits the RAW text on
  // `\s` (quotes included) and drops empties — so `tok` here indexes the same token
  // `tokens` does there. Two independent tokenisers over one command is how a guard
  // starts refusing the wrong word.
  let tok = -1;
  let opened = false; // has the current token emitted a character yet?
  while (i < n) {
    const ch = cut[i];
    if (ch === undefined) break;
    if (ch !== "'" && ch !== '"') {
      if (/\s/.test(ch)) opened = false;
      else if (!opened) {
        tok++;
        opened = true;
      }
      i++;
      continue;
    }
    const opensToken = !opened;
    if (opensToken) {
      tok++;
      opened = true;
    }
    const quote = ch;
    i++;
    let closed = false;
    let words = 0;
    let wordOpen = false;
    while (i < n) {
      const c = cut[i];
      if (c === undefined) break;
      if (c === quote) {
        closed = true;
        i++;
        break;
      }
      if (quote === '"' && c === "\\" && i + 1 < n) {
        // An escaped character inside double quotes is data and cannot close the
        // run — the same reading `deQuoteKeepingQuotedRuns` gives it.
        if (!wordOpen) words++;
        wordOpen = true;
        i += 2;
        continue;
      }
      if (/\s/.test(c)) {
        // Literal to bash — the run is still ONE argument — but the tokeniser splits
        // here, so each piece is its own token, and each of them came out of the run.
        while (i < n && /\s/.test(cut[i] ?? "")) i++;
        opened = false;
        wordOpen = false;
        continue;
      }
      if (!wordOpen) words++;
      wordOpen = true;
      i++;
    }
    if (!closed) return { quoted: new Set(), quotedSingle: new Set() };
    if (!opensToken) continue; // mid-token punctuation is not a quoted word
    // Mark every token this run produced, and only the single-word runs qualify as
    // a verb slot. The pieces after an interior space belong to the run's first
    // token index plus one each, which is what the raw split did to them.
    for (let w = 0; w < words; w++) quoted.add(tok + w);
    if (words === 1) quotedSingle.add(tok);
  }
  return { quoted, quotedSingle };
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
    // The narrowing is Pi's own type guard rather than a `toolName` comparison:
    // `CustomToolCallEvent.toolName` is `string`, which overlaps every literal, so
    // a bare comparison does not narrow `input` and the read below would need a
    // cast. A cast is what this handler must not carry — see the catch.
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command ?? "";
    // Fail CLOSED on a parse fault. Every path here is a string match on
    // untrusted input, and a throw that escaped the handler would be swallowed by
    // the event emitter the same way a blocked command's `undefined` return is —
    // the command would run. A guard whose failure mode is "the thing it guards"
    // is not a guard, so an unexpected throw is reported and refused, exactly as
    // merge-guard's analyse catches return `block(...)` rather than rethrowing.
    // The reason names the fault and its length, never the command: a memory body
    // can be anything the agent typed.
    let refused: string | undefined;
    try {
      refused = refusesMemoryWrite(command);
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      traceWarn(`memory-write-guard: parse fault — blocking by default (${detail.slice(0, 120)})`);
      return {
        block: true,
        reason: `Memory-write guard could not analyse this command (${detail.slice(0, 120)}) — refusing. Split or simplify the command; if you genuinely need a refused vipune verb, an operator runs it in a terminal or sets PI_ENSEMBLE_ALLOW_MEMORY_WRITES=1.`,
      };
    }
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
