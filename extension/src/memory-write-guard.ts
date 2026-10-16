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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMMAND_WRAPPERS, stripQuotedSegments } from "./bash-command-parser.ts";
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

/**
 * Flags that change an existing row. `update` alone is inert (it requires at
 * least one of these to do anything), so the clause that tests them binds to
 * the `update` verb first.
 *
 * Measured against vipune 0.15.0 — `vipune update <id> --stat active` answers
 * `error: unexpected argument '--stat' found` — clap does **not** accept an
 * abbreviated long flag. `--stat`, `--imp`, `--mem-t` and `--memorytyp=fact`
 * therefore mutate nothing, and are deliberately NOT matched: refusing a command
 * the binary rejects outright would report a threat that does not exist, and the
 * module header, `docs/troubleshooting.md` and `skill/vipune/SKILL.md` say exact
 * names and `=` forms for the same reason.
 *
 * Clustered short flags are the opposite case and ARE accepted by the binary:
 * measured, `vipune update <id> -tm` reaches the database and rewrites the row
 * with content `m`, because `t` consumes `m` as `--text`'s value. A cluster
 * member can mutate a row invisibly, so clusters are scanned character by
 * character in `hasMutatingFlag` below.
 *
 * The same flag names exist on `add` (`-m`, `--memory-type`, `--status`,
 * `--importance`), which is exactly why they must bind to `update` — a
 * verb-blind flag scan refuses every driver write.
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

// What counts as a `vipune` invocation, and where the scan may start.
//
// The scan walks TOKENS, not one monolithic regex, because the two things that
// make this predicate correct cannot both live in a pattern: a token-level check
// can ask "is this token the binary, and was the previous token a command-position
// starter?" without either question distorting the other. An earlier single-regex
// version failed both ways — a greedy option-skip group captured `42` as the verb
// of `vipune --json delete 42`, and its lazy counterpart captured `--json`.
//
// Command-position starters are the sibling guards' set (`discardsUncommittedWork`
// and `createsIssue` scan after `[;&|\n]`) plus `(`, `!` and the compound keywords
// bash puts before a command. The keywords are matched as WHOLE tokens — `then`,
// never a `then` inside `todo` — which the token walk gives us for free and a
// `\b`-anchored pattern does not (`_` is a word character, so `\b` cannot
// separate `memory__` from `vipune` either).
const COMMAND_POSITION_STARTERS: readonly string[] = [
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "for",
  "case",
  "&&",
  "||",
  "|||",
];

// Openers that attach to the token that follows them with no space, so they are
// stripped from the front of a token before the binary test (`(vipune delete 42)`).
const TOKEN_OPENERS = /^[(!]+/;

// Between the starter and the binary: process wrappers and KEY=value env
// assignments (`env FOO=1 vipune …`, `VIPUNE_DEBUG=1 vipune …`, `timeout 30
// vipune …`, `nice -n 5 vipune …`). The wrapper words are the ONE list in
// bash-command-parser.ts (`COMMAND_WRAPPERS`), so this guard and the prefix
// extractor cannot drift into disagreeing about what a wrapper is.
//
// A wrapper consumes its own positional arguments (`timeout 30`, `nice -n 5`,
// `env FOO=1`) — the token after a wrapper is ITS argument, not the command — so
// the scan stays in command position across them. That is what `env FOO=1 vipune
// delete 42` and `timeout 30 vipune delete 42` depend on: the wrapper rule is the
// ONLY difference between those two and `echo x vipune delete 42`, which is
// correctly not refused.
function isWrapperToken(token: string): boolean {
  return COMMAND_WRAPPERS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

// Is this token the vipune binary? Bare `vipune`, `oo vipune` (the allowlist's
// wrapper verb, handled by the wrapper loop), or a path whose FINAL segment is
// `vipune` (`/usr/local/bin/vipune`, `~/bin/vipune`, `./vipune`). The path form
// requires a `/`, which — together with the whole-token comparison — is what keeps
// `mcp__codebase_memory__vipune` unmatchable: it is one token, it is not equal to
// `vipune`, and it carries no `/`.
// Matched against a WHOLE token. `mcp__codebase_memory__vipune` is one token, is
// not equal to `vipune`, and carries no `/`, so no branch reaches it — which is
// what the leading `(?:^|…)` on the token level buys and a `\b` pattern could not.
const BINARY_TOKEN = /^(?:[^\s;&|()<>]*\/)vipune$|^vipune$/;

// Global options `vipune` accepts before the verb, with how many SEPARATE-TOKEN
// values each requires — transcribed from `vipune --help`'s `Options:` block, and
// that is the whole table on purpose: this is not a clap grammar, it is the four
// lines the binary prints. `test-memory-write-guard.ts` re-reads the help block
// and fails if the table and the binary disagree about which take a value.
//
// The arity is what makes the verb findable. Without a stopping rule, `vipune -p
// other delete 42` and `vipune --db-path X delete 42` each leave a bare word
// between the flag and the verb: a scan that keeps going reads past `delete`, a
// scan that stops reads `-p` as the verb. clap decides — `vipune -p` alone answers
// `error: a value is required for '--project <PROJECT>'`, `vipune --json` alone
// proceeds to "requires a subcommand" — so a `<VALUE>` option consumes one token
// and a bare flag consumes none.
const GLOBAL_OPTIONS: readonly { readonly flags: readonly string[]; readonly values: number }[] = [
  { flags: ["--json"], values: 0 },
  { flags: ["-h", "--help"], values: 0 },
  { flags: ["-V", "--version"], values: 0 },
  { flags: ["-p", "--project"], values: 1 },
  { flags: ["--db-path"], values: 1 },
];

/**
 * How many following tokens this option token consumes as its values.
 *
 * `undefined` means "not an option" — that is where the skip stops and the verb
 * begins. An UNKNOWN `-f` flag returns its arity as 0 rather than `undefined`,
 * which is the fail-toward-refusing direction the PM asked for: consuming nothing
 * means the next token is read as the verb, so a `vipune --verbose delete 42`
 * still reports `delete`, while a `vipune search --whatever foo` cannot have a
 * refused verb conjured out of a granted one (the verb still has to literally
 * appear, and it has to be one of the refused names).
 */
function optionArity(token: string): number | undefined {
  if (token.length < 2 || token[0] !== "-") return undefined;
  if (token.includes("=")) return 0; // `--flag=value` carries its own value
  for (const spec of GLOBAL_OPTIONS) {
    if (spec.flags.includes(token)) return spec.values;
  }
  return 0;
}

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
  // `vipune delete` is not refused.
  const c = stripQuotedSegments(command);
  // Segment by segment: a verb or flag cannot be borrowed across a shell operator,
  // so `vipune update 12 && cp --status x` is not a mutating update and
  // `vipune search 'x'; vipune delete 42` still refuses the second half.
  for (const segment of c.split(/[;&|\n]/)) {
    const { tokens, hits } = verbsIn(segment);
    for (const [i, verb] of hits) {
      if (REFUSED_VIPUNE_VERBS.includes(verb)) return verb;
      if (verb === "update" && hasMutatingFlag(tokens.slice(i + 1))) return "update <flag>";
    }
  }
  return undefined;
}

// Every (tokenIndex, verb) pair in one `;`/`&&`-delimited segment: each position
// where a vipune binary token appears in command position, paired with the verb
// that follows it. Returns the segment's token list too, because the update-flag
// check has to read the same list the scan produced — a single shared mutable
// would let the two halves disagree whenever a segment is scanned between the
// call and the check, so the pair travels together.
function verbsIn(segment: string): { tokens: string[]; hits: [number, string][] } {
  const tokens = segment.split(/[ \t]+/).filter((t) => t !== "");
  const hits: [number, string][] = [];
  // `inPosition` is true at the start of a segment (a `;`-delimited clause begins
  // in command position) and after any starter token; any other token that is not
  // the binary clears it, because after `cp foo` the next word is an argument.
  let inPosition = true;
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i] ?? "";
    // `(vipune`, `!vipune`: openers attach with no space, so they are stripped
    // before the whole-token comparisons.
    const token = raw.replace(TOKEN_OPENERS, "");
    if (token === "") continue;
    if (COMMAND_POSITION_STARTERS.includes(token) || isOperatorStarter(raw)) {
      inPosition = true;
      continue;
    }
    if (isWrapperToken(token)) {
      // `timeout 30`, `nice -n 5`, `env FOO=1`: consume the wrapper's own
      // arguments, but a NON-wrapper token after a wrapper may be the command
      // itself (`nohup vipune …`, `exec vipune …`), so only a KEY=value token or
      // a `-flag`/`-n` option is swallowed. Anything else leaves command position
      // set for the next token, which is what `nohup vipune delete 42` and the
      // bare-wrapper shapes depend on.
      let k = i + 1;
      while (k < tokens.length) {
        const next = (tokens[k] ?? "").replace(TOKEN_OPENERS, "");
        if (next === "-n") {
          k += 2; // `nice -n 5` — the value after the option
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) {
          k++; // `env FOO=1` / `VIPUNE_DEBUG=1`
          continue;
        }
        if (/^\d+[smhd]?$/.test(next)) {
          k++; // `timeout 30`, `timeout 30s` — a duration, never a command
          continue;
        }
        break;
      }
      i = k - 1;
      continue;
    }
    // `oo` is the allowlist's wrapper verb and transparent: `oo vipune delete 42`
    // is the same invocation as `vipune delete 42`, so `oo` neither is the binary
    // nor ends command position.
    if (token === "oo") continue;
    const binary = BINARY_TOKEN.exec(token);
    if (binary === null) {
      inPosition = false;
      continue;
    }
    if (!inPosition) continue;
    // Skip this invocation's leading global options and their required values;
    // the next token is the verb.
    let j = i + 1;
    while (j < tokens.length) {
      const arity = optionArity(tokens[j] ?? "");
      if (arity === undefined) break;
      j += 1 + arity;
    }
    hits.push([j, tokens[j] ?? ""]);
    // Everything after the binary in this clause is an argument, so a second
    // `vipune` later in the clause is an argument word, not a command.
    inPosition = false;
  }
  return { tokens, hits };
}

// An operator glued to the front of a token (`&&vipune`, `(vipune`) is still a
// starter — `;` and `&&` were already split away above, but `(` and `!` attach.
function isOperatorStarter(token: string): boolean {
  return token === "(" || token === "!" || token.startsWith("&&") || token.startsWith("||");
}

// True when the arguments following `vipune update` carry a row-mutating flag,
// in whole (`--status active`) or `=` (`--status=active`) form, or as a member
// of a clustered short flag (`-tm`). Tokens arrive already split and already cut
// at the next shell operator, so a chained command cannot borrow a flag from a
// different invocation — `vipune update 12 && cp --status x` is not a mutating
// update.
//
// Matching on TOKENS, not on a `(^|\s)flag(\s|=)` regex: the common `&&` chain
// (`vipune update 12 -t x && git add -A`) leaves trailing `&` characters where a
// regex anchored on a whitespace-or-`=` boundary would MISS the exact shape the
// guard exists for. A memory body cannot forge either form, because quoted
// segments are stripped before this runs.
//
// No long-flag prefix matching: measured on vipune 0.15.0, clap rejects every
// abbreviation (`--stat`, `--imp`, `--mem-t`, `--memorytyp=fact` → `unexpected
// argument`), so a prefix that merely LOOKS like `--status` mutates nothing.
function hasMutatingFlag(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    const name = token.split("=")[0] ?? "";
    if (MUTATING_UPDATE_FLAGS.includes(name)) return true;
    // Clustered short flags: every character is tested, not just the first.
    // Measured on 0.15.0, each of these reaches the database and rewrites the
    // row — `-tm` stores content `m` (t consumes m as --text's value), `-mt`
    // errors on --metadata's missing value, `-ta`/`-at`/`-xm` likewise mutate.
    // A cluster member is therefore a mutating flag even when the token's first
    // character is not one, which is the whole reason for the inner loop.
    //
    // `=` is not a boundary: `-t=x` is accepted and stores `x` (measured), so
    // `=` introduces no new flag but must not stop the scan either — stopping at
    // it would make `-xm=1` read as a harmless `x`.
    if (name.length > 2 && name.startsWith("-") && !name.startsWith("--")) {
      for (let i = 1; i < name.length; i++) {
        const ch = name[i];
        if (ch === "=") continue;
        for (const flag of MUTATING_UPDATE_FLAGS) {
          if (flag.length === 2 && flag.startsWith("-") && flag[1] === ch) return true;
        }
      }
    }
  }
  return false;
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
