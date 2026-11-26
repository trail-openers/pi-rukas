/**
 * work-driver-verify-select-literals — #2649: the literal rules of the selector,
 * split out of `work-driver-verify-select.ts`.
 *
 * Two selection rules answer a question about what a test's code SAYS rather than what
 * it imports: the classifier's exact namers of a changed repository file, and the
 * helper rule that finds the tests quoting a shell helper's path. Both read the roster
 * of offline tests (`work-driver-verify-offline-tests`), and a selection asks them
 * about every changed path at once — so the roster's literals are indexed ONCE per
 * selection and every question afterwards is a Map lookup, instead of the roster being
 * scanned once per changed path. A selection's literal cost is then the roster's size
 * once, not the roster's size times the number of changed paths — which is what made a
 * single docs path cost three full scans of the roster.
 *
 * The index has one key: a literal with the leading interpolation or relative prefix
 * removed (`"./docs/x.md"`, `"extension/docs/x.md"`, `"${d}/x.md"` all key to
 * `"docs/x.md"`). That single key serves both rules, because each compares a literal to
 * the changed path at a prefix-stripped form of itself: the classifier strips both sides
 * and requires equality, and the helper rule matches a path that carries no prefix, so
 * stripping changes nothing. The only spellings a changed path can be answered by are
 * therefore its own text and its text with one such prefix in front of it, and each is a
 * lookup — no scan of the roster finds who could answer.
 *
 * The rules themselves are injected rather than spelled here, so each keeps its single
 * spelling in its own module: the classifier's line in `work-driver-verify-classify`,
 * the helper's in `work-driver-verify-select`. Each is a line the mutation gates in
 * `test-verify-select-classify.ts` edit, and each is asked only of the literals that
 * could possibly satisfy it.
 */

import type { OfflineTests } from "./work-driver-verify-offline-tests.ts";

/** A leading interpolation or relative prefix that does not change which file a literal names — the classifier's own rule. */
const NAMER_LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;

/** The index key of a path or literal: its text with every leading prefix removed. */
export function literalKey(path: string): string {
  return path.replace(NAMER_LEADING_RE, "");
}

/**
 * The roster's literals, indexed once per selection: each distinct key, and for each the
 * roster tests holding a literal keyed by it, in roster order.
 *
 * A test the tokenizer could not close has no lexed entry, so it appears nowhere — which
 * is why the caller must not consult an index built from a doubtful roster.
 */
export interface LiteralIndex {
  /** a literal with its leading prefix removed → the tests holding such a literal. */
  byKey: Map<string, string[]>;
}

/** An empty index: what the off arm holds, since it never asks a literal rule anything. */
export function emptyLiteralIndex(): LiteralIndex {
  return { byKey: new Map() };
}

/** Append `name` to the bucket for `key`, once, keeping roster order. */
function push(index: Map<string, string[]>, key: string, name: string): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [name]);
  else if (!bucket.includes(name)) bucket.push(name);
}

/**
 * Index the whole roster's literals, once per selection: one pass over each roster
 * test's lexed strings and templates, deduplicated per test so a test that spells a path
 * twice is one holder of it — the answer each rule's per-path scan used to give.
 */
export function literalIndex(roster: OfflineTests): LiteralIndex {
  const index: LiteralIndex = { byKey: new Map() };
  for (const name of roster.names) {
    const lexed = roster.lexed.get(name);
    if (lexed === undefined) continue;
    for (const s of new Set([...lexed.strings, ...lexed.templates])) {
      push(index.byKey, literalKey(s), name);
    }
  }
  return index;
}

/**
 * The spellings under which a test may name `target`: its own text, and its text with
 * each single leading prefix the classifier's rule ignores in front of it. A literal
 * that satisfies either rule spells the target one of these ways, so these lookups are
 * the whole candidate set. A target that already carries a prefix is answered by its own
 * text alone, since both rules strip first and there is nothing left to strip.
 */
function spellingsOf(target: string): string[] {
  if (literalKey(target) !== target) return [target];
  return [target, `./${target}`, `../${target}`, `extension/${target}`];
}

/**
 * The tests that name `target` as an exact repository path, under the classifier's rule
 * (`namer`, spelled in `work-driver-verify-classify`): a test is asked only where it
 * holds a literal spelling the target one of the ways it could be spelled, and the rule
 * — which also carries the repository-path half — decides. Roster order, a test once.
 */
export function namersOf(
  index: LiteralIndex,
  target: string,
  namer: (literal: string, target: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const spelling of spellingsOf(target)) {
    if (!namer(spelling, target)) continue;
    for (const name of index.byKey.get(literalKey(spelling)) ?? []) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * The tests that quote each changed path verbatim, under the helper rule the selector
 * spells (`referrers`, spelled in `work-driver-verify-select`): one lookup per path, and
 * the rule asked only of the tests that hold a literal keyed by the path at all. Roster
 * order, a test once.
 */
export function quotersOf(
  roster: OfflineTests,
  index: LiteralIndex,
  targets: readonly string[],
  referrers: (roster: OfflineTests, rel: string) => string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const target of targets) {
    const holders = index.byKey.get(literalKey(target)) ?? [];
    if (holders.length === 0) continue;
    const quoted = new Set(referrers(roster, target));
    const names = holders.filter((n) => quoted.has(n));
    if (names.length > 0) out.set(target, names);
  }
  return out;
}
