/**
 * work-driver-path-claims-file — the disk layer under the cross-group claim
 * registry (#1454).
 *
 * Split from `work-driver-path-claims.ts` for the 500-line gate (AGENTS.md §12).
 * The seam is the filesystem: this module owns reading, validating and writing
 * `.pi/work-state/path-claims.json`, and knows nothing about liveness, terminal
 * statuses, or which claims may park a cycle. Everything above it is pure logic
 * over the entries this returns.
 *
 * The three reads are deliberately distinct and each comment says which caller
 * wants which — the bug this layer had was one of them silently filtering for
 * another:
 *
 *   - `readClaimsRawJson`  — the file's rows, malformed included, or `null`
 *                            when the file is missing/unparseable. The prune
 *                            needs EXACTLY the rows on disk.
 *   - `readRawRows`        — same rows, `null` flattened to `[]`. Prune only.
 *   - `readRawClaims`      — the well-formed subset, malformed rows reported
 *                            out through `malformed` so the caller can prune them.
 *
 * None of them filters by liveness: `work-driver-path-claims.ts`'s `readClaims`
 * is the single place staleness is decided.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { type PathClaimEntry, validClaimEntry } from "./work-driver-path-claims-staleness.ts";
import { workStateDir } from "./workflow-state.ts";

const CLAIMS_FILE = "path-claims.json";

/** Absolute path of the registry file for a repo root. */
export function claimsFilePath(repoRoot: string): string {
  return path.join(workStateDir(repoRoot), CLAIMS_FILE);
}

/**
 * Read the file verbatim — no liveness filter, but shape-validated.
 *
 * r2 — malformed entries are dropped here AND reported through `malformed`, so
 * the caller can prune them. Silently dropping them at the read was a real bug:
 * the classifier never saw them, so nothing was ever asked to remove them, and
 * an operator's typo or a torn write sat in the registry forever — invisible on
 * every read and unprunable. A claim that cannot be validated is a claim nobody
 * holds, and it should leave the file, not just the return value.
 *
 * The JSON parse lives in `readClaimsRawJson` so the prune — which must see
 * exactly the rows the file holds, malformed included — can share it without a
 * second copy of the ENOENT/parse-error handling drifting from this one.
 */
async function readClaimsRawJson(repoRoot: string): Promise<unknown[] | null> {
  const file = claimsFilePath(repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    trace(
      `work-driver-path-claims: could not read claims: ${(err as Error).message?.slice(0, 200)}`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    trace("work-driver-path-claims: claims file is not valid JSON — ignoring");
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * The registry's rows as the file holds them — malformed rows INCLUDED. For the
 * prune only, which has to write back exactly the rows it did not set out to
 * remove. Every other caller wants `readRawClaims`.
 */
export async function readRawRows(repoRoot: string): Promise<unknown[]> {
  return (await readClaimsRawJson(repoRoot)) ?? [];
}

/**
 * #1454 — no liveness filter HERE. `readClaims` is the reader that decides
 * staleness (`claimStaleReason`) and prunes; `registerClaim`/`releaseClaim` read
 * this raw file because a writer must never lose an entry it did not set out to
 * remove. The pre-#1454 shape filtered here, which made every writer's snapshot
 * lossy.
 *
 * #1101 — the same-process sibling filter likewise lives in `readClaims` (the
 * gate's read), not here, for the same reason: hiding a sibling's claim is a
 * *reading* decision, and a writer that hid it would prune a live sibling.
 */
export async function readRawClaims(
  repoRoot: string,
  malformed?: unknown[],
): Promise<PathClaimEntry[]> {
  const rows = await readClaimsRawJson(repoRoot);
  if (rows === null) return [];
  const entries: PathClaimEntry[] = [];
  for (const item of rows) {
    if (validClaimEntry(item)) entries.push(item);
    else {
      trace("work-driver-path-claims: dropped a malformed claim entry — treated as stale");
      malformed?.push(item);
    }
  }
  return entries;
}

/**
 * Atomic write + rename — the one writer shape for the claims file.
 *
 * The tmp name is unique per call (pid + random suffix), not a fixed
 * `<file>.tmp`: two cycles writing the registry concurrently used to share one
 * scratch path, so one writer's `rename` moved the other's half-written file
 * into place and the loser's write vanished. Same shape as `writeSnapshot` in
 * workflow-state.ts. `rename` stays the atomic publish step.
 */
export async function writeClaims(file: string, entries: PathClaimEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
