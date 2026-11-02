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
    `${label}: threw ${threw.constructor.name}, not ClassRefused (${threw.message})`,
  );
  assert(
    why.test(threw.message),
    `${label}: refused for the wrong reason — message was ${JSON.stringify(threw.message)}, expected /${why.source}/`,
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
    assert(
      !/(^|[^\\])-[]]/.test(m.mutated.slice(1, -1)),
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

// P3's companion: a deletion that changes MORE than the named member. `[-+a]`
// deletes `+` and leaves `[-a]`, whose leading `-` is now read as a range or an
// escape rather than a member — the class changed meaning, not just membership.
refused(
  () => mutantsFor("[-+a]"),
  /starts with a bare -|changed more than one member|not admitted/,
  "deleting `+` from `[-+a]` is refused: the leftover leading `-` changes the class's meaning",
);


// ───────────────────────── the harness that feeds the tables

import { CORPUS, measuredTable, runShipped, SHIPPED } from "./lib/lens-mutant-harness.ts";

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
}

console.log(exit === 0 ? "\nAll generator-witness checks passed." : "\nFAILED");
process.exit(exit);
