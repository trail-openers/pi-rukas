/**
 * review-findings-store — the per-branch memory of what six-lens review rounds
 * found (#1105).
 *
 * One JSON file, `review-findings.json`, sits next to `review-ledger.json` under
 * the git common dir, so every worktree of the clone shares it. It is written
 * under the ledger's lock (review-ledger-lock.ts); the ledger itself is untouched.
 *
 * Rows are `open` (reported, not resolved), `accepted` (an operator accepted it)
 * or `resolved`. An open row's fate is decided by `rowFate`
 * (review-findings-fate.ts), the one place that rule lives. A no-line row is
 * carried while its path is present; a path-gone row resolves on a complete full
 * review. Accepted rows are never evicted (see review-findings-file.ts for the cap).
 *
 * Failure policy — fail closed on the file, fail open on the review:
 *   - A file that does not parse is CORRUPT: readers see no memory, and writers
 *     refuse to overwrite it and copy it aside to `<file>.corrupt-<hash>`.
 *   - A malformed row is set aside on its own (`<file>.corrupt-<hash of the row>`)
 *     and the valid rows are kept and written back.
 *   - A fault while recording a round (no clone, corrupt file, a git error other
 *     than "path absent at head") skips recording and returns the reason; the
 *     caller reports every finding and shows the reason.
 *
 * The ONLY acceptance write is `acceptFinding`; `mutateFindings` is private.
 * extension/scripts/review-accept-row.ts calls `acceptFinding`, and
 * review-accept-guard.ts refuses agent attempts (advisory in trust mode).
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execp } from "./exec.ts";
import type { Finding } from "./lens-review-types.ts";
import { changedLineRanges } from "./review-diff.ts";
import { type ReviewKind, rowFate } from "./review-findings-fate.ts";
import {
  type ResolveReason,
  type StoredFinding,
  capPerBranch,
  parseFindingsFile,
  readFindingsFile,
  reasonProblem,
} from "./review-findings-file.ts";
import {
  type FindingIdentity,
  hashText,
  identityOf,
  pickMatch,
  sameTitle,
} from "./review-findings-match.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { trace } from "./trace.ts";

export {
  MAX_ROWS_PER_BRANCH,
  capPerBranch,
  capRows,
  readFindingsFile,
  type RowStatus,
  type StoredFinding,
} from "./review-findings-file.ts";

const execFileP = promisify(execFile);

/** The findings file's name, beside `review-ledger.json`. */
export const FINDINGS_FILE = "review-findings.json";
const FULL_SHA = /^[0-9a-f]{40}$/;
const ROW_ID = /^[0-9a-f]{8}$/;

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
  /** Whether a full review reached a verdict — only then may open rows resolve or carry forward. */
  complete: boolean;
  now?: number;
}

/** A row this round resolved, with why its cited code is gone (#1125). */
export interface ResolvedNotice {
  rowId: string;
  title: string;
  reason: ResolveReason;
}

/** The result of recording one round: the decisions, or why nothing was recorded. */
export type RecordOutcome =
  | { ok: true; decisions: Decision[]; carried: Finding[]; resolved: ResolvedNotice[] }
  | { ok: false; reason: string };

/** The result of an acceptance: the accepted row, or why nothing was accepted. */
export type AcceptOutcome = { ok: true; row: StoredFinding } | { ok: false; reason: string };

type MutateOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A repo-relative path that git can show at a commit without option injection. */
function safeRepoPath(p: string): boolean {
  if (!p || p.startsWith("-") || p.startsWith("/") || /[\0\n]/.test(p)) return false;
  return !p.split("/").includes("..");
}

/**
 * `lines`: the file exists at the commit. `missing`: the commit is readable but
 * the path is not in it (a lens cited a wrong or stale path) — recorded as a
 * no-line finding. `error`: git itself failed (bad sha, I/O) — the round cannot
 * be recorded.
 */
type HeadLines =
  | { kind: "lines"; lines: string[] }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

/** git's own wording for "this path is not in that commit" (LC_ALL=C pins it). */
const PATH_ABSENT_AT_HEAD = /does not exist in|exists on disk, but not in/;

/**
 * The lines of `file` at `sha`. A path absent from a readable commit is
 * `missing`; any other git failure is an `error`, never an empty file: an empty
 * file would give every finding a fake identity and suppress nothing on the
 * wrong evidence. git words "path absent" the same way for an unreadable commit,
 * so the commit is checked first.
 */
async function readHeadLines(cwd: string, sha: string, file: string): Promise<HeadLines> {
  if (!safeRepoPath(file)) return { kind: "missing" };
  try {
    await execFileP("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`]);
  } catch (err) {
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: not a commit in this clone (${(err as Error).message.slice(0, 80)})`,
    };
  }
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "show", `${sha}:${file}`], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { kind: "lines", lines: stdout.split("\n") };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (PATH_ABSENT_AT_HEAD.test(stderr)) return { kind: "missing" };
    return {
      kind: "error",
      reason: `cannot read ${file} at ${sha.slice(0, 12)}: ${(err as Error).message.slice(0, 120)}`,
    };
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
 * Resolve the findings file's path and the ledger path that guards it. Both
 * are undefined outside a git clone; the findings file lives beside the ledger.
 */
async function locate(cwd: string): Promise<{ ledger: string; file: string } | undefined> {
  const ledger = await ledgerPathFor(execp, cwd);
  if (!ledger) return undefined;
  const dir = path.dirname(ledger);
  if (!existsSync(dir)) return undefined;
  return { ledger, file: path.join(dir, FINDINGS_FILE) };
}

/** Copy one malformed row aside, named by its content, so a repeat never duplicates it. */
function setAside(file: string, row: unknown): void {
  const text = JSON.stringify(row, null, 2);
  const copy = `${file}.corrupt-${hashText(text)}`;
  if (!existsSync(copy)) writeFileSync(copy, `${text}\n`, "utf8");
  trace(`review-findings: a malformed row was set aside in ${copy}`);
}

/** Write the rows atomically; a failed write leaves no tmp file behind. */
function writeRows(file: string, rows: StoredFinding[]): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ rows: capPerBranch(rows) }, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Read-modify-write the findings file under the ledger lock. `fn` gets the
 * stored rows and returns the rows to keep plus a value. Private: the only
 * callers are `acceptFinding` and `recordFindingRunOutcome` in this module.
 * Never throws.
 */
async function mutateFindings<T>(
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
      const copy = `${loc.file}.corrupt-${hashText(readFileSync(loc.file, "utf8"))}`;
      copyFileSync(loc.file, copy);
      trace(`review-findings: ${loc.file} is corrupt (${parsed.reason}) — copied to ${copy}`);
      return {
        ok: false,
        reason: `the findings file is corrupt (${parsed.reason}); it was not overwritten and was copied to ${copy}`,
      };
    }
    for (const bad of parsed.malformed) setAside(loc.file, bad);
    const { rows, result } = fn(parsed.rows);
    writeRows(loc.file, rows);
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, reason: `write failed: ${(err as Error).message.slice(0, 160)}` };
  } finally {
    try {
      release?.();
    } catch (err) {
      trace(`review-findings: lock release failed: ${(err as Error).message}`);
    }
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

/** The one acceptance transition: an operator accepts a recorded row by id. */
export async function acceptFinding(
  cwd: string,
  branch: string,
  rowId: string,
  opts: { by: string; reason: string; now?: number },
): Promise<AcceptOutcome> {
  const by = opts.by.trim();
  const reason = opts.reason.trim();
  const problem =
    reasonProblem(reason) ??
    (ROW_ID.test(rowId)
      ? undefined
      : `row id must be 8 lowercase hex characters, got "${rowId}"`) ??
    (by ? undefined : "an acceptance needs an operator identity");
  if (problem) return { ok: false, reason: problem };
  const now = opts.now ?? Date.now();
  const out = await mutateFindings<AcceptOutcome>(cwd, (all) => {
    const idx = all.findIndex((r) => r.branch === branch && r.id === rowId);
    const refuse = (why: string) => ({ rows: all, result: { ok: false, reason: why } as const });
    const row = all[idx];
    if (!row) return refuse(`no row ${rowId} on branch ${branch}`);
    if (row.status === "resolved") return refuse(`row ${rowId} is resolved — nothing to accept`);
    if (row.severity === "CRITICAL") {
      return refuse(`row ${rowId} is CRITICAL — CRITICAL findings are never accepted`);
    }
    const accepted: StoredFinding = {
      ...row,
      status: "accepted",
      acceptance: { by, reason, at: now, snippetHash: row.snippetHash },
    };
    return {
      rows: all.map((r, i) => (i === idx ? accepted : r)),
      result: { ok: true, row: accepted },
    };
  });
  return out.ok ? out.value : { ok: false, reason: out.reason };
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

/** The row with its acceptance withdrawn: open again, so it is reported again. */
function reopen(r: StoredFinding): StoredFinding {
  return { ...r, status: "open", acceptance: undefined, resolvedReason: undefined };
}

/**
 * Record one round: match each finding to a stored row (or create one), decide
 * whether it is suppressed, and resolve open rows a complete full review no
 * longer reported. Returns the decisions (one per input finding) or the reason
 * nothing was recorded. Never throws.
 *
 * Suppression (CRITICAL is never suppressed; a finding on a path missing at
 * head is never suppressed):
 *   - `suppressed-accepted`: the matched row is accepted, the title agrees, and
 *     for a line-bearing finding the cited code still has the accepted snippet;
 *   - `suppressed-unchanged`: a delta round, the title agrees, the cited code's
 *     snippet is unchanged, and the cited line lies outside the delta.
 * An accepted row whose snippet changed lapses to open and is reported again.
 */
export async function recordFindingRunOutcome(run: FindingRun): Promise<RecordOutcome> {
  try {
    if (!FULL_SHA.test(run.headSha)) {
      return {
        ok: false,
        reason: `the reviewed head is not a full commit SHA (${run.headSha.slice(0, 40)})`,
      };
    }
    const now = run.now ?? Date.now();
    const ranges = run.deltaDiff !== undefined ? changedLineRanges(run.deltaDiff) : undefined;
    const linesByPath = new Map<string, string[]>();
    const missingPaths = new Set<string>();
    // Open rows' paths are read too: a round resolves or carries one forward only
    // on proof about its cited code (changed, or unchanged), so it needs the head lines.
    const openPaths = (await readBranchRows(run.cwd, run.branch))
      .filter((r) => r.status === "open")
      .map((r) => r.path);
    for (const p of [...run.findings.map((f) => f.path), ...openPaths]) {
      if (linesByPath.has(p) || missingPaths.has(p)) continue;
      const head = await readHeadLines(run.cwd, run.headSha, p);
      if (head.kind === "error") return { ok: false, reason: head.reason };
      if (head.kind === "missing") missingPaths.add(p);
      else linesByPath.set(p, head.lines);
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
            titleClass: id.titleClass,
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
        // Suppression needs the titles to agree too (see sameTitle): a snippet
        // match alone can be a different finding on the same line.
        const same = sameTitle(id, row);
        // The snippet the row was last recorded with. A changed neighbour line
        // changes the ±2 window, so an unchanged-code suppression needs this equal.
        const priorHash = row.snippetHash;
        let kept: StoredFinding = {
          ...row,
          lastSeen: now,
          snippetHash: id.snippetHash,
          line: f.line,
        };
        if (kept.status === "resolved") kept = reopen(kept);
        // A line-bearing finding is bound to the snippet the operator accepted; a
        // no-line finding is bound to its title only (see sameTitle).
        if (
          kept.status === "accepted" &&
          id.hasLine &&
          kept.acceptance.snippetHash !== id.snippetHash
        ) {
          trace(
            `review-findings: acceptance of ${kept.id} lapsed (cited code changed) — reported again`,
          );
          kept = reopen(kept);
        }
        mine[mine.indexOf(row)] = kept;
        if (kept.status === "accepted" && !critical && same) {
          decisions.push({
            action: "suppressed-accepted",
            rowId: kept.id,
            reason: `accepted by ${kept.acceptance.by}: ${kept.acceptance.reason}`,
          });
          return;
        }
        if (
          !critical &&
          !gone &&
          same &&
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
      const carried: Finding[] = [];
      const resolved: ResolvedNotice[] = [];
      // Only a complete FULL review may resolve an untouched row (rowFate); a
      // delta or an incomplete review carries it. A lens omitting a known finding
      // is not a fix on its own.
      const review: ReviewKind =
        run.deltaDiff !== undefined ? "delta" : run.complete ? "full" : "incomplete";
      mine.forEach((r, i) => {
        if (r.status !== "open" || touched.has(r.id)) return;
        const fate = rowFate(
          r,
          { pathGone: missingPaths.has(r.path), lines: linesByPath.get(r.path) },
          review,
        );
        if (fate.kind === "resolve") {
          mine[i] = {
            ...r,
            status: "resolved",
            acceptance: undefined,
            resolvedReason: fate.reason,
          };
          resolved.push({ rowId: r.id, title: r.title, reason: fate.reason });
        } else if (fate.kind === "carry") {
          carried.push({
            lens: r.lens,
            severity: r.severity,
            path: r.path,
            line: r.line,
            title: r.title,
          });
        }
      });
      return { rows: [...others, ...mine], result: { decisions, carried, resolved } };
    });
    return out.ok
      ? {
          ok: true,
          decisions: out.value.decisions,
          carried: out.value.carried,
          resolved: out.value.resolved,
        }
      : out;
  } catch (err) {
    trace(`review-findings: record failed: ${(err as Error).message}`);
    return { ok: false, reason: (err as Error).message.slice(0, 160) };
  }
}
