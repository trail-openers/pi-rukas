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
 *    to it (#1764 criterion 12 — the shape that refused ~285 halo commands).
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
  armsOf,
  baseName,
  closingQuote,
  shellWords,
  skipHeredoc,
  unquote,
} from "./review-accept-command.ts";

/** An assignment the shell has already resolved by the time the command runs: `NAME=`
 * followed by a literal value, with or without a leading `export`. */
const ASSIGNMENT = /^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$/;

/** A value the guard can substitute: quoted or bare, but spelling no expansion of its
 * own — `VAR=$OTHER` is a value the guard still cannot read, so it binds nothing. */
function literalValue(word: string): [string, string] | undefined {
  const match = ASSIGNMENT.exec(unquote(word));
  if (!match) return undefined;
  const name = match[1] as string;
  const value = match[2] ?? "";
  if (value === "" || /[$`]/.test(value)) return undefined;
  return [name, value.replace(/^(['"])(.*)\1$/, "$2")];
}

/**
 * Substitute the `$NAME` / `${NAME}` spellings of variables this SAME command assigned a
 * literal value to, so `F=.git/review-findings.json; cat > $F` is adjudicated as the
 * command the shell actually runs. Substitution is one-directional on purpose: the result
 * is only ever handed to the NAME test, so resolving a variable can bring a command INTO
 * scope, never take a store name out of it.
 */
export function withSameCommandAssignmentsApplied(command: string): string {
  const bindings = new Map<string, string>();
  for (const segment of armsOf(command)) {
    for (const word of shellWords(segment)) {
      const binding = literalValue(word);
      if (binding) bindings.set(binding[0], binding[1]);
    }
  }
  if (bindings.size === 0) return command;
  return command.replace(
    /\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g,
    (whole, name: string) => bindings.get(name) ?? whole,
  );
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
    if (command.startsWith("<<", i)) {
      const past = skipHeredoc(command, i);
      if (past === "PARSE_FAIL") return { visible: command, bodies: "", readable: false };
      visible += " << ";
      bodies += `\n${command.slice(i, past)}`;
      i = past;
      continue;
    }
    visible += c;
    i++;
  }
  return { visible, bodies, readable: true };
}

/** The command with every heredoc BODY replaced by the bare `<<` marker, for the tests
 * that must not see body text. An unreadable heredoc leaves the text as written. */
export function withoutHeredocBodies(command: string): string {
  return splitHeredocs(command).visible;
}

/** The prose options whose VALUE the shell hands straight to a program that writes it as
 * text: `git commit -m` / `--message`, and `gh` / `glab` `--title`, `--body` and `-m`.
 * Deliberately NOT a list of "flags that look harmless": `-F` takes a FILE, `--file`
 * takes a FILE, and a value the guard excuses is a value it will never name-check. */
function proseFlagsFor(program: string, verb: string): ReadonlySet<string> | undefined {
  if (program === "git") return verb === "commit" ? GIT_COMMIT_PROSE : undefined;
  if (program === "gh" || program === "glab") return FORGE_PROSE;
  return undefined;
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
  return !/[$`]/.test(word);
}

/** One segment with the contents of its prose options blanked; everything else verbatim. */
function maskProseSegment(segment: string): string {
  const words = shellWords(segment);
  if (words.length < 2) return segment;
  const flags = proseFlagsFor(baseName(unquote(words[0] ?? "")), baseName(unquote(words[1] ?? "")));
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
