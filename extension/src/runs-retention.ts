/**
 * Age-based transcript retention for the ensemble-runs tree (the pruning
 * half of /runs, split from runs.ts by the 500-line file-size gate).
 */

/**
 * Retention window in days: delete transcript batches whose newest child file
 * is older than this. Read at call time (not module load) so tests and same-
 * process env changes take effect on the next prune. Override with
 * PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS: unset/empty/invalid/negative → 5;
 * "0" disables; fractional values (e.g. "1.5") are honoured.
 */
const RETENTION_DAYS_DEFAULT = 5;

export function transcriptRetentionDays(): number {
  const raw = process.env.PI_ENSEMBLE_TRANSCRIPT_RETENTION_DAYS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return RETENTION_DAYS_DEFAULT;
}

/**
 * Safety floor — never delete anything younger than this regardless of
 * retention window. Protects in-progress spawns whose transcripts are still
 * being written.
 */
export const PRUNE_MIN_AGE_MS = 60_000;
