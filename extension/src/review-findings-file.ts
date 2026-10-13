/**
 * review-findings-file — the on-disk shape of `review-findings.json` (#1105):
 * the stored row type, its validation, the pure row-cap and the acceptance
 * reason rule. A file that does not parse is corrupt (fail closed); a single
 * malformed row is set aside by review-findings-store.ts and the valid rows
 * carry on. Nothing here writes to disk.
 *
 * The status union is the schema, not a write path: a row is `accepted` only
 * with an acceptance, and open/resolved rows carry none.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Severity } from "./lens-review-format.ts";
import { trace } from "./trace.ts";
import { looksLikeSecret } from "./vipune.ts";

export type RowStatus = "open" | "accepted" | "resolved";

/** Who accepted a finding, when, and against which snippet of code. */
export interface Acceptance {
  by: string;
  reason: string;
  at: number;
  snippetHash: string;
}

interface StoredBase {
  id: string;
  branch: string;
  path: string;
  anchor: string;
  titleClass: string;
  title: string;
  severity: Severity;
  lens: string;
  line?: number;
  /** #1129 — the trigger the lens named when it last reported this finding; absent = none. */
  trigger?: string;
  /**
   * #1129 — set on every row a round writes from #1129 on. Absent = a legacy row
   * written before triggers existed: its trigger was never asked for, so it is
   * not subject to the round-2 downgrade until a lens re-reports it.
   */
  triggerKnown?: true;
  snippetHash: string;
  firstSeen: number;
  lastSeen: number;
}

/** A stored row. Only an `accepted` row carries an acceptance. */
export type StoredFinding =
  | (StoredBase & { status: "open" | "resolved"; acceptance?: undefined })
  | (StoredBase & { status: "accepted"; acceptance: Acceptance });

/** The shortest reason an operator may give when accepting a finding. */
export const MIN_REASON_CHARS = 20;

/** Rows kept per branch; beyond this the oldest resolved, then open, rows go first. */
export const MAX_ROWS_PER_BRANCH = 200;

/** The reason's refusal, or undefined when it is acceptable. */
export function reasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length < MIN_REASON_CHARS) {
    return `--reason must be at least ${MIN_REASON_CHARS} characters (got ${trimmed.length})`;
  }
  if (looksLikeSecret(trimmed)) return "--reason looks like a secret; refusing to record it";
  return undefined;
}

/**
 * Keep at most `max` rows. Resolved rows go first (oldest first), then open
 * rows (oldest first). Accepted rows are never dropped — an acceptance is an
 * operator decision, so the store may exceed `max` when they alone fill it.
 */
export function capRows(rows: StoredFinding[], max = MAX_ROWS_PER_BRANCH): StoredFinding[] {
  if (rows.length <= max) return rows;
  let excess = rows.length - max;
  const byAge = [...rows].sort((a, b) => a.lastSeen - b.lastSeen);
  const drop = new Set<string>();
  for (const evictable of ["resolved", "open"] as const) {
    for (const r of byAge) {
      if (excess <= 0) break;
      if (r.status === evictable) {
        drop.add(r.id);
        excess--;
      }
    }
  }
  return rows.filter((r) => !drop.has(r.id));
}

/** `capRows` applied to each branch separately, so one branch never evicts another's rows. */
export function capPerBranch(rows: StoredFinding[]): StoredFinding[] {
  const branches = new Set(rows.map((r) => r.branch));
  return [...branches].flatMap((b) => capRows(rows.filter((r) => r.branch === b)));
}

const SEVERITIES: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function isAcceptance(v: unknown): v is Acceptance {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.by === "string" &&
    typeof a.reason === "string" &&
    typeof a.at === "number" &&
    typeof a.snippetHash === "string"
  );
}

/** Every declared field of a stored row, checked. The status decides whether an acceptance must be there. */
function isRow(v: unknown): v is StoredFinding {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const common =
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
    typeof r.firstSeen === "number" &&
    typeof r.lastSeen === "number";
  if (!common) return false;
  if (r.status === "accepted") return isAcceptance(r.acceptance);
  return (r.status === "open" || r.status === "resolved") && r.acceptance === undefined;
}

/**
 * `ok` with the valid rows and any malformed ones (set aside by the store), or
 * not ok when the file itself does not parse or has no rows array.
 */
export type ParsedFile =
  | { ok: true; rows: StoredFinding[]; malformed: unknown[] }
  | { ok: false; reason: string };

/** Parse the findings file. A missing file is an empty store; anything else unreadable is corrupt. */
export function parseFindingsFile(file: string): ParsedFile {
  if (!existsSync(file)) return { ok: true, rows: [], malformed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      ok: false,
      reason: `unparseable JSON (${(err as Error).message.slice(0, 80)})`,
    };
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return { ok: false, reason: "no rows array" };
  const good: StoredFinding[] = [];
  const malformed: unknown[] = [];
  for (const r of rows as unknown[]) {
    if (isRow(r)) good.push(r);
    else malformed.push(r);
  }
  return { ok: true, rows: good, malformed };
}

/** Read the findings file; a corrupt file reads as no rows, and malformed rows are skipped. */
export function readFindingsFile(file: string): StoredFinding[] {
  const parsed = parseFindingsFile(file);
  if (!parsed.ok) {
    trace(`review-findings: ${file} is corrupt (${parsed.reason}) — treated as no memory`);
    return [];
  }
  if (parsed.malformed.length > 0) {
    trace(`review-findings: ${file} has ${parsed.malformed.length} malformed row(s) — skipped`);
  }
  return parsed.rows;
}
