#!/usr/bin/env bun
/**
 * The generator's witnesses. `lens-class-mutants.ts` is what the per-member
 * tables in `lens-flank-escape-probe.ts` are built from, so a generator that
 * silently produced the WRONG set would make every number in that table a
 * fabrication wearing a hash. This file is the falsifiable half of that claim:
 * four shapes that a plausible tokenizer corrupts SILENTLY — preconditions pass,
 * wrong set results — each asserted to be REFUSED, plus the shipped classes
 * asserted to be ACCEPTED, plus each precondition given a mutant that violates
 * exactly that one and is refused for it.
 *
 * WHY REFUSALS AND NOT JUST ACCEPTANCES. An acceptance test proves the generator
 * runs; it cannot prove the generator is not wrong. The three shapes below came
 * from rebuilding the generator the adversarial gate described and probing it
 * with inputs it had never seen, and all three produced a mutant that looked
 * valid. A generator whose only tests are "it returns rows for the shipped
 * classes" would have passed every one of them while the table it fed was wrong.
 *
 * Each refusal is asserted on its MESSAGE, not merely on "it threw": a `throw`
 * from a typo in this test file is indistinguishable from a refusal, and the
 * whole point is which of the two happened.
 */

import {
  ClassRefused,
  mutantTable,
  mutantsFor,
  render,
  singleMembers,
  tokenize,
} from "./lib/lens-class-mutants.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Run `fn`, and assert it refused with a message matching `why`. */
function refused(fn: () => unknown, why: RegExp, label: string): void {
  let threw: Error | undefined;
  let value: unknown;
  try {
    value = fn();
  } catch (e) {
    threw = e as Error;
  }
  if (!threw) {
    assert(
      false,
      `${label}: expected a REFUSAL and the generator returned ${JSON.stringify(value).slice(0, 160)} — a silent wrong set is the defect this file exists to catch`,
    );
    return;
  }
  assert(
    threw instanceof ClassRefused,
    threw instanceof ClassRefused
      ? `${label}: refused as ClassRefused (expected /${why.source}/)`
      : `${label}: threw ${threw.constructor.name}, not ClassRefused (${threw.message})`,
  );
  assert(
    why.test(threw.message),
    why.test(threw.message)
      ? `${label}: refused for the expected reason (${JSON.stringify(threw.message).slice(0, 120)})`
      : `${label}: refused for the WRONG reason — message was ${JSON.stringify(threw.message)}, expected /${why.source}/`,
  );
}

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
// could not coexist.
assert(
  mutantsFor(PATH_CHAR).length === 5 && mutantsFor(NOT_PATH).length === 5,
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


// ───────────────────────── the harness that feeds the tables

import { CORPUS, measuredTable, runMutant, runShipped, SHIPPED, wholeClassRemoval } from "./lib/lens-mutant-harness.ts";

{
  const baseline = runShipped();
  assert(
    baseline.length === 0,
    `the shipped matcher satisfies every harness fixture — a corpus that fails here would make every "0 reds" in the table meaningless (failing: ${JSON.stringify(baseline)})`,
  );
  assert(CORPUS.length > 40, `the corpus is broad enough to name a flank: ${CORPUS.length} fixtures`);
  for (const flank of ["PATH_CHAR", "NOT_PATH", "TERMINATOR"] as const) {
    const rows = measuredTable(flank);
    assert(
      rows.every((r) => r.mutant.shipped === SHIPPED[flank]),
      `${flank}: every measured row declares the shipped class it was generated from`,
    );
    // The two mirror constants must BOTH produce rows: a harness that silently
    // measured one side is the defect this branch closes.
    assert(rows.length >= 5, `${flank}: ${rows.length} measured rows generated`);
  }
  const pathChar = measuredTable("PATH_CHAR");
  const notPath = measuredTable("NOT_PATH");
  const anyPathCharRed = pathChar.some((r) => r.reds.length > 0);
  const anyNotPathRed = notPath.some((r) => r.reds.length > 0);
  assert(
    anyPathCharRed && anyNotPathRed,
    `BOTH flanks redden under some member deletion (PATH_CHAR ${JSON.stringify(pathChar.map((r) => r.reds.length))}, NOT_PATH ${JSON.stringify(notPath.map((r) => r.reds.length))}) — a table that measured only one side could not print this`,
  );

  // THE CONTROL PAIR, as an assertion and not a header sentence. Two halves:
  // (1) the shipped class substituted for itself reddens ONLY the fixtures whose
  // right flank is decided by the class the harness does not substitute — the
  // two lone-CR fixtures, because `mentionsPathWith` takes NOT_LINE_BREAK as an
  // argument and a member-only mutant leaves that argument the shipped value
  // while the CR pair is decided by it. A no-op substitution that reddened a
  // PATH_CHAR or NOT_PATH fixture would mean the corpus and the shipped matcher
  // disagree, and every `0` on the table would then be meaningless; the CR pair is
  // the documented, non-PATH_CHAR exception, asserted rather than swept under.
  // (2) a real member deletion reddens the fixture that member exists to catch,
  // `PATH_CHAR_PLUS` first, among the CR siblings. Both halves together prove the
  // harness can both stay green (for the flank it is substituting) and redden.
  const noop = runMutant("PATH_CHAR", SHIPPED.PATH_CHAR);
  const noopNonCr = noop.filter((n) => !/lone CR/.test(n));
  assert(
    noopNonCr.length === 0,
    `control half 1: substituting the shipped class bytes for themselves reddens no PATH_CHAR/NOT_PATH fixture (${JSON.stringify(noopNonCr)}) — the only reds are the lone-CR pair, whose right flank is NOT_LINE_BREAK (not substituted by a member mutant); any OTHER red here means the corpus and the shipped matcher disagree and every table 0 is then meaningless`,
  );
  const oneDeletion = measuredTable("PATH_CHAR").find((r) => r.mutant.member === "+");
  assert(
    oneDeletion !== undefined &&
      oneDeletion.reds.includes("canary: a path followed by a terminal `+` is not a citation (PATH_CHAR_PLUS)"),
    `control half 2: \`PATH_CHAR\` minus \`+\` reddens the fixture the \`+\` member exists to catch, PATH_CHAR_PLUS (got ${oneDeletion ? JSON.stringify(oneDeletion.reds) : "no such row"}) — with half 1 this is the pair proving the harness can both stay green and redden`,
  );

  // THE WHOLE-CLASS CONTROL: asserted where it exists, asserted ABSENT where it
  // does not. `wholeClassRemoval` used to hand back a red count for all three
  // flanks, produced by interpolating `""` into the class position — `(?!|…)` and
  // `(?:^|)`, which redden 17 fixtures each for a reason unrelated to membership.
  // That is a whole-class figure wearing a label it did not earn, so those two
  // flanks now return null and an assertion holds them there.
  const termWhole = wholeClassRemoval("TERMINATOR");
  assert(
    termWhole !== null && termWhole.length > 0,
    `whole-class control: deleting the anchored TERMINATOR arm reddens ${termWhole?.length ?? "null"} fixture(s) — the figure the table's TERMINATOR rows are read against (${JSON.stringify(termWhole)})`,
  );
  for (const flank of ["PATH_CHAR", "NOT_PATH"] as const) {
    assert(
      wholeClassRemoval(flank) === null,
      `${flank}: NO whole-class control is offered — an empty class in that position changes the ARM rather than the membership, so any figure printed for it would be red for the wrong reason (got ${JSON.stringify(wholeClassRemoval(flank))})`,
    );
  }

  // The formatter the header's table rows are built from. Called here so a change
  // that makes it throw, or drops the representative/survivors a row is audited
  // by, is a red rather than a header describing a function nobody ran.
  const printed = mutantTable(SHIPPED.PATH_CHAR);
  assert(
    printed.length === 5 &&
      printed.every((l) => l.includes("representative") && l.includes("survivors")),
    `mutantTable renders one line per member carrying its representative and survivors (${printed.length} lines)`,
  );
}

// ───────────────────────── the table's numbers are a RUN, not a transcription

{
  // THE RECONCILIATION. The per-member table in `lens-flank-escape-probe.ts`
  // publishes a red count per member; a table transcribed into a header is a
  // second source of truth that silently rots the moment a fixture is added.
  // The block below re-measures every member and asserts the header states
  // EXACTLY these counts — so a future fixture that shifts a number reddens
  // this run instead of leaving the header describing a table nobody printed.
  // This is the executable answer to the reviewer's "the prose table is not
  // regenerated at runtime" finding.
  const EXPECTED: Record<string, Record<string, number | undefined>> = {
    PATH_CHAR: { _: 3, ".": 3, "/": 3, "+": 3, "-": 2 },
    NOT_PATH: { _: 3, ".": 3, "/": 9, "+": 8, "-": 3 },
    TERMINATOR: { "!": 2, "?": 2, ",": 2, ".": 4, ";": 2, ":": 2, "-": 3 },
  };
  for (const flank of ["PATH_CHAR", "NOT_PATH", "TERMINATOR"] as const) {
    const rows = measuredTable(flank);
    for (const r of rows) {
      const want = EXPECTED[flank]?.[r.mutant.member];
      assert(
        want === r.reds.length,
        `table reconciliation: ${flank} minus ${JSON.stringify(r.mutant.member)} measures ${r.reds.length} reds and the header must state that (${want === undefined ? "member absent from EXPECTED" : "header says " + want}) — if this reddens, a fixture moved the count and the table in lens-flank-escape-probe.ts needs the new figure, not a change here`,
      );
    }
  }
}

console.log(exit === 0 ? "\nAll generator-witness checks passed." : "\nFAILED");
process.exit(exit);
