/**
 * comment-retention-hunks — pure diff parsing and per-hunk classification for
 * the comment-retention gate (#948, #1040; follow-up fix on main).
 *
 * `parseHunks` turns a unified diff into hunks, each keyed to its REAL file
 * (a deleted file's `+++ /dev/null` is resolved from its `--- a/…` header) and
 * holding the ordered body lines (context / removed / added). A header that
 * cannot be parsed (e.g. CRLF) is an error, never silently skipped.
 *
 * `classifyHunk` decides, for one hunk, which removed comment blocks are
 * lost, replaced or exempt:
 *  - Annotated code = the code line(s) immediately after the removed comment
 *    block in the OLD file, with no unchanged context line in between. If the
 *    next old-file line is unchanged context, the annotated code is unchanged.
 *  - Exempt: the annotated code was removed and is gone at head (no new
 *    comment in the hunk).
 *  - Replaced (a note, not a failure): the hunk adds a comment line AND either
 *    (a) the annotated code was removed/changed in this hunk, or (b) the
 *    block's wording was carried into an added comment in this hunk (≥3
 *    distinct words, ≥60% of them shared).
 *  - Otherwise each block line is lost unless its trimmed text reappears under
 *    the scoped paths at head.
 */

const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;
const CARRY_MIN_WORDS = 3;
const CARRY_RATIO = 0.6;

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

/** A whole-line comment: `//`, block open/close, or a block-continuation star line. */
export function isCommentLine(raw: string, inBlock: boolean): boolean {
  const t = raw.trim();
  if (t.startsWith("//") || t.startsWith("/*")) return true;
  if (SQL_LUA_COMMENT_RE.test(t)) return true;
  if (t.startsWith("*")) {
    if (STAR_BARE_RE.test(t)) return true;
    return inBlock && STAR_PROSE_RE.test(t);
  }
  return t.endsWith("*/") && t.length > 2;
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
  let prevComment = false;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
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
      prevComment = false;
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
    const isComment = isCommentLine(raw, prevComment);
    prevComment = isComment;
    cur.lines.push({ kind, raw, isComment });
  }
  return { ok: true, hunks };
}

/** Did the block's wording survive into an added comment of this hunk? */
function wordingCarried(block: string[], addedComments: string[]): boolean {
  const words = new Set(wordsOf(block.join(" ")));
  if (words.size < CARRY_MIN_WORDS) return false;
  return addedComments.some((a) => {
    const added = new Set(wordsOf(a));
    let shared = 0;
    for (const w of words) if (added.has(w)) shared++;
    return shared / words.size >= CARRY_RATIO;
  });
}

/** Classify one hunk's removed comment blocks. */
export function classifyHunk(hunk: Hunk, presentAtHead: (text: string) => boolean): HunkVerdict {
  const verdict: HunkVerdict = { lost: [], replaced: [], exempt: 0 };
  const addedComments = hunk.lines
    .filter((l) => l.kind === "added" && l.isComment)
    .map((l) => l.raw.trim());
  const addedCode = new Set(
    hunk.lines.filter((l) => l.kind === "added" && !l.isComment).map((l) => l.raw.trim()),
  );
  const hasAddedComment = addedComments.length > 0;
  // The OLD file's view of this hunk: context and removed lines, in order.
  const old = hunk.lines.filter((l) => l.kind !== "added");
  let i = 0;
  while (i < old.length) {
    const first = old[i];
    if (!first || first.kind !== "removed" || !first.isComment) {
      i++;
      continue;
    }
    const block: string[] = [];
    let next = old[i];
    while (next && next.kind === "removed" && next.isComment) {
      block.push(next.raw);
      i++;
      next = old[i];
    }
    // Annotated code: the next old-file line, if it is a removed code line.
    // Unchanged context there means the documented code is unchanged.
    const follow = next && next.kind === "removed" && !next.isComment ? next.raw.trim() : "";
    if (follow && !presentAtHead(follow)) {
      if (hasAddedComment) verdict.replaced.push(...block.map((l) => l.trim()));
      else verdict.exempt += block.length;
      continue;
    }
    const codeChanged = follow !== "" && !addedCode.has(follow);
    if (hasAddedComment && (codeChanged || wordingCarried(block, addedComments))) {
      verdict.replaced.push(...block.map((l) => l.trim()));
      continue;
    }
    for (const l of block) if (!presentAtHead(l)) verdict.lost.push(l.trim());
  }
  return verdict;
}
