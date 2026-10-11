/**
 * comment-retention-hunks — pure diff parsing and per-hunk classification for
 * the comment-retention gate (#948, #1040).
 *
 * RETENTION: a comment line removed between base and head is retained when its
 * trimmed text reappears verbatim under the scoped paths at head, or as the
 * trailing part of a head line (a comment moved to the end of a code line).
 * Comment lines with no word characters (`/**`, ` *`, `*\/`, `//`) carry no
 * wording and are ignored entirely: neither lost nor counted as retained.
 *
 * Every removed comment line therefore falls into exactly one of three buckets:
 *  - RETAINED: its text survives at head (see above).
 *  - EXEMPT: the annotated code (the old-file line right after the comment
 *    block) was removed and no added line in the hunk is a comment — the
 *    comment went out together with the code it described.
 *  - LOST: everything else. A lost comment is EVIDENCE for the reviewers, not a
 *    develop failure: the adversarial reviewer and the six-lens review judge
 *    whether the removal is legitimate or a loss of still-relevant docs.
 *
 * `parseHunks` turns a unified diff into hunks, each keyed to its REAL file
 * (a deleted file's `+++ /dev/null` is resolved from its `--- a/…` header) and
 * holding the ordered body lines (context / removed / added). A trailing CR
 * (CRLF diff) is stripped from every line before matching. A header that
 * still cannot be parsed is an error, never silently skipped.
 *
 * A comment documents the code line immediately after it in the OLD file (its
 * annotated line), not the surrounding function body.
 *
 * `classifyHunk` decides, for one hunk, which removed comment blocks are
 * lost or exempt (the remainder are retained). Annotated code = the code line
 * immediately after the removed comment block in the OLD file, with no
 * unchanged context line in between.
 */

const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/;

/** A removed comment line the head does not keep, with the evidence around it. */
export type LostComment = {
  /** The file the comment was removed from (the real path at head, or base for deletions). */
  file: string;
  /** The removed comment line, trimmed. */
  text: string;
  /** Added comment lines in the same hunk — what the change wrote in its place, if anything. */
  addedNearby: string[];
};

export type BodyLine = {
  kind: "context" | "removed" | "added";
  raw: string;
  isComment: boolean;
};
export type Hunk = { file: string; lines: BodyLine[] };
export type ParseResult = { ok: true; hunks: Hunk[] } | { ok: false; reason: string };
export type HunkVerdict = {
  lost: LostComment[];
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

/** Classify one hunk's removed comment blocks into lost or exempt. */
export function classifyHunk(hunk: Hunk, presentAtHead: (text: string) => boolean): HunkVerdict {
  const verdict: HunkVerdict = { lost: [], exempt: 0 };
  // The added comment lines of this hunk: what the change wrote in place of
  // whatever it removed. Shown to the reviewers as context for a lost comment.
  const addedComments = hunk.lines
    .filter((l) => l.kind === "added" && l.isComment && hasWord(l.raw))
    .map((l) => l.raw.trim());
  const hunkAddsComment = addedComments.length > 0;
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
    // Exempt: the annotated code is gone at head and no comment was added.
    if (follow && !presentAtHead(follow) && !hunkAddsComment) {
      verdict.exempt += lines.length;
      continue;
    }
    for (const text of lines) {
      if (!presentAtHead(text))
        verdict.lost.push({ file: hunk.file, text, addedNearby: addedComments });
    }
  }
  return verdict;
}
