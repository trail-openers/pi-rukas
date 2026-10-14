/**
 * work-driver-park-memory — one park comment per unchanged intent park.
 *
 * `/work N --restart` starts from `initialState`, so nothing remembered that
 * the previous cycle parked this issue at the intent gate. A factory that
 * passes `--restart` on every second cycle re-resolved janit/tehas#85 and
 * janit/tehas#88 minutes after they parked, reached the same `contradicted-by-code`
 * verdict, and posted a second near-identical "Cap hit" comment for a human
 * to tell apart — presented as if it were the first report on the issue.
 *
 * `--restart` still re-resolves: the intent verdict is a model's judgement,
 * not a computation, and a second look can honestly end differently. What
 * this module removes is only the duplicate REPORT. A posted intent park is
 * recorded beside the other per-issue artifacts
 * (`.pi/work-state/<issue>/intent-park.txt`, which `--restart` never
 * touched) with its park reason and a fingerprint of what it was judged
 * against — the issue text and the checked-out commit. When a fresh
 * resolution parks again for the same reason against the same fingerprint,
 * the handoff reuses the earlier comment and says it is a repeat.
 *
 * Anything else — a different reason, an edited issue, a moved or unreadable
 * HEAD, a missing or malformed record, an earlier comment that never posted —
 * is not a repeat, and the handoff posts exactly as before.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { execp } from "./work-driver-verify.ts";
import { type WorkState, dispatchArtifactPath, writeDispatchArtifact } from "./workflow-state.ts";

/** The earlier park a handoff repeats: when it fired, and its comment. */
export interface RepeatOf {
  at: number;
  commentUrl: string;
}

/** What this cycle's park was judged against, and the earlier park it repeats (if any). */
export interface ParkMemory {
  /** Set only for an intent park with a stated reason and readable inputs. */
  key?: { fingerprint: string; parkReason: string };
  repeatOf?: RepeatOf;
}

/** The record's path. Shared with the tests. */
export function parkRecordPath(repoRoot: string, issue: number): string {
  return dispatchArtifactPath(repoRoot, issue, "intent-park");
}

/**
 * Fingerprint the two inputs an intent verdict depends on: the issue text
 * (title + body, as explore cached it) and the checked-out commit. `undefined`
 * when either cannot be read — half a fingerprint would call a moved codebase
 * "unchanged".
 */
async function parkFingerprint(ctx: DriverContext, state: WorkState): Promise<string | undefined> {
  const bodyPath = state.pipelineState.issueBodyArtifact;
  if (!bodyPath) return undefined;
  try {
    const issueText = await fs.readFile(bodyPath, "utf8");
    const exec = ctx.verifyExecFn ?? execp;
    const { stdout } = await exec("git rev-parse HEAD", { cwd: ctx.repoRoot, timeout: 10_000 });
    const head = stdout.trim();
    if (!head) return undefined;
    return createHash("sha256").update(`${head}\n${issueText}`).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Called at the start of the handoff step. Never throws: a missing record is
 * the normal case and a malformed one is treated as absent.
 */
export async function readParkMemory(ctx: DriverContext, state: WorkState): Promise<ParkMemory> {
  const cap = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  if (cap?.kind !== "cap-hit" || cap.cap !== "intent-park" || !cap.parkReason) return {};
  const fingerprint = await parkFingerprint(ctx, state);
  if (!fingerprint) return {};
  const key = { fingerprint, parkReason: cap.parkReason };
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(parkRecordPath(ctx.repoRoot, ctx.issue), "utf8"),
    );
    if (raw === null || typeof raw !== "object") return { key };
    const rec = raw as Record<string, unknown>;
    if (
      rec.fingerprint === fingerprint &&
      rec.parkReason === cap.parkReason &&
      typeof rec.parkedAt === "number" &&
      typeof rec.commentUrl === "string" &&
      rec.commentUrl
    ) {
      return { key, repeatOf: { at: rec.parkedAt, commentUrl: rec.commentUrl } };
    }
  } catch {
    /* no record, or an unreadable one — not a repeat */
  }
  return { key };
}

/**
 * Called once the handoff is emitted. A repeat keeps the original record (its
 * time and its comment); a new posted intent park replaces it; every other
 * outcome removes it, so a record only ever describes the issue's LATEST
 * handoff. Best-effort.
 */
export async function recordPark(
  ctx: DriverContext,
  memory: ParkMemory,
  commentUrl: string | undefined,
): Promise<void> {
  if (memory.repeatOf) return;
  try {
    if (!memory.key || !commentUrl) {
      await fs.rm(parkRecordPath(ctx.repoRoot, ctx.issue), { force: true });
      return;
    }
    const record = { ...memory.key, parkedAt: Date.now(), commentUrl };
    await writeDispatchArtifact(
      ctx.repoRoot,
      ctx.issue,
      "intent-park",
      JSON.stringify(record, null, 2),
    );
  } catch (err) {
    trace(`work-driver: could not update intent-park record: ${(err as Error).message}`);
  }
}
