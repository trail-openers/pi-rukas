/**
 * ledger — the in-file decision ledger for pi-ensemble's AGENTS.md.
 *
 * ## Why in-file, not a sidecar
 *
 * The ledger is a **per-repo fact that must travel with the repo**. A `.pi/`
 * sidecar is per-machine state (gitignored, regenerated on each host) and would
 * silently forget an operator's decision the moment the repo moved to another
 * checkout — which is exactly when a second, divergent decision would be made
 * and baked into the next render. The `decision-ledger` marker section keeps
 * the decisions next to the bytes they govern, in the same file, under the
 * same splice discipline as every other managed section.
 *
 * ## Row model
 *
 * One line per decision, in a markdown table. The provenance column is what
 * separates the two kinds of row, and the asymmetry is the whole design:
 *
 *   - `[auto:<date>]` — re-derivable from the repository. The next render
 *     recomputes it and **silently supersedes** the row if the derivation
 *     changed; no operator is involved because nothing was decided by a human.
 *   - `[asked:operator,<date>]` — the operator chose, overriding the
 *     auto-derivation. This row is **sticky**: a later render must not rewrite
 *     it just because the environment drifted. Drift on an `asked` row is a
 *     **warning** surfaced by `check`, never an automatic change.
 *
 * The date is a provenance stamp, not content: two renders of the same facts
 * produce different ledger dates, so the ledger is excluded from the
 * pure-render `Buffer.equals` idempotency assertion (see renderer.ts).
 */

import { MarkerError } from "./markers.ts";

export type LedgerProvenance = "auto" | "asked";

export interface LedgerRow {
  key: string;
  value: string;
  provenance: LedgerProvenance;
  date: string; // YYYY-MM-DD, the day the row was written
}

const ROW_RE = /^\|\s*([^\s|][^|]*?)\s*\|\s*(\S[^|]*?)\s*\|\s*\[(auto|asked)(?::([^\]]*))?\]\s*\|$/;

/** Render the ledger section body (table) from rows, in the given order. */
export function renderLedger(rows: LedgerRow[]): string {
  const header = "| key | value | provenance |\n| --- | --- | --- |";
  const body = rows.map((r) => renderRow(r));
  return [header, ...body].join("\n");
}

/** Render a single row as one table line. */
export function renderRow(r: LedgerRow): string {
  const prov = r.provenance === "asked" ? `asked:operator,${r.date}` : `auto:${r.date}`;
  return `| ${r.key} | ${r.value} | [${prov}] |`;
}

/**
 * Parse the ledger section body back into rows. Tolerant of an empty table
 * (header only) and of surrounding blank lines. Throws MarkerError on a
 * malformed row — the ledger must not silently drop a decision it cannot
 * read, or the next render would "forget" it and re-ask (or re-derive) the
 * very thing an operator already settled.
 */
export function parseLedger(body: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    // Skip the header row and the separator row.
    if (/^\| key \|/.test(t)) continue;
    if (/^\|\s*-{2,}/.test(t)) continue;
    const m = t.match(ROW_RE);
    if (!m) {
      throw new MarkerError(`malformed ledger row: ${t}`);
    }
    const provKind = (m[3] ?? "") as LedgerProvenance;
    const provExtra = m[4];
    let date = "";
    if (provExtra) {
      date = provExtra.replace(/^operator,/, "").trim();
    }
    rows.push({
      key: (m[1] ?? "").trim(),
      value: (m[2] ?? "").trim(),
      provenance: provKind,
      date,
    });
  }
  return rows;
}

/**
 * Upsert `row` into `rows` by key. Same-key rows are replaced IN PLACE — the
 * order of the surviving rows is preserved (an `asked` row keeps its position
 * rather than jumping to the end, which would make diffs noisy). Returns a new
 * array; never mutates the input.
 */
export function upsertRow(rows: LedgerRow[], row: LedgerRow): LedgerRow[] {
  const idx = rows.findIndex((r) => r.key === row.key);
  if (idx === -1) return [...rows, row];
  const out = rows.slice();
  out[idx] = row;
  return out;
}

/**
 * Merge new auto-derived rows over the existing ledger.
 *
 * The rules:
 *   - an existing `asked` row is NEVER overwritten by an `auto` row (sticky).
 *   - an existing `auto` row is superseded by a new `auto` row only when the
 *     value changed; an unchanged auto row is kept (date preserved) so a
 *     re-render does not churn the ledger for no reason.
 *   - a new `auto` row for an unknown key is appended.
 *
 * The `asked` row wins on a key collision: the human decision is the record.
 */
export function mergeAutoRows(existing: LedgerRow[], auto: LedgerRow[]): LedgerRow[] {
  const out = existing.slice();
  for (const a of auto) {
    const i = out.findIndex((r) => r.key === a.key);
    if (i === -1) {
      out.push({ ...a });
    } else {
      const cur = out[i];
      if (!cur) continue;
      if (cur.provenance === "asked") continue; // sticky — never auto-overwrite
      if (cur.value !== a.value) {
        out[i] = { ...a }; // value changed → supersede
      }
      // value identical → keep the existing row, date and all
    }
  }
  return out;
}

/**
 * Find keys where an `asked` row has drifted from a fresh auto-derivation.
 *
 * Drift here means: the operator chose value X, but the repository now
 * auto-derives value Y ≠ X. This is a WARNING, not an error — the operator's
 * choice stands; `check` reports it so a human can decide whether to re-ask.
 */
export function driftWarnings(
  existing: LedgerRow[],
  auto: LedgerRow[],
): { key: string; asked: string; derived: string }[] {
  const out: { key: string; asked: string; derived: string }[] = [];
  for (const a of auto) {
    const cur = existing.find((r) => r.key === a.key);
    if (cur && cur.provenance === "asked" && cur.value !== a.value) {
      out.push({ key: a.key, asked: cur.value, derived: a.value });
    }
  }
  return out;
}
