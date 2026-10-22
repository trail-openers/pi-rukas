/**
 * review-accept-views — the TEXT VIEWS clause (a)'s tests ask their questions of
 * (#1764 criteria 4, 6 and 12). Split out of `review-accept-command.ts` because the
 * matcher there is the tokeniser and the name test, and these three are neither: each
 * rewrites a command into a second text that ONE named test asks, and none of them
 * decides anything.
 *
 *  - `storeNameSubject` — what the name test (clause 1) reads. A heredoc body stays
 *    inside it (a body that spells the store is the store: the bytes land wherever the
 *    command redirects them); a literal value of a known PROSE option does not, because
 *    `git commit -m "…review-accept guard…"` is a sentence about the guard, not a route
 *    to it (#1764 criterion 12 — the shape that refused ~285 fieldbox commands).
 *  - `withoutHeredocBodies` — what the unreadable-word test (clause 5) reads. A body is
 *    data, so an expansion inside one is not a word the shell will substitute into an
 *    argument; leaving it in made `cat > f <<'EOF' … $HOME … EOF` look unreadable (#1764
 *    criterion 4).
 *  - `withSameCommandAssignmentsApplied` — an expansion the command resolves ITSELF
 *    (`F=.git/review-findings.json; cat > $F`) is a word the guard can read, so it is
 *    substituted before either test asks, and the substitution only ever ADDS a name to
 *    the text the name test sees (criterion 6).
 *
 * Every view fails toward the RAW command: a text this module cannot rewrite is asked of
 * the guard exactly as written, so a parser gap costs an over-refusal, never a pass.
 */

import {
  EXPANSION,
  armsOf,
  baseName,
  closingQuote,
  shellWords,
  skipHeredoc,
  unquote,
} from "./review-accept-command.ts";
import { gitVerbIndex } from "./review-accept-verb.ts";

/** An assignment the shell has already resolved by the time the command runs: `NAME=`
 * followed by a literal value, with or without a leading `export`. */
const ASSIGNMENT = /^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/;
/** The SHAPE of an assignment, whatever its value: `NAME=` with or without `export`.
 * #1764 round 4 (rule (b)): the ambiguity count asks this, not `ASSIGNMENT`, so an
 * EXPANSION-valued binding (`F=$V`, `F=$(printf a)`) is COUNTED — a name the command
 * rebinds, or binds to text the guard cannot read, never resolves. Counting only the
 * literal bindings is what made `F=x; F=$V; cat $F` resolve to the stale `x`. */
export const ASSIGNMENT_SHAPE = /^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)=/;
/**
 * A `$NAME` / `${NAME}` occurrence, the unit the substitution below decides about — and
 * ONLY those two spellings. The optional-brace form `\$\{?NAME\}?` matched `${F` without
 * requiring its closing brace, so `cat ${F//zz/}` was substituted into the literal value
 * and the operator form the shell ACTUALLY ran (`${F//zz/}`) vanished from the text the
 * guard read. An operator form (`${F#x}`, `${F%x}`, `${F//x/}`, `${F:5}`, `${F:-x}`) is a
 * DIFFERENT expansion the guard cannot evaluate, so it is never a match here: no match
 * means no substitution means the raw text stands, which is the safe direction (#1764
 * round 5, MUST-DO 2). Both alternatives are anchored on their own delimiters.
 */
const REFERENCE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** A value the guard can substitute: quoted or bare, but spelling no expansion of its
 * own — `VAR=$OTHER` is a value the guard still cannot read, so it binds nothing. */
function literalValue(word: string): [string, string] | undefined {
  const match = ASSIGNMENT.exec(unquote(word));
  if (!match) return undefined;
  const name = match[1] as string;
  const value = match[2] ?? "";
  if (value === "" || EXPANSION.test(value)) return undefined;
  return [name, value.replace(/^(['"])(.*)\1$/, "$2")];
}

/** The `$NAME` spellings of a word, rewritten with the bindings established BEFORE this
 * word in the command. A name the command never bound, or bound twice with different
 * values, is left exactly as written — an unresolved word is a word the guard keeps.
 * A single-quoted span is copied verbatim: the shell substitutes nothing inside one. */
function expandWord(word: string, values: Map<string, string>, ambiguous: Set<string>): string {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const c = word[i] as string;
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      const stop = end < 0 ? word.length : end + 1;
      out += word.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "$") {
      REFERENCE.lastIndex = 0;
      const match = REFERENCE.exec(word.slice(i));
      if (match && (match.index ?? 0) === 0) {
        // One of the two alternatives fired: the braced form carries the name in group 1,
        // the bare `$NAME` form in group 2.
        const name = (match[1] ?? match[2]) as string;
        const value = ambiguous.has(name) ? undefined : values.get(name);
        if (value !== undefined) {
          out += value;
          i += match[0].length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

const WORD_END = /[\s;|&()<>]/;

/**
 * Substitute the `$NAME` / `${NAME}` spellings of variables this SAME command assigned a
 * literal value to, so `F=.git/review-findings.json; cat > $F` is adjudicated as the
 * command the shell actually runs. Substitution is one-directional on purpose: the result
 * is only ever handed to the NAME test, so resolving a variable can bring a command INTO
 * scope, never take a store name out of it.
 *
 * The scan is ORDER- and SEGMENT-aware (#1764 fix round, criterion 6): a word sees only
 * the bindings that stand BEFORE it in the command, so `cat $F; F=notes.txt` keeps its
 * unreadable operand; and a name bound more than once with DIFFERENT values is left
 * unresolved rather than guessed at, so `F=.git/review-findings.json; F=x; cat $F` stays
 * the unreadable read it is. Single-quoted regions bind nothing and expand nothing, and a
 * heredoc BODY binds nothing — a body line that reads `F=x` is text, not an assignment.
 */
/** Walk one command the way the substitution scanner needs to: quoted spans and heredocs
 * come back as opaque COPY tokens (the shell substitutes nothing inside a single-quoted
 * span, and a heredoc body is data that binds nothing), everything else comes back as a
 * WORD. Returns false when a heredoc or a quote never closed — the caller then asks its
 * question of the raw text rather than of a half-built rewrite. */
function forEachToken(command: string, onToken: (text: string, isWord: boolean) => void): boolean {
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end + 1;
      onToken(command.slice(i, stop), false);
      i = stop;
      continue;
    }
    if (command.startsWith("<<", i) && !command.startsWith("<<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return false;
      onToken(command.slice(i, past.end), false);
      i = past.end;
      continue;
    }
    if (/\s/.test(c) || ";|&".includes(c)) {
      // A separator is copied too: the caller rebuilds the command text from the tokens.
      onToken(c, false);
      i++;
      continue;
    }
    const start = i;
    while (i < command.length && !WORD_END.test(command[i] as string)) {
      const ch = command[i] as string;
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        i = end < 0 ? command.length : end + 1;
        continue;
      }
      if (ch === '"') {
        const end = closingQuote(command, i);
        i = end < 0 ? i + 1 : end + 1;
        continue;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      i++;
    }
    const word = command.slice(start, i);
    if (word === "") {
      // A shell metacharacter the word scan refuses to eat — `(`, `)`, a single `<` or `>`.
      // Copied verbatim and the walk moves on: a scan that made no progress here would
      // never terminate, and this one runs on every guarded command.
      onToken(c, false);
      i++;
      continue;
    }
    onToken(word, true);
  }
  return true;
}

/**
 * Substitute the `$NAME` / `${NAME}` spellings of variables this SAME command assigned a
 * literal value to, so `F=.git/review-findings.json; cat > $F` is adjudicated as the
 * command the shell actually runs. Substitution is one-directional on purpose: the result
 * is only ever handed to the NAME test, so resolving a variable can bring a command INTO
 * scope, never take a store name out of it. An unresolved word is always COPIED — the
 * substitution may add a name to the text the name test reads and may never remove an
 * expansion from the text the unreadable-word test reads (#1764 fix round 3, H2).
 *
 * The scan is ORDER- and SEGMENT-aware (#1764 fix round, criterion 6) and needs TWO passes
 * to be honest about it: a word sees only the bindings that stand BEFORE it, so
 * `cat $F; F=notes.txt` keeps its unreadable operand; and the ambiguity of a name is judged
 * over the WHOLE command, so a decoy rebinding anywhere — `F=a; cat $F; F=b` — leaves the
 * name unreadable rather than resolving it to whichever value the scan happened to reach
 * first. Single-quoted regions bind nothing and expand nothing, and a heredoc BODY binds
 * nothing — a body line that reads `F=x` is text, not an assignment.
 */
export function withSameCommandAssignmentsApplied(command: string): string {
  // Pass one: EVERY binding the command states — literal or not (#1764 round 4, rule
  // (b)). A name bound more than once (even to the same value), or bound once to text the
  // guard cannot read, is ambiguous and NEVER resolves: the guard cannot say which value
  // the shell used at the point of use, and a stale literal standing in for an
  // expansion-valued rebinding is exactly how `F=x; F=$V; cat $F` read as a resolved
  // read. Judged over the whole command, before any substitution decision.
  const stated = new Map<string, string>();
  const ambiguous = new Set<string>();
  const collected = forEachToken(command, (text, isWord) => {
    if (!isWord || text.startsWith("-")) return;
    const shape = ASSIGNMENT_SHAPE.exec(unquote(text));
    if (!shape) return;
    const name = shape[1] as string;
    const binding = literalValue(text);
    if (!binding) {
      // An expansion-valued (or empty) binding: the name is bound, the value is unknown.
      ambiguous.add(name);
      return;
    }
    const [bound, value] = binding;
    if (stated.has(bound)) ambiguous.add(bound);
    else stated.set(bound, value);
  });
  if (!collected) return command;

  // Pass two: the rewrite, binding as it goes so a reference sees only what came BEFORE it.
  const values = new Map<string, string>();
  let out = "";
  const rewritten = forEachToken(command, (text, isWord) => {
    if (!isWord) {
      out += text;
      return;
    }
    const binding = text.startsWith("-") ? undefined : literalValue(text);
    if (binding) {
      const [name, value] = binding;
      const prior = values.get(name);
      if (prior === undefined && !ambiguous.has(name)) values.set(name, value);
      out += text;
      return;
    }
    out += expandWord(text, values, ambiguous);
  });
  return rewritten ? out : command;
}

/** One walk of the command, split into the part the shell parses and the parts it only
 * carries. `readable: false` means a heredoc or a quote never closed: nothing is safely
 * removable, so the caller asks its question of the raw text. */
interface HeredocSplit {
  readonly visible: string;
  readonly bodies: string;
  readonly readable: boolean;
}

function splitHeredocs(command: string): HeredocSplit {
  let visible = "";
  let bodies = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i] as string;
    if (c === "'" || c === '"') {
      const end = closingQuote(command, i);
      if (end < 0) return { visible: command, bodies: "", readable: false };
      visible += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (command.startsWith("<<", i) && !command.startsWith("<<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return { visible: command, bodies: "", readable: false };
      // A QUOTED tag is the one body the shell never expands, so only THAT body may be
      // set aside; an unquoted body is substituted into the command line and stays
      // visible to the expansion test (#1764 fix round, criterion 4). The words after the
      // closing tag are arguments either way, and so are the words after the OPENING tag
      // — `cat <<'EOF' > $F` redirects, quoted body or not (criterion 5).
      const args = [past.head, past.tail].filter((x) => x !== "").join(" ");
      if (past.quoted) {
        visible += args === "" ? " << " : ` << ${args} `;
        bodies += `\n${command.slice(past.bodyStart, past.bodyEnd)}`;
      } else {
        visible += command.slice(i, past.end);
      }
      i = past.end;
      continue;
    }
    visible += c;
    i++;
  }
  return { visible, bodies, readable: true };
}

/** The command with every QUOTED-delimiter heredoc BODY replaced by the bare `<<` marker,
 * for the tests that must not see body text. An UNQUOTED body is shell-expanded — it is
 * arguments the program will receive, so it stays. An unreadable heredoc leaves the text
 * as written. */
export function withoutHeredocBodies(command: string): string {
  return splitHeredocs(command).visible;
}

/** The prose options whose VALUE the shell hands straight to a program that writes it as
 * text: `git commit -m` / `--message`, and `gh` / `glab` `--title`, `--body` and `-m`.
 * Deliberately NOT a list of "flags that look harmless": `-F` takes a FILE, `--file`
 * takes a FILE, and a value the guard excuses is a value it will never name-check. */
function proseFlagsFor(segment: string): ReadonlySet<string> | undefined {
  const words = shellWords(segment);
  if (words.length < 2) return undefined;
  const program = baseName(unquote(words[0] ?? ""));
  if (program === "gh" || program === "glab") return FORGE_PROSE;
  if (program !== "git") return undefined;
  // The verb is read by the ONE git-verb reader, so `git -C <worktree> commit -m "…"` is
  // masked exactly as `git commit -m "…"` is — a second, position-of-word-1 reader made
  // the sanctioned worktree form lose its prose mask and refuse a plain commit message.
  const verb = gitVerbIndex(words);
  return verb >= 0 && unquote(words[verb] ?? "") === "commit" ? GIT_COMMIT_PROSE : undefined;
}
const GIT_COMMIT_PROSE = new Set(["-m", "--message"]);
const FORGE_PROSE = new Set(["-m", "--title", "--body"]);

/** Is this word a quoted literal carrying no expansion? `-m "$(cat secret)"` is NOT
 * prose — the value is bytes the guard cannot read, and the command stays in scope
 * whatever the option's name is (criterion 12's second sentence). */
function isLiteralProse(word: string): boolean {
  const quote = word[0];
  if ((quote !== "'" && quote !== '"') || word.length < 2) return false;
  if (closingQuote(word, 0) !== word.length - 1) return false;
  return !EXPANSION.test(word);
}

/** One segment with the contents of its prose options blanked; everything else verbatim. */
function maskProseSegment(segment: string): string {
  const words = shellWords(segment);
  if (words.length < 2) return segment;
  const flags = proseFlagsFor(segment);
  if (!flags) return segment;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    // The `=`-attached spelling carries its own value: `--body="…"`.
    const attached = [...flags].find((flag) => word.startsWith(`${flag}=`));
    if (attached) {
      const value = word.slice(attached.length + 1);
      out.push(isLiteralProse(value) ? `${attached}=" "` : word);
      continue;
    }
    if (flags.has(unquote(word))) {
      const next = words[i + 1];
      out.push(word);
      if (next !== undefined) out.push(isLiteralProse(next) ? '" "' : next);
      i++;
      continue;
    }
    out.push(word);
  }
  return out.join(" ");
}

/**
 * The text the NAME test asks: prose option values blanked, heredoc bodies kept. A
 * command this module cannot walk (an unterminated heredoc or quote) is returned as
 * written — the mask is a relaxation, and a relaxation must not survive a parse gap.
 */
export function storeNameSubject(command: string): string {
  const substituted = withSameCommandAssignmentsApplied(command);
  const split = splitHeredocs(substituted);
  if (!split.readable) return substituted;
  return `${armsOf(split.visible).map(maskProseSegment).join("\n")}\n${split.bodies}`;
}
