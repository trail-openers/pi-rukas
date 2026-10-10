#!/usr/bin/env bun
/**
 * #1029 — raw-text duplicate-key check for agents.json.
 *
 * `JSON.parse` silently keeps the LAST occurrence of a repeated key, so a
 * plain parse of agents.json can never reveal a duplicate. The wrapper-prefix
 * retirement left a bare `X` row next to a pre-existing bare `X` row in several
 * roles; every one of those duplicates was invisible to the last-wins parse.
 * This test scans the RAW text with a hand-rolled tokenizer that records every
 * key occurrence of every JSON object, and asserts no object repeats a key.
 *
 * Canaried: a fixture string containing a duplicate key MUST be reported,
 * and the same scanner run over a clean fixture must not.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const AGENTS_PATH = path.join(ROOT, "agents.json");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type ObjectScan = { keys: string[] };

/**
 * Scan raw JSON text and return one record per object (document order), each
 * carrying the object's keys in source order. Repeated keys therefore appear
 * as repeated entries — the shape `JSON.parse` hides.
 *
 * The tokenizer is intentionally small and dependency-free. It validates JSON
 * shape as it goes; malformed input throws, which is the desired failure mode
 * for a test fixture.
 */
function scanObjects(raw: string): ObjectScan[] {
  const objects: ObjectScan[] = [];
  const stack: ObjectScan[] = [];
  let i = 0;
  const n = raw.length;

  /** Read a JSON string starting at the opening quote at `start`. Returns
   *  [decodedValue, indexAfterClosingQuote]. */
  function readString(start: number): [string, number] {
    let j = start;
    let buf = "";
    buf += raw[j++]; // opening quote
    while (j < n) {
      const d = raw[j];
      buf += d;
      if (d === "\\") {
        buf += raw[j + 1];
        j += 2;
        continue;
      }
      if (d === '"') {
        j++;
        break;
      }
      j++;
    }
    if (j > n) throw new Error(`unterminated string at offset ${start}`);
    return [JSON.parse(buf), j];
  }

  while (i < n) {
    const c = raw[i];
    if (c === '"') {
      const [value, next] = readString(i);
      const top = stack[stack.length - 1];
      if (top) {
        // This string is a key iff the next non-space char is ':'.
        let k = next;
        while (k < n && raw[k] === " ") k++;
        if (raw[k] === ":") top.keys.push(value);
      }
      i = next;
      continue;
    }
    if (c === "{") {
      const obj: ObjectScan = { keys: [] };
      stack.push(obj);
      objects.push(obj);
      i++;
      continue;
    }
    if (c === "}") {
      stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return objects;
}

/** Per-object duplicate keys: `objectIndex:key -> occurrenceCount` (only >1). */
function duplicateKeys(raw: string): Map<string, number> {
  const objects = scanObjects(raw);
  const dupes = new Map<string, number>();
  objects.forEach((obj, idx) => {
    const counts = new Map<string, number>();
    for (const k of obj.keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const [k, count] of counts) {
      if (count > 1) dupes.set(`${idx}:${k}`, count);
    }
  });
  return dupes;
}

{
  const raw = readFileSync(AGENTS_PATH, "utf8");
  const dupes = duplicateKeys(raw);
  assert(dupes.size === 0, `agents.json: no object has a duplicate key (found ${dupes.size})`);
  if (dupes.size) {
    for (const [k, count] of dupes) console.error(`  object ${k} appears ${count}x`);
  }
}

// Canary: a fixture with a duplicate key MUST be reported; a clean one must
// not. Proves the scanner sees per-key occurrences rather than collapsing
// them the way JSON.parse does.
{
  const bad = '{ "a": "allow", "a": "deny", "b": { "c": 1, "c": 2 } }';
  const badDupes = duplicateKeys(bad);
  assert(
    badDupes.size === 2,
    `canary: fixture with duplicate keys IS reported (found ${badDupes.size}, expected 2)`,
  );

  const good = '{ "a": "allow", "b": { "c": 1, "d": 2 } }';
  const goodDupes = duplicateKeys(good);
  assert(
    goodDupes.size === 0,
    `canary: clean fixture reports no duplicates (found ${goodDupes.size})`,
  );
}

console.log(exit === 0 ? "\nAll duplicate-key checks passed." : "\nFAILED");
process.exit(exit);
