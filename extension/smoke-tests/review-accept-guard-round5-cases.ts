/**
 * #1764 fix round 5 — the exemption proof reads ONLY the text the shell receives.
 *
 * Rounds 3 and 4 both put the CRITICAL in the same place: the EXEMPTION proof trusted text
 * `withSameCommandAssignmentsApplied` had rewritten. The round-4 shape was
 * `F=.git/zz<store>; cat ${F//zz/}` — the old `\${?NAME}?` matcher matched `${F` WITHOUT its
 * closing brace, `expandWord` pasted the literal value in, the proof then saw an
 * expansion-free path the shell never produces, lifted the base floor, and bash printed the
 * store. The fix is structural: substitution feeds the store-NAME test alone (where it can
 * only ADD a refusal), and `commandFullyUnderstood`, `segmentUnderstood`, `operandWords`
 * and `patternIsProse` all run on the RAW command.
 *
 * Each row assembles its store path so clause (1) cannot fire — the raw text carries `.git/`
 * + `zz` + the name with the `zz` in the way, and only the expansion the guard cannot
 * evaluate would remove it — so a refusal here can only come from clause (5) admitting it
 * understood nothing. `$` is spelled `D` and the store's `r` as `r` so this SOURCE file
 * carries neither an expansion token the linters scan for nor the literal protected token;
 * at runtime both are the real characters.
 *
 * `ROUND5_ACCEPTED_COSTS` is the other side of the same rule and the reason it is a security
 * boundary rather than a narrowing: `F=notes.md; cat $F` resolves fine in bash, and the
 * guard used to read its own guess of that resolution as evidence. It no longer does.
 */

import type { ScopeClause } from "../src/review-accept-scope.ts";

export interface Round5Case {
  readonly c: string;
  readonly why: string;
  readonly clause: ScopeClause;
  /** Was the row refused at the frozen base too? `true` rows are monotonicity violations
   * the base already caught; `false` rows are ABSOLUTE under-refusals — base never asked
   * them, and the raw-text rule closes them on its own. */
  readonly atBase: boolean;
}

const D = String.fromCharCode(36);
const R = String.fromCharCode(114);
/** `.git/` + the store's name with `zz` spliced in: NOT the store (clause 1 stays silent),
 * and the text bash produces after `${F//zz/}` IS the store. */
const ASSEMBLED = `.git/zz${R}eview-findings.json`;

/**
 * The operator family. Each is a DIFFERENT bash operator the old optional-brace matcher
 * treated as a bare `$NAME` reference and substituted away: `//` global replace, `#` strip
 * prefix, `%` strip suffix, `:N` substring, `:-` default. The default operator is asked in
 * every binding spelling the shell accepts, because each of those resolved into an
 * expansion-free operand under the substituted view.
 */
export const ROUND5_OPERATORS: readonly Round5Case[] = [
  {
    c: `F=${ASSEMBLED}; cat ${D}{F//zz/}`,
    why: "the round-4 CRITICAL: `${F//zz/}` is a GLOBAL REPLACE, not a `$NAME` reference",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F=${ASSEMBLED}; cat ${D}{F#zz}`,
    why: "the prefix-strip operator was substituted away too",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F=${ASSEMBLED}; cat ${D}{F%zz}`,
    why: "the suffix-strip operator",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F=${ASSEMBLED}; cat ${D}{F:5}`,
    why: "the substring operator",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F=notes.txt; cat ${D}{F:-${ASSEMBLED}}`,
    why: "the default-value operator, unquoted binding",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `export F=notes.txt; cat ${D}{F:-${ASSEMBLED}}`,
    why: "the same with an `export` binding",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F="notes.txt"; cat ${D}{F:-${ASSEMBLED}}`,
    why: "the same with a quoted binding",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `F=x; cat ${D}{F:-${ASSEMBLED}}`,
    why: "the same with the name bound to something else entirely",
    clause: "unreadable-word",
    atBase: true,
  },
];

/**
 * The prose test's quote kinds. A single-quoted span is inert; a DOUBLE-quoted span
 * substitutes, so a `$` inside one is an expansion the guard cannot read. The old scanner
 * skipped to the next `'` and read `"a'$F"` as prose because the quote it found never
 * closed; an unclosed quote is UNREADABLE, never prose.
 */
export const ROUND5_QUOTES: readonly Round5Case[] = [
  {
    c: `grep "a'${D}F" f`,
    why: "a `$` inside double quotes is an expansion; the stray `'` does not make it inert",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `sed "x'${D}CMD" f`,
    why: "the same shape on a pattern tool the arms refuse outright",
    clause: "unreadable-word",
    atBase: false,
  },
];

/**
 * A pattern flag that CONSUMES the next word used to skip asking it, so the value never
 * reached the operand test at all. For `sed` / `awk` that value is the PROGRAM they run.
 */
export const ROUND5_PATTERN_FLAG_VALUE: readonly Round5Case[] = [
  {
    c: `sed -e ${D}P f`,
    why: "`sed -e` runs whatever `$P` holds — the consumed value is the program, not a path",
    clause: "unreadable-word",
    atBase: false,
  },
  {
    c: `awk -e ${D}P f`,
    why: "`awk -e` runs whatever `$P` holds",
    clause: "unreadable-word",
    atBase: false,
  },
];

/** `which` LEFT the print class: it resolves its operand against every directory on `PATH`,
 * so an unreadable operand is a file lookup through a path the guard cannot name. A print
 * tool echoes its argument; `which` opens for it. */
export const ROUND5_WHICH: readonly Round5Case[] = [
  {
    c: `which ${D}F`,
    why: "`which` reads PATH looking for its operand",
    clause: "unreadable-word",
    atBase: true,
  },
  {
    c: `cat notes.md && which ${D}F`,
    why: "the same behind a chained read tool — the PRINT-class exemption is gone",
    clause: "unreadable-word",
    atBase: true,
  },
];

/**
 * An assignment-shaped word HANDED TO an unknown program is an argv entry whose final text
 * the guard cannot name. (A binding BEFORE the program word, or one carried by a binding
 * prefix like `export` / `env`, stays the shell's own business — see `ROUND5_KEEP_ALLOWED`.)
 */
export const ROUND5_ASSIGNED_ARG: readonly Round5Case[] = [
  {
    c: `cat notes.txt && python3 X=${D}F`,
    why: "`X=$F` is argv for python3, not a binding the shell consumes",
    clause: "unreadable-word",
    atBase: true,
  },
];

/**
 * The accepted costs of the raw-text rule. Each went green ONLY because the exemption proof
 * read a substituted text — the shell really does resolve these references, but the guard no
 * longer trusts its own guess about what the shell will do, so the base floor stands.
 */
export const ROUND5_ACCEPTED_COSTS: readonly { c: string; why: string }[] = [
  {
    c: `F=notes.md; cat ${D}F`,
    why: "exemption never reads substituted text — the reference resolves in bash, not in the guard",
  },
  {
    c: `F=.git/notes.txt; cat > ${D}F`,
    why: "exemption never reads substituted text — and a redirection target is the last word to guess at",
  },
  {
    c: `F=x; (cat ${D}F)`,
    why: "exemption never reads substituted text — a subshell inherits the binding; the proof no longer assumes it",
  },
];

/**
 * The neighbours that must NOT have moved. Every one carries a `$` the raw rule still reads
 * as ordinary shell text for a reason of its own: a binding the SHELL consumes (before the
 * program word, or carried by `export` / `env`), a trailing `$` with nothing expandable
 * behind it, an escaped `\$` the shell will not substitute, a single-quoted program.
 */
export const ROUND5_KEEP_ALLOWED: readonly { c: string; why: string }[] = [
  {
    c: `export PATH=/tmp/bats-core/bin:${D}PATH; timeout 900 bats tests/install-tailscale.bats 2>&1 | tail -8`,
    why: "a binding BEFORE the program word is the shell's own environment, not argv",
  },
  {
    c: `cd /home/janni/projects/llm-iac; timeout 400 env PATH="/tmp/bats-core/bin:${D}PATH" bats tmp/issue-319/sweep/driftcheck.sh 2>&1 | tail -50`,
    why: "`env` is a binding prefix, so its NAME=value word is a binding and not an operand",
  },
  {
    c: `cd /home/janni/projects/pi-ab-bench && PYTHONPATH=${D}PWD timeout 300 python3 -m pytest /tmp/test_probe2.py -q 2>&1 | tail -12`,
    why: "a leading assignment before the program word, with an expansion-free argv",
  },
  {
    c: `grep -o -E "[a-z][a-z0-9][a-z0-9.+-]*[[:space:]]+\\\\${D}" /repo/Dockerfile`,
    why: "a trailing escaped `\\$` is an ERE anchor: the escape removes the `$`'s meaning, prose stays prose",
  },
  {
    c: 'grep -n "digest_of \\"\\$MARKER_PATH\\"" scripts/reconcile-config.sh; echo "rc=$?"',
    why: "an escaped `\\$` inside a double-quoted pattern is data the shell will not substitute",
  },
  {
    c: `grep -e 'a${D}' notes.txt`,
    why: "a single-quoted `-e` value is inert, so the exemption still holds",
  },
];
