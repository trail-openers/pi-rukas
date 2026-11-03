/**
 * headless/work-lean-trace — how one lean run's text reaches a host's stderr.
 *
 * Split from `work-lean.ts` at AGENTS.md §12's line cap along the seam the verb
 * already had: the verb decides WHAT to tell the host (its document and exit
 * code), this file makes sure whatever it tells arrives as ONE well-formed
 * NDJSON line. Every rule here is about untrusted text — a git tail, a hostile
 * `Error.name`, a multi-MB stack — reaching a terminal that executes escapes and
 * an NDJSON reader that splits on newlines.
 *
 * The bounds are exported because `test-AC3-empty-message-fallback.ts` asserts
 * against them: a bound nothing reads is a bound nothing tests, and each of these
 * was widened or removed in a mutation before it had a reader.
 */

/**
 * How much of a crash's stack reaches the trace.
 *
 * Exported because the test asserts against THIS number rather than a copy of
 * it: a bound that lives only in the test is a bound nobody chose, and a change
 * here has to be a change there. The text is cut to this BEFORE the newline
 * escaping, so `oneline` never runs over a multi-MB stack, and cut once more
 * AFTER it: escaping turns each `\n` into two characters, so the second cut is
 * what keeps the line at `TRACE_MAX` and lands on escaped text, where a cut
 * cannot split a `\n` pair in half and rejoin two frames.
 */
export const TRACE_MAX = 4000;

/**
 * How long one reason line the host reads may be.
 *
 * Separate from `TRACE_MAX` deliberately: the trace carries a stack a developer
 * needs, the document carries a reason a host prints, and the two bounds answer
 * different questions. `oneLine` clips at this and `clip` at its own bound
 * first, so a value that survives both still fits one record.
 */
export const MESSAGE_MAX = 1000;

/**
 * How long an Error's own `name` may be in the trace label.
 *
 * `name` is the one field a hostile Error supplies VERBATIM into the trace
 * prefix — a 100 KB `name` is a 100 KB line no `TRACE_MAX` on the body would
 * bound, and a `name` carrying a newline would split the record the same way a
 * raw stack would. So it is put through the same single-line rule as the body
 * and bounded on its own: the label is a word, and a word that needs more than
 * this many characters to say "Error" is not a label, it is the payload.
 */
export const NAME_MAX = 120;

/**
 * Every character `oneline` escapes, as ONE regex and ONE pass.
 *
 * The floor is the set that ends a line for SOME reader: `\r` and `\n`, and
 * U+2028 / U+2029 / U+0085, which are line terminators to the JS grammar itself
 * and to any NDJSON splitter that honours CRLF. Same family
 * `lean/text-fence.ts` strips, restated because that one is not exported and
 * folds tab to a space.
 *
 * But stopping at the terminators leaves ESC, BEL and NUL RAW, and those do not
 * need to end a line to do damage: ESC opens a sequence a terminal then
 * EXECUTES, BEL rings the host, and NUL truncates anything that reads the line
 * as a C string. Since the whole point of this function is that a hostile value
 * gets printed on somebody's stderr, the class is widened to every C0 code point
 * below 0x20 plus DEL (0x7f) — `\p{Cc}` — with the three Unicode separators
 * added because they are NOT `\p{Cc}` and would otherwise slip through. Tab is
 * inside the widened class now (it did not end a line, but it is a control
 * character and this is a trace, not a table), and a `\t` escape still spells a
 * stack's indentation. One regex with a replacer, so a multi-MB stack is walked
 * once rather than once per character.
 */
const CONTROL = /[\p{Cc}\u2028\u2029\u0085]/gu;
/** A single backslash — the escape introducer `oneline` writes. */
const BS = String.fromCharCode(0x5c);

/** A reason line a host can print: clipped, and never the whole step log. */
export function clip(text: string): string {
  const reason = text.trim();
  return reason.length > 2000 ? `${reason.slice(0, 2000)}…` : reason;
}

/**
 * Whether a value has anything to say — one predicate, one rule (a blank trim),
 * behind every blank test in this module. A bare `||` on a string treats a
 * whitespace-only message as present, which is AC3's bug.
 */
export function blank(text: string): boolean {
  return text.trim() === "";
}

/**
 * Text a hostile value cannot refuse to give: its own text, or "".
 *
 * "" is the answer that says "this value gave nothing", and the CALLER supplies
 * the stand-in (`UNKNOWN_CRASH` for a crash, nothing at all for a summary) — a
 * stand-in baked in here would leak a crash's wording into text that is not a
 * crash.
 *
 * `String()` is where a thrown value's own code runs — `Symbol.toPrimitive`,
 * `valueOf`, `toString` for a non-Error, and a computed `message`/`stack`
 * property for an Error — and `fail()` is the LAST net this verb has. A throw
 * from any of them escapes the verb, `runSubcommand` rejects, and the host
 * reads an empty stdout where the contract promises one document at 30. So a
 * value that refuses to describe itself still gets a label the host can print.
 * A hostile PROPERTY is handed to this function already read (`readField`),
 * because the read itself has to happen in a frame whose try can catch it.
 */
export function safeText(text: unknown): string {
  if (typeof text === "string") return text;
  // A symbol has no string form — a bare coercion throws — and `description` is
  // the only text it has; "symbol" is what an undecorated one is called.
  if (typeof text === "symbol") return text.description ?? "symbol";
  // `text` arrives already obtained in a guarded frame, so a failed property
  // read reaches here as `undefined`/`null` and becomes "" rather than the word
  // "undefined" — which would otherwise outrank a readable stack in the
  // fallback chain. The throw this catch exists for is the conversion's own.
  if (text === undefined || text === null) return "";
  try {
    return String(text);
  } catch {
    return "";
  }
}

/**
 * Read ONE property in THIS frame, so the throw lands inside this function's try.
 *
 * `String(err.message)` and `{ message: err.message }` do not do: bun evaluates
 * the property read at the CALLER's frame, before any callee's try can see it —
 * so a hostile `message` getter throws past `safeText`'s catch and takes the
 * verb down, which is the exact failure this net exists to stop (measured: the
 * getter's throw escapes with `safeText(String)` as its only guard). Each field
 * is therefore read through a call whose own try can see the throw, and one
 * hostile field cannot take the others with it. A property read, not
 * `Object.getOwnPropertyDescriptor`: reading a getter's descriptor is safe but
 * useless — the value still has to be obtained, and that is the dangerous step.
 * A failed read is `undefined`, which `safeText` turns into "" — never a string,
 * because a sentinel would be `String`-ified into a fake reason that outranks a
 * readable stack in the fallback chain.
 */
export function readField(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * An Error's own fields, each read on its own (`readField` + `safeText`): one
 * getter that throws costs ONLY that field. A try around the whole read would
 * discard a readable `name` and `stack` because `message` refused — exactly what
 * a hostile wrapped Error does.
 *
 * `name` is the one field with a default, because it labels the trace line and
 * an unlabelled warning says nothing about what warned.
 */
export function errorFields(err: Error): { name: string; message: string; stack: string } {
  const name = safeText(readField(err, "name")).trim();
  return {
    name: name === "" ? "Error" : name,
    message: safeText(readField(err, "message")),
    stack: safeText(readField(err, "stack")),
  };
}

/**
 * A multi-line value as ONE line: each line terminator escaped, so nothing
 * splits a record.
 *
 * NOT `oneLine` from `lean/text-fence.ts` — that one is for a MARKDOWN table
 * cell (it escapes `|`, collapses runs of spaces, folds tabs), and a stack
 * wants its indentation. The hazard here is narrower: the headless stderr writer
 * turns each physical line into its own NDJSON record, so every terminator in
 * `LINE_BREAK_CP` becomes its escape (`\n`, `\r`, or `\uXXXX`) and the result
 * holds no terminator at all — and no other control character either, so ESC,
 * BEL and NUL reach a reader as `\u001b` / `\u0007` / `\u0000` text rather than
 * as sequences a terminal executes. An escape is longer than the character it
 * replaces, so callers bound the result AFTER this runs.
 */
export function oneline(text: string): string {
  return text.replace(CONTROL, (ch) => {
    const cp = ch.codePointAt(0) as number;
    // The two ASCII breaks keep their short forms because that is what a
    // developer reading a truncated stack expects; everything else gets the
    // six-character `\u00XX` form, which stays complete without a table.
    if (cp === 0x0a) return `${BS}n`;
    if (cp === 0x0d) return `${BS}r`;
    return `${BS}u${cp.toString(16).padStart(4, "0")}`;
  });
}

/**
 * The trace label: an Error's `name`, scrubbed and bounded.
 *
 * `name` is the only field that reaches the trace VERBATIM — `TRACE_MAX` bounds
 * the body alone — so a 200 KB `name` or a `name` carrying a newline would get
 * past the body's bound and split or flood the record. It goes through
 * `oneline` — cut before the escape so it never walks a huge name, and again
 * after it so the bound holds on the ESCAPED text, because escaping lengthens it
 * (`\r` becomes two characters, U+2028 six) and a bound on the raw label is not
 * a bound on what a reader sees. The cut keeps its ellipsis inside the bound.
 */
export function traceLabel(name: string): string {
  // Cut BEFORE the escape so `oneline` never walks a 200 KB label, then again
  // AFTER it so the bound holds on the text a reader actually sees: an escape
  // only ever lengthens a string (`\r` is two characters, U+2028 six), so a
  // bound on the raw label is not a bound on the escaped one. The ellipsis is
  // counted INSIDE the bound, so the label is never longer than NAME_MAX.
  const scrubbed = oneline(name.slice(0, NAME_MAX));
  return scrubbed.length > NAME_MAX ? `${scrubbed.slice(0, NAME_MAX - 1)}…` : scrubbed;
}
