/**
 * lens-class-mutants — the generator behind every per-member mutant in the
 * `lens-flank-escape-probe.ts` table.
 *
 * WHY THIS FILE EXISTS. The table that shipped first described its mutants as
 * strings a person typed by hand, and every "0 suite reds" it printed had
 * measured a mutation that had never deleted anything: the hand-written
 * "mutant" of `[A-Za-z0-9_./+-]` was `[A-Za-z0-9_./+-]`. A blob hash does not
 * catch that — the bytes change by one escape character while the character
 * SET stays identical — so a hash is not a control here and the shipped table
 * was green on nothing. This file is the control: the table's rows are the
 * OUTPUT of `mutantsFor`, and each row it returns has passed three assertions
 * that run as code.
 *
 * THE THREE PRECONDITIONS (each is an `Error`, not a comment):
 *
 *   P1  MUTATED ≠ SHIPPED — the rendered class is not byte-identical to the
 *       shipped one, so something was genuinely removed.
 *   P2  STILL A CLASS — the MUTANT compiles as a character class in both
 *       positions the matcher uses it (bare and negated), so a mutant that
 *       merely breaks `new RegExp` cannot masquerade as "0 reds"; and the MUTANT
 *       still discriminates, admitting some probe characters and refusing others.
 *       BOTH readings are of the MUTANT, never of the shipped class: `[]` compiles
 *       (an empty class is a legal regex) and admits NOTHING, which is exactly the
 *       "0 reds" fabrication P2 exists to refuse. Moving the probe back onto the
 *       shipped class makes this throw unreachable — `test-lens-class-mutants.ts`
 *       pins it with `[!]`, which is ACCEPTED as a row if that regression returns.
 *   P3  THE MEMBER REALLY LEFT — the deleted member's canonical representative
 *       matches the shipped class and NOT the mutant, and every other member
 *       still matches the mutant.
 *
 * PLUS THE ROUND-TRIP GATE (P0). Before any of that, `render(tokenize(inner))
 * === inner` must hold. This is the one that turns a family of SILENT
 * corruptions into loud refusals, and it is not decoration — these are real
 * shapes that pass P1–P3 while the character set is wrong:
 *
 *   `+-]`      a naive tokenizer reads `+-` as a range ENDPOINT CHAIN and
 *              swallows `,-.…:;<=>?@A-Z[\]`; the round-trip does not reproduce
 *              the shipped text, so the mutant is refused. This is the shape
 *              that caused the original incident.
 *   `[^]a`     is refused one step EARLIER than the round-trip, by `splitClass`:
 *              the first `]` closes the class, so the body is `]` and the text is
 *              not a class at all. Its admits-nothing sibling `[^]a]` is what the
 *              round-trip gate is for — it deletes `a` and leaves `[^]]`, a class
 *              with a different MEANING (an unterminated/doubled bracket) still
 *              not byte-equal to the shipped literal, so P1 alone passes and the
 *              set is wrong.
 *   `\n`-in-class (`[a\t\r]`)  an escape-aware tokenizer that un-escapes yields
 *              literal `n`, so the class silently becomes `{a,t,r}`.
 *   trailing escape (`[a-z-\]`)  an escape with nothing after it.
 *   lone quantifier (`[]++]`, `[]?+]`)  a member deletion can leave a quantifier
 *              with nothing to repeat. The round-trip reproduces the text, so P0
 *              passes, and `new RegExp` throws `nothing to repeat`. `admits` now
 *              wraps that construction in the same `ClassRefused` as every other
 *              refusal, so this shape names itself too — before it it was a bare
 *              `SyntaxError`, which is loud but not named, and "loud" is not what
 *              the sentence below promises. (No shipped class reaches it: the
 *              three that the tables use generate 5/5/7 rows.)
 *
 * The refusal is a THROW naming the shape. A generator that quietly produced a
 * different set is the failure mode this whole branch exists to close.
 *
 * CANONICAL SPELLING, stated so the table is reproducible: a range token
 * renders `from-to`; a literal `-` renders EXACTLY as it was read — unescaped
 * when the shipped literal wrote it unescaped (both shipped classes end `+-`,
 * with the `-` last, as `lens-review-coverage.ts` writes it), and `\-` when the
 * shipped literal escaped it (as `TERMINATOR` does). Preserving the source's own
 * spelling is what makes `render(tokenize(x)) === x` a GATE instead of a
 * formatter that redacts its own input: an escape-normalising renderer round-trips
 * `[a-z-\]` too, and would then certify a mutant built on a tokenizer that
 * mis-reads the class. `\-` and `-` are the same MEMBER; only the round-trip can
 * tell whether the tokenizer put a backslash where none was written.
 */

/** One token of a character class: a single member (remembering whether the
 * source escaped it, so the renderer can reproduce the source byte-for-byte), or
 * an inclusive range. */
export type ClassToken =
  | { kind: "char"; ch: string; escaped: boolean }
  | { kind: "range"; from: string; to: string };

/** A generated mutant, with everything a reader needs to audit it. */
export interface ClassMutant {
  /** The deleted member as it appears in the shipped literal. */
  readonly member: string;
  /** The shipped class literal this mutant came from. */
  readonly shipped: string;
  /** The generated mutant literal. */
  readonly mutated: string;
  /** The character that must stop matching (P3's probe). */
  readonly representative: string;
  /** Every character the mutant must STILL match (P3's companion). */
  readonly survivors: string;
}

/** Refuse a shape rather than generate a wrong set. */
export class ClassRefused extends Error {}

/**
 * Split a class body into tokens. `\`-escapes are honoured, and an escaped
 * character is always a single member (never a range endpoint — `[a-\z]` is a
 * literal `\z`, and reading it as an endpoint is how a range silently grows).
 * A `-` immediately before `]` is a literal `-`, which is how both shipped
 * classes carry one.
 */
export function tokenize(inner: string): ClassToken[] {
  const toks: ClassToken[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      const escaped = inner[i + 1];
      if (escaped === undefined)
        throw new ClassRefused(
          `trailing escape at index ${i}: ${JSON.stringify(inner)} ends in a backslash with nothing to escape`,
        );
      toks.push({ kind: "char", ch: escaped, escaped: true });
      i += 2;
      continue;
    }
    const ch = inner[i]!;
    const isRange =
      inner[i + 1] === "-" && inner[i + 2] !== undefined && inner[i + 2] !== "]";
    if (isRange) {
      const to = inner[i + 2]!;
      if (to === "\\")
        throw new ClassRefused(
          `range ${JSON.stringify(ch)}-\\ at index ${i} of ${JSON.stringify(inner)} has an escaped endpoint, which this generator refuses rather than guess at`,
        );
      toks.push({ kind: "range", from: ch, to });
      i += 3;
      continue;
    }
    toks.push({ kind: "char", ch, escaped: false });
    i += 1;
  }
  return toks;
}

/** Render tokens back to class-body text in the canonical spelling. */
export function render(toks: readonly ClassToken[]): string {
  return toks
    .map((t) =>
      t.kind === "range" ? `${t.from}-${t.to}` : t.ch === "-" && t.escaped ? "\\-" : t.ch,
    )
    .join("");
}

/** The class body and its negation flag, or a refusal for anything that is not
 * a bracketed class. */
function splitClass(literal: string): { negated: boolean; inner: string } {
  if (literal.length < 3 || !literal.startsWith("[") || !literal.endsWith("]"))
    throw new ClassRefused(`${JSON.stringify(literal)} is not a bracketed character class`);
  const negated = literal.startsWith("[^");
  const inner = negated ? literal.slice(2, -1) : literal.slice(1, -1);
  if (inner.length === 0) throw new ClassRefused(`${JSON.stringify(literal)} has an empty body`);
  return { negated, inner };
}

/**
 * The members a table may delete: the single-character tokens. Whole `a-z`
 * style ranges are deliberately EXCLUDED from the generated rows — removing a
 * 26-member range is not the same experiment as removing one character, and the
 * table reports ranges separately and says so.
 */
export function singleMembers(literal: string): string[] {
  const { inner } = splitClass(literal);
  const toks = tokenizeChecked(inner, literal);
  return toks.filter((t) => t.kind === "char").map((t) => (t as { ch: string }).ch);
}

/** P0 — parse and re-render, and refuse unless the text is reproduced exactly. */
function tokenizeChecked(inner: string, literal: string): ClassToken[] {
  const toks = tokenize(inner);
  const back = render(toks);
  if (back !== inner)
    throw new ClassRefused(
      `round-trip REFUSED for ${JSON.stringify(literal)}: its body ${JSON.stringify(inner)} re-renders as ${JSON.stringify(back)}, so this generator's tokenizer does not describe that class and no mutant built from it can be trusted`,
    );
  return toks;
}

/** One printable character that the token admits — P3's probe. For a range, its
 * midpoint (a character no neighbouring token can also supply). */
function representativeOf(token: ClassToken): string {
  if (token.kind === "char") return token.ch;
  const a = token.from.codePointAt(0)!;
  const b = token.to.codePointAt(0)!;
  return String.fromCodePoint(Math.floor((a + b) / 2));
}

/** Does `ch` fall inside this class literal, evaluated the way JS evaluates it? */
function admits(literal: string, ch: string): boolean {
  // Wrapped, not left raw. `assertCompilesAsClass` below already refuses a
  // mutant that does not COMPILE, but P3 evaluates `admits` on a shape the
  // compile check never sees: a lone quantifier left behind where a member was
  // deleted (`[]++]`, `[^]++]`, `[]?+]`, `[]+*]`) round-trips through
  // `render(tokenize(…))` untouched and then makes `new RegExp` throw
  // `Invalid regular expression: nothing to repeat`. Left raw that is a bare
  // `SyntaxError` with no name in it, while this file's header promises "the
  // refusal is a THROW naming the shape" — the two disagreed, and the promise
  // is the one a reader relies on. Same `ClassRefused` the other preconditions
  // raise, and the message carries the shape, the offending form, and the
  // underlying reason.
  const form = `^(?:${literal})$`;
  let re: RegExp;
  try {
    re = new RegExp(form);
  } catch (e) {
    throw new ClassRefused(
      `${JSON.stringify(literal)} cannot be evaluated as a class member test: ${form} does not compile — ${(e as Error).message} (a lone quantifier with nothing to repeat, which a member deletion can leave behind)`,
    );
  }
  return re.test(ch);
}

/** P2's probe characters. Deliberately NOT derived from the shipped matcher's own
 * alphabet: `TERMINATOR`'s `?`, `,`, `;` and `:` are covered by no `PATH_CHAR`
 * representative, and the table publishes three of them as measured UNPINNED 0s.
 * A refusal keyed to "the probes cannot see this deletion" would delete rows whose
 * 0 is a measurement — the corpus carries the neighbour-sweep fixtures that a
 * reader can re-run (`lens-mutant-corpus.ts`, and `runMutant` names the fixtures
 * each mutant reddens) — and not a blind spot: the same error inverted. What this
 * gate refuses is a class that admits NOTHING or EVERYTHING, which no wider probe
 * set can rescue because such a class is broken for every character. A fixed set
 * (rather than hard-coding `a`/`\u0000`) is what lets one check serve a positive
 * class (admits `a`, refuses `\n`) and a negated one (`TERMINATOR` admits `!`,
 * refuses `a`).
 *
 * WHICH GATE THIS IS, since the name invites the wrong reading: P2 is an
 * admits-nothing / admits-everything gate, NOT a discriminating-power gate. A
 * mutant that separates only two of these eleven probes passes — `[\ta!]` is
 * accepted — because refusing a weak-but-legal class is P3's and the corpus's
 * job, not this gate's, and P3 is what makes a deletion whose verdict no fixture
 * moves visible rather than silently accepted. Read this gate as "is this still
 * a class at all", not as "does this class still decide anything". */
const PROBE_CHARS = ["a", "Z", "0", "_", ".", "/", "+", "-", "!", " ", "\n"];

/** Does this literal compile as a class, in BOTH positions the matcher puts one?
 * The shipped classes appear bare (`PATH_CHAR`, `TERMINATOR`) and as the source of
 * a negation (`NOT_PATH`), so a mutant that survives only one reading is still a
 * mutant the table must not print. */
function assertCompilesAsClass(literal: string, negatedOfShipped: boolean): void {
  const forms = negatedOfShipped ? [literal] : [literal, `[^${literal.slice(1, -1)}]`];
  for (const form of forms) {
    try {
      void new RegExp(`^(?:${form})$`);
    } catch (e) {
      throw new ClassRefused(
        `${JSON.stringify(literal)} does not compile as a character class${
          form === literal ? "" : ` in its negated form ${JSON.stringify(form)}`
        }: ${(e as Error).message}`,
      );
    }
  }
}

/**
 * P2 — the MUTANT is still a usable class. `new RegExp` is the same construction
 * the matcher uses, so a mutant that merely breaks the pattern cannot reach the
 * table as a "0 reds" row: it throws here instead.
 *
 * The parameter is the MUTANT and nothing else. The previous signature took a
 * second, optional `literalSource` and read every probe against `literalSource ??
 * literal`; `mutantsFor` always passed the SHIPPED class there, so both probes
 * counted the shipped class, any shipped class with a member and a non-member
 * among the probes made the throw UNREACHABLE, and an `[]` mutant — which compiles,
 * since an empty class is a legal regex, and matches no character at all — entered
 * the table as a row whose red count was 0 by construction for EVERY fixture. A
 * precondition that cannot fire is the defect this branch exists to close, wearing
 * the shape of a precondition.
 */
function assertStillAClass(mutated: string, negatedOfShipped: boolean): void {
  assertCompilesAsClass(mutated, negatedOfShipped);
  const mutantAdmits = PROBE_CHARS.filter((c) => admits(mutated, c));
  if (mutantAdmits.length === 0 || mutantAdmits.length === PROBE_CHARS.length)
    throw new ClassRefused(
      `${JSON.stringify(mutated)} is not a usable class — from ${PROBE_CHARS.length} probes it admitted ${mutantAdmits.length} and refused ${PROBE_CHARS.length - mutantAdmits.length}: an admits-nothing (or admits-everything) class is the "0 reds" fabrication this gate refuses`,
    );
}

/**
 * The probe character for EVERY token of the shipped class: the literal itself,
 * or a range's midpoint. P3's companion set — a mutant must still admit every
 * probe but the deleted member's own. Built from the token list, never
 * hand-typed, so this cannot silently no-op the way a hand-written "survivors"
 * string does.
 */
function probesOf(toks: readonly ClassToken[]): string[] {
  return toks.map((t) => representativeOf(t));
}

/**
 * The mutants for one shipped class: one per single-character member, each
 * having passed P0–P3. A class whose shape this generator cannot prove it
 * understands throws rather than producing a row.
 *
 * `negated` is inferred from the leading `^`, so the same code covers the
 * matcher's `PATH_CHAR` and `NOT_PATH`.
 */
export function mutantsFor(literal: string): ClassMutant[] {
  const { negated, inner } = splitClass(literal);
  const toks = tokenizeChecked(inner, literal);
  const probes = probesOf(toks);
  const mutants: ClassMutant[] = [];
  toks.forEach((token, index) => {
    if (token.kind !== "char") return;
    const member = token.ch;
    const rest = toks.filter((_, j) => j !== index);
    const rendered = render(rest);
    const mutated = `[${negated ? "^" : ""}${rendered}]`;

    // P1 — the mutant must differ from shipped.
    if (mutated === literal)
      throw new ClassRefused(
        `deleting ${JSON.stringify(member)} from ${JSON.stringify(literal)} is a NO-OP (mutant is byte-identical to shipped)`,
      );
    // A deletion that leaves a leading `^` or `-` has changed the class's
    // MEANING rather than its membership, and P1 cannot see it. Refuse.
    if (rendered.startsWith("^") && !negated)
      throw new ClassRefused(
        `deleting ${JSON.stringify(member)} from ${JSON.stringify(literal)} leaves ${JSON.stringify(mutated)}, whose leading ^ is now a negation instead of a member`,
      );
    if (rendered.startsWith("-") || rendered.startsWith("\\"))
      throw new ClassRefused(
        `deleting ${JSON.stringify(member)} from ${JSON.stringify(literal)} leaves ${JSON.stringify(mutated)}, which starts with a bare - or escape and reads as a range or an escape, not a member`,
      );

    // P2 — still a class, and still discriminating. Judged against the MUTANT
    // alone: no shipped class is passed (see assertStillAClass for what reading
    // the probe against shipped made unreachable).
    assertStillAClass(mutated, negated);

    // P3 — the member really left, and nothing else did. Read the class the way
    // JS does: a NEGATED class EXCLUDES its tokens, so `[^…+-]` admits `_` and
    // refuses `-`, and the mutant of the `-` row must start ADMITTING `-`.
    // `expectedAdmits` is that polarity in one place, so the same code serves
    // `PATH_CHAR` (positive) and `NOT_PATH` (negated) without an `if (negated)`
    // at each of the three sites.
    const representative = representativeOf(token);
    const expectedAdmits = !negated;
    if (admits(literal, representative) !== expectedAdmits)
      throw new ClassRefused(
        `${JSON.stringify(representative)} (representative of ${JSON.stringify(member)}) is not admitted by shipped ${JSON.stringify(literal)} the way a member of a ${negated ? "negated" : "positive"} class must be — P3 cannot be evaluated`,
      );
    if (admits(mutated, representative) === expectedAdmits)
      throw new ClassRefused(
        `${JSON.stringify(representative)} STILL behaves the same under the mutant ${JSON.stringify(mutated)} of ${JSON.stringify(literal)} — the member was not actually deleted`,
      );
    const survivors = probes.filter((_, j) => j !== index);
    for (const ch of survivors) {
      if (admits(mutated, ch) !== admits(literal, ch))
        throw new ClassRefused(
          `${JSON.stringify(ch)} changed behaviour under the mutant ${JSON.stringify(mutated)} of ${JSON.stringify(literal)} — deleting ${JSON.stringify(member)} moved more than one member`,
        );
    }

    mutants.push({ member, shipped: literal, mutated, representative, survivors: survivors.join("") });
  });
  return mutants;
}

/**
 * The rows the table prints: one per generated mutant, formatted with the
 * member, the class it becomes, and P3's representative. The table in
 * `lens-flank-escape-probe.ts` is this output with the measured reds pasted
 * beside each row — and the reds come from a run, not from this function.
 */
export function mutantTable(literal: string): string[] {
  return mutantsFor(literal).map(
    (m) =>
      `\`${m.member}\` → ${m.mutated}  (representative ${JSON.stringify(m.representative)} must stop matching; survivors ${JSON.stringify(m.survivors)})`,
  );
}
