/**
 * review-findings-store — the per-branch memory of what six-lens review rounds
 * found (#1105).
 *
 * One JSON file — FINDINGS_FILE, i.e. review-findings.json — is the store. Since
 * #1764 it lives under the agent dir in a per-clone, randomly-keyed state dir
 * (`review-state-path.ts`), not beside the ledger; it is written under the
 * ledger's lock (review-ledger-lock.ts) and the ledger itself is untouched.
 *
 * Rows are `open` (reported, not resolved), `accepted` (an operator accepted it)
 * or `resolved`. An open row's fate is decided by `rowFate`
 * (review-findings-fate.ts), the one place that rule lives. An untouched open row
 * resolves only when its CITED LINE itself changed (its `lineHash` is gone from
 * the head file) on a complete full review; a window edit, a moved line or a
 * missing `lineHash` carries it. An omission by a lens is not a fix on its own.
 * An accepted row is not immortal either: a FULL round evicts one whose path is
 * absent from the reviewed commit (`path-gone`), while a delta round — which
 * never saw the deletion — carries it. What the row cap (`capPerBranch`,
 * review-findings-file.ts) never drops is an accepted row: it is an operator
 * decision, so the store may exceed the cap when accepted rows alone fill it.
 *
 * Head reads live in review-findings-head.ts: a git read error refuses the whole
 * round, so nothing is suppressed or resolved on evidence that could not be read.
 *
 * Failure policy — fail closed on the file, fail open on the review:
 *   - A file that does not parse is CORRUPT: the round's own read refuses, and a
 *     writer refuses to overwrite it and copies it aside to `<file>.corrupt-<hash>`,
 *     which the refusal names so the operator knows what to repair. Every copy
 *     aside goes through one helper (`copyBytesAside` / `corruptDisclosure` in
 *     review-findings-file.ts), so all three sites name their copy identically.
 *   - A malformed row is set aside on its own (`<file>.corrupt-<hash of the row>`)
 *     and the valid rows are kept and written back.
 *   - A fault while recording a round (no clone, corrupt file, a git error other
 *     than "path absent at head", a delta round with no diff) skips recording and
 *     returns the reason; the caller reports every finding and shows the reason.
 *     Any set-aside the round had already disclosed before the fault rides on the
 *     refusal too, so a failed write never hides memory that had already gone.
 *
 * The write is a per-call parameter (`writeFn`, defaulting to the real atomic
 * write), not a module-global seam: a test that must exercise the failed-write
 * disclosure injects it on its own call and no other round in the process can be
 * affected by it.
 *
 * The ONLY acceptance write is `acceptFinding`; `mutateFindings` is private.
 * extension/scripts/review-accept.ts (human-only) calls `acceptFinding`, and
 * review-accept-guard.ts refuses agent attempts (advisory in trust mode).
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execp } from "./exec.ts";
import type { Finding } from "./lens-review-types.ts";
import { type ChangedRanges, changedLineRanges } from "./review-diff.ts";
import type { ReviewKind } from "./review-findings-fate.ts";
import {
  type CorruptCopy,
  type Decision,
  type ResolvedNotice,
  type SetAsideNotice,
  type StoredFinding,
  capPerBranch,
  copyBytesAside,
  corruptDisclosure,
  parseFindingsFile,
  reasonProblem,
} from "./review-findings-file.ts";
import { type HeadState, readHeadLines } from "./review-findings-head.ts";
import { hashText } from "./review-findings-match.ts";
import {
  type BranchRows,
  readBranchRowsFailOpen,
  readBranchRowsRaw,
} from "./review-findings-read.ts";
import { applyFindingRound } from "./review-findings-round.ts";
import type { ConfirmationLapse } from "./review-findings-store-types.ts";
import {
  type AcceptOutcome,
  type FindingRun,
  type RecordOutcome,
  defaultWriteRows,
  mutateFindings,
} from "./review-findings-store-write.ts";
import type { LedgerEntry } from "./review-ledger-entry.ts";
import { acquireLedgerLock } from "./review-ledger-lock.ts";
import { ledgerPathFor } from "./review-ledger-path.ts";
import { readLedgerAt } from "./review-ledger-read.ts";
import { workingTreePatchId } from "./review-ledger.ts";
import { type FindingsLocation, findingsStateDir } from "./review-state-path.ts";
import { trace } from "./trace.ts";

/**
 * What a round decided for one finding, aligned by index with the findings it
 * was given. Declared in the leaf (review-findings-file.ts) and re-exported here
 * because the round and this store BOTH produce it — a copy in either one made
 * the two modules import each other.
 */
export type { Decision } from "./review-findings-file.ts";

/**
 * The findings file's pre-#1764 name — the basename its `.tmp` / `.corrupt-*`
 * siblings are built from, and the name the one-time migration looks for under
 * the git common dir. The live store file itself is `findings.json` inside the
 * state dir (review-state-path.ts); the name stays re-exported so every
 * copy-aside site keeps one naming scheme, and so the offline fixtures that
 * build a path beside a redirected ledger still name the same file.
 */
export { FINDINGS_FILE } from "./review-state-path.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const ROW_ID = /^[0-9a-f]{8}$/;

/**
 * Resolve the findings file's path and the ledger path that guards it. Both are
 * undefined outside a git clone.
 *
 * #1764 phase 1 - the two no longer share a directory. The ledger (and its lock)
 * still live under the git common dir; the findings file lives in the per-clone
 * state dir under the agent dir (`$PI_AGENT_DIR`/review-state/<key>/<token>/),
 * outside the repository and outside every worktree, so an agent's ordinary bash
 * cannot name it. `PI_ENSEMBLE_REVIEW_LEDGER_FILE` still pins the findings file
 * beside the override, which is what the whole offline suite isolates on. The
 * resolution itself - key, token, modes, migration and the fallback to the old
 * location - lives in review-state-path.ts.
 *
 * The resolved path is RETURNED, never cached here: the read path takes it as an
 * argument from whoever called `locate`, so changing `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * between two rounds cannot leave a later round reading the first round's file.
 * Each entry point calls this ONCE and threads the result through its read and
 * its write, so neither half of a round can diverge onto another file.
 */
async function locate(cwd: string): Promise<FindingsLocation | undefined> {
  return findingsStateDir(execp, cwd);
}

/**
 * The rows of one branch (any status), for the prompt block. Never throws: a
 * file that cannot be read reads as no memory HERE (a prompt is not a
 * decision). The round's own record path does NOT read fail-open: an unreadable
 * findings file fails the round, because a round recorded on "no memory" would
 * resolve rows the unreadable file may still hold.
 *
 * #1832 — the "does this branch still hold an open line-bearing CRITICAL?"
 * question is NOT answerable from this read (fail-open collapses unreadable into
 * "no rows"), so it lives beside it in review-findings-critical-probe.ts.
 */
export async function readBranchRows(cwd: string, branch: string): Promise<StoredFinding[]> {
  try {
    const loc = await locate(cwd);
    const rows = await readBranchRowsFailOpen(loc?.file, branch);
    return rows ?? [];
  } catch (err) {
    // `locate` itself failing (no git, no common dir) is the same "no memory"
    // answer; the read path already traced anything it could not read.
    trace(`review-findings: no findings file to read: ${(err as Error).message.slice(0, 120)}`);
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
  const loc = await locate(cwd);
  if (!loc) return { ok: false, reason: "not a git clone (no git common dir)" };
  const out = await mutateFindings<AcceptOutcome>(loc, (all) => {
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
      resolvedReason: undefined,
    };
    return {
      rows: all.map((r, i) => (i === idx ? accepted : r)),
      result: { ok: true, row: accepted },
    };
  });
  return out.ok ? out.value : { ok: false, reason: out.reason };
}

/**
 * Record one round: match each finding to a stored row (or create one), decide
 * whether it is suppressed, and let `rowFate` resolve the open rows the round no
 * longer reports. The matching itself is pure and lives in
 * review-findings-round.ts; this function owns the I/O around it — the branch
 * read, the head reads, the lock, and the write. Returns the decisions (one per
 * input finding) or the reason nothing was recorded. Never throws.
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
    // A delta round's ranges come from its own diff and nowhere else. A delta
    // round with NO diff is not a delta round with no changes: it is a round
    // that cannot say which lines it reviewed, and decision 5 says such a round
    // resolves nothing — so it refuses rather than recording a round whose
    // silence about every row would read as coverage evidence.
    let ranges: ChangedRanges | undefined;
    if (run.review === "delta") {
      if (run.deltaDiff === undefined || run.deltaDiff.trim() === "") {
        return { ok: false, reason: "a delta round supplied no changed line ranges" };
      }
      ranges = changedLineRanges(run.deltaDiff);
    }
    // The branch's rows for this round, read ONCE: the paths to judge, and any
    // malformed row the branch carries. A file that EXISTS but cannot be read
    // FAILS the round: recording a round on "no memory" would resolve open rows
    // the unreadable file may still hold, which is the corruption a fail-soft
    // read cannot be trusted to prevent. A round that finds no file at all
    // legitimately has no memory; a round that cannot read one does not.
    let branchRows: BranchRows;
    // ONE resolution of the ledger and the findings file, threaded into both the
    // read below and the write further down: two `locate` calls would re-read
    // `PI_ENSEMBLE_REVIEW_LEDGER_FILE` between them, and a round whose read came
    // from one file and whose write landed in another is a round whose decisions
    // describe memory it did not modify.
    let loc: FindingsLocation | undefined;
    try {
      loc = await locate(run.cwd);
      if (!loc) {
        return { ok: false, reason: "not a git clone (no git common dir)" };
      }
      branchRows = readBranchRowsRaw(loc.file, run.branch) ?? { rows: [], malformed: [] };
    } catch (err) {
      // The prefix is short and the tail is the load-bearing part (the operator
      // action and the copy the bytes are in), so this clip keeps the actionable
      // end of the message rather than the cause's wording.
      const detail = (err as Error).message.replace(
        /^the branch's findings rows could not be read: ?/,
        "",
      );
      const reason = `the branch's findings rows could not be read: ${detail.slice(0, 360)}`;
      trace(`review-findings: ${reason}`);
      return { ok: false, reason };
    }
    const heads = new Map<string, HeadState>();
    // A git read error refuses the whole round (readHeadLines): nothing is
    // suppressed or resolved on evidence that could not be read.
    // Open AND accepted rows' paths are read: a round resolves or carries an open
    // row only on proof about its cited code (changed, or unchanged), and an
    // accepted row's path is read so a full round can EVICT an acceptance whose
    // file no longer exists (#1125) rather than keep it alive forever.
    const judgedPaths = branchRows.rows
      .filter((r) => r.status === "open" || r.status === "accepted")
      .map((r) => r.path);
    for (const p of [...run.findings.map((f) => f.path), ...judgedPaths]) {
      if (heads.has(p)) continue;
      const head = await readHeadLines(run.cwd, run.headSha, p);
      if (head.kind === "error") return { ok: false, reason: head.reason };
      heads.set(p, head);
    }
    // The pre-lock set-asides travel with the write: if the write fails the
    // round never reaches its summary, and without these the operator loses the
    // disclosure of memory that had already been set aside (#1125).
    //
    // #1934 — the identity the round's own write and its confirmations key on.
    // One computation for both: the caller that already computed it (the lens
    // ledger write) threads it in, so a normal recorded round pays for exactly
    // one `git diff | git patch-id --stable`. A failed identity read leaves it
    // undefined, which reads as "no confirmation available" below — never as a
    // match, because `confirmationsFor` compares by string equality against a
    // ledger row that is always non-empty.
    let patchId = run.patchId;
    if (run.confirmFixes === true && patchId === undefined) {
      try {
        patchId = (await workingTreePatchId(execp, run.cwd)).patchId;
      } catch (err) {
        trace(
          `review-findings: confirmations unavailable — the review identity could not be computed (${(err as Error).message.slice(0, 120)})`,
        );
      }
    }
    // #1934 — the ledger rows an independent confirmation is read from, read
    // ONCE here and threaded into the round: the same resolver the store's own
    // location uses (`ledgerPathFor`, override-honouring), so a round isolated by
    // `PI_ENSEMBLE_REVIEW_LEDGER_FILE` reads the ledger it was isolated with. Any
    // fault answers "no rows", which is the answer that confirms nothing — a
    // ledger the round cannot read never retires a row, exactly as it never
    // satisfies the merge guard. Read BEFORE the lock: the findings write holds
    // it, and taking a git read inside the critical section would widen the
    // window the #1071 lock exists to shorten.
    let ledgerRows: LedgerEntry[] = [];
    if (run.confirmFixes === true && patchId !== undefined) {
      try {
        // One resolution, the same override-honouring resolver the store's own
        // location is computed from (`ledgerPathFor` / `computeLocation` both read
        // `PI_ENSEMBLE_REVIEW_LEDGER_FILE` first), so an isolated round reads the
        // ledger it was isolated with — the read/write agreement #1125 requires.
        const ledgerFile = await ledgerPathFor(execp, run.cwd);
        if (ledgerFile) ledgerRows = readLedgerAt(ledgerFile);
      } catch (err) {
        trace(
          `review-findings: confirmations unavailable — the ledger could not be read (${(err as Error).message.slice(0, 120)})`,
        );
      }
    }
    const useConfirmations = run.confirmFixes === true && patchId !== undefined;
    // The pre-lock set-asides travel with the write: if the write fails the
    // round never reaches its summary, and without these the operator loses the
    // disclosure of memory that had already been set aside (#1125).
    const out = await mutateFindings(
      loc,
      (all) => {
        const others = all.filter((r) => r.branch !== run.branch);
        const mine = all.filter((r) => r.branch === run.branch);
        const round = applyFindingRound({
          branch: run.branch,
          findings: run.findings,
          mine,
          taken: new Set(all.map((r) => r.id)),
          headOf: (p: string) => heads.get(p),
          review: run.review,
          ...(ranges ? { deltaRanges: ranges } : {}),
          ...(useConfirmations
            ? {
                confirmations: {
                  ledger: ledgerRows,
                  patchId: patchId as string,
                  headSha: run.headSha,
                },
              }
            : {}),
          now,
        });
        return {
          rows: [...others, ...mine],
          result: {
            ...round,
            setAside: [...round.setAside, ...branchRows.malformed],
          },
        };
      },
      branchRows.malformed,
      run.writeFn,
    );
    if (!out.ok) {
      return out.setAside && out.setAside.length > 0
        ? { ok: false, reason: out.reason, setAside: out.setAside }
        : { ok: false, reason: out.reason };
    }
    return {
      ok: true,
      decisions: out.value.decisions,
      carried: out.value.carried,
      resolved: out.value.resolved,
      ...(out.value.lapsed && out.value.lapsed.length > 0 ? { lapsed: out.value.lapsed } : {}),
      ...(out.value.setAside.length > 0 ? { setAside: out.value.setAside } : {}),
    };
  } catch (err) {
    trace(`review-findings: record failed: ${(err as Error).message}`);
    return { ok: false, reason: (err as Error).message.slice(0, 160) };
  }
}
