/**
 * work-driver-verify-header-leaf — the Rust/cargo panic HEADER: the one
 * spelling that recognises it, the name it carries, and the per-thread id
 * normaliser that keeps identity stable across runs.
 *
 * Why a leaf, and why it is separate from `work-driver-verify-rust.ts`: every
 * panic decision in the verify layer — the table's `rust-panic` entry, the
 * anywhere-in-text recognizer, the quote veto, the excuse gate, the sameness key
 * and the containment side of `sharesAssertion` — asks the same question about
 * the same token run. The #2341 fix wave (H2) settled that the run has ONE
 * spelling; this module is where it is spelled, so a consumer imports it and can
 * never re-state it. The stream-scanning predicates that ASK it (the per-test
 * verdict correlation over a whole run) stay in `work-driver-verify-rust.ts`,
 * which imports the readers here, as does the table in
 * `work-driver-verify-shapes.ts`. Nothing here imports either of them: the
 * direction is one-way, which is what keeps the module graph a DAG.
 *
 * THE PER-THREAD ID, and why it belongs to the header's owner. A current cargo
 * prints `thread 'tests::failing_unit' (2271626) panicked at src/lib.rs:34:9:`
 * — an OS thread id between the quoted name and `panicked at`, on EVERY header
 * the toolchain prints (`main` and `worker-N` included), per-THREAD rather than
 * per-process, so it differs between two runs of the same failure. Two
 * consequences follow, and both are decided once, here:
 *
 *   - RECOGNITION tolerates it. Make it optional in one matcher only and the
 *     dialect is inert on a current toolchain: the header matches nothing, yet
 *     still opens like a header, so it is unparseable rather than absent — the
 *     name reads `undefined` and the sameness key reads `null`, and every gate
 *     that fails closed on those answers silently stops gating;
 *   - IDENTITY removes it, out of BOTH operands of every comparison. A key with
 *     the id stripped against a haystack that still carries it never contains
 *     each other, so the base excuse silently stops matching while a unit test
 *     on the key alone stays green. `stripRustPanicThreadIds` is therefore asked
 *     of the key AND of the haystack, by the one reader that compares them.
 *
 * The id is never part of a NAME, a KEY, or a CONTAINMENT haystack — and it is
 * never stripped from what the OPERATOR is shown: the published quote keeps the
 * bytes the run printed, because the id is where the operator looks up the
 * thread in the log.
 */

/** The header's opening token up to the quoted name. */
const RUST_PANIC_HEAD_SRC = String.raw`thread\s+'`;
/** The quoted test/thread name, quotes and all — the header's subject. */
const RUST_PANIC_NAME_BODY_SRC = String.raw`[^']+`;
/** …and the same name as group 1, which is the form every reader extracts. */
const RUST_PANIC_NAME_SRC = String.raw`(${RUST_PANIC_NAME_BODY_SRC})`;
/** cargo's per-thread id, `(2271626)`, between the name and `panicked at `. */
const RUST_PANIC_ID_SRC = String.raw`(?:\s+\(\d+\))?`;
/** The verb that separates the header's subject from its location. */
const RUST_PANIC_PANICKED_SRC = String.raw`panicked\s+at\s`;

/**
 * The header's opening token run — the ONE spelling every reader composes from
 * (`RUST_PANIC_RE`, `RUST_PANIC_GLOBAL_RE`, `RUST_PANIC_HEADER_FORM` and the
 * normaliser's `RUST_PANIC_ID_FORM_RE` below). Private to this module on
 * purpose: a consumer that imported the fragment could re-assemble it wrongly,
 * which is the drift the #2341 fix wave (H2) removed. Four literals spelling the
 * same token run is four answers to "is this a panic header", and the drift
 * between them is how a `warning:`-prefixed or record-lifted header ended up
 * neither vetoed as a quote nor gated as an excuse.
 */
const RUST_PANIC_OPEN_SRC = String.raw`${RUST_PANIC_HEAD_SRC}${RUST_PANIC_NAME_SRC}'${RUST_PANIC_ID_SRC}\s+${RUST_PANIC_PANICKED_SRC}`;

/** The header's location token — the separator-free run after `panicked at `. */
const RUST_PANIC_LOC_SRC = String.raw`\S+`;

/**
 * The header anchored at line start — what the failure table's `rust-panic`
 * shape entry asks, and what reads the test name out of a header the caller
 * already holds. A gate's own prefix (`warning:`, a timestamp, `[INFO]`, an
 * ANSI colour, the harness's record sentence) is NOT a panic header in this
 * position; {@link rustPanicHeaderIn} is the arm that sees through one.
 */
export const RUST_PANIC_RE = new RegExp(String.raw`^${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}`);

/**
 * The same header, searched for anywhere in a text. `g` so ONE spelling serves
 * both "the first header in this text" ({@link rustPanicHeaderIn}) and "every
 * header this record carries" (`changePanicsAreBaseFailures`); both go through
 * `matchAll`, which works on a CLONE of this regex, so the shared instance's
 * `lastIndex` is never advanced by a reader.
 */
export const RUST_PANIC_GLOBAL_RE = new RegExp(
  String.raw`${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}`,
  "g",
);

/**
 * The identity form — the header run demanded THROUGH its trailing colon and
 * then whitespace or end of string, which is what separates a header from a
 * clipped or inline-shaped lookalike. Captured whole so the sameness key is the
 * matched token run and not a re-spelling of it.
 */
const RUST_PANIC_HEADER_FORM = new RegExp(
  String.raw`^(${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}:)(?:\s|$)`,
);

/**
 * "Does this merely OPEN like a header?" — the fail-closed question, asked of a
 * string whose identity could not be parsed. Deliberately looser than the
 * matchers above: it is the arm that decides a header-shaped string compares as
 * NOTHING rather than by falling back to substring containment, so it must fire
 * on every spelling a header can arrive in, including the pre-1.73 inline form
 * (`thread 'main' panicked at 'boom: oh', src/main.rs:5:5`), whose token run
 * does not end at a colon and whose identity is not what this dialect extracts.
 */
const PANIC_HEADER_LOOK_RE = /^thread\s+'/;

/**
 * The id-bearing header open with its id as the piece the normaliser drops,
 * composed from the SAME sources as the matchers — so "which token run is a
 * header" has one answer and {@link stripRustPanicThreadIds} cannot recognise a
 * header the matchers would refuse (or miss one they would take). The
 * replacement re-joins the two kept groups with a single space, which is the
 * whitespace cargo prints, so a normalised id-bearing header is byte-identical
 * to the id-less spelling of the same failure.
 */
const RUST_PANIC_ID_FORM_RE = new RegExp(
  String.raw`(${RUST_PANIC_HEAD_SRC}${RUST_PANIC_NAME_BODY_SRC}')\s+\(\d+\)\s+(${RUST_PANIC_PANICKED_SRC})`,
  "g",
);

/**
 * Remove cargo's per-thread id from every panic header in `text`, leaving every
 * other byte (including the id inside a message, a path or a tally) untouched:
 * the pattern is anchored on the whole header open, so an ordinary parenthesised
 * number in prose is not a header and is not edited.
 *
 * BOTH operands of an identity comparison go through this — the key AND the
 * haystack it is contained in. The id is volatile across runs, so comparing an
 * id-stripped key against raw stream text makes every base-excuse miss while
 * key-vs-key unit tests stay green; that asymmetry is the trap this function
 * exists to close, and it is why it is exported rather than folded into the key
 * alone.
 */
export function stripRustPanicThreadIds(text: string): string {
  return text.replace(
    RUST_PANIC_ID_FORM_RE,
    (_match: string, open: string, at: string): string => `${open} ${at}`,
  );
}

/** The test name a panic header carries, or `undefined` if it does not parse. */
export function rustPanicTestName(header: string): string | undefined {
  return RUST_PANIC_RE.exec(header)?.[1];
}

/**
 * The panic header carried ANYWHERE in `text`, prefix and all, or `undefined`.
 * Returns the matched header token run — the text from `thread` through the
 * `file:line:col`, per-thread id included — so a caller can hand the answer
 * straight back to {@link rustPanicTestName} and every other line-anchored
 * header reader, and quote it verbatim to the operator.
 *
 * THE ONE RECOGNIZER (#2341). The quote veto used to ask the table's shape key
 * and the excuse gate its own line-anchored look; a header the gate printed with
 * a prefix satisfied neither, so it could be quoted as captured output AND grant
 * an excuse. Every panic decision asks THIS instead, through the one global
 * spelling above, so they cannot drift apart again: `extractSpecificAssertion`
 * (the quote), `panicCanExcuseChange` (the excuse) and
 * `changePanicsAreBaseFailures` (the excuse, per failing test of the change's
 * record). A text this answers `undefined` for is not a panic to any of them.
 */
export function rustPanicHeaderIn(text: string): string | undefined {
  return text.matchAll(RUST_PANIC_GLOBAL_RE).next().value?.[0];
}

/**
 * The SAMENESS key of a Rust panic assertion. The extractor joins the header and
 * its message for the operator-facing value; two runs of the SAME failing test
 * print that pair byte-identically, and two DIFFERENT failing tests in one
 * target differ exactly in the header (test name, file, line, column). So the
 * header alone — with cargo's per-thread id removed by
 * {@link stripRustPanicThreadIds}, because it changes every run — is the
 * identity the sameness comparison anchors on.
 *
 * What the key guarantees, stated exactly: a clip that falls in the MESSAGE
 * cannot fold two failures, because the message is what the key discards. A clip
 * that falls INSIDE the header fails CLOSED (#2341 fix wave M1): a string that
 * starts like a panic header (`^thread '`) but whose identity (test name /
 * file:line:col) cannot be extracted answers `null`, and `null` is the answer no
 * sameness reader may turn into a "SAME assertion" claim — the pre-fix fallback
 * to the whole clipped string was the substring-containment rule that ticket
 * exists to remove, reachable again through the one dialect that anchors sameness
 * on a header. The fail-closed half is asked of anything that merely LOOKS like a
 * header ({@link PANIC_HEADER_LOOK_RE}), which includes the pre-1.73 inline form:
 * its token run does not end at a colon, its identity is not what the key
 * extracts, and a quote that only resembles a parseable header compares as
 * nothing rather than reopening the containment rule. That inline form keeps its
 * known misparse when its message contains a colon; it is a disclosed limitation
 * of the pre-1.73 spelling, not a case this key folds. Any other assertion —
 * every shape that does not open with the panic look — is its own key; exact
 * containment is unchanged for it.
 */
export function rustPanicSamenessKey(assertion: string): string | null {
  const header = RUST_PANIC_HEADER_FORM.exec(assertion)?.[1];
  if (header !== undefined) return stripRustPanicThreadIds(header);
  return PANIC_HEADER_LOOK_RE.test(assertion) ? null : assertion;
}
