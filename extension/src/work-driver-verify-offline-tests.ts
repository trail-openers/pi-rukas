/**
 * work-driver-verify-offline-tests — #2649: the offline smoke tests of one tree,
 * read once per selection.
 *
 * Two #2649 rules need the same list — which offline tests exist, and what each
 * one's code says — and each used to read the directory for itself: the always-run
 * detector scanned the top level of `smoke-tests/`, and the changed-path classifier
 * of #2649 scans it again to find who names a docs file. A selection reads the tree
 * once and hands the same lexed answer to both, so a file cannot be a reader to one
 * rule and unknown to the other.
 *
 * `unlexable` is a verdict, not a gap: a test file the tokenizer cannot close has
 * no trustworthy literal set, so a caller must not select on the answer it could
 * give. A file that cannot be read at all is reported the same way — the safe
 * direction is the full suite, never a partial selection.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { type LexedSource, lexSource } from "./work-driver-verify-select-lex.ts";
import { isOfflineTest } from "./work-driver-verify-shared.ts";

/** Every offline test of the tree, lexed, plus the ones whose lexing could not be trusted. */
export interface OfflineTests {
  /** Sorted test names — the whole roster, lexable or not. */
  names: string[];
  /** name → its lexed source, for the tests the tokenizer could close. */
  lexed: Map<string, LexedSource>;
  /** True when any roster file could not be lexed or read. */
  unlexable: boolean;
}

/**
 * Read and lex every offline smoke test of the tree, once.
 *
 * The roster is the top level of `smoke-tests/`; `isOfflineTest` is the single
 * name contract (a `-live.ts` test never runs offline, so nothing may be selected
 * on what it names).
 */
export function readOfflineTests(extensionDir: string): OfflineTests {
  const names: string[] = [];
  const lexed = new Map<string, LexedSource>();
  let unlexable = false;
  for (const name of readdirSync(path.join(extensionDir, "smoke-tests"))) {
    const rel = `smoke-tests/${name}`;
    if (!isOfflineTest(rel)) continue;
    names.push(rel);
    let raw: string;
    try {
      raw = readFileSync(path.join(extensionDir, rel), "utf8");
    } catch {
      unlexable = true;
      continue;
    }
    const l = lexSource(raw);
    if (l === undefined) unlexable = true;
    else lexed.set(rel, l);
  }
  return { names: names.sort(), lexed, unlexable };
}

/** The offline smoke tests of `extensionDir`, sorted, as `smoke-tests/test-x.ts`. */
export function offlineTestNames(extensionDir: string): string[] {
  return readOfflineTests(extensionDir).names;
}
