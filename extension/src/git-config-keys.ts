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
 */

/** The config read's stdout cap, as on the fence's status call. */
export const CONFIG_MAX_BUFFER = 4 * 1024 * 1024;

/** The full key templates a fix round is not blamed for; everything else counts. */
const EXEMPT_TEMPLATES = ["branch.*.remote", "branch.*.merge", "remote.*.fetch"];

/**
 * `--list --null` stdout → one `key\tvalue` string per record, exempt keys out.
 * Records are NUL-separated, each `key\nvalue`, so a value may hold a newline;
 * anything else throws, so a truncated read is never a clean empty list.
 */
export function parseConfigList(stdout: string): string[] {
  const out: string[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    if (nl <= 0) throw new Error(`unparsable git config record: ${JSON.stringify(record)}`);
    const key = record.slice(0, nl).toLowerCase();
    const [first, last] = [key.indexOf("."), key.lastIndexOf(".")];
    const template = `${key.slice(0, first)}.*.${key.slice(last + 1)}`;
    if (!(first > 0 && last > first && EXEMPT_TEMPLATES.includes(template))) {
      out.push(`${key}\t${record.slice(nl + 1)}`);
    }
  }
  return out;
}

/**
 * The keys a before/after pair of parsed lists disagree on — added, removed or
 * rewritten — each named once, so the caller's message never carries a value.
 */
export function changedConfigKeys(before: string[], after: string[]): string[] {
  const multiset = (list: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const entry of list) map.set(entry, (map.get(entry) ?? 0) + 1);
    return map;
  };
  const changed = new Set<string>();
  const [b, a] = [multiset(before), multiset(after)];
  for (const [entry, n] of b) {
    if (a.get(entry) !== n) changed.add(entry.slice(0, entry.indexOf("\t")));
  }
  for (const [entry, n] of a) {
    if (b.get(entry) !== n) changed.add(entry.slice(0, entry.indexOf("\t")));
  }
  return [...changed].sort();
}
