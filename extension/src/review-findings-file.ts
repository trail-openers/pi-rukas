/**
 * review-findings-file — the on-disk shape of `review-findings.json` (#1105):
 * the stored row type, its validation, and the parse that decides whether the
 * file is usable. A file that does not parse, or holds a malformed row, is
 * corrupt. review-findings-store.ts decides what to do about corruption (copy
 * it aside, never overwrite). Nothing here writes to disk.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Severity } from "./lens-review-format.ts";
import { trace } from "./trace.ts";

export type RowStatus = "open" | "accepted" | "resolved";

export interface StoredFinding {
  id: string;
  branch: string;
  path: string;
  anchor: string;
  titleClass: string;
  title: string;
  severity: Severity;
  lens: string;
  line?: number;
  snippetHash: string;
  status: RowStatus;
  firstSeen: number;
  lastSeen: number;
  acceptance?: { by: string; reason: string; at: number; snippetHash: string } | undefined;
}

const SEVERITIES: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function isAcceptance(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.by === "string" &&
    typeof a.reason === "string" &&
    typeof a.at === "number" &&
    typeof a.snippetHash === "string"
  );
}

/** Every declared field of a stored row, checked. A row failing any check makes the file corrupt. */
function isRow(v: unknown): v is StoredFinding {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.branch === "string" &&
    typeof r.path === "string" &&
    typeof r.anchor === "string" &&
    typeof r.titleClass === "string" &&
    typeof r.title === "string" &&
    typeof r.severity === "string" &&
    SEVERITIES.includes(r.severity) &&
    typeof r.lens === "string" &&
    (r.line === undefined || typeof r.line === "number") &&
    typeof r.snippetHash === "string" &&
    (r.status === "open" || r.status === "accepted" || r.status === "resolved") &&
    typeof r.firstSeen === "number" &&
    typeof r.lastSeen === "number" &&
    (r.acceptance === undefined || isAcceptance(r.acceptance))
  );
}

export type ParsedFile = { ok: true; rows: StoredFinding[] } | { ok: false; reason: string };

/** Parse the findings file. A missing file is an empty store; anything else unreadable is corrupt. */
export function parseFindingsFile(file: string): ParsedFile {
  if (!existsSync(file)) return { ok: true, rows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, reason: `unparseable JSON (${(err as Error).message.slice(0, 80)})` };
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return { ok: false, reason: "no rows array" };
  const bad = rows.findIndex((r) => !isRow(r));
  if (bad >= 0) return { ok: false, reason: `row ${bad} is malformed` };
  return { ok: true, rows: rows as StoredFinding[] };
}

/** Read the findings file; a missing or corrupt file reads as no rows. */
export function readFindingsFile(file: string): StoredFinding[] {
  const parsed = parseFindingsFile(file);
  if (parsed.ok) return parsed.rows;
  trace(`review-findings: ${file} is corrupt (${parsed.reason}) — treated as no memory`);
  return [];
}
