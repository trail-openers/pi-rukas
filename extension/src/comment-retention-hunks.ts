/**
 * comment-retention-hunks — pure diff parsing and per-hunk classification for
 * the comment-retention gate (#948, #1040; follow-up fix on main).
 *
 * RETENTION: a comment line removed between base and head is retained when its
 * trimmed text reappears verbatim under the scoped paths at head, or as the
 * trailing part of a head line (a comment moved to the end of a code line).
 * Comment lines with no word characters (`/**`, ` *`, `*\/`, `//`) carry no
 * wording and are ignored entirely: neither lost nor counted as retained.
 *
 * REPLACEMENT: a removed comment block is REPLACED (a note, never a failure)
 * when either
 *  (a) it is reworded IN PLACE — the block and one or more added comment lines
 *      form one contiguous change run in the diff (no unchanged context line
 *      between them), whatever the word overlap; or
 *  (b) the annotated code (the old-file line right after the block) was removed
 *      or changed in this hunk AND the block's wording carries (≥3 words, ≥60%
 *      of the non-stop words shared) into one run of added comment lines.
 * An unrelated comment added elsewhere in the hunk never replaces a comment
 * whose annotated code is unchanged; boilerplate overlap alone never carries.
 *
 * `parseHunks` turns a unified diff into hunks, each keyed to its REAL file
 * (a deleted file's `+++ /dev/null` is resolved from its `--- a/…` header) and
 * holding the ordered body lines (context / removed / added). A trailing CR
 * (CRLF diff) is stripped from every line before matching. A header that
 * still cannot be parsed is an error, never silently skipped.
 *
 * A comment documents the code line immediately after it in the OLD file (its
 * annotated line), not the surrounding function body: a body edit alone never
 * licenses rewording a comment above an unchanged annotated line.
 *
 * `classifyHunk` decides, for one hunk, which removed comment blocks are
 * lost, replaced or exempt:
 *  - Annotated code = the code line(s) immediately after the removed comment
 *    block in the OLD file, with no unchanged context line in between. If the
 *    next old-file line is unchanged context, the annotated code is unchanged.
 *  - Exempt: the annotated code is gone at head and the hunk adds nothing
 *    (a pure deletion of the comment together with its code).
 *  - Otherwise each block line is lost unless its trimmed text reappears under
 *    the scoped paths at head.
 */

const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const CARRY_MIN_WORDS = 3;
const CARRY_RATIO = 0.6;
/** Boilerplate that carries no meaning; never counts toward wording carry. */
const CARRY_STOP = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "it",
  "this",
  "that",
  "see",
  "doc",
  "docs",
  "todo",
  "fix",
  "note",
  "more",
  "info",
]);

export type BodyLine = {
  kind: "context" | "removed" | "added";
  raw: string;
  isComment: boolean;
};
export type Hunk = { file: string; lines: BodyLine[] };
export type ParseResult = { ok: true; hunks: Hunk[] } | { ok: false; reason: string };
export type HunkVerdict = {
  lost: string[];
  replaced: string[];
  exempt: number;
};

// Leading-`*` line forms. Bare `*` or `**` are always a block-closer comment.
// A prose `* text` line is a block continuation ONLY inside a block (the
// previous content line was also a comment); an arithmetic continuation
// (` * b;` after `const y = a`) is not a comment.
const STAR_BARE_RE = /^\*(\*)?$/;
/** SQL / Lua line comment: `-- text` (the space or EOL keeps `--x` operators out). */
const SQL_LUA_COMMENT_RE = /^--(\s|$)/;
const STAR_PROSE_RE = /^\*(\*\/?)?\s\S/;

/**
 * A whole-line comment: a double-slash line, a block-open line, a block-close
 * line, or a block-continuation star line.
 *
 * `inBlock` is `true` when the previous line was also a comment (we are
 * inside a block comment). A prose `* text` line is a comment only when
 * `inBlock` is true; a bare `*` or `**` is always a comment (block closer).
 * This stops an arithmetic continuation (` * b;` after `const y = a`) from
 * being misread as a JSDoc continuation.
 */
export function isCommentLine(raw: string, inBlock: boolean): boolean {
  const t = raw.trim();
  if (t.startsWith("//") || t.startsWith("/*")) return true;
  // A jsdoc closer on its own line is always part of the comment block.
  if (t === "*/" || t === "**/") return true;
  if (SQL_LUA_COMMENT_RE.test(t)) return true;
  if (t.startsWith("*")) {
    if (STAR_BARE_RE.test(t)) return true;
    return inBlock && STAR_PROSE_RE.test(t);
  }
  return t.endsWith("*/") && t.length > 2; // closing of a block comment
}

/** Does the text carry any word character (not just markers / punctuation)? */
function hasWord(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** Lowercased word tokens, punctuation collapsed. */
export function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** `--- a/x` / `+++ b/x` → `x`; `/dev/null` is kept as-is. */
function diffPath(s: string): string {
  const p = (s.split("\t")[0] ?? "").trim();
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Split a unified diff into hunks, keyed per real file. */
export function parseHunks(diff: string): ParseResult {
  const hunks: Hunk[] = [];
  const lines = diff.split("\n");
  let oldPath = "";
  let file = "";
  let cur: Hunk | null = null;
  let inBody = false;
  let oldLeft = 0;
  let newLeft = 0;
  // Block continuity is tracked per kind: an added line's predecessor is the
  // previous added line, not an interleaved removed one.
  let prev: Record<BodyLine["kind"], boolean> = {
    context: false,
    added: false,
    removed: false,
  };
  for (let n = 0; n < lines.length; n++) {
    // A CRLF diff carries a trailing CR on every line: strip it before matching.
    const line = (lines[n] ?? "").replace(/\r$/, "");
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER_RE.exec(line);
      if (!m) {
        return {
          ok: false,
          reason: `unparseable hunk header at diff line ${n + 1} (${JSON.stringify(line.slice(0, 60))})`,
        };
      }
      oldLeft = Number(m[1] ?? 1);
      newLeft = Number(m[2] ?? 1);
      inBody = oldLeft > 0 || newLeft > 0;
      cur = { file, lines: [] };
      hunks.push(cur);
      prev = { context: false, added: false, removed: false };
      continue;
    }
    // `---` / `+++` are file headers only OUTSIDE a hunk body: inside one, a
    // removed SQL `-- x` line is `--- x` and is content.
    if (!inBody) {
      if (line.startsWith("--- ")) oldPath = diffPath(line.slice(4));
      else if (line.startsWith("+++ ")) {
        const newPath = diffPath(line.slice(4));
        file = newPath === "/dev/null" ? oldPath : newPath;
      }
      continue;
    }
    const sign = line.charAt(0);
    if (sign === "\\") continue; // "\ No newline at end of file"
    const kind: BodyLine["kind"] = sign === "+" ? "added" : sign === "-" ? "removed" : "context";
    if (kind === "added") newLeft--;
    else if (kind === "removed") oldLeft--;
    else {
      oldLeft--;
      newLeft--;
    }
    if (oldLeft <= 0 && newLeft <= 0) inBody = false;
    if (!cur) continue;
    const raw = line.slice(1);
    const isComment = isCommentLine(raw, prev[kind]);
    prev[kind] = isComment;
    if (kind === "context") prev.added = prev.removed = isComment;
    cur.lines.push({ kind, raw, isComment });
  }
  return { ok: true, hunks };
}

/**
 * Did the block's wording survive into one contiguous run of added comment
 * lines? Runs (not the whole hunk) are the unit, so an unrelated comment added
 * elsewhere in the hunk cannot launder a lost comment.
 */
function wordingCarried(block: string[], addedRuns: string[][]): boolean {
  // Count real words (≥3) but measure overlap on non-stop words, so boilerplate
  // alone never carries and a one-content-word comment can still be carried.
  if (new Set(wordsOf(block.join(" "))).size < CARRY_MIN_WORDS) return false;
  const words = new Set(wordsOf(block.join(" ")).filter((w) => !CARRY_STOP.has(w)));
  if (words.size === 0) return false;
  return addedRuns.some((run) => {
    const added = new Set(wordsOf(run.join(" ")));
    let shared = 0;
    for (const w of words) if (added.has(w)) shared++;
    return shared / words.size >= CARRY_RATIO;
  });
}

/** Classify one hunk's removed comment blocks. */
export function classifyHunk(hunk: Hunk, presentAtHead: (text: string) => boolean): HunkVerdict {
  const verdict: HunkVerdict = { lost: [], replaced: [], exempt: 0 };
  // Contiguous change runs: a run is broken by an unchanged context line only.
  // A removed comment and an added comment in the same run were reworded in place.
  const changeRunOf = new Map<BodyLine, number>();
  const runsWithAddedComment = new Set<number>();
  const addedRuns: string[][] = [];
  let changeRun = 0;
  let inChange = false;
  let run: string[] | null = null;
  for (const l of hunk.lines) {
    if (l.kind === "context") {
      inChange = false;
      run = null;
      continue;
    }
    if (!inChange) {
      changeRun++;
      inChange = true;
    }
    changeRunOf.set(l, changeRun);
    if (l.kind === "added" && l.isComment) {
      runsWithAddedComment.add(changeRun);
      if (!run) {
        run = [];
        addedRuns.push(run);
      }
      run.push(l.raw.trim());
    } else run = null;
  }
  const hunkAddsNothing = !hunk.lines.some((l) => l.kind === "added");
  // The OLD file's view of this hunk: context and removed lines, in order.
  const old = hunk.lines.filter((l) => l.kind !== "added");
  let i = 0;
  while (i < old.length) {
    const first = old[i];
    if (!first || first.kind !== "removed" || !first.isComment) {
      i++;
      continue;
    }
    const block: BodyLine[] = [];
    let next = old[i];
    while (next && next.kind === "removed" && next.isComment) {
      block.push(next);
      i++;
      next = old[i];
    }
    // Word-less markers (`/**`, ` *`, `*/`, `//`) carry no wording: ignored.
    const lines = block.map((l) => l.raw.trim()).filter(hasWord);
    if (lines.length === 0) continue;
    // Annotated code: the next non-blank old-file line, if it is a removed code
    // line (blank lines between are skipped). Unchanged non-blank context there
    // means the documented code is unchanged.
    let j = i;
    while (old[j] && (old[j]?.raw ?? "").trim() === "") j++;
    const annotated = old[j];
    const follow =
      annotated && annotated.kind === "removed" && !annotated.isComment ? annotated.raw.trim() : "";
    // (a) reworded in place: the block shares a change run with added comment lines.
    if (block.some((l) => runsWithAddedComment.has(changeRunOf.get(l) ?? -1))) {
      verdict.replaced.push(...lines);
      continue;
    }
    // (b) the annotated code changed AND the wording carried into an added comment.
    if (follow !== "" && wordingCarried(lines, addedRuns)) {
      verdict.replaced.push(...lines);
      continue;
    }
    // Pure deletion: the annotated code is gone and the hunk adds nothing.
    if (follow && !presentAtHead(follow) && hunkAddsNothing) {
      verdict.exempt += lines.length;
      continue;
    }
    for (const l of lines) if (!presentAtHead(l)) verdict.lost.push(l);
  }
  return verdict;
}
