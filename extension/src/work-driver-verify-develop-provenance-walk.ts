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

import { PROVENANCE_KEYS, PROVENANCE_MAX_TOKENS } from "./work-driver-verify-develop-provenance.ts";

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

/** What one file's bytes yielded: the tokens to probe, whether the corpus overflowed the cap,
 * and the keys whose value had no probeable shape. */
export interface ParsedTokens {
  pairs: ProvenancePair[];
  pastCap: boolean;
  unjudgable: UnjudgableValue[];
}

/** Parse one added file's bytes into (key, token) pairs, or say why it cannot be parsed.
 * NDJSON is line-by-line and one bad line makes the WHOLE file unparsable — a partially
 * parsed NDJSON would let a truncated tail read as a complete record set. */
export function tokensOf(
  content: string,
  ndjson: boolean,
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
  // A value under a provenance key that is neither a string nor a container of strings: a
  // half-serialised or hand-edited record. Not a pass — see the row's own comment.
  const unjudgable: UnjudgableValue[] = [];
  let pastCap = false;
  const seen = new Set<string>();
  const keySet = new Set(PROVENANCE_KEYS);
  /** Register one candidate token, honouring the per-workstream cap. Key and value are joined
   * with a NUL, which no JSON string can carry, so two distinct (key, value) pairs can never
   * collapse into one dedupe identity. */
  const offer = (key: string, raw: string): void => {
    const id = `${key}\u0000${raw}`;
    if (seen.has(id)) return;
    seen.add(id);
    // The cap bounds what is JUDGED, not what is reported: the first PROVENANCE_MAX_TOKENS
    // unique tokens are probed and the rest are carried as rows the caller discloses.
    // Returning false here instead would discard the whole file — and a 300-row record would
    // then leak past the gate that exists for records of exactly that size.
    if (pairs.length < PROVENANCE_MAX_TOKENS) pairs.push({ key, token: raw });
    else pastCap = true;
  };
  /** What a non-string value under a provenance key is, in words a reader can act on. */
  const shapeOf = (raw: unknown): string =>
    raw === null ? "null" : Array.isArray(raw) ? "an array" : typeof raw;
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
          if (keyUnderProvenance !== undefined) offer(keyUnderProvenance, item);
          continue;
        }
        if (!walk(item, depth + 1, keyUnderProvenance)) return false;
      }
      return true;
    }
    if (value === null || typeof value !== "object") return true;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === "string") {
        if (keySet.has(key)) offer(key, raw);
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
  return { ok: true, pairs, pastCap, unjudgable };
}
