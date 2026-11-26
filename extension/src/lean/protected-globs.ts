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
 * compiler: a regex over unbounded wildcards backtracks, so a non-matching path can cost depth to
 * the power of the entry's doublestar count and its LENGTH to the power of its TOTAL wildcard
 * count. The entry is therefore normalised before it is compiled (a spelling change, never a
 * meaning change) and four counts of it are capped: 256 characters, two `**` SEGMENTS, four `*`/`?`
 * wildcards in one segment, and four wildcards in TOTAL (a `**` segment counting one). Position
 * decides what a shape costs where counts cannot see it, so {@link wildcardBesideDoublestar} refuses
 * the wildcards a doublestar would retry at every offset. The rows of
 * `test-lean-protected-globs.ts` are the matcher's contract; the caps and those refusals are the
 * entry's.
 *
 * The other half of that bound is the INPUT, and it belongs to the filesystem rather than the
 * config: {@link SEGMENT_CEILING} and {@link PATH_CEILING}. A path past either cannot exist on
 * disk, so the matcher is never asked to backtrack over it — and a path that arrives past them
 * is answered as PROTECTED, because one this module cannot read is not one it can vouch for.
 */

/**
 * Characters no entry may contain: shell metacharacters, quotes, and the INVISIBLE class —
 * `\p{Cf}`, the format characters (zero-width, the bidi overrides and isolates, BOM, the TAGS
 * block), plus the C0/C1 controls, NEL and the line/paragraph separators. An entry with one in it
 * looks identical to the entry the author meant and matches nothing. The same set
 * `config-test-location.ts` refuses; unlike that module, `*` and `?` are legal here, because a glob
 * is the whole point of the field. A property class is used rather than an enumerated range list so
 * the invisible class cannot silently omit a block.
 */
const FORBIDDEN = /[;&|`$<>"'\\\n\r]|\p{Cc}|\p{Cf}|\u0085|\u2028|\u2029/u;

/** How long one entry may run: long enough for a rule, short enough to read in a refusal. */
const ENTRY_CEILING = 256;

/** How many doublestar SEGMENTS one entry may carry after normalisation — the count a non-match's
 *  cost is raised to the power of, so it is the one that decides what a red path costs. */
const DEPTH_STAR_CEILING = 2;

/** How many `*` and `?` one SEGMENT of an entry may carry after normalisation. */
const SEGMENT_WILDCARD_CEILING = 4;

/** A wildcard written beside a doublestar with nothing to stop it, on the normalised entry — the one
 *  shape no count bounds, so the entry is refused by shape rather than priced: a wildcard NEXT TO a
 *  `**` is retried at every offset that doublestar can absorb, each retry carrying the length of the
 *  path. A wildcard the doublestars cannot reach, and a BARE `*`/`?` SEGMENT, stay admitted.
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
 *  SEGMENT counting one. The ceilings above bound the DEPTH a shape multiplies by; this bounds the
 *  LENGTH — a non-match costs like the path's length to this power. Measured on a legal 4,095-char
 *  path: four costs 26 ms, five 769 ms and six 6.3 s, so the ceiling is the largest count with a
 *  measured worst case. Every rule a project writes sits at three or under. */
const TOTAL_WILDCARD_CEILING = 4;

/** Linux NAME_MAX: a longer segment is not a path git ever reported, so its regex cost is not one
 *  this matcher can be asked to pay. */
const SEGMENT_CEILING = 255;

/** Linux PATH_MAX: how long a whole path can be — the input's side of the bound that
 *  {@link ENTRY_CEILING} provides for the pattern. */
const PATH_CEILING = 4096;

/** Worth running the regex over `file` at all? Every segment a backtracking `*` could spread over is
 *  one a filesystem could hold. */
function pathWithinLimits(file: string): boolean {
  if (file.length > PATH_CEILING) return false;
  for (const segment of file.split("/")) if (segment.length > SEGMENT_CEILING) return false;
  return true;
}

/**
 * The entry in the only spellings it can have, as a precondition of {@link entryCost} and of the
 * compile — never as a separate matcher. Both moves collapse a repetition of what one already
 * absorbs: a run of `*` inside ONE segment becomes one `*`, and two ADJACENT doublestar SEGMENTS
 * become one. A segment that is not exactly a doublestar keeps its interior stars.
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
 * more times. Non-capturing so the inner `[^/]*` stays pinned to one segment and the repetition
 * cannot cross a separator (which would make `src/retry.ts` match `src/app/legacy.vue`); the
 * separator is bracketed as `[/]` because engines disagree on an unescaped `/` here.
 */
const DEPTH_STAR = "(?:[^/]*[/])*";

/** The tail a trailing doublestar needs: git will not let `docs/**` stop at the node called `docs`,
 *  so it takes a separator the pattern cannot elide plus a non-empty run — a negated-newline class
 *  rather than a dot, so it reads as "non-empty", not a wildcard. */
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
 * (and may span none), `?` spans exactly one. Translated in a SINGLE pass, so the escaping
 * applies to the same text as the wildcard rule — escaping afterwards would leave `*` a quantifier.
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
 * Segments are walked rather than mapped and joined because the join has to know which separators
 * the AUTHOR wrote (always emitted literally — a `*` never crosses a directory boundary) and which
 * belong to a doublestar (each of whose repetitions already ends on the `/` it needs, so it takes
 * none of the join's). That is what makes `a-doublestar-b` name `a/b` as readily as `a/x/y/b`.
 * The one spelling needing more than {@link DEPTH_STAR} is a doublestar that ENDS the pattern: it
 * takes {@link UNDER} behind a literal `/` — unless the pattern is nothing BUT that doublestar,
 * which means "everything" and so has no prefix to be under.
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
  // A pattern naming no directory matches a basename at any depth — the gitignore rule, and here
  // exactly "one segment" (a leading doublestar does NOT lift the anchor: that spelling asks for an
  // ANCHORED pattern whose sides absorb segments). A trailing `/` keeps ITS separator mandatory and
  // requires something after it: `theme/` never names `theme`.
  const prefix = segments.length === 1 ? DEPTH_STAR : "";
  return `^${prefix}${source}${trailing ? `/${UNDER}$` : "$"}`;
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
  // What the entry is spelled like decides what the matcher pays, in backtracking: the four counts
  // are taken on the NORMALISED entry, so a redundant `**` or a doubled `*` is not charged twice.
  if (entry.length > ENTRY_CEILING)
    return `${where} entry \`${entry.slice(0, 60)}…\` is ${String(entry.length)} characters long, over the ${String(ENTRY_CEILING)}-character ceiling for one pattern`;
  const [depthStars, segmentWildcards, totalWildcards] = entryCost(entry);
  if (depthStars > DEPTH_STAR_CEILING) {
    // A leading doublestar is the usual reason an entry is one over the ceiling and asks only for
    // segments IN FRONT of the rest, which a repo-relative path already satisfies. Dropping it is not
    // always the SAME rule (the prefix also covers the name nested elsewhere), so the refusal offers
    // it as the thing to check rather than asserting an equal spelling.
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
  // `dir/**/` is `dir/**` written twice: the doublestar already takes everything under `dir`, so the
  // trailing `/` asks for one segment more beneath that. Refused, pointing at the spelling that works.
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
