#!/usr/bin/env bun
/**
 * #835 — collision-aware key fragments in the dispatch deck's description
 * column. Moved from test-dispatch-deck-interactive.ts (blocks 4c, 4d–4g):
 * same-role jobs whose keys share a long common prefix now render DISTINCT
 * descriptions (the 2nd+ occurrence's prefix lengthens until unique), with
 * the no-progress termination on duplicate keys and unchanged key/value
 * routing. Short/unique keys keep the exact pre-#835 output.
 */

import type { DeckEntry } from "../src/dispatch-deck.ts";
import { buildDeckItems, encodeDeckValue } from "../src/dispatch-deck-composite.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

// Fixtures: one developer-role entry per key, distinct seq/label so labels differ.
function mkJobs(keys: string[], now: number): DeckEntry[] {
  return keys.map((key, i) => ({
    key,
    label: `developer[task-${i}]`,
    seq: i,
    startedAt: now - 134_000,
    state: makeState("developer", { lastToolName: "bash", toolUses: 7, lastEventAt: now - 1000 }),
  }));
}

// 4c. #835 collision fix: same-role jobs whose keys are BOTH >10 chars and share the
// first 10 chars now render DISTINCT descriptions (the 2nd+ occurrence's prefix
// lengthens until unique). Labels and values still disambiguate.
{
  const now = 4_500_000;
  const items = buildDeckItems(mkJobs(["aaaaaaaaaaa1", "aaaaaaaaaaa2"], now), now);
  const d0 = items[0]?.description ?? "";
  const d1 = items[1]?.description ?? "";
  const ok = d0 !== d1 && d0.startsWith("key aaaaaaaaaa") && d1.startsWith("key aaaaaaaaaa");
  assert(ok, `distinct fragments after fix: ${d0} vs ${d1}`);
  assert(
    items[0]?.label !== items[1]?.label || items[0]?.value !== items[1]?.value,
    "labels/values still distinguish same-prefix keys",
  );
}

// 4d. Non-colliding >10-char key and ≤10-char key: output unchanged by the fix.
{
  const now = 4_700_000;
  const u4 = buildDeckItems(mkJobs(["z0z0z0z0z1z9"], now), now)[0]?.description ?? "";
  const u4ok = u4 === "key z0z0z0z0z1…" && buildDeckItems(mkJobs(["x"], now), now)[0]?.description === "x";
  assert(u4ok, "4d: unique fragment unchanged; ≤10-char key verbatim (no prefix, no ellipsis)");
}

// 4e. Three 15-char keys sharing their first 13 chars → 3 distinct fragments,
// key/value columns unchanged (routing safe).
{
  const now = 4_700_000;
  const keys = ["abcdefghijklm1x", "abcdefghijklm2x", "abcdefghijklm3x"];
  const items4 = buildDeckItems(mkJobs(keys, now), now).slice(0, keys.length);
  const ok4 =
    new Set(items4.map((it) => it?.description ?? "")).size === keys.length &&
    items4.every((it, i) => it.key === keys[i] && it.value === encodeDeckValue(keys[i] ?? ""));
  assert(ok4, "4e: 3 keys sharing 13 chars → distinct; key/value columns unchanged (routing safe)");
}

// 4f. Duplicate keys force the no-progress termination: same fragment,
// distinct labels, identical values (labels/values still disambiguate).
{
  const now = 4_700_000;
  const dup = buildDeckItems(mkJobs(["abc", "abc"], now), now);
  const dupOk = dup.length === 2 && dup[0]?.description === dup[1]?.description;
  const dupMsg = "4f: duplicates terminate — same fragment, distinct labels, values correct";
  assert(dupOk && dup[0]?.label !== dup[1]?.label && dup[0]?.value === dup[1]?.value, dupMsg);
}

// 4g (PM decision). Three 14-char keys sharing their first 12 chars → pairwise
// distinct, routing unchanged.
{
  const adv = ["aaaaaaaaaaaa11", "aaaaaaaaaaaa22", "aaaaaaaaaaaa33"];
  const items = buildDeckItems(mkJobs(adv, 4_900_000), 4_900_000).slice(0, adv.length);
  const descs = items.map((it) => it?.description ?? "");
  const ok5 =
    new Set(descs).size === adv.length &&
    items.every((it, i) => it.key === adv[i] && it.value === encodeDeckValue(adv[i] ?? ""));
  assert(ok5, `4g: 3 keys sharing 12 chars → pairwise distinct (${descs.join(" | ")}); routing safe`);
}

// 4h. Two entries with IDENTICAL keys longer than 10 chars: the loop must
// terminate (its no-progress exit) with the prefix lengthened past 10 —
// both fragments stay >10-char elided forms (never the full key), the
// fragment stays the leading fragment, and the labels/values still carry
// the identical key (identical, as in any duplicate-key deck).
{
  const now = 5_100_000;
  const k = "abcdefghijklmn";
  const items = buildDeckItems(mkJobs([k, k], now), now);
  assert(items.length === 2, "4h: duplicate long keys → 2 entries (no cancel sentinel, #834)");
  const d0 = items[0]?.description ?? "";
  const d1 = items[1]?.description ?? "";
  assert(
    d0 === `key ${k.slice(0, 10).trimEnd()}…` &&
      d1 === `key ${k.slice(0, 11).trimEnd()}…`,
    `4h: loop terminates (no-progress exit), both descriptions stay elided fragments (${d0} / ${d1})`,
  );
  assert(
    d0 !== d1 &&
      items[0]?.value === items[1]?.value &&
      items[0]?.value === encodeDeckValue(k),
    "4h: fragments remain pairwise distinct; values still round-trip the identical key",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
