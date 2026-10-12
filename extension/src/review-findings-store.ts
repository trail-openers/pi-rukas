/**
 * review-findings-store — the per-branch memory of what six-lens review rounds
 * found (#1105).
 *
 * One JSON file, `review-findings.json`, sits NEXT TO `review-ledger.json`
 * under the git common dir, so every worktree of the clone shares it. It is
 * written under the ledger's own lock (review-ledger-lock.ts keyed on the
 * ledger path) rather than a second lock. The ledger itself is not touched:
 * review-ledger.ts stays at its size cap, and this module owns the findings.
 *
 * Each row is one finding a round reported (see review-findings-match.ts for
 * the identity). Rows are `open` (reported, not resolved), `accepted`
 * (an operator accepted it by id — human-only, see extension/scripts/
 * review-accept.ts) or `resolved` (a full review no longer reported it).
 * A branch keeps at most MAX_ROWS_PER_BRANCH rows; resolved rows go first.
 *
 * `recordFindingRun` is the one per-round entry point. It never throws: every
 * fault is traced and it returns `undefined`, which the caller reads as "no
 * suppression this round" — the findings are then all reported, the safe
 * direction. Acceptance is the only path that marks a row accepted.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "./lens-exec.ts";
import type { Severity } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";
import { changedLineRanges } from "./review-diff.ts";
import {
  type FindingIdentity,
  identityOf,
  pickMatch,
  titleClassOf,
} from "./review-findings-match.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

/** The findings file's name, beside `review-ledger.json`. */
export const FINDINGS_FILE = "review-findings.json";
/** Rows kept per branch; beyond this the oldest resolved rows go first. */
export const MAX_ROWS_PER_BRANCH = 200;

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

/**
 * What a round decided for one finding, aligned by index with the findings it
 * was given. `suppressed-*` findings are dropped from the review's findings
 * and listed in the residual disclosure with their row id and reason.
 */
export type Decision =
  | { action: "new" | "matched"; rowId: string }
  | { action: "suppressed-unchanged" | "suppressed-accepted"; rowId: string; reason: string };

export interface FindingRun {
  cwd: string;
  branch: string;
  /** The full commit the round reviewed; identities are read from it. */
  headSha: string;
  /** Deduplicated findings, in the order the decisions must align with. */
  findings: Finding[];
  /** The delta diff (`git diff since..head`) when this round was a delta review. */
  deltaDiff?: string;
  /** Whether a full review that reached a verdict — only then may unmatched open rows resolve. */
  complete: boolean;
  now?: number;
}

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/** The lines of `file` at `sha`, or [] when it cannot be read there. */
async function readHeadLines(cwd: string, sha: string, file: string): Promise<string[]> {
  if (!safeRepoPath(file)) return [];
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "show", `${sha}:${file}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.split("\n");
  } catch {
    return [];
  }
}

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
    typeof r.snippetHash === "string" &&
    typeof r.lastSeen === "number" &&
    (r.status === "open" || r.status === "accepted" || r.status === "resolved")
  );
}

/** Read the findings file; a missing or corrupt file reads as no rows. */
export function readFindingsFile(file: string): StoredFinding[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) return [];
    return parsed.rows.filter(isRow);
  } catch (err) {
    trace(`review-findings: unreadable findings file ${file}: ${(err as Error).message}`);
    return [];
  }
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
 * Keep at most `max` rows: the oldest resolved rows are dropped first, then
 * the oldest of the rest.
 */
export function capRows(rows: StoredFinding[], max = MAX_ROWS_PER_BRANCH): StoredFinding[] {
  if (rows.length <= max) return rows;
  let excess = rows.length - max;
  const byAge = [...rows].sort((a, b) => a.lastSeen - b.lastSeen);
  const drop = new Set<string>();
  for (const r of byAge) {
    if (excess <= 0) break;
    if (r.status === "resolved") {
      drop.add(r.id);
      excess--;
    }
  }
  for (const r of byAge) {
    if (excess <= 0) break;
    if (!drop.has(r.id)) {
      drop.add(r.id);
      excess--;
    }
  }
  return rows.filter((r) => !drop.has(r.id));
}

/**
 * Resolve the findings file's path and the ledger path that guards it. Both
 * are undefined outside a git clone; the findings file lives beside the
 * ledger so the two share a directory (and the override in tests).
 */
async function locate(cwd: string): Promise<{ ledger: string; file: string } | undefined> {
  const ledger = await ledgerPathFor(execp, cwd);
  if (!ledger) return undefined;
  const dir = path.dirname(ledger);
  if (!existsSync(dir)) return undefined;
  return { ledger, file: path.join(dir, FINDINGS_FILE) };
}

/**
 * Read-modify-write the findings file under the ledger lock. `fn` returns the
 * rows to store and a result. Returns undefined when there is no clone.
 */
async function mutate<T>(
  cwd: string,
  fn: (rows: StoredFinding[]) => { rows: StoredFinding[]; result: T },
): Promise<T | undefined> {
  const loc = await locate(cwd);
  if (!loc) return undefined;
  const release = await acquireLedgerLock(loc.ledger);
  try {
    const { rows, result } = fn(readFindingsFile(loc.file));
    const tmp = `${loc.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ rows: capRows(rows) }, null, 2), "utf8");
    renameSync(tmp, loc.file);
    return result;
  } finally {
    release();
  }
}

/** The rows of one branch (any status), for the prompt block. Never throws. */
export async function readBranchRows(cwd: string, branch: string): Promise<StoredFinding[]> {
  try {
    const loc = await locate(cwd);
    if (!loc) return [];
    return readFindingsFile(loc.file).filter((r) => r.branch === branch);
  } catch {
    return [];
  }
}

/** Would a finding on `line` of `file` fall outside the delta's changed lines? */
function outsideDelta(
  f: Finding,
  identity: FindingIdentity,
  ranges: Map<string, Array<[number, number]>>,
): boolean {
  const spans = ranges.get(f.path);
  if (!spans) return true;
  if (!identity.hasLine) return false;
  const line = f.line ?? 0;
  return !spans.some(([lo, hi]) => line >= lo && line <= hi);
}

/**
 * Record one round: match each finding to a stored row (or create one), decide
 * whether it is suppressed, and resolve open rows a complete full review no
 * longer reported. Returns one decision per input finding, or undefined when
 * nothing could be recorded (no clone, unreadable store) — the caller then
 * reports every finding.
 *
 * Suppression (CRITICAL is never suppressed):
 *   - `suppressed-accepted`: the matched row is accepted and the code it cites
 *     still has the snippet the operator accepted;
 *   - `suppressed-unchanged`: a delta round, and the cited line lies outside
 *     the delta's changed lines (the finding is on code this round did not
 *     touch).
 * An accepted row whose snippet changed lapses to open and is reported again.
 */
export async function recordFindingRun(run: FindingRun): Promise<Decision[] | undefined> {
  try {
    const now = run.now ?? Date.now();
    const ranges = run.deltaDiff !== undefined ? changedLineRanges(run.deltaDiff) : undefined;
    const linesByPath = new Map<string, string[]>();
    for (const f of run.findings) {
      if (!linesByPath.has(f.path)) {
        linesByPath.set(f.path, await readHeadLines(run.cwd, run.headSha, f.path));
      }
    }
    const identities = run.findings.map((f) => identityOf(f, linesByPath.get(f.path) ?? []));
    return await mutate(run.cwd, (all) => {
      const others = all.filter((r) => r.branch !== run.branch);
      const mine = all.filter((r) => r.branch === run.branch);
      const touched = new Set<string>();
      const taken = new Set(all.map((r) => r.id));
      const decisions: Decision[] = [];
      run.findings.forEach((f, i) => {
        const id = identities[i] as FindingIdentity;
        const critical = f.severity === "CRITICAL";
        const row = pickMatch(id, mine);
        if (!row) {
          const fresh: StoredFinding = {
            id: newRowId(taken),
            branch: run.branch,
            path: f.path,
            anchor: id.anchor,
            titleClass: id.titleClass || titleClassOf(f.title),
            title: f.title,
            severity: f.severity,
            lens: f.lens,
            ...(f.line ? { line: f.line } : {}),
            snippetHash: id.snippetHash,
            status: "open",
            firstSeen: now,
            lastSeen: now,
          };
          taken.add(fresh.id);
          mine.push(fresh);
          touched.add(fresh.id);
          decisions.push({ action: "new", rowId: fresh.id });
          return;
        }
        touched.add(row.id);
        row.lastSeen = now;
        row.snippetHash = id.snippetHash;
        if (f.line) row.line = f.line;
        if (row.status === "resolved") row.status = "open";
        if (row.status === "accepted" && row.acceptance) {
          // A line-bearing finding is bound to the snippet the operator accepted.
          // A no-line finding is bound to its title only: two file-level findings
          // sharing most title tokens must not inherit each other's acceptance.
          if (id.hasLine && row.acceptance.snippetHash !== id.snippetHash) {
            trace(
              `review-findings: acceptance of ${row.id} lapsed (cited code changed) — reported again`,
            );
            row.status = "open";
            row.acceptance = undefined;
          } else if (!critical && (id.hasLine || row.titleClass === id.titleClass)) {
            decisions.push({
              action: "suppressed-accepted",
              rowId: row.id,
              reason: `accepted by ${row.acceptance.by}: ${row.acceptance.reason}`,
            });
            return;
          }
        }
        if (!critical && ranges && outsideDelta(f, id, ranges)) {
          const reason = `cited line ${f.line ?? "?"} is outside the delta since the last recorded review`;
          trace(`review-findings: suppressed-unchanged ${row.id} — ${reason}`);
          decisions.push({ action: "suppressed-unchanged", rowId: row.id, reason });
          return;
        }
        decisions.push({ action: "matched", rowId: row.id });
      });
      if (run.complete) {
        for (const r of mine) {
          if (r.status === "open" && !touched.has(r.id)) r.status = "resolved";
        }
      }
      return { rows: [...others, ...mine], result: decisions };
    });
  } catch (err) {
    trace(`review-findings: record failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** The outcome of an acceptance attempt. */
export type AcceptResult = { ok: true; row: StoredFinding } | { ok: false; reason: string };

/**
 * Mark one open row accepted. Human-only by construction: the only caller is
 * extension/scripts/review-accept.ts, which the operator runs in a terminal.
 * A resolved row cannot be accepted (nothing is reported against it).
 */
export async function acceptRow(opts: {
  cwd: string;
  branch: string;
  rowId: string;
  reason: string;
  by: string;
  now?: number;
}): Promise<AcceptResult> {
  const now = opts.now ?? Date.now();
  const out = await mutate<AcceptResult>(opts.cwd, (all) => {
    const row = all.find((r) => r.branch === opts.branch && r.id === opts.rowId);
    if (!row) {
      return {
        rows: all,
        result: { ok: false, reason: `no row ${opts.rowId} on branch ${opts.branch}` },
      };
    }
    if (row.status === "resolved") {
      return {
        rows: all,
        result: { ok: false, reason: `row ${opts.rowId} is resolved — nothing to accept` },
      };
    }
    row.status = "accepted";
    row.acceptance = { by: opts.by, reason: opts.reason, at: now, snippetHash: row.snippetHash };
    return { rows: all, result: { ok: true, row } };
  });
  return out ?? { ok: false, reason: "no git common dir (not a git clone) — nothing recorded" };
}
