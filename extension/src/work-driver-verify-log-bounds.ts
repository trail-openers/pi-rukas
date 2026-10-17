/**
 * work-driver-verify-log-bounds — the size bound every persisted verify
 * artefact shares.
 *
 * The raw stream of a verify run can be the full 8 MiB maxBuffer, and these
 * logs are diagnostic, not load-bearing: past the cap the operator still has
 * the bounded tail in the evidence, so truncate with a marker rather than
 * write multi-MB scratch files. Split from `work-driver-verify-flake.ts` so
 * the hang-report writer and the run-log writer share one bound without one
 * importing the other's executor plumbing.
 */

// #841 — bound on a persisted run log.
export const VERIFY_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** #841 — apply the size cap to a raw run stream before it is persisted. */
export function boundVerifyLog(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") <= VERIFY_LOG_MAX_BYTES) return raw;
  const marker = "\n…[truncated — full output exceeded the 2 MiB log cap]\n";
  const max = VERIFY_LOG_MAX_BYTES - Buffer.byteLength(marker, "utf8");
  let out = raw;
  while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, Math.floor(out.length / 2));
  return out + marker;
}
