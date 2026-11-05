/**
 * home-watch — the `$HOME` leftover listing for a REVIEWER child.
 *
 * A reviewer is the child that probes hostile config, and the four protected files of
 * `spawn-operator-config.ts` say nothing about a name the child creates elsewhere
 * under the operator's home (`~/.pi`, `~/.cache`, a dotfile of its own). So the same
 * window that snapshots those files lists the top level of `$HOME` before and after
 * the child and reports one line per NEW top-level entry NAME. Listing is disclosure,
 * never deletion: the operator's own entries are not this guard's to remove, and a
 * line naming a leftover costs the operator one read to act on.
 *
 * Names, not times: the difference is taken over the entry-name sets readdir gave, so
 * no clock reading sits anywhere near the verdict, and an entry the child replaced
 * under a name the baseline already held stays invisible — the four config files are
 * the guard's separate concern. Concurrency rides the guard's own model (module
 * header of `spawn-operator-config.ts`): overlapping children share one window, so
 * the line says "created in $HOME during the <role> run" and the warn is the
 * attribution rather than a claim about which child wrote the name.
 *
 * A name is an ACCUSATION, so it is named only where the baseline listing was READ.
 * An unreadable home is not evidence of a child write, so a child that made entries in
 * it is not accused — the rule `spawn-operator-config.ts` applies to a protected file
 * with no baseline, and the reason a failed listing is kept apart from an empty one:
 * `{ names: [] }` is "the top level is empty", which is a listing, and `{ code }` is
 * "there is no listing", which is not.
 *
 * Both are disclosure only: `ok`, `loopOutcome` and the verdicts are untouched, because
 * there is nothing to repair.
 *
 * A name is also UNTRUSTED text: a child picks it, and the line it lands in reaches
 * stderr and the PM's report. `neutraliseFenceEntry` is the repo's one-line sanitiser
 * for exactly that (a control character there is a log-injection primitive), and
 * `neutraliseEvidence` is the repo's marker neutraliser — it brackets every token a
 * reader parses (`VERDICT: APPROVED` → `‹VERDICT›: APPROVED`), which a child-chosen
 * name otherwise hands to the PM-facing line as a forgeable verdict. The name goes
 * through both, and so does `role`, which reaches the same line.
 */

import { readdir } from "node:fs/promises";
import { neutraliseEvidence } from "./comment-evidence.ts";
import { neutraliseFenceEntry } from "./plan-fence-render.ts";

/** The result of a listing: the names it saw, or the errno that stopped it. */
export type HomeBaseline = { names: string[] } | { code: string | undefined };

/**
 * List the top level of `home`, or report the errno that stopped the listing. The two
 * are never conflated: `{ names: [] }` is "the top level is empty", which is a
 * listing, and `{ code }` is "there is no listing", which is not.
 */
export async function homeEntries(home: string): Promise<HomeBaseline> {
  try {
    return { names: await readdir(home) };
  } catch (err) {
    return { code: (err as NodeJS.ErrnoException).code };
  }
}

/**
 * The new top-level entries of `home`, as one line per entry for the operator-config
 * report. `baseline` is the pre-run listing and `after` the one taken after the child.
 * A side that is not a listing yields no lines: the caller reports that failure
 * itself, and names are never accused against a listing the guard does not have.
 */
export function homeNewEntryLines(
  role: string,
  baseline: HomeBaseline,
  after: HomeBaseline,
): string[] {
  if (!("names" in baseline) || !("names" in after)) return [];
  const had = new Set(baseline.names);
  const lines: string[] = [];
  for (const name of new Set(after.names)) {
    if (!had.has(name))
      lines.push(
        `${neutraliseEvidence(neutraliseFenceEntry(name))} created in $HOME during the ${neutraliseEvidence(neutraliseFenceEntry(role))} run`,
      );
  }
  return lines;
}
