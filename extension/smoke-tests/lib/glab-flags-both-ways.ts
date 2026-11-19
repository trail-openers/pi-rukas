/**
 * The both-ways half of the `glab` flag gate — `test-glab-flags.ts`'s equality
 * assertion and its two red proofs, split out along the same data/gate seam the
 * flag data itself already uses (and for the same reason: the 500-line file limit).
 *
 * Why the equality exists at all: the offline arm asks only "is every flag a
 * builder emits pinned?", and the live arm asks only "does the installed binary
 * list every flag we pinned?". Neither can see a pin that no `GLAB_CALLS` row
 * emits — such a member asserts nothing, and it outlives the release that dropped
 * the flag. That is exactly how the shipped gate went red on glab 1.89.0 over
 * `api --form`/`--placeholder`, `ci status -w/--wait` and `auth status -F/--output`,
 * while the forge layer worked on 1.89.0 untouched. So each subcommand's pinned set
 * must EQUAL the flags its rows emit, in both directions.
 *
 * Both directions are observed failing, on copies of the SHIPPED flag text (the
 * `shipped.replace(...)` shape `lib/ci-doctrine-shipped-canaries.ts` uses), and
 * judged by the same `pinEqualsEmitted` predicate the shipped assertion uses. A
 * canary whose mutation did not apply is a red, not a pass — each one demands the
 * text actually changed before it demands the report.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** One row of the gate's enumeration, as `test-glab-flags.ts` builds it. */
export interface CallLike {
  key: string;
  argv: string[];
  /** Flags this row is EXPECTED to emit that its pinned set does not list. Excluded
   *  from the emitted side of the equality: a named defect is not a member the set
   *  must carry. */
  expectedUnknown?: string[];
}

/** Every (short, long) pair the help prints for a flag this layer emits. A pinned
 *  set carries both halves of a help row while a builder writes one spelling of
 *  each, so a member is live when a row emits it OR emits its partner — that is
 *  what makes `-s` live in the `mr create` set on a builder that writes `-s`. A
 *  member that pairs with nothing anyone emits asserts nothing, and is reported. */
const FLAG_PAIRS: readonly (readonly [string, string])[] = [
  ["-s", "--source-branch"],
  ["-b", "--target-branch"],
  ["-t", "--title"],
  ["-d", "--description"],
  ["-y", "--yes"],
  ["-l", "--label"],
  ["-p", "--page"],
  ["-P", "--per-page"],
  ["-w", "--web"],
  ["-m", "--message"],
  ["-l", "--live"],
  ["-A", "--all"],
  ["-X", "--method"],
  ["-H", "--header"],
  ["-f", "--raw-field"],
  // `--output` carries two short spellings across these subcommands: `-F` on every
  // subcommand but `issue list`, whose help prints `-O`.
  ["-F", "--output"],
  ["-O", "--output"],
  // `--auto-merge` is one flag with two spellings of its own: the bare flag, and the
  // `=false` form the merge builder writes.
  ["--auto-merge=false", "--auto-merge"],
];

/** `issue list` is the one subcommand whose `--output` is `-O`, not `-F`: the other
 *  short form of the SAME flag must not read as live there. */
const KEY_EXCLUDED: Record<string, string> = { "issue list": "-F" };

/** The members a pinned set may hold for a key, given what its rows emit: each
 *  emitted flag, the other spelling the help prints in the same row for it, and the
 *  pair that names the one known defect (`mr note create`'s body has no file form, so
 *  the set must carry the flag that replaces it or no arm could report `--body-file`
 *  as unknown at all). */
function allowedFor(
  key: string,
  emitted: Set<string>,
  noteReplacement: { key: string; instead: readonly string[] },
): Set<string> {
  const allowed = new Set<string>(emitted);
  for (const [shortForm, longForm] of FLAG_PAIRS) {
    if (emitted.has(shortForm)) allowed.add(longForm);
    if (emitted.has(longForm)) allowed.add(shortForm);
  }
  if (key === noteReplacement.key) {
    for (const f of noteReplacement.instead) allowed.add(f);
  }
  const excluded = KEY_EXCLUDED[key];
  if (excluded && !(emitted.has(excluded) && emitted.has("--output"))) allowed.delete(excluded);
  return allowed;
}

/** The equality, per subcommand key: one row per key whose pinned set is not exactly
 *  the flags its rows emit, naming the dead members and the unpinned ones. */
export function pinEqualsEmitted(
  entries: readonly CallLike[],
  flagSets: Record<string, ReadonlySet<string>>,
  opts: {
    flagsOf: (argv: string[]) => string[];
    noteReplacement: { key: string; instead: readonly string[] };
  },
): string[] {
  const failures: string[] = [];
  for (const key of [...new Set(entries.map((c) => c.key))]) {
    const pinned = flagSets[key] ?? new Set<string>();
    const emitted = new Set(
      entries
        .filter((c) => c.key === key)
        .flatMap((c) => opts.flagsOf(c.argv).filter((f) => !(c.expectedUnknown ?? []).includes(f))),
    );
    const dead = [...pinned].filter((f) => !allowedFor(key, emitted, opts.noteReplacement).has(f));
    const unchecked = [...emitted].filter((f) => !pinned.has(f));
    if (dead.length || unchecked.length) {
      failures.push(
        `${key}${dead.length ? ` — pinned but emitted by no row: ${dead.join(", ")}` : ""}${
          unchecked.length ? ` — emitted but not pinned: ${unchecked.join(", ")}` : ""
        }`,
      );
    }
  }
  return failures;
}

/** The shipped text of the flag data, with one literal rewritten — `from` MUST
 *  appear, or the canary is reported rather than silently skipped. */
function mutatedFlagData(
  from: string,
  to: string,
  assert: (cond: boolean, msg: string) => void,
): Record<string, ReadonlySet<string>> | null {
  const shipped = readFileSync(path.join(import.meta.dirname, "glab-flags-pinned.ts"), "utf8");
  const mutated = shipped.replace(from, to);
  assert(mutated !== shipped, `canary: the mutation \`${from.split("\n")[0]!.trim()}\` applied to the shipped flag data`);
  // The block runs to the file's final `};`, located by lastIndexOf rather than a
  // regex: the literal's members close with `]),` and `]` on their own lines, so a
  // bracket-anchored pattern stops inside a member, and a truncated literal is a
  // syntax error, not a mutated set.
  const start = mutated.search(/export const GLAB_FLAGS[^=]*=/);
  const open = mutated.indexOf("{", start);
  const close = mutated.lastIndexOf("\n};");
  assert(start >= 0 && open >= 0 && close > open, "canary: the shipped GLAB_FLAGS block was found to mutate");
  if (start < 0 || open < 0 || close <= open) return null;
  // The literal is `new Set([...])` values over string literals with no identifiers
  // of their own, so it evaluates without the module's imports. Its `new Set<string>()`
  // annotations are TS-only and erase to a bare `new Set()`.
  const body = mutated.slice(open + 1, close).replace(/<string>/g, "");
  return new Function(`return {${body}}`)() as Record<string, ReadonlySet<string>>;
}

/** The floor, asserted once: the literal lives in the data file's header, the prose
 *  lives in the docs, and the two must name the same version. Same pattern as the Pi
 *  install floor (`install-preflight.sh`'s `MIN_PI_VERSION`, read by
 *  `test-pi-min-version.ts`): an edit to either side that drifts is reported here
 *  rather than left to a reader comparing two files. */
export function glabFloorCanaries(
  minVersion: string,
  assert: (cond: boolean, msg: string) => void,
): void {
  const docs = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "..", "docs", "headless.md"),
    "utf8",
  );
  const section = docs.slice(docs.indexOf("## Which forge a cycle works on"));
  const named = section.match(/glab`? \*\*(\d+\.\d+\.\d+)\*\* \(or newer\)/);
  assert(
    /^\d+\.\d+\.\d+$/.test(minVersion),
    `lib/glab-flags-pinned.ts declares GLAB_MIN_VERSION as a version (got "${minVersion}")`,
  );
  assert(
    named !== null,
    "docs/headless.md names a glab floor in the forge-capability section (``glab` **X.Y.Z** (or newer)``)",
  );
  assert(
    named !== null && named[1] === minVersion,
    `docs/headless.md and GLAB_MIN_VERSION name the same floor (docs ${named?.[1] ?? "none"} vs data ${minVersion})`,
  );
}

/** The shipped equality plus the two red proofs, reported through the caller's
 *  `assert` so they count in its exit code. */
export function glabFlagCanaries(
  entries: readonly CallLike[],
  flagSets: Record<string, ReadonlySet<string>>,
  assert: (cond: boolean, msg: string) => void,
  opts: {
    flagsOf: (argv: string[]) => string[];
    noteReplacement: { key: string; instead: readonly string[] };
  },
): void {
  const rows = pinEqualsEmitted(entries, flagSets, opts);
  assert(
    rows.length === 0,
    `every pinned set equals exactly the flags its GLAB_CALLS rows emit${rows.length ? ` — ${rows.join("; ")}` : ""}`,
  );

  // Proof 1 — a stale pin re-added. `--form` is a real `glab api` flag on new builds
  // that no row ever emitted: it is literally the member this data shipped with, and
  // the one that turned the gate red on 1.89.0 for a call that worked there.
  const stale = mutatedFlagData(
    `  api: new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "--output"]),`,
    `  api: new Set(["-X", "--method", "-H", "--header", "-f", "--raw-field", "--output", "--form"]),`,
    assert,
  );
  const staleRows = stale ? pinEqualsEmitted(entries, stale, opts) : ["<mutation failed>"];
  assert(
    staleRows.length === 1 && staleRows[0]!.includes("api") && staleRows[0]!.includes("--form"),
    `canary: a re-added pin no row emits IS reported (${staleRows.join("; ") || "not reported"})`,
  );

  // Proof 2 — an emitted flag dropped from its pin set: the other half of the
  // equality, on the same shipped text. `-y` is what stops glab's confirmation
  // prompt, so a set that lost it would hide a builder regression the offline arm
  // would then wave through.
  const dropped = mutatedFlagData(
    `    "--draft",
    "-y",
    "--yes",`,
    `    "--draft",
    "--yes",`,
    assert,
  );
  const droppedRows = dropped ? pinEqualsEmitted(entries, dropped, opts) : ["<mutation failed>"];
  assert(
    droppedRows.length === 1 && droppedRows[0]!.includes("mr create") && droppedRows[0]!.includes("-y"),
    `canary: an emitted flag dropped from its pin set IS reported (${droppedRows.join("; ") || "not reported"})`,
  );
}
