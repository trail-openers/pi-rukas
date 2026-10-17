/**
 * memory-write-cli-surface — the `vipune` binary's own vocabulary, as the memory
 * write guard has to read it: which flags actually change a row, and which global
 * options consume a value before the verb.
 *
 * Split out of `memory-write-tokenizer.ts` at the seam the file-size cap made
 * visible: the tokenizer is about SHELL position (where a command may begin, what a
 * wrapper consumed), and this module is about the TARGET BINARY (what `vipune` does
 * with the words it is given). Neither knows the other's rules. A change to vipune's
 * `--help` output belongs here and touches nothing in the tokenizer; a change to how
 * bash tokenises belongs there and touches nothing here.
 *
 * Everything below is measured against the binary, not inferred from a grammar —
 * `test-memory-write-guard-arity.ts` re-reads `vipune --help` and fails if this
 * table and the binary disagree about which option takes a value, which is what
 * keeps a hand-transcribed list from quietly rotting.
 */

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
export const MUTATING_UPDATE_FLAGS: readonly string[] = [
  "-t",
  "--text",
  "-m",
  "--metadata",
  "--memory-type",
  "--status",
  "--importance",
];
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
type GlobalOption = { readonly flags: readonly string[]; readonly values: number };

export const GLOBAL_OPTIONS: readonly GlobalOption[] = [
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
export function optionArity(token: string): number | undefined {
  if (token.length < 2 || token[0] !== "-") return undefined;
  if (token.includes("=")) return 0; // `--flag=value` carries its own value
  for (const spec of GLOBAL_OPTIONS) {
    if (spec.flags.includes(token)) return spec.values;
  }
  return 0;
}

// The tokeniser splits on the WHOLE whitespace class, not `[ \t]`: bash separates
