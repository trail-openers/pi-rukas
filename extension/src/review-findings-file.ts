/**
 * review-findings-file — the on-disk shape of `review-findings.json` (#1105):
 * the stored row type, its validation, the pure row-cap, the acceptance reason
 * rule, the row id, and the `Decision` a round returns per finding. A file that
 * does not parse is corrupt (fail closed); a single malformed row is set aside
 * by review-findings-store.ts and the valid rows carry on. Nothing here writes
 * to disk, and nothing here imports the store or the round.
 *
 * The status union is the schema, not a write path: a row is `accepted` only
 * with an acceptance, and open/resolved rows carry none.
 *
 * `newRowId` and `Decision` live here rather than in the store because the
 * store and the round (review-findings-round.ts) BOTH produce them: keeping
 * them in either one made the two modules import each other.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Severity } from "./lens-review-format.ts";
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
  /**
   * The finding's prose as the lens reported it (#1130): a carried row is
   * re-rendered to the operator VERBATIM from the row, so a row that stored no
   * description would print an empty line under its own heading. Optional —
   * `report_finding`'s description is optional — but a carried row always
   * renders something (`findingDescription` in lens-review-format.ts).
   */
  description?: string;
  /** The lens's suggested fix, kept for the same reason as `description`. */
  suggestion?: string;
  severity: Severity;
  lens: string;
  line?: number;
  snippetHash: string;
  /** Hash of the cited line alone (#1300). Absent on rows written before it existed. */
  lineHash?: string;
  firstSeen: number;
  lastSeen: number;
}

/** Why a row was resolved (#1125): path gone, cited line past EOF, or the cited line itself changed. */
export const RESOLVE_REASONS = ["path-gone", "line-past-eof", "code-gone"] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];

/** A row resolved by this round, with why its cited code is gone. */
export interface ResolvedNotice {
  rowId: string;
  title: string;
  reason: ResolveReason;
}

/**
 * A row this round SET ASIDE as malformed (#1125 disclosure): a copy went to
 * `<file>.corrupt-<hash>` and the row is gone from the store. `wasAcceptance`
 * is the load-bearing field — an operator acceptance that failed validation
 * silently stops suppressing, so it must reach the summary and the residual
 * disclosure rather than only the trace log.
 */
export interface SetAsideNotice {
  /** The malformed row's id, when it carried one. */
  rowId?: string;
  path: string;
  severity: string;
  title: string;
  /** The first validation failure, when the row is an object. */
  problem?: string;
  wasAcceptance: boolean;
}

/** A stored row. Only an `accepted` row carries an acceptance; only open/resolved rows carry a resolution reason. */
export type StoredFinding =
  | (StoredBase & {
      status: "open" | "resolved";
      acceptance?: undefined;
      resolvedReason?: ResolveReason | undefined;
    })
  | (StoredBase & {
      status: "accepted";
      acceptance: Acceptance;
      resolvedReason?: undefined;
    });

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
  return rowProblem(v) === undefined;
}

/** The first rule the schema breaks, or undefined when it breaks none. */
function rowProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object") return "not an object";
  const r = v as Record<string, unknown>;
  for (const key of [
    "id",
    "branch",
    "path",
    "anchor",
    "titleClass",
    "title",
    "severity",
    "lens",
    "snippetHash",
  ] as const) {
    if (typeof r[key] !== "string") return `${key} is not a string`;
  }
  if (!SEVERITIES.includes(String(r.severity))) {
    return `severity "${String(r.severity)}" is not one of ${SEVERITIES.join(", ")}`;
  }
  if (r.line !== undefined && typeof r.line !== "number") return "line is not a number";
  if (r.lineHash !== undefined && typeof r.lineHash !== "string") {
    return "lineHash is not a string";
  }
  for (const key of ["firstSeen", "lastSeen"] as const) {
    if (typeof r[key] !== "number") return `${key} is not a number`;
  }
  for (const key of ["description", "suggestion"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return `${key} is not a string`;
  }
  if (r.status === "accepted") {
    if (!isAcceptance(r.acceptance)) return "acceptance is missing or malformed";
    if (r.resolvedReason !== undefined) return "an accepted row carries a resolvedReason";
    return undefined;
  }
  if (r.status !== "open" && r.status !== "resolved") {
    return `status "${String(r.status)}" is invalid`;
  }
  if (r.acceptance !== undefined) return "a non-accepted row carries an acceptance";
  if (
    r.resolvedReason !== undefined &&
    !(RESOLVE_REASONS as readonly unknown[]).includes(r.resolvedReason)
  ) {
    return `resolvedReason "${String(r.resolvedReason)}" is invalid`;
  }
  return undefined;
}

/** How much of an untrusted field one disclosure line carries. */
const SET_ASIDE_FIELD_CHARS = 200;

/**
 * What one malformed row was, for the operator disclosure: enough identity to
 * find it again in the `.corrupt-<hash>` copy, and whether it held an acceptance.
 * The copied fields are untrusted file content, so each is bounded.
 */
export function describeSetAside(v: unknown): SetAsideNotice {
  const o = (v ?? {}) as Record<string, unknown>;
  const text = (key: string): string =>
    (typeof o[key] === "string" ? String(o[key]) : "?").slice(0, SET_ASIDE_FIELD_CHARS);
  const problem = rowProblem(v);
  const rowId = typeof o.id === "string" && o.id ? o.id : undefined;
  return {
    ...(rowId ? { rowId } : {}),
    path: text("path"),
    severity: text("severity"),
    title: text("title"),
    ...(problem ? { problem } : {}),
    wasAcceptance: o.status === "accepted",
  };
}

/** A fresh 8-hex row id, unique among `taken`. */
export function newRowId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
    if (!taken.has(id)) return id;
  }
}

/**
 * What a round decided for one finding, aligned by index with the findings it
 * was given. `suppressed-*` findings are dropped from the review's findings
 * and listed in the residual disclosure with their row id and reason.
 *
 * Declared here (and not in the store) so both halves of a round — the store
 * and review-findings-round.ts — import the same type from a leaf.
 */
export type Decision =
  | { action: "new" | "matched"; rowId: string }
  | { action: "suppressed-unchanged" | "suppressed-accepted"; rowId: string; reason: string };

/**
 * `ok` with the valid rows and any malformed ones (set aside by the store), or
 * not ok when the file itself does not parse or has no rows array.
 */
export type ParsedFile =
  | { ok: true; rows: StoredFinding[]; malformed: unknown[] }
  | { ok: false; reason: string };

/**
 * Split raw parsed rows into the valid ones and the malformed ones, without
 * touching the disk. The store's read path uses it on rows it has already read
 * itself, so one read serves both the valid rows and the set-aside notices.
 */
export function splitRows(rows: readonly unknown[]): {
  rows: StoredFinding[];
  malformed: unknown[];
} {
  const good: StoredFinding[] = [];
  const malformed: unknown[] = [];
  for (const r of rows) {
    if (isRow(r)) good.push(r);
    else malformed.push(r);
  }
  return { rows: good, malformed };
}

/** Parse the findings file. A missing file is an empty store; anything else unreadable is corrupt. */
export function parseFindingsFile(file: string): ParsedFile {
  if (!existsSync(file)) return { ok: true, rows: [], malformed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, reason: `unparseable JSON (${(err as Error).message.slice(0, 80)})` };
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return { ok: false, reason: "no rows array" };
  const split = splitRows(rows as unknown[]);
  return { ok: true, rows: split.rows, malformed: split.malformed };
}
