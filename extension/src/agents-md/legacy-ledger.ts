/**
 * legacy-ledger — the pre-M2 in-file decision-ledger reader.
 *
 * Post-#681 M2 the ledger lives in a JSON sidecar (`.pi/agents-md-state.json`),
 * and the heading-based section detector (section-detect.ts) no longer knows
 * about the marker spans that only pre-migration files carry. This module is
 * the one remaining marker-aware reader in the codebase: it reads the raw
 * content of a legacy in-file `decision-ledger` marker span (which has NO
 * heading — the sidecar migration is M1's job, not M2's) so the update verb
 * can migrate those rows to the sidecar. The ledger table bytes are read
 * verbatim; the one-pass strip (section-detect.ts) never touches them.
 */

import { type LedgerRow, parseLegacyMarkdownLedger } from "./ledger.ts";

/**
 * Read the in-file decision-ledger span from a pre-M2 legacy file (the span
 * is still marker-wrapped with NO heading). Returns `{ rows, kind }` where
 * kind is "absent" (no in-file span — the normal post-migration shape), "ok"
 * (valid rows read from the span), or "corrupt" (malformed row → the caller
 * refuses the update, exit 2).
 */
export function parseInFileLedger(content: string): {
  rows: LedgerRow[];
  kind: "absent" | "ok" | "corrupt";
} {
  try {
    const ledgerBody = legacyInFileLedgerBody(content);
    if (ledgerBody === undefined) return { rows: [], kind: "absent" };
    // The in-file span uses the LEGACY markdown-table format (pre-M1).
    return { rows: parseLegacyMarkdownLedger(ledgerBody), kind: "ok" };
  } catch {
    return { rows: [], kind: "corrupt" };
  }
}

/**
 * The raw content of a legacy in-file `decision-ledger` marker span, or
 * undefined when absent. The span uses the marker-era begin/end comments
 * (both pi-rukas and pi-ensemble prefixes, any version) — the one remaining
 * place in the post-M2 codebase that reads a marker span, because the
 * decision-ledger is the one managed section that M1 (not M2) migrates to
 * the sidecar and that never gets a heading in the heading pipeline.
 */
export function legacyInFileLedgerBody(content: string): string | undefined {
  const beginRe =
    /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:begin\s+decision-ledger\s+v\d+\s*-->[\r\n]*/;
  const endRe = /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:end\s+decision-ledger\s*-->/;
  const b = content.match(beginRe);
  const e = content.match(endRe);
  if (!b || !e) return undefined;
  const start = (b.index ?? 0) + b[0].length;
  const end = e.index ?? 0;
  if (end < start) return undefined;
  return content.slice(start, end);
}
