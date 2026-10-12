/**
 * review-accept-row — the ONLY write path that marks a recorded review finding
 * accepted (#1105).
 *
 * Imported by extension/scripts/review-accept.ts and nothing under src/ — a
 * smoke test asserts that, so no Pi tool, lens or driver can reach it through
 * the import graph. It enforces the acceptance rules itself, so a caller that
 * skips the CLI still cannot record a bad acceptance:
 *   - the reason is at least MIN_REASON_CHARS and does not look like a secret;
 *   - a CRITICAL row is never accepted (CRITICAL findings are never suppressed);
 *   - a resolved row is not accepted (nothing is reported against it).
 * Every refusal is `{ ok: false, reason }` and writes nothing.
 */

import type { StoredFinding } from "../src/review-findings-store.ts";
import { mutateFindings } from "../src/review-findings-store.ts";
import { looksLikeSecret } from "../src/vipune.ts";

/** The shortest reason the operator may give. */
export const MIN_REASON_CHARS = 20;

/** The reason's refusal, or undefined when it is acceptable. */
export function reasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_CHARS) {
    return `--reason must be at least ${MIN_REASON_CHARS} characters (got ${trimmed.length})`;
  }
  if (looksLikeSecret(trimmed)) return "--reason looks like a secret; refusing to record it";
  return undefined;
}

/** The outcome of an acceptance attempt. */
export type AcceptResult = { ok: true; row: StoredFinding } | { ok: false; reason: string };

/** Mark one open row accepted. See the module header for the refusals. */
export async function acceptRow(opts: {
  cwd: string;
  branch: string;
  rowId: string;
  reason: string;
  by: string;
  now?: number;
}): Promise<AcceptResult> {
  const problem = reasonProblem(opts.reason);
  if (problem) return { ok: false, reason: problem };
  const now = opts.now ?? Date.now();
  const out = await mutateFindings<AcceptResult>(opts.cwd, (all) => {
    const refuse = (reason: string) => ({ rows: all, result: { ok: false, reason } as const });
    const row = all.find((r) => r.branch === opts.branch && r.id === opts.rowId);
    if (!row) return refuse(`no row ${opts.rowId} on branch ${opts.branch}`);
    if (row.status === "resolved") {
      return refuse(`row ${opts.rowId} is resolved — nothing to accept`);
    }
    if (row.severity === "CRITICAL") {
      return refuse(`row ${opts.rowId} is CRITICAL — CRITICAL findings are never accepted`);
    }
    row.status = "accepted";
    row.acceptance = { by: opts.by, reason: opts.reason, at: now, snippetHash: row.snippetHash };
    return { rows: all, result: { ok: true, row } };
  });
  return out.ok ? out.value : { ok: false, reason: out.reason };
}
