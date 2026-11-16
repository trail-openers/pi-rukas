/**
 * work-driver-verify-develop-provenance-walk — one added data file's bytes to the tokens this
 * gate judges, plus what it declined to judge.
 *
 * Split out of `work-driver-verify-develop-provenance.ts` for the 500-line cap, along the seam
 * the file already had: parsing and walking a record is a pure function of its bytes, and the
 * gate around it is git reads and verdicts. The split matters for testability more than for
 * length — a walk that quietly read nothing and reported a clean file is the vacuous-green class
 * this gate exists to close, and a pure function makes that arm assertable without a repository.
 *
 * The rule the walk enforces: a value under one of {@link PROVENANCE_KEYS} that is a string (or
 * a string inside an array or nested container under such a key) is a candidate token; one whose
 * shape names no path is disclosed, never exempt. The per-workstream token cap bounds what is
 * JUDGED and not what is reported — past the cap the remainder is carried as a row, because a
 * walk that dropped the file entirely would let a 300-row record evade the gate built for
 * records of exactly that size.
 */

import {
  PROVENANCE_KEYS,
  PROVENANCE_MAX_CANDIDATES_PER_VALUE,
  PROVENANCE_MAX_TOKENS,
  provenanceFragmentId,
  provenanceTokenId,
} from "./work-driver-verify-develop-provenance-token.ts";

/** Extensions whose bytes are read as a data record. YAML and every other format is out of
 * scope: an added file with any other extension is simply not a data record here. Lives with
 * the walk because the walk is what reads the bytes; the gate asks this module the question. */
const DATA_SUFFIXES = [".json", ".ndjson"] as const;

/** Does this added path name a file this gate reads as a data record? */
export function isDataFile(p: string): boolean {
  const lower = p.toLowerCase();
  return DATA_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** A file whose own text is a NDJSON array of rows, one record per line. */
export const NDJSON_SUFFIX = ".ndjson";

/** A candidate token: the provenance key it sat under and the raw string to probe. */
export interface ProvenancePair {
  key: string;
  token: string;
}

/** A value under a provenance key whose shape names no path: recorded so the caller discloses
 * it rather than reading the file as clean. */
export interface UnjudgableValue {
  key: string;
  shape: string;
}

/** A whole string under a provenance key, carried by its key for the caller to render as a
 * disclosure row. Same field shape as a pair, because it is a (key, raw value) row. */
export interface UnreportedValue {
  key: string;
  token: string;
}

/** What one file's bytes yielded: the tokens to probe, whether the corpus overflowed the cap,
 * and the keys whose value had no probeable shape. */
export interface ParsedTokens {
  pairs: ProvenancePair[];
  pastCap: boolean;
  unjudgable: UnjudgableValue[];
  /** The whole values the extractor split up to its per-value ceiling, so the remainder of each
   * was not judged. Empty whenever no extractor was handed, which is what keeps the off arm's
   * disclosure set the shipped one. A value that yielded NO fragment is not carried here: the
   * walk offered it as a whole-value pair (the shipped behaviour) and the caller's classifier
   * already discloses it, so a second row would double-report the same claim. */
  truncated: UnreportedValue[];
  /** The workstream's token charge after this file — feed it to the next file's budget so the
   * cap and the shared dedupe set count the workstream and not each file. */
  chargedInto: number;
}

/** Parse one added file's bytes into (key, token) pairs, or say why it cannot be parsed.
 * NDJSON is line-by-line and one bad line makes the WHOLE file unparsable — a partially
 * parsed NDJSON would let a truncated tail read as a complete record set.
 *
 * `keys` is the set of provenance names this call walks. It is a parameter rather than a read of
 * {@link PROVENANCE_KEYS} because the prose switch selects between two sets at call time — the
 * nine current names and the seven v0.14.85 shipped — and a walk that read the constant itself
 * could not be told which one to use, which is the reason
 * `test-verify-develop-provenance-prose-v85.ts` would have had no off arm to compare against.
 * Omit it and the walk uses the current set. */
export function tokensOf(
  content: string,
  ndjson: boolean,
  budget?: ProvenanceBudget,
  keys: readonly string[] = PROVENANCE_KEYS,
  extract?: (value: string) => string[],
): ({ ok: true } & ParsedTokens) | { ok: false; why: string } {
  const values: unknown[] = [];
  if (ndjson) {
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        return { ok: false, why: "a row is not valid JSON" };
      }
      values.push(row);
    }
  } else {
    try {
      values.push(JSON.parse(content));
    } catch {
      return { ok: false, why: "the file is not valid JSON" };
    }
  }
  const pairs: ProvenancePair[] = [];
  // A value the extractor split past its per-value ceiling. The remainder was not judged and the
  // reader has to be able to tell that from a value whose every fragment was probed. Populated
  // only when the extractor is handed; with no extractor — the v0.14.85 shape, which is what the
  // prose switch's off arm passes — this stays empty and the walk is byte-for-byte the shipped one.
  const truncated: UnreportedValue[] = [];
  // A value under a provenance key that is neither a string nor a container of strings: a
  // half-serialised or hand-edited record. Not a pass — see the row's own comment.
  const unjudgable: UnjudgableValue[] = [];
  let pastCap = false;
  const keySet = new Set(keys);
  // Dedupe and the cap live with the CALLER, not with the file. The cap is one workstream's
  // budget for the git probes a review round pays; a set and a counter local to one file made
  // it a per-file allowance, so N added files bought N × the cap and the bound bounded nothing.
  const seen = budget?.seen ?? new Set<string>();
  // The count of record tokens this walk has offered. Kept separate from the caller's charge
  // because it is the per-file view a reader of ONE file's disclosure row wants, while the
  // charge is the workstream-wide number the cap is actually drawn against.
  let offered = 0;
  /** How many tokens this workstream has already been charged, carried in from earlier files. */
  let charged = budget?.chargedInto ?? 0;
  /** Charge the workstream's budget for one token this walk has never seen. `id` is the dedupe
   * identity the caller picked — the (key, value) pair for a whole value, the marker-prefixed
   * fragment for a fragment — and the two live in DISJOINT namespaces on purpose. Writes through to
   * the caller's object AS WELL AS the local count: the gate threads the budget through the
   * executor-mediated reads between files, and a returned field can be dropped along that path
   * without any type error — the object is the state. `charged`
   * still starts from the carried-in number rather than the set size, because a set that deduped a
   * repeated token must not be charged twice for it.
   *
   * The cap bounds what is JUDGED, not what is reported: the tokens up to the budget are
   * probed and the rest are carried as rows the caller discloses. Refusing to add them here
   * would discard the whole file — and a 300-row record would then leak past the gate that
   * exists for records of exactly that size. */
  const charge = (id: string): void => {
    charged++;
    seen.add(id);
    if (budget !== undefined) budget.chargedInto = charged;
  };
  const offer = (key: string, raw: string): void => {
    // A whole value is judged under its own (key, value) identity and nothing else. It is NOT
    // deduped against a fragment identity: a fragment in `seen` says some sentence in the corpus
    // named these bytes, which is not evidence that THIS value was judged, and deduping on it
    // dropped the claim with no probe, no failure, no note and no row. The one duplication that
    // costs anything — a value that is nothing but one fragment, which the split offers again as a
    // fragment — is bounded, cheap, and belongs to the split arm, not here.
    const id = provenanceTokenId(key, raw);
    if (!seen.has(id)) {
      // The budget is the WORKSTREAM's, so the carried-in charge is tested first: an earlier
      // file can have spent it all, and a per-file counter would then happily hand this file
      // another full allowance — N added files buying N × the cap.
      if (charged >= PROVENANCE_MAX_TOKENS) {
        pastCap = true;
        // Charged all the same: an offered-but-not-judged token is one the workstream ran out
        // of budget on, and the set is what makes a repeat of it cheap rather than free.
        charge(id);
        return;
      }
      seen.add(id);
      offered++;
      charge(id);
      pairs.push({ key, token: raw });
      return;
    }
    // A token an earlier file of the SAME workstream already offered spent budget that will not
    // be spent again, and the budget is one workstream's, not one file's: without this row a
    // corpus repeated across files reported itself as in-budget when the workstream had already
    // overflowed.
    if (charged >= PROVENANCE_MAX_TOKENS) pastCap = true;
  };
  /** What a non-string value under a provenance key is, in words a reader can act on. */
  const shapeOf = (raw: unknown): string =>
    raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw;
  /** One string under a provenance key, read either whole (no extractor) or split into
   * fragments (the prose arm). Splitting is what #2295 exists for: a claim wrapped in a
   * sentence used to be the pass-by-whitespace this gate never saw.
   *
   * The fragment identity is {@link provenanceFragmentId} — the fragment under a `frag\0` marker,
   * not the (key, fragment) pair: two rows of one corpus that cite the same absent file in
   * different sentences are one claim, and probing it twice buys a duplicate failure. The marker
   * is what keeps that identity from colliding with a whole value's {@link provenanceTokenId}:
   * the bare fragment string IS a legal value under some other key, and an unmarked identity made
   * a prose claim sharing bytes with a sibling bare claim get silently dropped — no probe, no
   * failure, no row. The whole-value identity keeps the pair, which is what the shipped walk used,
   * and the two namespaces are tested to stay disjoint by
   * `test-verify-develop-provenance-prose.ts`.
   *
   * A value that yields NO fragment is offered under its key exactly as the shipped walk offered
   * it, so the caller's classifier reaches the same verdict on it it reached before #2295 — a
   * sentence with nothing path-shaped in it is disclosed as host provenance, not failed. */
  const offerString = (key: string, raw: string): void => {
    if (extract === undefined) {
      offer(key, raw);
      return;
    }
    const fragments = extract(raw);
    if (fragments.length === 0) {
      // The value yielded nothing to split, so it is offered whole exactly as the shipped walk
      // offered it — and the identity it is tested against is its OWN pair identity, never a
      // fragment's. A fragment identity in `seen` says some sentence elsewhere in the corpus named
      // these bytes; it does not say this value was judged, and deduping a whole value against it
      // dropped the claim with no probe, no failure, no note and no row. `{"source":"run.log",
      // "input":"elapsed of run.log …"}` is that shape: the second value's only fragment is the
      // first value's whole self, so the prose claim vanished.
      offer(key, raw);
      return;
    }
    for (const fragment of fragments) {
      // The fragment's own identity, and nothing else. Testing it against a whole-value identity
      // was the bug: `"run.log"` as a value and `run.log` as a fragment of a SIBLING's sentence are
      // different claims — the first says "I read this file", the second says "this file fed that
      // number" — and a hit on the pair identity dropped the fragment with no probe, no failure,
      // no note and no row. The pair namespace and the fragment namespace are disjoint precisely so
      // neither can swallow the other; a value that is nothing but one fragment is judged twice at
      // worst, which is one extra git probe on the same answer, not a wrong one.
      const id = provenanceFragmentId(fragment);
      if (!seen.has(id)) {
        if (charged >= PROVENANCE_MAX_TOKENS) {
          pastCap = true;
          charge(id);
          continue;
        }
        offered++;
        charge(id);
        pairs.push({ key, token: fragment });
      } else if (charged >= PROVENANCE_MAX_TOKENS) {
        pastCap = true;
      }
    }
    if (fragments.length >= PROVENANCE_MAX_CANDIDATES_PER_VALUE) {
      truncated.push({ key, token: raw });
    }
  };
  const walk = (value: unknown, depth: number, keyUnderProvenance?: string): boolean => {
    // Depth ceiling: a self-referential structure cannot occur in parsed JSON (JSON.parse
    // rejects cycles), so this bounds cost against a pathological fixture, not an attack.
    if (depth > 32) return false;
    if (Array.isArray(value)) {
      for (const item of value) {
        // A STRING inside an array under a provenance key is a candidate token: `sources:
        // ["a.json","b.json"]` is the shape a multi-file corpus actually takes, and recursing
        // past it without reading it judged nothing and reported a pass. A nested container is
        // walked, because the strings it holds are the record's own provenance.
        if (typeof item === "string") {
          if (keyUnderProvenance !== undefined) offerString(keyUnderProvenance, item);
          continue;
        }
        if (!walk(item, depth + 1, keyUnderProvenance)) return false;
      }
      return true;
    }
    if (value === null || typeof value !== "object") return true;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === "string") {
        if (keySet.has(key)) offerString(key, raw);
        continue;
      }
      if (keySet.has(key) && shapeOf(raw) !== "an array") {
        // An object, a number or null under a provenance key names no path this gate can
        // probe, so it can never fail — and it is never exempt either: a value of a shape nobody
        // wrote is exactly what a synthesised or half-serialised record looks like, and dropping
        // it silently is the pass-by-silence this gate exists to refuse. An ARRAY is the
        // exception: its elements are read above, and disclosing it as well would bury the
        // verdict its own strings earned.
        unjudgable.push({ key, shape: shapeOf(raw) });
        continue;
      }
      // A container under a provenance key carries no name of its own, so its nested strings
      // are judged against the key they ultimately sit under — `sources: [{ input: … }]` is a
      // provenance list whatever its depth.
      if (!walk(raw, depth + 1, keySet.has(key) ? key : undefined)) return false;
    }
    return true;
  };
  for (const root of values) {
    if (!walk(root, 0))
      return { ok: false, why: "a value is nested past the 32-level walk ceiling" };
  }
  // The charge lives on the CALLER's object, so the cap survives however the gate threads the
  // budget between files; the returned copy is the same number for a caller that passed no
  // budget at all and needs a count of its own.
  return {
    ok: true,
    pairs,
    pastCap,
    unjudgable,
    truncated,
    chargedInto: charged,
  };
}

/** The workstream-scoped state a walk shares across the files of one workstream: which
 * (key, token) identities have already been offered. Optional — a caller with one file needs
 * neither it nor a cap argument. The cap itself is counted by the walk over the tokens it
 * offered, so it cannot be desynced from what the walk actually read. */
export interface ProvenanceBudget {
  seen: Set<string>;
  chargedInto: number;
}
