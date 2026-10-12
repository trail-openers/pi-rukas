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
 * (an operator accepted it by id) or `resolved` (a full review no longer
 * reported it). A branch keeps at most MAX_ROWS_PER_BRANCH rows; resolved rows
 * go first. Accepted rows are never evicted.
 *
 * Failure policy — fail closed on the file, fail open on the review:
 *   - A findings file that does not parse, or holds a malformed row, is
 *     CORRUPT. Readers treat it as no memory. Writers refuse to overwrite it
 *     and copy it aside to `review-findings.json.corrupt-<ms>`, so an operator
 *     acceptance is never silently erased.
 *   - Any fault while recording a round (no clone, corrupt file, a git error
 *     reading a head file) skips recording for that round and returns the
 *     reason. The caller reports every finding and shows the reason. A path
 *     absent at head is not a fault: its findings are recorded as no-line
 *     findings and are never suppressed.
 *
 * This module has NO acceptance write path. The only way to mark a row
 * accepted is `acceptRow` in extension/scripts/review-accept-row.ts, which the
 * operator reaches through extension/scripts/review-accept.ts. Agents are
 * refused that path by review-accept-guard.ts — a guard that is advisory in
 * trust mode (a string match, see its header).
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "./lens-exec.ts";
import type { Severity } from "./lens-review-format.ts";
import type { Finding } from "./lens-review-types.ts";
import { changedLineRanges } from "./review-diff.ts";
import {
  type FindingIdentity,
  JACCARD_MATCH,
  identityOf,
  jaccard,
  pickMatch,
  titleClassOf,
  titleTokens,
} from "./review-findings-match.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

/** The findings file's name, beside `review-ledger.json`. */
export const FINDINGS_FILE = "review-findings.json";
/** Rows kept per branch; beyond this the oldest resolved, then open, rows go first. */
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

/** The result of recording one round: the decisions, or why nothing was recorded. */
export type RecordOutcome = { ok: true; decisions: Decision[] } | { ok: false; reason: string };

/** The result of a locked read-modify-write: the callback's value, or why it did not run. */
export type MutateOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

const SEVERITIES: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/**
 * `lines`: the file exists at the commit. `missing`: the commit is readable but
 * the path is not in it (a lens cited a wrong or stale path) — an expected case,
 * recorded as a no-line finding. `error`: git itself failed (bad sha, I/O,
 * buffer overflow) — this round cannot be recorded.
 */
type HeadLines =
  | { kind: "lines"; lines: string[] }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** Does git hold `spec` (a `<sha>:<path>` or `<sha>^{commit}`)? Exit 0 only when it does. */
async function gitHas(cwd: string, spec: string): Promise<boolean> {
  try {
    await execFileP("git", ["-C", cwd, "cat-file", "-e", spec]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lines of `file` at `sha`. A path absent from a readable commit is
 * `missing`, not an error, so one wrong citation does not disable the run's
 * memory. Any other git failure is an `error`, never an empty file: an empty
 * file would give every finding a fake identity and suppress nothing on the
 * wrong evidence.
 */
async function readHeadLines(cwd: string, sha: string, file: string): Promise<HeadLines> {
  // An unsafe path names nothing git can hold, so it is missing at head too.
  if (!safeRepoPath(file)) return { kind: "missing" };
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "show", `${sha}:${file}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { kind: "lines", lines: stdout.split("\n") };
  } catch (err) {
    if ((await gitHas(cwd, `${sha}^{commit}`)) && !(await gitHas(cwd, `${sha}:${file}`))) {
      return { kind: "missing" };
    }
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`,
    };
  }
}

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

type ParsedFile = { ok: true; rows: StoredFinding[] } | { ok: false; reason: string };

/** Parse the findings file. A missing file is an empty store; anything else unreadable is corrupt. */
function parseFindingsFile(file: string): ParsedFile {
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
 * Read-modify-write the findings file under the ledger lock. `fn` gets the
 * stored rows and returns the rows to keep plus a value. A corrupt file is
 * copied aside and never overwritten; any failure is a `{ ok: false }` with
 * the reason, never a throw.
 */
export async function mutateFindings<T>(
  cwd: string,
  fn: (rows: StoredFinding[]) => { rows: StoredFinding[]; result: T },
): Promise<MutateOutcome<T>> {
  const loc = await locate(cwd);
  if (!loc) return { ok: false, reason: "not a git clone (no git common dir)" };
  let release: (() => void) | undefined;
  try {
    release = await acquireLedgerLock(loc.ledger);
    const parsed = parseFindingsFile(loc.file);
    if (!parsed.ok) {
      const copy = `${loc.file}.corrupt-${Date.now()}`;
      copyFileSync(loc.file, copy);
      trace(`review-findings: ${loc.file} is corrupt (${parsed.reason}) — copied to ${copy}`);
      return {
        ok: false,
        reason: `the findings file is corrupt (${parsed.reason}); it was not overwritten and was copied to ${copy}`,
      };
    }
    const { rows, result } = fn(parsed.rows);
    const tmp = `${loc.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ rows: capRows(rows) }, null, 2), "utf8");
    renameSync(tmp, loc.file);
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, reason: `write failed: ${(err as Error).message.slice(0, 160)}` };
  } finally {
    release?.();
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
 * longer reported. Returns the decisions (one per input finding) or the reason
 * nothing was recorded — the caller then reports every finding and shows that
 * reason. Never throws.
 *
 * Suppression (CRITICAL is never suppressed; a finding on a path missing at
 * head is never suppressed):
 *   - `suppressed-accepted`: the matched row is accepted and the code it cites
 *     still has the snippet the operator accepted;
 *   - `suppressed-unchanged`: a delta round, the title agrees, the cited code's
 *     snippet is unchanged, and the cited line lies outside the delta's changed
 *     lines.
 * An accepted row whose snippet changed lapses to open and is reported again.
 */
export async function recordFindingRunOutcome(run: FindingRun): Promise<RecordOutcome> {
  try {
    const now = run.now ?? Date.now();
    const ranges = run.deltaDiff !== undefined ? changedLineRanges(run.deltaDiff) : undefined;
    const linesByPath = new Map<string, string[]>();
    const missingPaths = new Set<string>();
    for (const f of run.findings) {
      if (linesByPath.has(f.path) || missingPaths.has(f.path)) continue;
      const head = await readHeadLines(run.cwd, run.headSha, f.path);
      if (head.kind === "error") return { ok: false, reason: head.reason };
      if (head.kind === "missing") missingPaths.add(f.path);
      else linesByPath.set(f.path, head.lines);
    }
    // A path absent at head has no line to cite: the finding is a no-line one,
    // and it is never suppressed (there is no code it could be unchanged against).
    const findings = run.findings.map((f) =>
      missingPaths.has(f.path) ? { ...f, line: undefined } : f,
    );
    const identities = findings.map((f) => identityOf(f, linesByPath.get(f.path) ?? []));
    const out = await mutateFindings(run.cwd, (all) => {
      const others = all.filter((r) => r.branch !== run.branch);
      const mine = all.filter((r) => r.branch === run.branch);
      const touched = new Set<string>();
      const taken = new Set(all.map((r) => r.id));
      const decisions: Decision[] = [];
      findings.forEach((f, i) => {
        const id = identities[i] as FindingIdentity;
        const critical = f.severity === "CRITICAL";
        const gone = missingPaths.has(f.path);
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
        // Suppression needs the titles to agree too: a snippet match alone can
        // be a different finding on the same line. No-line findings keep the
        // stricter titleClass equality (Jaccard would merge sibling file gaps).
        const sameTitle =
          row.titleClass === id.titleClass ||
          (id.hasLine && jaccard(titleTokens(f.title), titleTokens(row.title)) >= JACCARD_MATCH);
        // The snippet the row was last recorded with. A changed neighbour line
        // changes the ±2 window, so an unchanged-code suppression needs this equal.
        const priorHash = row.snippetHash;
        row.lastSeen = now;
        row.snippetHash = id.snippetHash;
        if (gone) row.line = undefined;
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
          } else if (!critical && !gone && sameTitle) {
            decisions.push({
              action: "suppressed-accepted",
              rowId: row.id,
              reason: `accepted by ${row.acceptance.by}: ${row.acceptance.reason}`,
            });
            return;
          }
        }
        // priorHash === snippetHash: the cited code is the code the row last saw.
        if (
          !critical &&
          !gone &&
          sameTitle &&
          ranges &&
          priorHash === id.snippetHash &&
          outsideDelta(f, id, ranges)
        ) {
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
    return out.ok ? { ok: true, decisions: out.value } : out;
  } catch (err) {
    trace(`review-findings: record failed: ${(err as Error).message}`);
    return { ok: false, reason: (err as Error).message.slice(0, 160) };
  }
}

/** The decisions of a round, or undefined when nothing was recorded. */
export async function recordFindingRun(run: FindingRun): Promise<Decision[] | undefined> {
  const out = await recordFindingRunOutcome(run);
  return out.ok ? out.decisions : undefined;
}
