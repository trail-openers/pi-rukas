/**
 * git-config-keys — the shared `.git/config` compared as keys, not as bytes (#2138).
 *
 * The fix fence compares the parsed key/value multiset of
 * `git config --file <commonDir>/config --list --null`, so a concurrent cycle's
 * branch-tracking churn (`git worktree add --track`, `git push -u`) and a pure
 * reorder are clean. Exemption is by exact normalised key template, never a
 * section prefix: `branch.<sub>.remote`, `branch.<sub>.merge`,
 * `remote.<name>.fetch`, `<sub>`/`<name>` being everything between the first
 * and last dot of the lower-cased key. Any other key counts, `remote.<name>.url`
 * included. A multiset, so a refspec that appears twice is a change.
 *
 * The parsed list is the compared form, and stays one: the caller keeps it as a
 * list and compares lists directly. Joining it on a delimiter and splitting again
 * was not injective — a value holding the delimiter could fold an entry into its
 * neighbour and delete the original key with the joined text unchanged.
 * `configEntryDigest` is the injective form the snapshot carries instead.
 */

import { createHash } from "node:crypto";

/** The config read's stdout cap, as on the fence's status call. */
export const CONFIG_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The config read's wall-clock bound — the same LOCAL_GIT_TIMEOUT_MS every other
 * guard-side local git read passes.
 */
export const CONFIG_TIMEOUT_MS = 30_000;

/** The full key templates a fix round is not blamed for; everything else counts. */
const EXEMPT_TEMPLATES = ["branch.*.remote", "branch.*.merge", "remote.*.fetch"];

/** `key` → its exempt template, or `undefined` for a key the round is blamed for. */
const exemptTemplate = (key: string): string | undefined => {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last <= first) return undefined;
  const template = `${key.slice(0, first)}.*.${key.slice(last + 1)}`;
  return EXEMPT_TEMPLATES.includes(template) ? template : undefined;
};

/** Whether `key` (already lower-cased) is churn a fix round is not blamed for. */
export function isExemptConfigKey(key: string): boolean {
  return exemptTemplate(key) !== undefined;
}

/**
 * `--list --null` stdout → one `key\tvalue` string per record, exempt keys out,
 * in git's output ORDER (for a repeated key, git's last value is the effective
 * one). Records are NUL-separated, each `key\nvalue`, so a value may hold a
 * newline. Every rejection names the record's index and the rule it broke, never
 * its content. A throw makes the caller's snapshot `unreadable`.
 */
export function parseConfigList(stdout: string): string[] {
  if (stdout !== "" && !stdout.endsWith("\0")) {
    throw new Error("git config read truncated: no trailing NUL separator");
  }
  const records = stdout.split("\0").filter((record) => record !== "");
  if (records.length === 0) {
    throw new Error("git config read returned no records: a repo config has core.* keys");
  }
  const out: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] as string;
    const nl = record.indexOf("\n");
    if (nl <= 0) throw new Error(`git config record ${i} has no key/value newline`);
    const key = record.slice(0, nl).toLowerCase();
    if (exemptTemplate(key) === undefined) out.push(`${key}\t${record.slice(nl + 1)}`);
  }
  return out;
}

/**
 * The compared form of a parsed list: injective, so two different lists can never
 * share one and no value can fold entries together. A section reorder changes it
 * (fail-closed); a reformat of the same ordered list does not.
 */
export function configEntryDigest(list: string[]): string {
  return `config:${createHash("sha256").update(JSON.stringify(list)).digest("hex")}`;
}

/**
 * The keys the before/after lists disagree on — added, rewritten, moved under
 * another key's name, or reordered where a repeated key's values swapped — each
 * named once, so the message never carries a value. Exempt keys are filtered out
 * of the reply, never of the compared lists: an exempt-only reorder still fails
 * the equality the caller already saw, and the reply then says so honestly.
 */
export function changedConfigKeys(before: string[], after: string[]): string[] {
  const multiset = (list: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const entry of list) map.set(entry, (map.get(entry) ?? 0) + 1);
    return map;
  };
  const keyOf = (entry: string): string => entry.slice(0, entry.indexOf("\t"));
  const changed = new Set<string>();
  const [b, a] = [multiset(before), multiset(after)];
  // The multiset legs catch every value change; the positional leg below adds the
  // keys whose ORDER moved (a reordered exempt key is not in `changed` then, and
  // `changedConfigKeys` sees the whole list). Together the two say whether the
  // lists differ, so the message names the non-exempt keys that do.
  const differing = changed.size > 0 || before.join("\n\0") !== after.join("\n\0");
  for (const [entry, n] of b) if (a.get(entry) !== n) changed.add(keyOf(entry));
  for (const [entry, n] of a) if (b.get(entry) !== n) changed.add(keyOf(entry));
  // Position matters only for a repeated key, where git's last value wins: a swap
  // keeps the multiset and changes the effective value. Positional rows add those
  // keys alone, so the ORDER leg names nothing an added or removed entry missed.
  // It is also the only leg that sees the positional fold — a record moved under
  // another key's name, which git then reads under the wrong section.
  const at = new Map<string, string>();
  before.forEach((entry, i) => at.set(entry, String(i)));
  const moved = after.filter((entry, i) => at.get(entry) !== String(i));
  for (const entry of moved) {
    const key = keyOf(entry);
    if (!changed.has(key)) changed.add(key);
  }
  return differing ? [...changed].filter((key) => !isExemptConfigKey(key)).sort() : [];
}
