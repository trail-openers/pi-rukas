/**
 * work-driver-cherry-pick-cue — #813 fix round: where a conflicted pick's
 * path is READ, split out of work-driver-cherry-pick-conflict.ts (AGENTS.md
 * §12 file-size cap) because the reading rule is the part that carries the
 * defect this closes.
 *
 * git names the colliding path on its own stderr, in two phrasings, and each
 * needs its own capture shape:
 *
 * - `Merge conflict in <path>` prints the path TO END OF LINE and does not
 *   quote it. A `(\S+)` capture therefore truncates any path containing a
 *   space — `src/my file.ts` came back as `src/my`, a path that does not
 *   exist, which the renderer then attributed to a workstream. So the match is
 *   re-read from the path token to end of line (git appends nothing after it),
 *   and an optional pair of surrounding quotes is stripped for the case where
 *   something upstream did quote it. A spaced path that git printed unquoted
 *   has no other delimiter — EOL is the only one it has.
 * - `could not apply <abbrev>... <subject>` names the COMMIT, not the file.
 *   The line is `error: could not apply <sha>... <subject>` and the subject is
 *   free text, so a path-looking token in it is the commit message. This cue
 *   runs ONLY when the same output also carries a `CONFLICT (` line — with
 *   one, git really did fail a pick and the tail is the file; without one,
 *   no file was observed.
 *
 * An observation the batch did not make must not populate `conflictedFile` —
 * a fabricated path is what licenses a fabricated "likely coupled" diagnosis
 * one layer up, which is the #813 defect.
 */

/** A path, not a bare word: git names file paths, so a candidate with no
 *  separator and no extension is prose that happened to sit after the cue. */
function looksLikePath(candidate: string): boolean {
  return candidate.length >= 2 && (/[/]/.test(candidate) || /\.[\w]+$/.test(candidate));
}

/** Strip the quotes git itself added, and surrounding whitespace. */
function unwrapPath(raw: string): string {
  return raw
    .trim()
    .replace(/^"([^"]*)"$/g, "$1")
    .trim();
}

/**
 * git's `Merge conflict in <path>` cue — optionally quoted. Group 1 is the
 * quoted form, group 2 the bare token (which stops at the first space, hence
 * the end-of-line re-read below).
 */
const MERGE_CONFLICT_IN = /Merge conflict in\s+(?:"([^"]+)"|(\S+))/i;

/** git's `CONFLICT (<type>): ...` family, on any line of the output. */
const CONFLICT_LINE = /CONFLICT \([^)]*\)/;

/** The rest of the line starting at `fromIndex` — git prints the path to EOL. */
function restOfLine(line: string, fromIndex: number): string {
  return line.slice(fromIndex).trim();
}

/** The line carrying `needle`, or the whole blob when the cue spans one line. */
function lineWith(haystack: string, needle: string): string {
  const at = haystack.indexOf(needle);
  if (at < 0) return haystack;
  const nl = haystack.indexOf("\n", at);
  return nl < 0 ? haystack.slice(at) : haystack.slice(at, nl);
}

/**
 * The path git named for an aborted pick, or `undefined` when its output
 * named none. `undefined` is an ABSENCE the reporters render as one; it is
 * never a placeholder, because a placeholder naming a file would manufacture
 * the coupling claim (see `describeObservedConsolidationConflict`).
 */
export function conflictedFileFromCue(gitOutput: string): string | undefined {
  const merge = MERGE_CONFLICT_IN.exec(gitOutput);
  if (merge) {
    const quoted = merge[1];
    const bare = merge[2] ?? "";
    // The `\S+` alternative stopped at the first space, so re-read from the
    // path token to end of line — git prints the path to EOL, so the rest of
    // the line IS the path. A quoted match yields the whole path in `quoted`.
    const line = lineWith(gitOutput, bare);
    const raw = quoted ?? restOfLine(line, line.indexOf(bare));
    const value = unwrapPath(raw);
    if (looksLikePath(value)) return value;
  }

  // Cue 2 — `could not apply …` names the COMMIT, so it is trusted only
  // beside a `CONFLICT (` line proving a pick really failed.
  if (CONFLICT_LINE.test(gitOutput)) {
    const m = /could not apply\s+[^\n]*?([\w./-]+\.\w+)/i.exec(gitOutput);
    const candidate = m?.[1] === undefined ? undefined : unwrapPath(m[1]);
    if (candidate !== undefined && looksLikePath(candidate)) return candidate;
  }

  return undefined;
}
