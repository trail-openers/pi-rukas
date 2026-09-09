#!/usr/bin/env bun
/**
 * ledger-provenance — the #659 B1 provenance extension, at the unit level.
 *
 * A new `detected` provenance value joins `auto` and `asked` in the
 * decision-ledger. This test pins the whole contract:
 *
 *   1. renderRow/parseLedger round-trip of `[detected:agent,<date>]`
 *   2. the PER-PROVENANCE prefix-strip map (asked strips `operator,`,
 *      detected strips `agent,` — never the wrong one)
 *   3. the asymmetric date contract: renderRow(detected, "") THROWS;
 *      renderRow(auto, "") does NOT; parseLedger on a dateless detected row
 *      throws MarkerError while a dateless auto row parses fine
 *   4. mergeAutoRows sticky rule extended to detected (a detected row is
 *      never auto-overwritten)
 *
 * These are the four edit sites in ledger.ts; the test travels with the
 * subject.
 */

import {
  type LedgerRow,
  mergeAutoRows,
  parseLedger,
  renderLedger,
  renderRow,
  upsertRow,
} from "../src/agents-md/ledger.ts";
import { MarkerError } from "../src/agents-md/markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------- 1. round-trip

{
  const row: LedgerRow = {
    key: "quality-gates",
    value: "agent",
    provenance: "detected",
    date: "2026-01-01",
  };
  const line = renderRow(row);
  assert(
    line === `| quality-gates | agent | [detected:agent,2026-01-01] |`,
    "renderRow emits `[detected:agent,<date>]` for a detected row",
  );
  const parsed = parseLedger(line);
  assert(parsed.length === 1, "parseLedger recovers one row");
  assert(parsed[0]?.provenance === "detected", "round-trip: provenance is 'detected'");
  assert(parsed[0]?.date === "2026-01-01", "round-trip: date is intact");
  assert(parsed[0]?.key === "quality-gates", "round-trip: key intact");
}

// --------------------------------------- 2. per-provenance prefix-strip map
//
// The two provenances that carry a prefix must each recover ONLY their own
// date token: an `asked` row is never stripped with the `detected` (agent,)
// prefix and vice versa. A single generalised regex that strips
// `^[^,]+,` would work here but would corrupt a value containing a comma
// differently per kind — the map keeps the two kinds structurally distinct.

{
  const asked: LedgerRow = { key: "k", value: "v", provenance: "asked", date: "2026-02-02" };
  const askedLine = renderRow(asked);
  assert(
    askedLine === `| k | v | [asked:operator,2026-02-02] |`,
    "asked row renders `[asked:operator,<date>]`",
  );
  const askedParsed = parseLedger(askedLine);
  assert(askedParsed[0]?.provenance === "asked", "asked round-trip: provenance 'asked'");
  assert(askedParsed[0]?.date === "2026-02-02", "asked round-trip: date recovered (operator, stripped)");

  const detected: LedgerRow = { key: "k", value: "v", provenance: "detected", date: "2026-03-03" };
  const detectedLine = renderRow(detected);
  const detectedParsed = parseLedger(detectedLine);
  assert(detectedParsed[0]?.provenance === "detected", "detected round-trip: provenance 'detected'");
  assert(
    detectedParsed[0]?.date === "2026-03-03",
    "detected round-trip: date recovered (agent, stripped — NOT operator,)",
  );
  // Cross-check: an asked row must NOT be mis-parsed as detected, and a
  // detected row must NOT be mis-parsed as asked. The map guarantees this by
  // keying the strip on the provenance kind, not a shared pattern.
  assert(
    askedParsed[0]?.provenance !== "detected" && detectedParsed[0]?.provenance !== "asked",
    "prefix-strip is per-provenance: no cross-kind mis-parse",
  );
}

// ------------------------------------------- 3. asymmetric date contract
//
// detected + empty date → renderRow THROWS (a detected fact with no
// timestamp is a programmer error). auto + empty date → does NOT throw
// (existing behaviour: `[auto:]`). parseLedger on a dateless detected row →
// MarkerError; a dateless auto row parses fine. Both directions are pinned.

{
  let threw = false;
  try {
    renderRow({ key: "k", value: "v", provenance: "detected", date: "" });
  } catch (e) {
    threw = true;
    assert(e instanceof MarkerError, "renderRow(detected, '') throws a MarkerError");
  }
  assert(threw, "renderRow(detected, '') THROWS (asymmetric: detected requires a date)");

  // auto + empty date must NOT throw (existing behaviour unchanged).
  let autoThrew = false;
  const autoLine = (() => {
    try {
      return renderRow({ key: "k", value: "v", provenance: "auto", date: "" });
    } catch {
      autoThrew = true;
      return "";
    }
  })();
  assert(!autoThrew, "renderRow(auto, '') does NOT throw (auto tolerates an empty date)");
  assert(autoLine === `| k | v | [auto:] |`, "renderRow(auto, '') emits `[auto:]` (unchanged shape)");

  // parseLedger on a dateless detected row → MarkerError.
  let parseThrew = false;
  try {
    parseLedger(`| k | v | [detected:agent] |`);
  } catch (e) {
    parseThrew = true;
    assert(e instanceof MarkerError, "parseLedger on dateless detected row throws MarkerError");
  }
  assert(parseThrew, "parseLedger([detected:agent]) THROWS (corruption is an error)");

  // A dateless auto row parses fine (asymmetry, both directions).
  const autoParsed = parseLedger(`| k | v | [auto:] |`);
  assert(autoParsed.length === 1 && autoParsed[0]?.provenance === "auto", "dateless auto row parses");
  assert(autoParsed[0]?.date === "", "dateless auto row: date is empty string");
}

// ------------------------------------ 4. mergeAutoRows sticky extended to detected
//
// The sticky rule `if (cur.provenance === "asked") continue;` is extended to
// also skip `detected`: an agent-derived row is never silently overwritten by
// a fresh auto-derivation. The `auto` parameter only ever receives plain-auto
// rows, so this one-line extension is sufficient (no 3-way matrix).

{
  const existing: LedgerRow[] = [
    { key: "quality-gates", value: "agent", provenance: "detected", date: "2026-01-01" },
  ];
  const auto: LedgerRow[] = [
    { key: "quality-gates", value: "derived-different", provenance: "auto", date: "2026-09-01" },
  ];
  const merged = mergeAutoRows(existing, auto);
  const row = merged.find((r) => r.key === "quality-gates");
  assert(row?.provenance === "detected", "mergeAutoRows: a detected row is sticky (not auto-overwritten)");
  assert(row?.value === "agent", "mergeAutoRows: detected row keeps its original value");
  assert(row?.date === "2026-01-01", "mergeAutoRows: detected row keeps its original date");

  // Contrast: an auto row with a changed value IS superseded (unchanged rule).
  const autoExisting: LedgerRow[] = [
    { key: "k", value: "old", provenance: "auto", date: "2026-01-01" },
  ];
  const autoNew: LedgerRow[] = [
    { key: "k", value: "new", provenance: "auto", date: "2026-09-01" },
  ];
  const autoMerged = mergeAutoRows(autoExisting, autoNew);
  assert(autoMerged.find((r) => r.key === "k")?.value === "new", "auto row: changed value is still superseded");
}

// ------------------------------------------------------- 5. renderLedger over mixed
{
  const rows: LedgerRow[] = [
    { key: "a", value: "x", provenance: "auto", date: "2026-01-01" },
    { key: "b", value: "y", provenance: "asked", date: "2026-01-02" },
    { key: "c", value: "z", provenance: "detected", date: "2026-01-03" },
  ];
  const rendered = renderLedger(rows);
  const reparsed = parseLedger(rendered);
  assert(reparsed.length === 3, "renderLedger/parseLedger round-trips a mixed 3-provenance table");
  assert(reparsed[1]?.provenance === "asked", "mixed: asked row survives");
  assert(reparsed[2]?.provenance === "detected", "mixed: detected row survives");
  // upsertRow is provenance-agnostic (keys by row key) — a detected upsert
  // replaces an existing row in place, preserving position.
  const before = [{ key: "c", value: "z", provenance: "detected", date: "2026-01-03" }];
  const after = upsertRow(before, { key: "c", value: "z2", provenance: "detected", date: "2026-01-04" });
  assert(after.length === 1 && after[0]?.date === "2026-01-04", "upsertRow replaces a detected row in place");
}

console.log(exit === 0 ? "\nAll ledger-provenance checks passed." : "\nFAILED");
process.exit(exit);
