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

import { type Dirent, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { lexSource } from "./work-driver-verify-select-lex.ts";

/** `trusted` with the reason it is not, or `undefined` when every file was read. */
export type LiteralTrust = { trusted: true } | { trusted: false; reason: string };

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
    let entries: Dirent[] | undefined;
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      // No lib directory at all is not a doubt: nothing under it can be misread.
      if (rel === "") return { trusted: true };
      return { trusted: false, reason: `unlexable:smoke-tests/lib/${rel}` };
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
        raw = readFileSync(path.join(dir, child), "utf8");
      } catch {
        return { trusted: false, reason: `unlexable:smoke-tests/lib/${child}` };
      }
      if (lexSource(raw) === undefined) {
        return { trusted: false, reason: `unlexable:smoke-tests/lib/${child}` };
      }
    }
  }
  return { trusted: true };
}
