/**
 * comment-retention-hunks — pure diff parsing and per-hunk classification for
 * the comment-retention gate (#948, #1040; follow-up fix on main).
 *
 * `parseHunks` turns a unified diff into hunks, each keyed to its REAL file
 * (a deleted file's `+++ /dev/null` is resolved from its `--- a/…` header) and
 * holding the ordered body lines (context / removed / added). A header that
 * cannot be parsed is an error, never silently skipped (a trailing CR from a
 * CRLF file is tolerated; any other malformed header fails closed).
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
  // Block continuity is tracked per kind: an added line's predecessor is the
  // previous added line, not an interleaved removed one.
  let prev: Record<BodyLine["kind"], boolean> = {
    context: false,
    added: false,
    removed: false,
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] ?? "";
    if (line.startsWith("@@")) {
      const m = HUNK_HEADER_RE.exec(line.replace(/\r$/, ""));
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
  const words = new Set(wordsOf(block.join(" ")).filter((w) => !CARRY_STOP.has(w)));
  if (words.size < CARRY_MIN_WORDS) return false;
  return addedRuns.some((run) => {
    const added = new Set(wordsOf(run.join(" ")).filter((w) => !CARRY_STOP.has(w)));
    let shared = 0;
    for (const w of words) if (added.has(w)) shared++;
    return shared / words.size >= CARRY_RATIO;
  });
}

/** Classify one hunk's removed comment blocks. */
export function classifyHunk(hunk: Hunk, presentAtHead: (text: string) => boolean): HunkVerdict {
  const verdict: HunkVerdict = { lost: [], replaced: [], exempt: 0 };
  const addedRuns: string[][] = [];
  let run: string[] | null = null;
  for (const l of hunk.lines) {
    if (l.kind === "added" && l.isComment) {
      if (!run) {
        run = [];
        addedRuns.push(run);
      }
      run.push(l.raw.trim());
    } else run = null;
  }
  const addedCode = new Set(
    hunk.lines.filter((l) => l.kind === "added" && !l.isComment).map((l) => l.raw.trim()),
  );
  const hasAddedComment = addedRuns.length > 0;
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
    // Annotated code: the next non-blank old-file line, if it is a removed code
    // line (unchanged blank context lines are skipped). Unchanged non-blank
    // context there means the documented code is unchanged.
    let j = i;
    while (old[j]?.kind === "context" && (old[j]?.raw ?? "").trim() === "") j++;
    const annotated = old[j];
    const follow =
      annotated && annotated.kind === "removed" && !annotated.isComment ? annotated.raw.trim() : "";
    if (follow && !presentAtHead(follow)) {
      if (hasAddedComment) verdict.replaced.push(...block.map((l) => l.trim()));
      else verdict.exempt += block.length;
      continue;
    }
    const codeChanged = follow !== "" && !addedCode.has(follow);
    if (hasAddedComment && (codeChanged || wordingCarried(block, addedRuns))) {
      verdict.replaced.push(...block.map((l) => l.trim()));
      continue;
    }
    for (const l of block) if (!presentAtHead(l)) verdict.lost.push(l.trim());
  }
  return verdict;
}
