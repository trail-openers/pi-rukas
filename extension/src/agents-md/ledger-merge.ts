import { type LedgerRow, driftWarnings, mergeOmissionRows, upsertRow } from "./ledger.ts";
import { managedSectionBody } from "./section-detect.ts";

const FACT_IDS = ["quality-gates", "commands", "environment"] as const;

export interface LedgerMergeResult {
  merged: LedgerRow[];
  omittedForLedger: { id: string; reason: string }[];
  drift: ReturnType<typeof driftWarnings>;
}

/**
 * The Item 5 (refresh) + Item 3 (first-time population) + Item 4
 * (omission suppression) + drift-warning logic for the agentOverride
 * update path.
 *
 * For each fact section that agentOverride is writing (a body, not an
 * omission):
 *   - refresh: true → only touches [detected:agent] rows; a byte-identical
 *     body (post trailing-newline normalisation) keeps the existing row and
 *     its date (no churn); a changed body bumps the date to today.
 *   - refresh: false → first-time population only (no existing row);
 *     an existing [auto] or [detected] row is left alone.
 *
 * Omission rows are filtered to exclude any id that has a [detected:agent]
 * row (the operator is not told a section is omitted when it is
 * agent-derived). Drift warnings compare the existing ledger's values
 * against the newly-derived omission rows.
 */
export function mergeAgentOverrideLedger(
  existingLedger: LedgerRow[],
  initialMerged: LedgerRow[],
  auto: LedgerRow[],
  updates: Map<string, string>,
  omitted: { id: string; reason: string }[],
  current: string,
  useOverride: boolean,
  refresh: boolean,
  today: string,
): LedgerMergeResult {
  if (!useOverride) {
    return {
      merged: initialMerged,
      omittedForLedger: omitted,
      drift: driftWarnings(existingLedger, auto),
    };
  }

  const detectedAgentIds = new Set(
    existingLedger.filter((r) => r.provenance === "detected").map((r) => r.key),
  );
  let merged = initialMerged;
  for (const id of FACT_IDS) {
    const body = updates.get(id);
    if (body === undefined) continue;
    const spliceForm = body.endsWith("\n") ? body : `${body}\n`;
    const existing = existingLedger.find((r) => r.key === id);
    const isDetected = existing?.provenance === "detected";
    if (refresh) {
      if (!isDetected) continue;
      // stored body shape: blank separator + content, no trailing newline
      // (section-detect.ts findManagedSections convention)
      const stored = managedSectionBody(current, id) ?? "";
      const existingBody = stored.startsWith("\n") ? stored.slice(1) : stored;
      const sameValue =
        (existingBody.endsWith("\n") ? existingBody : `${existingBody}\n`) === spliceForm ||
        existingBody === body;
      if (sameValue) continue;
      merged = upsertRow(merged, { key: id, value: "agent", provenance: "detected", date: today });
    } else if (!isDetected && existing?.provenance === undefined) {
      merged = upsertRow(merged, { key: id, value: "agent", provenance: "detected", date: today });
    }
  }

  const omittedForLedger = omitted.filter((o) => !detectedAgentIds.has(o.id));
  merged = mergeOmissionRows(merged, omittedForLedger, today);
  const drift = driftWarnings(existingLedger, auto);

  return { merged, omittedForLedger, drift };
}
