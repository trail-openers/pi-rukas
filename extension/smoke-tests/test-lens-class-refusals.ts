#!/usr/bin/env bun
/**
 * The generator's REFUSAL witnesses — the shapes that must never become a table
 * row. `test-lens-class-mutants.ts` holds the acceptances and the harness/table
 * reconciliation; this half holds the refusals, which is where a new blind spot
 * gets recorded. Split from it along that seam when the 500-line cap (§12) was
 * about to be met; nothing here was trimmed to fit, and both files are in
 * `tsconfig.smoke-tests.json`.
 *
 * WHY REFUSALS AND NOT JUST ACCEPTANCES (the reason both halves exist). An
 * acceptance test proves the generator runs; it cannot prove the generator is
 * not wrong. The shapes below came from rebuilding the generator the adversarial
 * gate described and probing it with inputs it had never seen, and several
 * produced a mutant that looked valid. A generator whose only tests are "it
 * returns rows for the shipped classes" would have passed every one of them
 * while the table it fed was wrong.
 *
 * Each refusal is asserted on its MESSAGE, not merely on "it threw": a `throw`
 * from a typo in this test file is indistinguishable from a refusal, and the
 * whole point is which of the two happened.
 *
 * Shares its `check`/`refused` helpers with the other half through
 * `lib/lens-class-mutants-arms.ts`, so the two files cannot drift on what
 * "refused for the right reason" means.
 */

import { mutantsFor, render, singleMembers, tokenize } from "./lib/lens-class-mutants.ts";
import { assert, refused, state } from "./lib/lens-class-mutants-arms.ts";

// ───────────────────────── the four shapes that corrupt silently

// `+-]` is the shape behind the original incident: a tokenizer that treats a
// `-` as an endpoint chain reads `+-` as `+`→`]` and swallows
// `,-.…:;<=>?@A-Z[\]` into one range. The class then admits 45 characters it
// should not, the round-trip cannot reproduce the source text, and a table built
// on that tokenizer prints "0 reds" for a member that was never deleted.
// The refusal asserted here is the generator's own named precondition, and the
// companion assertion below is the one that pins the BRIEF's claim: `tokenize`
// must not read `+-` as an endpoint chain. A refusal that merely happened to
// come from a neighbouring precondition would let a tokenizer regression slip
// through still refusing, for the wrong reason, over a class it mis-reads.
refused(
  () => mutantsFor("[+-]"),
  /round-trip REFUSED|starts with a bare -|does not compile|not a usable class/,
  "`+-]` is refused rather than tokenised into the 45-character set an endpoint chain gives",
);
assert(
  (() => {
    const t = tokenize("+-]");
    return t.length === 3 && t.every((x) => x.kind === "char");
  })(),
  "`+-]` tokenises to the THREE members `+`, `-`, `]` — not the single range `+`→`]` that swallows `,-.…:;<=>?@A-Z[\\]` (the original incident)",
);

// `[^]a` is the class whose MEANING changes while its bytes stay different from
// shipped: strip the leading `[^` and the body is `]a`, which re-renders
// identically, so a bytes-differ precondition passes and the set is wrong anyway.
refused(
  () => mutantsFor("[^]a"),
  /is not a bracketed character class|not a usable class|does not compile|round-trip REFUSED/,
  "`[^]a` (whose body round-trips to `[^]`/`[^]]` — not byte-identical, so a bytes-differ check alone passes while the class changed meaning)",
);

// An escape-aware tokenizer that UN-ESCAPES as it parses turns `[a\t\r]` into the
// token set `{a,t,r}` — the class silently loses `\t` and `\r`. The renderer that
// preserves the source's own spelling is what makes this a refusal and not a
// formatting detail.
refused(
  () => mutantsFor("[a\\t\\r]"),
  /round-trip REFUSED/,
  "`[a\\t\\r]` (an un-escaping tokenizer yields literal `n`/`t`/`r`, so the class becomes {a,t,r})",
);

// A trailing escape has nothing to escape. Refusing it is the loud case the
// round-trip gate was checked against first; the three above are the ones it had
// to be extended to catch.
refused(
  () => mutantsFor("[a-z-\\]"),
  /round-trip REFUSED|trailing escape/,
  "`[a-z-\\]` (trailing escape)",
);

// THE `range out of order` EXONERATION, asserted rather than argued. The round
// brief records a scratch probe that died on `SyntaxError: range out of order in
// character class` and attributes it to the probe's OWN escaping bug (collapsing
// `\\-` to a literal `-`) rather than to the generator. `[a---]` is that shape: it
// is not one of the three shipped classes, and its mutant `[a--]` is the pattern
// that raises the error. Two things must both hold, and asserting only the second
// would let a generator that merely threw the SyntaxError through unhandled pass:
// the refusal is a ClassRefused naming the compile failure (P2), not a raw
// SyntaxError escaping the generator.
refused(
  () => mutantsFor("[a---]"),
  /does not compile as a character class.*range out of order/,
  "`[a---]` is REFUSED by P2 with a ClassRefused naming `range out of order` (the scratch probe's own escaping bug, not a generator defect: the generator turns it into a refusal rather than letting the SyntaxError escape)",
);
assert(
  (() => {
    // The claim is about WHERE the SyntaxError is raised: from `new RegExp` on the
    // mutant, not from the generator. Compiling the pattern through the
    // constructor is the thing under test, so the string is built from parts — a
    // pattern LITERAL with a reversed range is rejected when this file is parsed,
    // before any `try` runs, which would turn the fact being observed into a crash
    // on import. (This is also why the lint rule that prefers literals over the
    // constructor does not apply here: the deferral to runtime is the point.)
    const mutant = String.fromCharCode(94, 63, 63, 58, 91, 97, 45, 45, 93, 36);
    try {
      new RegExp(mutant);
      return false;
    } catch (e) {
      return (e as Error) instanceof SyntaxError;
    }
  })(),
  "the `range out of order` SyntaxError really does come from `new RegExp` on `[a--]` — so the scratch probe's crash was the input's, and the generator's job is to refuse it, which the assertion above shows it does",
);

// P2's second position, stated rather than witnessed — and the distinction is the
// point. `assertCompilesAsClass` builds the mutant in BOTH positions the matcher
// uses a class in (bare for `PATH_CHAR`/`TERMINATOR`, and the negated reading
// `NOT_PATH` occupies), which is what makes the header's "both positions" claim
// code rather than prose. No witness is asserted for the negated arm, because none
// exists to write: probed over bracket/escape/range shapes, there is no JS class
// that compiles bare and fails negated (negation is applied to a well-formed class
// body), so the arm can only ever agree with the bare one. A test that asserted a
// refusal there would be pinning an input that cannot be built. The arm is kept
// because it is the position `NOT_PATH` actually occupies, not because a run
// distinguishes it.
assert(
  (() => {
    // The arm is at least REACHED: a positive shipped class must be compiled in
    // its negated reading too, and a body that cannot compile negated must refuse.
    // `[a--]` is the one JS shape that fails both, so it proves the loop iterates
    // past the bare form rather than short-circuiting on it.
    try {
      mutantsFor("[a--a]");
      return false;
    } catch (e) {
      return /does not compile as a character class/.test((e as Error).message);
    }
  })(),
  "P2 reaches its compile check for a class whose body cannot compile (the both-positions loop is entered, not short-circuited on the bare form)",
);

// ───────────────────────── the shipped classes are accepted, and correctly

const PATH_CHAR = "[A-Za-z0-9_./+-]";
const NOT_PATH = "[^A-Za-z0-9_./+-]";
const TERMINATOR = "[!?,.;:\\-]";

for (const [label, lit, members] of [
  ["PATH_CHAR", PATH_CHAR, ["_", ".", "/", "+", "-"]],
  ["NOT_PATH", NOT_PATH, ["_", ".", "/", "+", "-"]],
  ["TERMINATOR", TERMINATOR, ["!", "?", ",", ".", ";", ":", "-"]],
] as const) {
  const inner = lit.startsWith("[^") ? lit.slice(2, -1) : lit.slice(1, -1);
  let ok = false;
  let detail = "";
  try {
    const toks = tokenize(inner);
    ok = render(toks) === inner;
    detail = `re-renders ${JSON.stringify(render(toks))}`;
  } catch (e) {
    detail = `threw ${(e as Error).message}`;
  }
  assert(ok, `${label} round-trips: tokenize then render reproduces ${JSON.stringify(lit)} byte-for-byte (${detail})`);

  const got = (() => {
    try {
      return singleMembers(lit);
    } catch (e) {
      return `REFUSED: ${(e as Error).message}`;
    }
  })();
  assert(
    Array.isArray(got) && got.join(",") === members.join(","),
    `${label} tokenises to exactly the single-character members ${JSON.stringify(members)} (got ${JSON.stringify(got)})`,
  );

  const rows = mutantsFor(lit);
  assert(
    rows.length === members.length,
    `${label} generates one row per single-character member: ${members.length} expected, ${rows.length} generated`,
  );
  // The BYTE delta is not one whenever the deleted member was itself written as an
  // escape (`TERMINATOR`'s `\-` is two bytes for one token), so this counts TOKENS
  // and prints both figures rather than asserting a byte count that holds only for
  // the two unescaped classes.
  for (const m of rows) {
    const shippedTokens = tokenize(m.shipped.slice(1, -1));
    let mutantTokens: ReturnType<typeof tokenize> | null = null;
    try {
      mutantTokens = tokenize(m.mutated.slice(1, -1));
    } catch {
      mutantTokens = null;
    }
    assert(
      m.mutated !== m.shipped &&
        mutantTokens !== null &&
        mutantTokens.length === shippedTokens.length - 1,
      `${label} -${JSON.stringify(m.member)}: ${m.mutated} is ${mutantTokens?.length} tokens to shipped's ${shippedTokens.length} (bytes ${m.shipped.length} -> ${m.mutated.length}; a two-byte delta is correct when the member was written as an escape)`,
    );
    // The dangling-range witness. The class was previously written `[]]` — an
    // EMPTY character class, which matches nothing — so this assertion could never
    // fire for any input, and a real dangling range (`[Q-]]`) printed green. It is
    // escaped now so the check can actually fail: `-` immediately before the
    // closing `]` is the shape P1's own refusal exists to stop.
    assert(
      !/(^|[^\\])-[[\]]]/.test(m.mutated.slice(1, -1)),
      `${label} -${JSON.stringify(m.member)}: ${m.mutated} leaves no dangling range`,
    );
  }
}

// ───────────────────────── each precondition has a mutant that violates it

// P3 is the precondition that catches a silent no-op. `[aa-z]` admits `a` twice,
// so deleting one `a` token leaves a class that STILL admits `a` — and the bytes do
// change, so a "mutant ≠ shipped" check alone would have passed it and handed the
// table a row whose member was never actually removed.
refused(
  () => mutantsFor("[aa-z]"),
  /not actually deleted/,
  "a duplicated member (`[aa-z]`) is refused: the bytes change but `a` still matches (P3)",
);

// P2, shape one: `[^]` is an empty negated body — not a class at all.
refused(() => mutantsFor("[^]"), /empty body/, "an empty-bodied class is refused (P2)");

// P2, shape two: a class whose mutant admits NOTHING. `[^]a]` deletes `a` and
// leaves `[^]]`, which compiles, matches no character, and would have printed
// "0 reds" for every member of a class that never matched anything — the exact
// way the old table's zeros were manufactured. This is also the closest executable
// form of the brief's `[^]a` shape: `[^]a` is not itself a complete class (the
// first `]` closes it), so `splitClass` refuses it as malformed before the
// admits-nothing check is ever reached — stated here because a test that asserted
// the *reason* it happened to fail would be pinning an accident.
refused(
  () => mutantsFor("[^]a]"),
  /not a usable class/,
  "an admits-nothing mutant (`[^]a]` → `[^]]`) is refused rather than reported as a row (P2)",
);

// The brief's literal `[^]a`, asserted for the refusal it actually gets: a class
// that is not a class. Both spellings being refused is the point — neither a
// malformed class nor an admits-nothing one can enter the table.
refused(
  () => mutantsFor("[^]a"),
  /is not a bracketed character class/,
  "`[^]a` is refused as a malformed class (the first `]` closes it, so the body is `]`)",
);

// P2, shape three: THE DISCRIMINATOR ITSELF. `[^]a]` above is refused because
// `splitClass` reads its body as `^` and P3 then sees an admits-nothing class —
// but the shipped classes have a member and a non-member among the probes, so
// reading the probe against the SHIPPED class keeps the throw unreachable for any
// mutant of them. `[!]` is the shape that separates the two readings: its only
// mutant is `[]`, which COMPILES (an empty class is a legal regex, contrary to the
// claim this file's harness header used to make about `nothing to repeat`) and
// admits no character at all. Under the shipped-class reading of the probe, `[!]`
// was ACCEPTED and `[]` entered the table as a row — the row whose red count is 0
// for every fixture in the corpus, i.e. the fabrication wearing a precondition.
// Asserting the refusal, by message, is what pins the probe to the mutant.
refused(
  () => mutantsFor("[!]"),
  /is not a usable class.*admitted 0/,
  "a single-member class whose only mutant is the empty class `[]` is refused (P2 reads the MUTANT: `[]` compiles and admits nothing — the 0-reds fabrication)",
);

// P3, the shape the header's "the refusal is a THROW naming the shape" promise
// used to break. A member deletion can leave a LONE QUANTIFIER where the member
// was: `[]++]` deletes `+` and yields `[]+]`, whose `+` has nothing to repeat.
// The round-trip reproduces the text (`render(tokenize(inner)) === inner` is
// TRUE for all four shapes below), so P0 passes; and `assertCompilesAsClass`
// never sees this form, because `admits` evaluates the class as a whole. So the
// one construction nobody wrapped threw a bare `SyntaxError`, and the header
// promised a named refusal. None of the three shipped classes reaches it (they
// generate 5/5/7 rows), so the consequence was a loud crash rather than a bad
// table — but a promise and a behaviour that disagree is how the next reader
// trusts the wrong one.
for (const shape of ["[]++]", "[^]++]", "[]?+]", "[]+*]"]) {
  refused(
    () => mutantsFor(shape),
    /cannot be evaluated as a class member test.*nothing to repeat/,
    `\`${shape}\` is refused by a ClassRefused naming the shape and the reason (P0 round-trips, P2's compile check does not see this form, and a bare SyntaxError was the old behaviour)`,
  );
}
// …and the wrapping did not turn a loud refusal into a quiet one: the same four
// shapes still produce ZERO rows, which is what "fails loudly, prints no table"
// means in code.
for (const shape of ["[]++]", "[^]++]", "[]?+]", "[]+*]"]) {
  assert(
    (() => {
      try {
        return mutantsFor(shape).length === 0;
      } catch {
        return true;
      }
    })(),
    `\`${shape}\` produces no table row (either it refuses, or it returns nothing — a silent row is the failure this branch closes)`,
  );
}

// P2's real limit, asserted so no future reader mistakes it for a strength gate.
// P2 refuses admits-NOTHING and admits-EVERYTHING; it does not refuse a legal
// class with almost no discriminating power. `[! ]` admits just `!` and the space
// of the eleven probes — two of eleven — and is ACCEPTED, with both of its
// deletions becoming rows. That is deliberate: a class that separates something
// is a class, and whether its deletion moves a verdict is the corpus's question,
// answered by `measuredTable` and the reconciliation below. If someone later
// "tightens" P2 into a discrimination gate, this assertion is the one that
// reddens and forces the argument to be had here rather than in a table header.
//
// The brief's `[^\ta!]` is the same observation about a class this generator
// refuses one gate earlier, and the distinction is worth stating: `[^\ta!]` is
// refused by P0, because `tokenize`/`render` do not round-trip `\t` (the body
// `\ta!` re-renders as `ta!`) — which is the documented `\n`-in-class shape in
// the header. So the weak-class witness is spelled with characters the tokenizer
// reads faithfully; the gate being pinned is unaffected, and the third assertion
// here keeps the brief's own example from quietly becoming a claim nothing runs.
{
  const weak = "[! ]";
  const PROBE11 = ["a", "Z", "0", "_", ".", "/", "+", "-", "!", " ", "\n"];
  const weakAdmits = PROBE11.filter((c) => new RegExp(`^(?:${weak})$`).test(c)).length;
  assert(
    weakAdmits === 2,
    `the weak class \`${weak}\` is genuinely weak: it admits ${weakAdmits} of ${PROBE11.length} probes — one member each way from the admits-nothing refusal (the premise the next assertion depends on)`,
  );
  assert(
    (() => {
      try {
        return mutantsFor(weak).length === 2;
      } catch {
        return false;
      }
    })(),
    `P2 ACCEPTS \`${weak}\` and generates both its deletions — P2 is an admits-nothing/admits-everything gate, NOT a discriminating-power gate (2/${PROBE11.length} probes admitted is enough). Read the comment on PROBE_CHARS before changing this.`,
  );
  // The brief's example, asserted for the refusal it actually gets rather than
  // left as a shape this file implies is accepted.
  refused(
    () => mutantsFor("[^\\ta!]"),
    /round-trip REFUSED/,
    "`[^\\ta!]` is refused by P0 (the `\\t` in the body does not round-trip), so the weak-class witness above is `[! ]` — the weak ACCEPTED shape spelled from characters the tokenizer reads",
  );
}

// The companion: `[^!]`'s mutant is `[^]`, which compiles and admits EVERYTHING.
// Same gate, opposite polarity — a class that matches every character also makes
// every "is this still a citation" fixture answer the same way.
refused(
  () => mutantsFor("[^!]"),
  /is not a usable class.*admitted 11/,
  "a negated single-member class whose mutant `[^]` admits EVERY probe is refused (P2's other polarity — an admits-everything class decides nothing)",
);
// And the shipped classes still generate rows under the mutant-reading probe: if
// the check were simply too strict, the two refusals above and these three rows
// could not coexist. Lives here beside the refusals for exactly that reason — it
// is the counterweight that keeps P2's refusals from reading as mere strictness.
// `test-lens-class-mutants.ts` asserts the same ten rows again on the acceptance
// side; duplicated deliberately, because the pair of claims is the point.
const SHIPPED_MIRROR_PATH = "[A-Za-z0-9_./+-]";
const SHIPPED_MIRROR_NOT_PATH = "[^A-Za-z0-9_./+-]";
assert(
  mutantsFor(SHIPPED_MIRROR_PATH).length === 5 && mutantsFor(SHIPPED_MIRROR_NOT_PATH).length === 5,
  "the shipped mirror classes still generate all ten member rows under the mutant-reading probe (P2 refuses broken mutants, not real ones)",
);

// P3's companion: a deletion that changes MORE than the named member. `[-+a]`
// deletes `+` and leaves `[-a]`, whose leading `-` is now read as a range or an
// escape rather than a member — the class changed meaning, not just membership.
refused(
  () => mutantsFor("[-+a]"),
  /starts with a bare -|changed more than one member|not admitted/,
  "deleting `+` from `[-+a]` is refused: the leftover leading `-` changes the class's meaning",
);

console.log(state.exit === 0 ? "\nAll refusal-witness checks passed." : "\nFAILED");
process.exit(state.exit);
