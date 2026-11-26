/**
 * child-forge-read-words.ts — the path primitives the #2638 read rule is built on.
 *
 * One word in, "is this a protected path (or under one)?" out — the answer the
 * command judge (`child-forge-read-judge.ts`) asks word by word and the program
 * judge (`child-forge-read-programs.ts`) asks of every path it finds inside an
 * interpreter's text or a copy verb's source. Both judges import these rather than
 * each carrying a matcher: two spellings of "beneath a protected root" is how one
 * of them ends up wrong.
 *
 * Two things every judgement does, and neither is optional:
 *
 *  - it asks in BOTH spellings, the lexical one the command typed and the one the
 *    OS opens (`formsOf`), so a symlink onto a protected tree is refused whichever
 *    name was used;
 *  - it compares WITHOUT regard to case, so the shifted spelling of a protected
 *    root (`.config/GH/…`) on a case-sensitive filesystem is the same tree to the
 *    rule as the lower-case one every resolver produces. The matcher is still
 *    component-wise: `.config/ghost/…` is not `gh`.
 *
 * A protected set is data the PARENT produced; nothing here reads an environment
 * to build one.
 */

import path from "node:path";
import { expandHome, safeResolve } from "./write-fence-path.ts";

/** A protected forge config directory, as the parent resolved it. */
export interface ProtectedDir {
  /** The directory as the parent named it (lexical, absolute). */
  lexical: string;
  /** Its realpath, or the lexical form when it could not be resolved. */
  real: string;
  /** `gh` or `glab` — the refusal never prints the path, only the forge. */
  forge: string;
}

/** Why a call is refused: the two forges' roots, never a path or its content. */
export interface ForgeReadHit {
  forge: string;
}

/** A word's judged spellings: what the command typed, and what the OS opens. */
export function formsOf(word: string, cwd: string): string[] {
  const expanded = expandHome(word);
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
  const out = [abs];
  const real = safeResolve(abs);
  if (real !== undefined && real !== abs) out.push(real);
  return out;
}

/** One root of one protected directory, normalised for comparison. */
export function rootsOf(d: ProtectedDir): string[] {
  // The stored root is normalised HERE rather than at construction: the set
  // crosses a serialised env var on its way to the child, and a trailing slash
  // must never decide whether a rule fires.
  return [d.lexical, d.real].map((raw) => (raw.length > 1 ? raw.replace(/[/]+$/, "") : raw));
}

/** The same path without a trailing separator (which names the same entry). */
export function untrail(form: string): string {
  return form.length > 1 ? form.replace(/[/]+$/, "") : form;
}

/**
 * Does any judged spelling of `word` name a protected directory or something
 * under it? `homes` are the homes a leading `~` may stand for (see `tildeForms`).
 */
export function hits(
  word: string,
  cwd: string,
  dirs: readonly ProtectedDir[],
  homes: readonly string[] = [],
  raw: string | undefined = undefined,
): ForgeReadHit | undefined {
  if (word === "") return undefined;
  const scheme = fileScheme(word);
  const base = scheme === undefined ? word : decodeURIComponent(word.slice(scheme.length));
  // A URL may carry an authority between the scheme and the path (`file:///op`,
  // `file://localhost/op`); what the tool opens is the path half. With an authority
  // that is some other host the word is not a local file, and the judge's contract
  // is the paths it can name — the scheme is stripped in both readings, so the
  // plain `file://<path>` spelling a child uses is judged as the path it is.
  const authority = /^\/\/([^/?#]+)/.exec(base)?.[1];
  const forms = formsOf(base, cwd);
  if (scheme !== undefined && (authority === undefined || authority === "localhost")) {
    const pathHalf = base.startsWith("/") ? base : `/${base}`;
    for (const f of formsOf(pathHalf, cwd)) if (!forms.includes(f)) forms.push(f);
  }
  for (const form of tildeForms(raw, forms, homes)) {
    for (const d of dirs) {
      if (matches(form, d)) return { forge: d.forge };
    }
  }
  return undefined;
}

/** `child` is strictly beneath `parent`. */
export function isUnder(child: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** A `key=VALUE` argument is not a path: only the value part is ever judged. */
export function isKeyValue(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);
}

/**
 * The spellings of one word in which each home it could stand for is substituted
 * for a leading `~` or an embedded `~/`.
 *
 * The lexer has already expanded a plain `~` against THIS process's home, so a
 * reviewer or explore child — whose `HOME` the harness itself redirects to a
 * scratch tree — would otherwise have its `~/.config/gh/hosts.yml` resolved
 * against the scratch home and judged clean. The homes the parent published are
 * therefore all tried against the word's raw spelling, so `~` means every home
 * it could mean, whatever the child's own `HOME` says.
 */
function tildeForms(
  raw: string | undefined,
  resolved: string[],
  homes: readonly string[],
): string[] {
  const out = [...resolved];
  // Either the lexer kept the word's TYPED spelling (its `~` is already gone from
  // `text`, substituted with this process's home) or the text still spells one — a
  // here-string or heredoc body is never lexed as a word, so it carries no mark.
  const spelled = tildeSpelling(raw, resolved);
  if (spelled === undefined) return out;
  const rest = spelled.rest;
  for (const home of homes) {
    const joined = spelled.marker === "~" ? home : `${home}${path.sep}${rest}`;
    out.push(joined);
    const real = safeResolve(joined);
    if (real !== undefined) out.push(real);
  }
  return out;
}

/**
 * Does one spelling name a protected directory or anything under it?
 *
 * The comparison is CASE-INSENSITIVE. Every resolver that builds the protected
 * set spells the directory in lower case (`gh`, `glab-cli`, `github`), but a
 * POSIX filesystem is usually case-sensitive, so `.config/GH/hosts.yml` is a
 * DIFFERENT tree holding the same credential layout the CLI would read — a rule
 * that matched case-sensitively protected the tree nobody types and left the one
 * a child that knows the rule types.
 */
function matches(form: string, d: ProtectedDir): boolean {
  const f = untrail(form).toLowerCase();
  for (const root of rootsOf(d)) {
    const r = root.toLowerCase();
    if (f === r || isUnder(f, r)) return true;
  }
  return false;
}

/** The scheme prefix of a URL word (`file://`), lower-cased, or undefined. */
function fileScheme(text: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (m === null) return undefined;
  // The group is read through a local because index access on a RegExpExecArray is
  // possibly-undefined under `noUncheckedIndexedAccess`.
  const scheme = m[1];
  return scheme !== undefined && scheme.toLowerCase() === "file" ? m[0] : undefined;
}

/** The two components of a home-relative word: the `~` and everything after it. */
interface TildeSpelling {
  /** The home marker as typed: `~`, `~/` or `~\`. */
  marker: string;
  /** The part after the marker, `""` for a bare `~`. */
  rest: string;
}

/**
 * The home-relative spelling of one word: the text the child typed, when the lexer
 * kept it, otherwise one of the word's own spellings that still begins with `~`
 * (a here-string or a heredoc body is never lexed as a word, so it carries no mark).
 *
 * The marker is kept as typed, not assumed to be `~/`: the caller re-joins `rest`
 * under each home the parent published, and a bare `~` carries no separator.
 */
function tildeSpelling(
  raw: string | undefined,
  resolved: readonly string[],
): TildeSpelling | undefined {
  const words = [raw, ...resolved];
  for (const w of words) {
    if (w === undefined) continue;
    if (w === "~") return { marker: "~", rest: "" };
    if (w.startsWith("~/")) return { marker: "~/", rest: w.slice(2) };
    if (w.startsWith("~\\")) return { marker: "~\\", rest: w.slice(2) };
  }
  return undefined;
}
