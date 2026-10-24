/**
 * public-hygiene-unreadable — a publish flag whose TEXT the shell builds is a
 * publish the guard cannot read (#1788 round 1).
 *
 * Every other unreadable surface in this guard arrives from the filesystem or
 * from git: a body file that vanished, a range git would not resolve. This one
 * arrives from the command line itself. `gh pr create --body "$(cat notes.md)"`,
 * `` --title `cat t` `` and `--body $BODY` all name text the guard has no way to
 * see — `simpleCommands` deliberately stops at a command substitution and hands
 * the inner words to a separate scan, and the substitution's RESULT exists only
 * once a shell has run. Refusing is the guard's standing rule that "could not
 * tell" is never "clean", applied to the one shape an agent reaches for
 * constantly, because a publish whose text was never read is precisely the leak
 * the guard exists to stop.
 *
 * ## What counts as unreadable, and what does not
 *
 * - `$(` — a command substitution. `$(…)` and the `$(…)` inside double quotes
 *   both expand before `gh` sees the argument.
 * - a backtick — the other substitution form.
 * - `<(` — a process substitution, which reads like a filename and is none.
 * - a bare `$NAME` / `${NAME}` — an environment value whose contents no scan of
 *   the command text can know.
 *
 * Not flagged: a `$` that is not the start of one of those (a trailing dollar,
 * `100$`, a shell positional `$1` inside a quoted prose sentence still expands,
 * so it IS flagged), and any flag that is not a publish-text flag — a `--json`
 * selector or a `--repo` value is not text the forge publishes.
 *
 * ## The remedy the refusal offers
 *
 * `--body-file`. A file the guard can open, bound and read is the shape this
 * whole module already judges, so the sentence tells the agent how to keep the
 * publish rather than only that it cannot happen.
 */

/** One publish-text operand the guard cannot read, and what to call it. */
export interface UnreadableOperand {
  /** "body", "title", "commit message", … — the same vocabulary as the scan. */
  location: string;
}

/**
 * Does `value` get built by the shell, so that no scan of this command text can
 * read it? Asked of a flag's VALUE, not the flag itself.
 */
export function shellBuilt(value: string): boolean {
  if (value.includes("$(")) return true;
  if (value.includes("`")) return true;
  if (value.includes("<(")) return true;
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value);
}

/**
 * The text-carrying flags of each publish command, as `{flag: location}`.
 *
 * Kept here rather than imported from `public-hygiene-scan.ts` deliberately:
 * the scan's flag tables answer "whose value is prose to MATCH", and several of
 * those entries are noun-conditional (`-n` is release notes for `release` and a
 * no-body switch for `issue`). This table answers the narrower question "whose
 * value could the shell have built", where the cost of over-including is a
 * refusal the agent can satisfy with a file, and the cost of under-including is
 * an unchecked publish.
 */
export const TEXT_FLAG_LOCATIONS: readonly (readonly [string, string])[] = [
  ["--title", "title"],
  ["-t", "title"],
  ["--body", "body"],
  ["-b", "body"],
  ["--notes", "release notes"],
  ["--subject", "commit message"],
  ["-m", "commit message"],
  ["--message", "commit message"],
];

/** `key=value` forms of gh api's field flags, whose value is published text. */
export const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

/**
 * Every unreadable publish operand in one argv.
 *
 * `gh <noun> <create|edit|comment|review>`, `gh api`, and `git commit` are the
 * three command shapes with text-carrying flags; the caller has already decided
 * the command publishes (the scan does that), so this function asks only about
 * the operands it is given.
 */
/**
 * Every unreadable publish operand in one argv.
 *
 * `gh <noun> <create|edit|comment|review>`, `gh api`, and `git commit` are the
 * three command shapes with text-carrying flags; the caller has already decided
 * the command publishes (the scan does that), so this function asks only about
 * the operands it is given.
 *
 * `raw` is the WHOLE command the argv was cut from, and it is asked because the
 * word list cannot answer this question alone: `simpleCommands` ENDS a command
 * at a `$(…` or a backtick (it must, so the substituted body gets its own scan)
 * and at a `<(` process substitution it splits the word in half. `--body
 * "$(cat x)"` therefore arrives as the empty word, not the substitution, and a
 * scan of the words alone would report a clean publish where the shell is about
 * to build one. The raw text is consulted only for the operand positions this
 * function has already identified, and only for the four shapes below — it is
 * never used to decide whether the command publishes.
 */
export function unreadableOperands(argv: readonly string[], raw?: string): UnreadableOperand[] {
  const found: UnreadableOperand[] = [];
  const isGhApi = argv.includes("gh") && argv.includes("api");
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    let consumed = 0;
    let matched = false;
    for (const [flag, location] of TEXT_FLAG_LOCATIONS) {
      const value = operandOf(w, flag, argv, i);
      if (value === undefined) continue;
      if (shellBuilt(value.value) || shellBuiltOperand(raw, flag)) found.push({ location });
      consumed = value.used;
      matched = true;
      break;
    }
    if (matched) {
      i += consumed;
      continue;
    }
    if (!isGhApi) continue;
    if (!API_FIELD_FLAGS.has(w)) continue;
    const raw2 = argv[i + 1];
    if (raw2 === undefined) continue;
    // `body=$(cat x)` publishes a substituted body; `body=literal` publishes a
    // literal. Only the value half is asked, so a field NAME that merely
    // contains a dollar (which gh would not accept anyway) is not a finding.
    const eq = raw2.indexOf("=");
    const value = eq > 0 ? raw2.slice(eq + 1) : raw2;
    if (!value.startsWith("@") && (shellBuilt(value) || shellBuilt(raw2)))
      found.push({ location: "comment" });
    // The raw command is asked for the SAME reason as for the text flags: a
    // process substitution splits the word (`-F body=<` + `(/dev/stdin)`), so
    // the words alone can miss it while the command plainly carries one.
    if (shellBuiltFieldOperand(raw, w)) found.push({ location: "comment" });
    i += 1;
  }
  return found;
}

/**
 * Does the RAW command carry a substitution glued to a FIELD flag's operand,
 * where the word list cut it in half? `-F body=<(/dev/stdin)` arrives as
 * `-F`, `body=<`, `(/dev/stdin)`, and asking only the words would report a clean
 * publish. The operand is located after `flag` and asked on its own, so an
 * unrelated `$(…)` elsewhere in the chain cannot refuse this field.
 */
function shellBuiltFieldOperand(raw: string | undefined, flag: string): boolean {
  if (raw === undefined) return false;
  let at = raw.indexOf(flag);
  while (at >= 0) {
    const operand =
      raw
        .slice(at + flag.length)
        .trimStart()
        .split(/\s/)[0] ?? "";
    const eq = operand.indexOf("=");
    const value = eq > 0 ? operand.slice(eq + 1) : operand;
    if (value !== "" && !value.startsWith("@") && shellBuilt(operand)) return true;
    at = raw.indexOf(flag, at + 1);
  }
  return false;
}

/**
 * Does the RAW command carry a substitution glued to `flag`'s operand, where the
 * word list has already been cut? `--body $(…)` (empty word), `--body=<(...)`
 * (split word) and the backtick form all land here.
 */
function shellBuiltOperand(raw: string | undefined, flag: string): boolean {
  if (raw === undefined) return false;
  // Scan the raw command for `flag` followed by its operand, and ask the shell-
  // built question of that operand only — never of the whole command, which
  // would refuse an unrelated `$(…)` anywhere in a chain.
  for (const needle of [`${flag}=`, `${flag} `]) {
    let at = raw.indexOf(needle);
    while (at >= 0) {
      const operand = raw
        .slice(at + needle.length)
        .trimStart()
        .split(/\s/)[0];
      if (operand !== undefined && operand !== "" && shellBuilt(operand)) return true;
      at = raw.indexOf(needle, at + 1);
    }
  }
  // The glued short form (`-m$(…)`), which has neither `=` nor a space.
  if (flag.length === 2) {
    let at = raw.indexOf(flag);
    while (at >= 0) {
      const operand = raw.slice(at + flag.length).split(/\s/)[0] ?? "";
      if (operand !== "" && shellBuilt(operand)) return true;
      at = raw.indexOf(flag, at + 1);
    }
  }
  return false;
}

/** The operand of `flag` in this word list, with `=` and glued short forms. */
function operandOf(
  w: string,
  flag: string,
  argv: readonly string[],
  i: number,
): { value: string; used: number } | undefined {
  if (w === flag) {
    const next = argv[i + 1];
    return next === undefined ? undefined : { value: next, used: 1 };
  }
  if (flag.length > 2 && w.startsWith(`${flag}=`))
    return { value: w.slice(flag.length + 1), used: 0 };
  // A glued short form (`-mtext`, `-btext`) carries its value inline; a long
  // flag never glues, so `--bodyfile` is not `--body` with a value.
  if (flag.length === 2 && w.startsWith(flag) && w.length > flag.length) {
    return { value: w.slice(flag.length), used: 0 };
  }
  return undefined;
}

/** The refusal: what could not be read, and the shape that can be. */
export function unreadableOperandRefusal(location: string): string {
  return [
    "Refused: this publish could not be checked, and an unchecked publish is not a clean one.",
    `The ${location} is built by the shell (a command substitution, a backtick, a process substitution or a variable), so its text does not exist in the command this guard can read.`,
    "Write the text to a file and pass that file (for gh: --body-file or --input; for git commit: a message file), and the check will run on the real text. If this publish is genuinely fine, an operator can set PI_ENSEMBLE_PUBLIC_HYGIENE=0.",
  ].join("\n");
}
