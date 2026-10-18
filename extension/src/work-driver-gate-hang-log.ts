/**
 * #1427 — writing a gate run's hang report to scratch.
 *
 * The full report (process tree, output tail, every still-running test name)
 * is too wide for the 800-char failure-string window the cap renderer keeps,
 * so the report lives in a file and only `gateHangClause`'s one line rides in
 * the evidence. The handoff names the path.
 *
 * Extracted from `work-driver-consolidated-verify.ts` (AGENTS.md §12's 500-line
 * gate) so the probe's run/restore logic keeps its shape; the write itself has
 * one job, one contract, and no dependency on the cherry-pick machinery beside
 * it. Same contract as `writeConsolidatedVerifyLog`: a report is diagnosis, so
 * a failed write is traced and returns `undefined` and NEVER changes the verify
 * outcome.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import type { GateHangInput, HangProcess } from "./work-driver-gate-hang.ts";
import { reportGateHang } from "./work-driver-gate-hang.ts";
import { boundVerifyLog } from "./work-driver-verify-log-bounds.ts";

/**
 * #1427 — the filename of one gate-hang report, relative to `scratchDir`.
 * Its own prefix rather than the consolidated-verify one because a hang report
 * is written by every gate seam (per-worktree, consolidated, commit-pr, the
 * baseline probe), not only the consolidated run: an operator looking for the
 * report of a per-worktree hang should not have to know which seam produced it.
 */
function gateHangLogName(timestamp: string, tag?: string): string {
  const stamp = timestamp.replace(/[:.]/g, "-");
  // #1427 fix round — the timestamp alone collides when a fan-out kills two
  // gate runs in the same millisecond (every per-worktree run of one cycle is
  // started together), and the second write silently destroyed the first
  // report. The caller's discriminator is the workstream/cwd slug; when it is
  // absent a per-process counter keeps the name unique anyway.
  if (tag !== undefined && tag !== "") return `gate-hang-${stamp}-${slugName(tag)}.log`;
  return `gate-hang-${stamp}-${nextHangSeq()}.log`;
}

/** Filename-safe slug: path-ish input, lowercase, `[a-z0-9._-]` only, bounded. */
export function slugName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "run" : slug;
}

// #1427 fix round — the fallback discriminator when the caller has no slug:
// a monotonic per-process counter, so two writes in one millisecond never
// share a name.
let hangSeq = 0;
function nextHangSeq(): number {
  hangSeq += 1;
  return hangSeq;
}

/**
 * #1427 round 3 — the first free sequence number for one base name.
 *
 * The round-2 fix made the NAME unique across a fan-out by tagging it with the
 * workstream slug, and that is what the timestamp alone could not do. It did
 * not make it unique across two kills of the SAME workstream in one cycle — and
 * that is the shape the flake re-run produces: run 1 is killed at the bound,
 * the single permitted re-run is killed too, and both writes carry the same
 * timestamp and the same slug, so the second silently destroyed the first. One
 * report for two kills is the wrong direction: the operator reads a snapshot of
 * the later run with no record the earlier one existed.
 *
 * The scan starts at 2 because the unsuffixed name is the natural one (an
 * operator who knows there was one kill finds `gate-hang-<ts>-<slug>.log`, not
 * `…-<slug>-2.log`); only collisions acquire a suffix.
 */
function nextFreeSeq(dir: string, base: string): number {
  for (let n = 2; n < 100; n += 1) {
    if (!existsSync(path.join(dir, `${base}-${n}.log`))) return n;
  }
  // Unreachable in practice (100 kills of one worktree in one cycle); fall back
  // to the process counter rather than overwrite a report.
  return 100 + nextHangSeq();
}

/**
 * #1427 round 3 — one filename per kill, not one per slug. The first write of
 * a stem takes the plain `<base>.log`; a second write of the same stem takes
 * `<base>-2.log`, and so on. The existence probe is not atomic, so the write
 * below opens with the exclusive `wx` flag: a race that survives the probe
 * surfaces as `EEXIST` and the caller takes the next sequence number rather
 * than truncating the file it raced with.
 */
function hangLogPathFor(scratchDir: string, base: string): string {
  const plain = path.join(scratchDir, `${base}.log`);
  if (!existsSync(plain)) return plain;
  return path.join(scratchDir, `${base}-${nextFreeSeq(scratchDir, base)}.log`);
}

/**
 * #1427 — persist a killed gate run's hang report and return the path, or
 * `undefined` when nothing could be written. Never fails the step (same
 * contract as `writeConsolidatedVerifyLog`, whose size bound it shares).
 *
 * The tree is NOT walked here: the caller captured it in its `catch`, in the
 * window where the killed group may still have been alive, and hands it in on
 * `input.processes` — one walk feeds both this file and the failure-string
 * clause, so the two cannot describe different snapshots for one kill.
 */
export function writeGateHangLog(
  scratchDir: string,
  timestamp: string,
  input: GateHangInput,
  deps: {
    walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string };
    /** #1427 fix round — the per-run discriminator (workstream id or cwd). */
    tag?: string;
  } = {},
): string | undefined {
  // #1427 round 3 — the stem (timestamp + slug) without the extension, so a
  // collision can acquire a sequence suffix rather than overwrite.
  const base = path.basename(gateHangLogName(timestamp, deps.tag), ".log");
  try {
    // #1427 round 3 — the directory is created private (0700 rather than 0777
    // masked by umask): the scratch dir holds killed gates' raw streams.
    //
    // The mkdir is inside this try for the reason the pre-fix code put the
    // whole write in it: an unwritable scratch dir throws, and a report that
    // cannot be written is a traced `undefined`, never an exception out of the
    // gate's failure path.
    mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    trace(
      `work-driver: gate hang — could not create the scratch dir: ${(err as Error).message?.slice(0, 160)}`,
    );
    return undefined;
  }
  // Two attempts. `flag: "wx"` makes the write fail with EEXIST instead of
  // truncating a report that raced with this one; on that race the next
  // sequence number is taken. A genuine write failure (EACCES, ENOSPC, an
  // unwritable dir) is NOT retried — it would fail the same way, and the
  // contract below is that a failed write returns `undefined` rather than
  // changing the verify outcome.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const file = hangLogPathFor(scratchDir, base);
    try {
      writeFileSync(file, boundVerifyLog(reportGateHang(input, deps)), {
        encoding: "utf8",
        // #1427 round 3 — owner-only AT CREATION. The pre-fix shape wrote with
        // the default mode and `chmod`ed afterwards, which leaves a window in
        // which the file exists and is group-readable: with a permissive umask
        // the killed run's raw stream — which can carry anything the gate
        // printed, including a credential it echoed — is briefly legible to
        // every other user on the host. A `mode` on the write closes the window
        // instead of shutting it after the fact. (`mode` is ignored when the
        // file already exists; the exclusive flag makes that impossible here.)
        mode: 0o600,
        flag: "wx",
      });
      trace(`work-driver: gate hang — report written to ${file}`);
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && attempt === 0) continue;
      trace(
        `work-driver: gate hang — could not write the report: ${(err as Error).message?.slice(0, 160)}`,
      );
      return undefined;
    }
  }
  return undefined;
}
