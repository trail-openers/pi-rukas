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
 * an anchored tail turn a NON-matching path into a cost that grows with its depth — like depth
 * to the power of the doublestar count, and like the LENGTH of the path raised to the power of the
 * entry's TOTAL wildcard count: the segment ceiling alone leaves a leading-doublestar entry free
 * to spend a second on one legal 4,095-character path. So the entry is normalised before it is
 * compiled (a spelling change only, never a meaning change), and four counts of the normalised
 * entry are capped: 256 characters, two `**` SEGMENTS, four `*`/`?` wildcards in one segment, and
 * four wildcards in TOTAL (a `**` segment counting one). Counts are blind to WHERE a wildcard sits,
 * and position decides what a shape costs. A wildcard has to be retried at every offset a `**` can
 * absorb, so the expensive place for one is ADJACENT to a doublestar with no literal between: a
 * segment that PRECEDES the first `**`, or one wedged between two `**` segments with nothing but
 * literals on one side of it, pays a LENGTH term for itself on top of a DEPTH term for the
 * doublestars beside it. Both are refused by shape, not by count ({@link wildcardBesideDoublestar}).
 * A leading doublestar itself is allowed, and so is a wildcard after the LAST one, which is
 * what the rules a project writes actually say — a leading doublestar, then the wildcard in the tail
 * (a sources pattern, a lockfile pattern, a framework extension). A bare `*` or `?` SEGMENT is
 * allowed on either side of a doublestar even between two of them: it is a single `[^/]*` the
 * doublestar swallows whole, so it carries no retry of its own, and it is what makes the bare
 * segment between two doublestars cost 12 ms where the same slot with a widened wildcard costs
 * 800 ms.
 * The rows of `test-lean-protected-globs.ts` are the matcher's contract; the caps and those
 * refusals are the entry's.
 *
 * The other half of that bound is the INPUT, and it belongs to the filesystem rather than the
 * config: {@link SEGMENT_CEILING} and {@link PATH_CEILING}. A path past either cannot exist on
 * disk, so the matcher is never asked to backtrack over it — and a path that arrives past them
 * is answered as PROTECTED, because one this module cannot read is not one it can vouch for.
 */

/**
 * Characters no entry may contain: shell metacharacters, quotes, and the INVISIBLE class —
 * `\p{Cf}`, the format characters (zero-width, the bidi overrides and isolates, BOM, the TAGS
 * block), plus the C0/C1 controls, NEL and the line/paragraph separators that `\p{Cc}` and two
 * explicit code points carry. An entry with one in it looks identical to the entry the author
 * meant and matches nothing. The same set `config-test-location.ts` refuses; unlike that module,
 * `*` and `?` are legal here, because a glob is the whole point of the field. `\p{Cf}` is used
 * rather than an enumerated range list because the list had never caught the TAGS block
 * (U+E0001–U+E007F), which is format characters by property and invisible by any measure.
 */
const FORBIDDEN = /[;&|`$<>"'\\\n\r]|\p{Cc}|\p{Cf}|\u0085|\u2028|\u2029/u;

/** How long one entry may run. A pattern is a rule, not a document, and the length bound is
 *  what keeps a pathological config small enough to read in the refusal that names it. */
const ENTRY_CEILING = 256;

/** How many doublestar SEGMENTS one entry may carry after normalisation. Cost grows like
 *  (path depth)^(this count), so this is the one count that decides what a non-match costs: at
 *  four, one 400-segment path that never matches costs over half a second, and the shape behind
 *  it costs more the deeper the path runs. */
const DEPTH_STAR_CEILING = 2;

/** How many `*` and `?` one SEGMENT of an entry may carry after normalisation. */
const SEGMENT_WILDCARD_CEILING = 4;

/** A wildcard written beside a doublestar with nothing to stop it, on the normalised entry — the one
 *  shape no count bounds, so the entry is refused by shape rather than priced. What a `**` compiles
 *  to is "any number of whole segments", so a wildcard NEXT TO one is retried at every offset that
 *  doublestar can absorb and each retry carries the length of the path; counts cannot see position,
 *  and position is what decides the cost. Two spellings pay, and both are refused:
 *
 *    - a wildcard in a segment that comes BEFORE the first doublestar — the leading-wildcard
 *      spelling costs about three seconds on the legal 4,095-character path where the same rule
 *      written the other way round costs 12 ms;
 *    - a wildcard in a segment that sits BETWEEN two doublestar segments — the mirror image of the
 *      first, whose wildcard carries a length term for the doublestar on each side rather than only
 *      the one behind it, measured at 800 ms to 2.7 s on the same path.
 *
 *  A wildcard the doublestars cannot reach stays admitted: after the LAST `**` it is anchored at the
 *  end of the path, which is where a rule means it. And a BARE `*`/`?` SEGMENT never pays, wherever
 *  it sits: it is one `[^/]*` that the doublestar beside it swallows whole, so it starts no retry of
 *  its own — measured, the bare-wildcard-between-doublestars shape costs 12 ms and 13 ms on the
 *  longest legal path where the same shapes with a widened wildcard in that slot cost 800 ms and
 *  850 ms. So a bare wildcard segment between two doublestars is what makes the vendored-tree
 *  pattern the shape a project writes, and the literal the wildcard has to reject is what makes the
 *  widened-segment spelling the shape it must not.
 *
 *  Returns the first offending segment, which the refusal quotes back. */
function wildcardBesideDoublestar(entry: string): string | undefined {
  const segments = entrySegments(normaliseEntry(entry)).segments;
  const first = segments.indexOf(DEPTH_STAR_TEXT);
  if (first < 0) return undefined;
  for (const segment of segments.slice(0, first)) {
    for (const c of segment) if (c === "*" || c === "?") return segment;
  }
  const last = segments.lastIndexOf(DEPTH_STAR_TEXT);
  if (last === first) return undefined;
  const middle = segments.slice(first + 1, last);
  for (let i = 0; i < middle.length; i++) {
    const segment = middle[i] as string;
    if (segment === DEPTH_STAR_TEXT || isBareWildcardSegment(segment)) continue;
    let wildcard = false;
    for (const c of segment) if (c === "*" || c === "?") wildcard = true;
    if (!wildcard) continue;
    // Exempt only when a bare wildcard (or another doublestar) already stands between this segment
    // and the doublestar on EACH side, because that is the shape where neither doublestar has to
    // retry anything of this segment's.
    const leftAbsorbed = middle.slice(0, i).some(isAbsorbingSegment);
    const rightAbsorbed = middle.slice(i + 1).some(isAbsorbingSegment);
    if (leftAbsorbed && rightAbsorbed) continue;
    return segment;
  }
  return undefined;
}

/** A segment that is exactly one `*` or exactly one `?` — a single `[^/]*` with no literal in it. */
function isBareWildcardSegment(segment: string): boolean {
  return segment === "*" || segment === "?";
}

/** A segment that absorbs what sits beside it whole: a doublestar, or a bare single wildcard. */
function isAbsorbingSegment(segment: string): boolean {
  return segment === DEPTH_STAR_TEXT || isBareWildcardSegment(segment);
}

/** How many wildcards an entry may carry over ALL its segments after normalisation, each `**`
 *  SEGMENT counting one. The two ceilings above bound the DEPTH a shape can multiply by; this one
 *  bounds the LENGTH it multiplies over — the cost of a non-match grows like the length of the
 *  path raised to this count. Measured on the legal 4,095-character path of 255-character dense
 *  segments: at four the worst admitted entry costs 26 ms, at five 769 ms and at six 6.3 s, so the
 *  ceiling sits at the largest count with a measured worst case — four. Every rule a project
 *  actually writes sits at three or under. */
const TOTAL_WILDCARD_CEILING = 4;

/** Linux NAME_MAX: how long one segment can be on disk, so a longer one is not a path git ever
 *  reported and its regex cost is not a cost this matcher can be asked to pay. */
const SEGMENT_CEILING = 255;

/** Linux PATH_MAX: how long a whole path can be — the input's side of the bound that
 *  {@link ENTRY_CEILING} provides for the pattern. */
const PATH_CEILING = 4096;

/** Can the regex be worth running over `file` at all? Within both OS limits, every segment a
 *  backtracking `*` could spread over is one a filesystem could actually hold. */
function pathWithinLimits(file: string): boolean {
  if (file.length > PATH_CEILING) return false;
  for (const segment of file.split("/")) if (segment.length > SEGMENT_CEILING) return false;
  return true;
}

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
 * The entry's three cost counts, on its {@link normaliseEntry} spelling — so a run of stars that
 * compiles to one `[^/]*` cannot be charged twice, nor a redundant doublestar charged as two.
 * `[doublestar segments, widest single segment, wildcards over all segments]`, the last counting a
 * `**` segment as one: it is the exponent the length of a non-matching path is raised to.
 */
function entryCost(entry: string): [number, number, number] {
  const segments = entrySegments(normaliseEntry(entry)).segments;
  let depthStars = 0;
  let segmentWildcards = 0;
  let totalWildcards = 0;
  for (const segment of segments) {
    if (segment === DEPTH_STAR_TEXT) {
      depthStars += 1;
      totalWildcards += 1;
      continue;
    }
    let wildcards = 0;
    for (const c of segment) if (c === "*" || c === "?") wildcards += 1;
    totalWildcards += wildcards;
    if (wildcards > segmentWildcards) segmentWildcards = wildcards;
  }
  return [depthStars, segmentWildcards, totalWildcards];
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
  // match cost more the deeper that path is, and a wildcard total past the ceiling makes it
  // cost more the LONGER that path is. The four counts are taken on the NORMALISED
  // entry, so a redundant `**` or a doubled `*` cannot be charged twice, and the entry that
  // is refused is the entry that would have been compiled.
  if (entry.length > ENTRY_CEILING)
    return `${where} entry \`${entry.slice(0, 60)}…\` is ${String(entry.length)} characters long, over the ${String(ENTRY_CEILING)}-character ceiling for one pattern`;
  const [depthStars, segmentWildcards, totalWildcards] = entryCost(entry);
  if (depthStars > DEPTH_STAR_CEILING) {
    // A leading doublestar is the usual reason an entry is one over the ceiling, and the prefix
    // asks only for segments IN FRONT of the rest — which a repo-relative path already satisfies
    // wherever it lives. So dropping it keeps the rule's own literals and takes one doublestar off
    // the matcher; it is not always the SAME rule (the prefix also covers the same directory name
    // nested elsewhere), which is why the refusal offers it as the thing to check rather than
    // asserting it as an equal spelling.
    const cheaper = entry.startsWith(`${DEPTH_STAR_TEXT}/`)
      ? ` — if it starts with "**/", that prefix only asks for segments in front of the rest, so \`${entry.slice(DEPTH_STAR_TEXT.length + 1)}\` is usually the rule meant, for one doublestar less`
      : "";
    return `${where} entry \`${entry}\` has ${String(depthStars)} "**" segments, over the ${String(DEPTH_STAR_CEILING)} this matcher will backtrack over${cheaper}`;
  }
  if (segmentWildcards > SEGMENT_WILDCARD_CEILING)
    return `${where} entry \`${entry}\` has ${String(segmentWildcards)} "*"/"?" wildcards in one segment, over the ${String(SEGMENT_WILDCARD_CEILING)} this matcher will backtrack over`;
  if (totalWildcards > TOTAL_WILDCARD_CEILING)
    return `${where} entry \`${entry}\` has ${String(totalWildcards)} wildcards in total (each "**" segment counting one), over the ${String(TOTAL_WILDCARD_CEILING)} this matcher will backtrack over — the cost of a path that does not match grows with its LENGTH to that power, so the rule needs fewer wildcards, or a literal to anchor on`;
  // The refusal no count can express, because a count is blind to position and position is what
  // decides the cost: the same wildcards after the LAST doublestar are admitted, and stay under the
  // timing ceiling (see `SLOW_ACCEPTED` in the shapes lib).
  const beside = wildcardBesideDoublestar(entry);
  if (beside !== undefined)
    return `${where} entry \`${entry}\` has a "*"/"?" in the segment \`${beside}\`, which sits beside a "**" segment with only literals between them — a wildcard next to a "**" is retried at every offset that "**" can absorb, so a path that does not match costs by its LENGTH on top of its DEPTH; write the rule so the wildcard lands after the "**" (a leading "**" itself is allowed, so \`**/${beside}\` is the usual spelling of the same idea, and a bare \`*\` or \`?\` segment beside a "**" is fine)`;
  // `dir/**/` is the same rule as `dir/**` written a second way: the doublestar already names
  // everything under `dir`, so the trailing `/` asks for one more segment below what already
  // takes everything. Refuse the spelling rather than let two ways of saying one thing read as
  // two rules — and point at the one that works.
  if (segments[segments.length - 1] === DEPTH_STAR_TEXT && trailing)
    return `${where} entry \`${entry}\` is the same rule as \`${entry.slice(0, -1)}\` written twice — the "**" already names everything under what precedes it, so write \`${entry.slice(0, -1)}\``;
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
 *  nothing) name `file`? A path past {@link PATH_CEILING} or {@link SEGMENT_CEILING} is answered
 *  PROTECTED without running the regex: no real changed path is that shape, and for one that
 *  somehow is, reverting it is the direction that cannot lose the child's work. */
export function protectedGlobMatches(entry: string, file: string): boolean {
  if (!pathWithinLimits(file)) return true;
  return compiled(entry).test(file);
}
