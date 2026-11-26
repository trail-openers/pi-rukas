/**
 * work-driver-verify-always-run — #1647: the smoke tests that run on EVERY
 * develop verify, whatever the diff touched.
 *
 * A test that reads repository source or configuration AS TEXT depends on files
 * no import graph shows (it opens `src/x.ts` by name, or walks a directory), so
 * a selection built from imports would never run it for a change to the file it
 * reads. The set is COMPUTED from the worktree's own smoke tests at selection
 * time: there is no committed list to regenerate, so no cycle ever claims this
 * path and a sibling cycle on an unrelated issue is not handed back at plan.
 *
 * A test is a reader when it makes a read call AND one of its string literals
 * (or a `path.join`/`resolve` argument) names a repository path. That is judged
 * on the lexed code, so a comment or a message that quotes a path does not
 * count, and a word that merely equals a directory name does not count unless it
 * is a path argument. Live tests (`-live.ts`) never run offline, so they are not
 * readers here. `test-verify-select-computed-always-run.ts` gates membership.
 *
 * The roster of offline tests (`work-driver-verify-offline-tests`) is the single
 * read of that tree: `rosterReaders` judges the files the roster already lexed, so
 * one selection reads and tokenizes each top-level test once and the always-run
 * rule and the exact-namer rule see the same answer for the same file. A test the
 * tokenizer could not close has no lexed form to judge, so it reads as a reader —
 * a file whose text cannot be read cannot be shown NOT to read repository paths.
 *
 * #2649: the nameable-path whitelist moved to `work-driver-verify-repo-paths.ts`
 * so the classifier of a changed non-node path asks the same question a reader is
 * judged by, and the two cannot drift. This file is hand-edited; the exempt-path
 * claim for it in `work-driver-shared-paths.ts` says so.
 *
 * Paths are relative to `extension/`, the directory the smoke tests run from.
 */

import { type OfflineTests, readOfflineTests } from "./work-driver-verify-offline-tests.ts";
import { isRepoPath, repoDirs, repoFiles } from "./work-driver-verify-repo-paths.ts";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";

const READ_CALL_RE =
  /\b(?:readFileSync|readdirSync|readFile|readdir|openSync|readSync|createReadStream|opendirSync)\s*\(|\bBun\.file\b/;
/** A call to join or resolve on lexed code; the group is its argument list. */
const JOIN_CALL_RE = /\b(?:join|resolve)\s*\(([^()]*)\)/g;
/** A string token on lexed code (a `<STR><i><STR>` or template `<TPL><i><TPL>` pair). */
// The markers are spelled as \u escapes rather than pasted: a bare private-use code point
// here would be a placeholder collision to the lexer whose output this matches, and this
// file is a graph node — the whole selection would fall back to the full suite.
// biome-ignore lint/complexity/useRegexLiterals: the escapes are the point, not an avoidance of escaping.
const TOKEN_RE = new RegExp("[\\uE000\\uE001](\\d+)[\\uE000\\uE001]", "g");

/** True when the lexed code of a test reads and names a repository path. */
function codeReadsRepositoryText(lexed: LexedSource): boolean {
  if (!READ_CALL_RE.test(lexed.code)) return false;
  if (lexed.strings.some(isRepoPath) || lexed.templates.some(isRepoPath)) return true;
  // `path.join(ext, "src", "x.ts")`: a bare directory segment passed to join or resolve.
  for (const m of lexed.code.matchAll(JOIN_CALL_RE)) {
    for (const t of (m[1] ?? "").matchAll(TOKEN_RE)) {
      const value = lexed.strings[Number(t[1])] ?? lexed.templates[Number(t[1])];
      if (value !== undefined && (repoDirs().includes(value) || repoFiles().includes(value))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when the file reads and names a repository path. Unlexable text reads as a
 * reader: it cannot be judged.
 */
export function readsRepositoryText(raw: string): boolean {
  const lexed = lexSource(raw);
  if (lexed === undefined) return READ_CALL_RE.test(raw);
  return codeReadsRepositoryText(lexed);
}

/**
 * The always-run set of a develop round, from the roster the caller already read:
 * the offline smoke tests that read repository text, sorted.
 *
 * A roster file with no lexed entry is the unlexable case and counts as a reader,
 * which is the same verdict `readsRepositoryText` gives for the same file. Taking
 * the roster instead of scanning `smoke-tests/` here is what lets a selection read
 * and lex each top-level test ONCE; the roster is the same top-level scan under the
 * same name contract (`isOfflineTest`), so the reader rule and the exact-namer rule
 * cannot disagree about which files they judged.
 *
 * A tree with no `smoke-tests/` directory is not a silent empty set: the roster
 * read throws, and the caller's try/catch turns that into a full-suite fallback.
 */
export function rosterReaders(roster: OfflineTests): string[] {
  const out: string[] = [];
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined || codeReadsRepositoryText(lexed)) out.push(name);
  }
  return out.sort();
}

/**
 * The offline smoke tests (top level, extension-relative) that read repository
 * text, sorted — the always-run set for a caller that holds no roster of its own.
 */
export function textReadingTests(extensionDir: string): string[] {
  return rosterReaders(readOfflineTests(extensionDir));
}
