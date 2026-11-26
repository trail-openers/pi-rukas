/**
 * work-driver-verify-literal-trust — #2649: can the literal-based selection rules
 * be trusted for this tree?
 *
 * Two rules select by what a test's code SAYS rather than by what it imports: the
 * classifier picks the tests that name a changed docs file, and the helper rule
 * picks the tests that quote a changed shell helper's path. Both are answers about
 * a set of files the graph does not walk — every offline test, plus the contents of
 * `smoke-tests/lib/` — so both are only as trustworthy as that read. A file the
 * tokenizer cannot close, or one it cannot open at all, means the caller is
 * selecting on a partial answer, and a selection that misses the one test affected
 * by a docs edit is the failure this whole feature exists to prevent.
 *
 * The result is computed once per selection, beside the roster of offline tests
 * (`work-driver-verify-offline-tests`), and carries the name of the first file that
 * could not be judged so the fallback reason says what happened.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";

/** `trusted` with the reason it is not, or `undefined` when every file was read. */
export type LiteralTrust = { trusted: true } | { trusted: false; reason: string };

/** The extension-relative path of a `smoke-tests/lib/` file, given its path inside that directory. */
const libRel = (rel: string): string => `smoke-tests/lib/${rel}`;

/**
 * Every `.ts` file under `smoke-tests/lib/`, nested directories included, as
 * extension-relative paths — the subtree the literal rules ask about.
 *
 * Returns nothing for a tree with no such directory: no lib file exists to be
 * misread, so that is not a doubt. A file the lexing pass never reached is reported
 * by `literalTrustFromLexed` (or by the standalone walk below), not here.
 */
export function listLibTsFiles(extensionDir: string): string[] {
  const dir = path.join(extensionDir, "smoke-tests", "lib");
  const queue = [""];
  const files: string[] = [];
  for (const rel of queue) {
    let entries;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      if (rel === "") return [];
      // A nested directory that vanished mid-walk is a doubt about the subtree, and
      // the reason shape is the same one the lexing pass uses for a file it could
      // not read: the caller cannot judge what it cannot list.
      return [`${libRel(rel)} (unreadable directory)`];
    }
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) queue.push(child);
      else if (child.endsWith(".ts")) files.push(libRel(child));
    }
  }
  return files;
}

/**
 * The trust verdict for a subtree the caller has already lexed: every `.ts` file
 * `libTsFiles` listed must have a lexed entry, since a file the tokenizer could not
 * close (or that the caller could not open) leaves the literal rules judging a
 * partial answer.
 *
 * A file the lexing pass never saw is a doubt, not a pass: `buildGraph` walks that
 * subtree only for the #2649 arm, so with the rules off — or for a tree whose lib
 * files sit outside the node pattern — there is simply no lexed answer for it, and
 * the same `unlexable:<file>` reason the standalone walk gives for an unclosable
 * file is the honest one for a file nobody read.
 */
export function literalTrustFromLexed(
  libTs: readonly string[],
  lexed: ReadonlyMap<string, LexedSource>,
): LiteralTrust {
  for (const rel of libTs) {
    if (lexed.get(rel) === undefined) return { trusted: false, reason: `unlexable:${rel}` };
  }
  return { trusted: true };
}

/**
 * Can literal-based selection run on this tree?
 *
 * `smoke-tests/lib/` is the directory the helper rules ask about, and the only one
 * whose contents a selection reads without the graph, so its TypeScript helpers are
 * lexed here (including nested directories). Shell and other non-TypeScript content
 * is NOT lexed: a bash helper is a script, not a module, and the lexer's placeholder
 * discipline (a private-use code point it did not write is a collision it cannot
 * resolve) is a rule about source it must tokenise. Whether a test QUOTES such a
 * path is judged from the tests' own lexed code, which is the roster's guarantee.
 */
export function literalRulesTrustworthy(extensionDir: string): LiteralTrust {
  const dir = path.join(extensionDir, "smoke-tests", "lib");
  const queue = [""];
  for (const rel of queue) {
    let entries;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      // No lib directory at all is not a doubt: nothing under it can be misread.
      if (rel === "") return { trusted: true };
      return { trusted: false, reason: `unlexable:${libRel(rel)}` };
    }
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(child);
        continue;
      }
      if (!child.endsWith(".ts")) continue;
      let raw: string;
      try {
        // `libRel` is the extension-relative path, so the read joins it to the tree
        // root rather than to `smoke-tests/lib/` again.
        raw = readFileSync(path.join(extensionDir, libRel(child)), "utf8");
      } catch {
        return { trusted: false, reason: `unlexable:${libRel(child)}` };
      }
      if (lexSource(raw) === undefined) {
        return { trusted: false, reason: `unlexable:${libRel(child)}` };
      }
    }
  }
  return { trusted: true };
}
