/**
 * home-watch — the `$HOME` leftover listing for a REVIEWER child.
 *
 * A reviewer is the child that probes hostile config, and the four protected files of
 * `spawn-operator-config.ts` say nothing about a name the child creates elsewhere
 * under the operator's home (`~/.pi`, `~/.cache`, a dotfile of its own). So the same
 * window that snapshots those files lists the top level of `$HOME` before and after
 * the child and reports one line per NEW entry. Listing is disclosure, never
 * deletion: the operator's own entries are not this guard's to remove, and a line
 * naming a leftover costs the operator one read to act on.
 *
 * A reported name is an ACCUSATION, so two facts are required before one is named:
 *
 * 1. the baseline listing was READ. An unreadable home is not evidence of a child
 *    write, so a child that made entries in it is not accused — the rule
 *    `spawn-operator-config.ts` applies to a protected file with no baseline, and the
 *    reason a failed listing is kept apart from an empty one. Where the listing fails,
 *    the reason line names the errno the listing ACTUALLY got, never one re-derived by
 *    a second attempt: a home the child made readable again before the line was
 *    written would otherwise be reported as `unknown` for a home the guard could in
 *    fact read.
 * 2. the name is absent from that baseline, present in the listing taken after the
 *    child, and settled against the other runs watching the same home. Two overlapping
 *    reviewers both see the other's entry as "new since my baseline", so the pair of
 *    listings is not enough on its own: the ledger in this file keeps what each run
 *    saw and when, and an entry is named only where no other run's observations
 *    contradict it. Two facts about a run that started after this one settle the case,
 *    because each is something the writer cannot produce about its own entry — it saw
 *    neither of them:
 *      - that run's baseline already held the name, so the entry predates that run and
 *        cannot have come from this one, which opened earlier;
 *      - that run saw nothing there at all, so nothing was there for it to make and
 *        the entry this run sees must be the other one's.
 *    No entry is ever named on the strength of an inode timestamp compared with a
 *    userspace stamp: the two are not on one scale, and a window built from them drops
 *    the entry written in the same instant as its own bound (that is what
 *    `fs-clock.ts` is for). The listings are the whole of the evidence.
 *
 * Both are disclosure only: `ok`, `loopOutcome` and the verdicts are untouched, because
 * there is nothing to repair.
 */

import { readdir } from "node:fs/promises";
import { isFsClockSentinel } from "./fs-clock.ts";

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

/** A listing's names, with the guard's own clock-keeping filtered out. */
function listed(names: string[]): string[] {
  return names.filter((name) => !isFsClockSentinel(name));
}

/** One home's ledger: what each run listed, and when. */
type Sightings = { runs: Map<string, RunSighting>; at: number };

/**
 * One run's view of a home: when its baseline was taken, the names it saw then, and
 * the names its post-run listing saw (`null` = that listing never happened, so the run
 * observed nothing and says nothing about what the others made).
 */
type RunSighting = {
  startedAt: number;
  baseline: Set<string>;
  after: Set<string> | null;
  /** When the post-run listing was taken; null until it was (`0` before that). */
  endedAt: number;
};

/** Long enough that no real reviewer run is mistaken for a stale ledger. */
const LEDGER_TTL_MS = 10 * 60_000;

const ledgers = new Map<string, Sightings>();

function peekLedger(home: string): Sightings | undefined {
  return ledgers.get(home);
}

function freshLedger(home: string): Sightings | undefined {
  const held = ledgers.get(home);
  if (held === undefined) return undefined;
  if (Date.now() - held.at > LEDGER_TTL_MS) {
    ledgers.delete(home);
    return undefined;
  }
  return held;
}

/**
 * File this run's baseline with the home's ledger, so the runs watching the same home
 * can settle an overlapping entry between themselves. A baseline the clock could not
 * stamp (`startedAt` null) is not filed: with no bound the run cannot be placed in the
 * ordering, and a run is never accused on a gap it cannot be positioned in.
 */
export function recordBaseline(
  home: string,
  runId: string,
  names: string[],
  startedAt: number | null,
): void {
  if (startedAt === null) return;
  const held = freshLedger(home) ?? { runs: new Map<string, RunSighting>(), at: 0 };
  held.runs.set(runId, {
    startedAt,
    baseline: new Set(listed(names)),
    after: null,
    endedAt: 0,
  });
  held.at = Math.max(held.at, startedAt);
  ledgers.set(home, held);
}

/**
 * File this run's post-run listing. A run that saw an EMPTY top level is the strongest
 * witness against its own authorship: nothing was there during its window, so any
 * entry another run reports from that window cannot be its work — and the entry is
 * newer than its baseline, so it is not an entry that predates the pair either.
 */
export function recordAfterListing(
  home: string,
  runId: string,
  names: string[],
  startedAt: number,
): void {
  // The listing the run took BEFORE its work is what disqualifies it from another
  // run's entry, so a run that never filed a baseline (its listing failed) files none
  // here either: it has no observation of the home before its own writes, and a run
  // with nothing to say about its own window must not silence another run's report.
  const held = peekLedger(home);
  const mine = held?.runs.get(runId);
  if (held === undefined || mine === undefined) return;
  mine.after = new Set(listed(names));
  held.runs.set(runId, mine);
  held.at = Date.now();
  ledgers.set(home, held);
}

/**
 * Would another run's own listings contradict this run's claim on `name`? True for the
 * two shapes a writer cannot produce about an entry it made (it saw neither), and false
 * for every observation the writer really did make — including "I saw that entry too",
 * which a run whose window sat entirely inside the writer's records honestly and must
 * not silence the writer's line.
 */

/**
 * Would another run's own listings contradict this run's claim on `name`? Only two
 * shapes do, and a writer cannot produce either about an entry it made itself — it saw
 * neither of them:
 *
 * - the other run's baseline ALREADY held the name, so the entry predates that run,
 *   and this run opened even earlier: neither of them made it;
 * - the other run began after this one's baseline, saw the name in none of its
 *   listings, and still had something in the home to report. Its window therefore sat
 *   inside the span in which the name appeared, and its own listings show it wrote
 *   nothing there — so the name this run sees is its sibling's, not its own.
 *
 * Every other observation is the writer's own footprint and must not silence it, above
 * all "I saw that entry too" from a run whose window sat entirely inside the writer's.
 */
/**
 * Would another run's own listings contradict this run's claim on `name`? Only two
 * shapes do, and a run that MADE the entry can produce neither of them about it — it
 * saw the name in none of its own listings:
 *
 * - the other run's baseline already held the name, so the entry predates that run,
 *   and this run opened even earlier: neither of them made it;
 * - the other run's window sits inside this run's, saw nothing in the home at either
 *   end of its own window, and is therefore the run whose window the name appeared in
 *   without this run having anything to show for it.
 *
 * The other run has to be placed inside this run's window for the second shape to say
 * anything: a run that began after this run had already listed the name tells the
 * nothing about who wrote it, and must not overrule the run that watched the home the
 * whole time.
 */
/**
 * Would another run's own listings contradict this run's claim on `name`? Two shapes
 * do, and the run that MADE the entry can produce neither of them about it: it saw the
 * name in none of its listings, and it is not the youngest observer of it.
 *
 * - the other run's baseline already held the name, so the entry predates that run —
 *   and this run opened even earlier, so neither of them made it;
 * - the other run reports the name among the entries IT saw appear. An entry is
 *   reported by exactly one run, the one that made it, so two runs reporting the same
 *   name is one of them being wrong, and the younger window is the one that cannot be
 *   right: an entry this run saw appear after the other run's baseline had already
 *   listed the home is the other run's work, and the entry this run made it is the one
 *   the other run has no listing of.
 *
 * Under-reporting is the safe direction, so the elder's line stands when the two
 * cannot be told apart: both saw nothing, and both name nothing.
 */
function contradicted(
  home: string,
  name: string,
  runId: string,
  bounds: { baselineAt: number | null; seenAt: number | null },
): boolean {
  if (bounds.baselineAt === null) return false;
  const held = freshLedger(home);
  if (held === undefined) return false;
  for (const [other, seen] of held.runs) {
    if (other === runId) continue;
    if (seen.startedAt <= bounds.baselineAt) continue;
    if (seen.baseline.has(name)) return true;
    // The other run's window opened before this run finished listing: it was watching
    // when the entry appeared, and if it too lists the name as its own, this run is
    // the later claimant and the entry belongs to that window instead.
    if (
      seen.startedAt < (bounds.seenAt ?? Number.POSITIVE_INFINITY) &&
      (seen.after?.has(name) ?? false)
    ) {
      return true;
    }
  }
  return false;
}

/** Forget every ledger. For a test that wants the process's starting state. */
export function resetHomeSightings(): void {
  ledgers.clear();
}

/**
 * The new top-level entries of `home`, as one line per entry for the operator-config
 * report. `baseline` is the pre-run listing and `after` the one taken after the child,
 * or null when it could not be taken (in which case no entry is named — the caller
 * reports the failure instead).
 *
 * `runId` identifies this run to the ledger and `bounds.baselineAt` is when its
 * baseline was taken, both stamped by the watched filesystem (`fs-clock.ts`).
 */
export function homeNewEntryLines(
  role: string,
  home: string,
  runId: string,
  baseline: HomeBaseline,
  after: HomeBaseline | null,
  bounds: { baselineAt: number | null; seenAt: number | null },
): string[] {
  if (!("names" in baseline)) return [];
  if (after === null || !("names" in after)) return [];
  const had = new Set(listed(baseline.names));
  const lines: string[] = [];
  for (const name of listed(after.names)) {
    if (had.has(name)) continue;
    if (contradicted(home, name, runId, bounds)) continue;
    lines.push(`${name} created in $HOME during the ${role} run`);
  }
  return lines;
}
