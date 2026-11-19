/**
 * lean/protected-globs — the matcher and the validity rules for a project's own
 * protected paths (`.pi/work.json` `lean.protectedPaths`). Both questions live here, and
 * only here, so the config validator and the revert predicate cannot disagree about what
 * a pattern MEANS: `protectedPathProblem` asks whether an entry is usable at all (an
 * entry that cannot name a repo-relative path is a typo whose rule silently protects
 * nothing, so the loader refuses it and quotes it); `protectedGlobMatches` asks whether
 * an entry names a path — the ONE matcher.
 *
 * The semantics are gitignore's, read off git itself (`git check-ignore` against a
 * scratch repo) rather than from a summary of them: `*` spans characters WITHIN one
 * segment (and may span none, so `package*.json` names `package.json`), `?` spans
 * exactly one character other than `/`, a doublestar spans zero or more WHOLE segments,
 * a pattern naming no directory matches a basename at any depth, and a trailing `/` means
 * that directory and everything under it — never the directory node itself. No repo
 * matcher has exactly this set — the driver's `globMatchesSegments` makes `*` match at
 * least one segment and has no doublestar — and a glob library is a dependency this
 * extension does not carry, so the matcher is written here.
 *
 * The comparison is CASE-SENSITIVE on purpose: `isProtectedPath` in
 * `work-driver-doctrine.ts` classifies case-sensitively, and a revert rule that folded
 * case would revert files the author never named, on a case-sensitive filesystem.
 *
 * What the regex costs is bounded by what {@link protectedPathProblem} admits, not by the
 * compiler: a regex over unbounded wildcards backtracks, and a few doublestars in front of
 * an anchored tail turn a NON-matching path into a cost that grows with its depth. So the
 * entry is normalised before it is compiled (a spelling change only, never a meaning
 * change), and three counts of the normalised entry are capped. The rows of
 * `test-lean-protected-globs.ts` are the matcher's contract; the caps are the entry's.
 */

/**
 * Characters no entry may contain: shell metacharacters, quotes, and the INVISIBLE class
 * (C0/C1 controls, zero-width, the bidi overrides U+202A–U+202E and isolates U+2066–U+2069,
 * BOM, line/paragraph separators) — an entry with one in it looks identical to the entry the
 * author meant and matches nothing. The same set `config-test-location.ts` refuses; unlike
 * that module, `*` and `?` are legal here, because a glob is the whole point of the field.
 */
const FORBIDDEN =
  /[;&|`$<>"'\\\n\r]|\p{Cc}|\u0085|\u2028|\u2029|[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** How long one entry may run. A pattern is a rule, not a document, and the length bound is
 *  what keeps a pathological config small enough to read in the refusal that names it. */
const ENTRY_CEILING = 256;

/** How many doublestar SEGMENTS one entry may carry after normalisation. */
const DEPTH_STAR_CEILING = 4;

/** How many `*` and `?` one SEGMENT of an entry may carry after normalisation. */
const SEGMENT_WILDCARD_CEILING = 4;

/**
 * The entry in the only spellings it can have, as a precondition of {@link entryCost} and of
 * the compile, never as a separate matcher. Two moves, neither of which can change what the
 * entry matches:
 *
 *   - a run of `*` inside ONE segment is one `*`: each compiles to its own `[^/]*`, and a
 *     repetition of `[^/]*` absorbs exactly what one of them absorbs, so `a***b` names what
 *     `a*b` names;
 *   - two ADJACENT doublestar SEGMENTS are one, because a doublestar already spans zero or
 *     more whole segments and a second can only absorb what the first declined, so the
 *     three-of-them spelling names what the one-of-them spelling names.
 *
 * A segment that is not exactly a doublestar keeps its interior stars — this matcher gives
 * that spelling a pair of `[^/]*`, and the pre-pass does not reinterpret it.
 */
function normaliseEntry(entry: string): string {
  const trailing = entry.endsWith("/");
  const body = trailing ? entry.slice(0, -1) : entry;
  const collapsed: string[] = [];
  for (const segment of body.split("/")) {
    const one = segment === DEPTH_STAR_TEXT ? DEPTH_STAR_TEXT : segment.replace(/\*+/g, "*");
    if (one === DEPTH_STAR_TEXT && collapsed[collapsed.length - 1] === DEPTH_STAR_TEXT) continue;
    collapsed.push(one);
  }
  return `${collapsed.join("/")}${trailing ? "/" : ""}`;
}

/**
 * The entry's two cost counts, on its {@link normaliseEntry} spelling — so a run of stars that
 * compiles to one `[^/]*` cannot be charged twice, nor a redundant doublestar charged as two.
 * `[doublestar segments, widest single segment]`.
 */
function entryCost(entry: string): [number, number] {
  const segments = entrySegments(normaliseEntry(entry)).segments;
  let depthStars = 0;
  let segmentWildcards = 0;
  for (const segment of segments) {
    if (segment === DEPTH_STAR_TEXT) {
      depthStars += 1;
      continue;
    }
    let wildcards = 0;
    for (const c of segment) if (c === "*" || c === "?") wildcards += 1;
    if (wildcards > segmentWildcards) segmentWildcards = wildcards;
  }
  return [depthStars, segmentWildcards];
}

/** The pattern spelling that {@link DEPTH_STAR} is the regex source of. */
const DEPTH_STAR_TEXT = "**";

/**
 * One path segment and the separator after it — the unit a doublestar absorbs, taken zero or
 * more times. Non-capturing on purpose: inside `(?:…)*` the inner `[^/]*` is pinned to one
 * segment, so the repetition consumes whole segments and can collapse to nothing between two
 * literals; a doublestar that could cross separators would make `src/retry.ts` match
 * `src/app/legacy.vue`. The separator is bracketed as `[/]` because engines disagree on an
 * unescaped `/` in this position.
 */
const DEPTH_STAR = "(?:[^/]*[/])*";

/**
 * The tail a trailing doublestar needs: git will not let docs-doublestar stop at the node
 * called docs, so it takes a separator the pattern cannot elide plus a non-empty run —
 * a negated-newline class rather than a dot, so it reads as "non-empty", not a wildcard.
 */
const UNDER = "[^\\n]+";

/** Regex metacharacters needing escape in a literal. `/` is DELIBERATELY absent (an escaped
 *  `/` in a character class stops meaning "not a slash") and `?` DELIBERATELY present (a
 *  quantifier the wildcard pass already consumed, so anything left is literal). */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** One literal stretch of a pattern segment, regex-escaped. */
function literal(text: string): string {
  return text.replace(REGEX_SPECIAL, "\\$&");
}

/**
 * One path segment of a pattern as regex source: `*` spans characters inside one segment
 * (and may span none), `?` spans exactly one. Both are translated in a SINGLE pass, so the
 * escaping happens to the same text as the wildcard rule rather than after it — escaping
 * afterwards would leave `*` a regex quantifier.
 */
function segmentSource(segment: string): string {
  if (segment === DEPTH_STAR_TEXT) return DEPTH_STAR;
  let out = "";
  let pending = "";
  const flush = (): void => {
    out += literal(pending);
    pending = "";
  };
  for (const c of segment) {
    if (c === "*" || c === "?") {
      flush();
      out += c === "*" ? "[^/]*" : "[^/]";
    } else pending += c;
  }
  flush();
  return out;
}

/** One entry split into the segments the author wrote, with the trailing `/` kept. */
function entrySegments(entry: string): { segments: string[]; trailing: boolean } {
  const trailing = entry.endsWith("/");
  return { segments: (trailing ? entry.slice(0, -1) : entry).split("/"), trailing };
}

/**
 * This entry as anchored regex source over `/`-separated paths.
 *
 * Segments are walked rather than mapped and joined because the join has to know which
 * separators the AUTHOR wrote and which belong to a doublestar: a `/` the author wrote is
 * always emitted literally (a `*` never crosses a directory boundary, so neither can the
 * join invent one), while a doublestar contributes repetitions of "a whole segment then its
 * own `/`" and takes none of the join's — each repetition already ends on the `/` it needs,
 * and a zero-segment expansion must fuse with what follows. That is what makes
 * a-doublestar-b name a/b as readily as a/x/y/b, while a leading doublestar still refuses a
 * file named qx.
 *
 * The one spelling needing more than {@link DEPTH_STAR} is a doublestar that ENDS the
 * pattern: it takes {@link UNDER} behind a literal `/` — unless the pattern is nothing BUT
 * that doublestar, which means "everything" and so has no prefix to be under.
 */
function toRegexSource(entry: string): string {
  const { segments, trailing } = entrySegments(entry);
  let source = "";
  let previous: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    if (segment === DEPTH_STAR_TEXT) {
      if (i === segments.length - 1 && !trailing) {
        source += (previous === null ? "" : "/") + UNDER;
        previous = segment;
        continue;
      }
      source += DEPTH_STAR;
      previous = DEPTH_STAR_TEXT;
      continue;
    }
    if (previous !== null && previous !== DEPTH_STAR_TEXT) source += "/";
    source += segmentSource(segment);
    previous = segment;
  }
  // A pattern naming no directory matches a basename at any depth; one naming a directory
  // is anchored where the author wrote it — {@link basenameDepth}. A trailing `/` keeps ITS
  // separator mandatory and requires something after it: `theme/` never names `theme`.
  const prefix = basenameDepth(segments) ? DEPTH_STAR : "";
  return `^${prefix}${source}${trailing ? `/${UNDER}$` : "$"}`;
}

/**
 * Whether this entry says "a name, at any depth" rather than "a path, where I wrote it" — the
 * gitignore rule. "Names no directory" is exactly "no separator but for a trailing one", so
 * `theme/` stays unanchored while `src/theme/`, `docs/**` and `a/b` are anchored. A leading
 * doublestar does NOT lift the anchor: that spelling asks for an ANCHORED pattern whose sides
 * absorb segments.
 */
function basenameDepth(segments: readonly string[]): boolean {
  return segments.length === 1;
}

/** Why this `lean.protectedPaths` entry cannot be used, or undefined when it can. Each refusal
 *  quotes the entry, so a config with ten patterns and one typo is fixed off the message. */
export function protectedPathProblem(entry: unknown): string | undefined {
  const where = ".pi/work.json lean.protectedPaths";
  if (typeof entry !== "string") return `${where} entries must be strings`;
  if (entry.trim() === "") return `${where} must not contain an empty entry`;
  if (entry !== entry.trim())
    return `${where} entries must not have surrounding whitespace — the value is matched verbatim, so \`${entry}\` would match nothing`;
  if (FORBIDDEN.test(entry))
    return `${where} entry \`${entry}\` must be a plain repo-relative glob: ; & | \` $ < > " ' \\ and newline are not allowed, and neither is an invisible/control character`;
  if (entry.startsWith("/"))
    return `${where} entry \`${entry}\` must be repo-relative, not absolute`;
  if (/^[A-Za-z]:[\\/]/.test(entry))
    return `${where} entry \`${entry}\` must be repo-relative, not a Windows absolute path`;
  const { segments, trailing } = entrySegments(entry);
  if (segments.includes("..")) return `${where} entry \`${entry}\` must not contain ".."`;
  if (segments.includes("."))
    return `${where} entry \`${entry}\` has exactly one spelling — write \`${segments
      .filter((s) => s !== ".")
      .join("/")}\` (the paths git reports for a changed set never carry a "." segment)`;
  if (segments.includes(""))
    return `${where} entry \`${entry}\` must not contain a doubled slash (one trailing slash, to name a directory, is the exception)`;
  // What the entry is spelled like decides what the matcher pays, and the matcher pays in
  // backtracking: a few doublestars in front of an anchored tail make a path that does NOT
  // match cost more the deeper that path is. The three counts are taken on the NORMALISED
  // entry, so a redundant `**` or a doubled `*` cannot be charged twice, and the entry that
  // is refused is the entry that would have been compiled.
  if (entry.length > ENTRY_CEILING)
    return `${where} entry \`${entry.slice(0, 60)}…\` is ${String(entry.length)} characters long, over the ${String(ENTRY_CEILING)}-character ceiling for one pattern`;
  const [depthStars, segmentWildcards] = entryCost(entry);
  if (depthStars > DEPTH_STAR_CEILING)
    return `${where} entry \`${entry}\` has ${String(depthStars)} "**" segments, over the ${String(DEPTH_STAR_CEILING)} this matcher will backtrack over`;
  if (segmentWildcards > SEGMENT_WILDCARD_CEILING)
    return `${where} entry \`${entry}\` has ${String(segmentWildcards)} "*"/"?" wildcards in one segment, over the ${String(SEGMENT_WILDCARD_CEILING)} this matcher will backtrack over`;
  // `dir/**/` already names everything under `dir`, and the trailing slash then asks for one
  // more segment below that — so the two spellings together name nothing. Refuse it rather
  // than accept a rule that reads as a protection and protects nothing.
  if (segments[segments.length - 1] === DEPTH_STAR_TEXT && trailing)
    return `${where} entry \`${entry}\` matches no path — the "**" already names everything under what precedes it, so write \`${entry.slice(0, -1)}\``;
  // A leading `!` is gitignore's negation, which this list has no meaning for —
  // better to refuse the spelling than to protect a file literally named `!x`.
  if ((segments[0] ?? "").startsWith("!"))
    return `${where} entry \`${entry}\` must not start with "!": negation is not part of this field`;
  return undefined;
}

/** Compiled per entry, so a fold matching a hundred changed paths compiles once. */
const CACHE = new Map<string, RegExp>();

/** Entries come from a project file, so the cache is bounded rather than growing out of a config
 *  nobody vetted. */
const CACHE_CEILING = 512;

function compiled(entry: string): RegExp {
  // The normalised entry is what gets compiled and cached: the two name the same paths, and
  // a config that spells `a/**/**/b` then `a/**/b` reuses one regex rather than paying twice.
  const key = normaliseEntry(entry);
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;
  const re = new RegExp(toRegexSource(key));
  if (CACHE.size >= CACHE_CEILING) CACHE.clear();
  CACHE.set(key, re);
  return re;
}

/** Does `entry` (validated or not — an entry the loader would refuse simply matches
 *  nothing) name `file`? */
export function protectedGlobMatches(entry: string, file: string): boolean {
  return compiled(entry).test(file);
}
