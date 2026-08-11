/**
 * memory-stats — is the memory actually being used?
 *
 * The operator's condition for keeping memory on is *"as long as it provides
 * value to agents."* That is only a condition if it can be checked, and until
 * now it could not be: nothing in pi-ensemble recorded whether an injected
 * memory was read, ignored or contradicted.
 *
 * vipune maintains the answer and surfaces none of it. `retrieval_count` and
 * `last_retrieved_at` are real columns, kept up to date on every read that does
 * not pass `--no-touch` — but no subcommand prints them (upstream
 * randomm/vipune#179). `search --json` and `list --json` both return only
 * `content`, `created_at` and `id`.
 *
 * So this reads the SQLite file directly, **read-only**, and computes what the
 * CLI will not. That is a deliberate and bounded exception to "go through the
 * seam": the seam spawns a binary that cannot answer this question, and opening
 * the database `mode=ro` cannot alter a byte of it.
 *
 * Measured on the live store for `randomm/pi-ensemble`: 111 rows (103 active,
 * 2 candidate, 6 superseded), 1186 retrievals, max 31, and only 8 rows never
 * retrieved. The corpus is heavily used — just not by this harness, which
 * contributes none of those reads. That number is the baseline this is meant to
 * move.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MemoryStats {
  project: string;
  rows: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  totalRetrievals: number;
  maxRetrievals: number;
  /** Rows that have never been read. The clearest single signal of dead weight. */
  neverRetrieved: number;
  /** Median content length — the injection-cost driver. */
  medianChars: number;
}

/** Where vipune keeps its store. `VIPUNE_DB_PATH` wins, as it does for the CLI. */
export function defaultDbPath(): string {
  return process.env.VIPUNE_DB_PATH ?? path.join(os.homedir(), ".vipune", "memories.db");
}

/**
 * Read usage statistics for one project.
 *
 * Returns undefined rather than throwing on every failure path — an absent
 * database, an unreadable one, a schema that has moved on. This is an
 * observability helper; it must never be the reason a command fails.
 */
export async function readMemoryStats(
  project: string,
  dbPath = defaultDbPath(),
): Promise<MemoryStats | undefined> {
  if (!existsSync(dbPath)) return undefined;
  let db: { query: (sql: string) => { all: (...p: unknown[]) => unknown[] }; close: () => void };
  try {
    // `bun:sqlite` is available in the runtime this extension targets, but
    // tsconfig declares only node types, so the specifier is held in a variable
    // to keep it out of static module resolution. Opened read-only: this module
    // must be INCAPABLE of mutating the operator's memory, not merely
    // disinclined to.
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as {
      Database: new (p: string, o: { readonly: boolean }) => typeof db;
    };
    db = new Database(dbPath, { readonly: true });
  } catch {
    return undefined;
  }
  try {
    const rows = db
      .query(
        "select status, type, coalesce(retrieval_count,0) as rc, length(content) as len from memories where project_id = ?",
      )
      .all(project) as Array<{ status: string; type: string; rc: number; len: number }>;
    if (rows.length === 0) return undefined;

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let total = 0;
    let max = 0;
    let never = 0;
    const lens: number[] = [];
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      total += r.rc;
      if (r.rc > max) max = r.rc;
      if (r.rc === 0) never++;
      lens.push(r.len);
    }
    lens.sort((a, b) => a - b);
    return {
      project,
      rows: rows.length,
      byStatus,
      byType,
      totalRetrievals: total,
      maxRetrievals: max,
      neverRetrieved: never,
      medianChars: lens[Math.floor(lens.length / 2)] ?? 0,
    };
  } catch {
    return undefined;
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

/** One-screen summary for `/audit`. */
export function renderMemoryStats(s: MemoryStats): string {
  const pct = s.rows > 0 ? Math.round((100 * s.neverRetrieved) / s.rows) : 0;
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  return [
    `Memory — ${s.project}`,
    `  rows            ${s.rows}   (${kv(s.byStatus)})`,
    `  types           ${kv(s.byType)}`,
    `  retrievals      ${s.totalRetrievals} total, max ${s.maxRetrievals} on one row`,
    `  never retrieved ${s.neverRetrieved} (${pct}%)`,
    `  median length   ${s.medianChars} chars`,
  ].join("\n");
}
