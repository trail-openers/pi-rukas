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
 * #2649: the nameable-path whitelist moved to `work-driver-verify-repo-paths.ts`
 * so the classifier of a changed non-node path asks the same question a reader is
 * judged by, and the two cannot drift. This file is hand-edited; the exempt-path
 * claim for it in `work-driver-shared-paths.ts` says so.
 *
 * Paths are relative to `extension/`, the directory the smoke tests run from.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isRepoPath, repoDirs, repoFiles } from "./work-driver-verify-repo-paths.ts";
import { lexSource } from "./work-driver-verify-select-lex.ts";

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

/** True when the file reads and names a repository path. Unlexable text reads as a reader: it cannot be judged. */
export function readsRepositoryText(raw: string): boolean {
  const lexed = lexSource(raw);
  if (lexed === undefined) return READ_CALL_RE.test(raw);
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
 * The offline smoke tests (top level, extension-relative) that read repository
 * text, sorted — the always-run set of a develop round. The predicate is text
 * based on purpose: a reader whose path never reaches a literal it can judge
 * would be missed, so unlexable text reads as a reader, and a fixture that writes
 * and reads a `src/` path counts as a reader too.
 */
export function textReadingTests(extensionDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(extensionDir, "smoke-tests"))) {
    if (!/^test-[^/]+\.ts$/.test(name) || /-live\.ts$/.test(name)) continue;
    const text = readFileSync(path.join(extensionDir, "smoke-tests", name), "utf8");
    if (readsRepositoryText(text)) out.push(`smoke-tests/${name}`);
  }
  return out.sort();
}
