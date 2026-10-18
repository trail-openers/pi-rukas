/**
 * headless/plan-session — the record a headless planning session keeps between
 * its turns (#1471). A turn is one run of `pi-rukas-headless plan`; the session
 * is what lets the next run continue it hours later in a fresh process.
 *
 * One JSON file per session, `<dir>/<id>.json`, where `<dir>` is
 * `PI_ENSEMBLE_PLAN_SESSION_DIR` (absolute) or `<git-common-dir>/pi-plan-sessions`.
 * A caller that plans in a fresh clone per turn sets the variable to a
 * directory it keeps. Writes are atomic (temp file + rename) and every turn
 * holds `<id>.lock`, so two runs on one session never interleave.
 *
 * The file is pi-rukas's private persistence, like the work state file: a host
 * reads the turn's JSON result, never this file.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PlanProvenance } from "../plan-provenance.ts";
import type { PlanType } from "../plan-types.ts";

const execFileP = promisify(execFile);

export const PLAN_SESSION_VERSION = 1 as const;

/** A question put to the operator. `options` is empty when the answer is free text. */
export interface PlanQuestion {
  id: string;
  question: string;
  options: { label: string; description: string }[];
  /** The gap gate's proposed resolution, when the question is an open point of a shown plan. */
  resolution?: string;
}

/** What a turn ended in. */
export type TurnStatus = "question" | "shown" | "duplicate-risk" | "failed";

export interface PlanSession {
  v: typeof PLAN_SESSION_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  descriptor: string;
  type?: PlanType;
  context?: string;
  /** The number of turns run so far. */
  turn: number;
  /** Every answer the operator gave, in order, with what it answered. */
  answers: { turn: number; at: string; asked: PlanQuestion[]; shownTitle?: string; text: string }[];
  /** How the last turn ended. Absent before the first turn has finished. */
  pending?: { status: TurnStatus; questions: PlanQuestion[] };
  /** The plan the last turn showed. Only this plan can be confirmed. */
  shown?: { title: string; spec: string; digest: string; turn: number };
  /** Written before the forge call, so a cut-off filing is looked for, not repeated. */
  filing?: { startedAt: string; digest: string };
  filed?: { url: string; number?: number; at: string; digest: string };
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A session id is a UUID; anything else never reaches a path. */
export function isSessionId(id: string): boolean {
  return ID_RE.test(id);
}

/** Where sessions live. Undefined when there is no override and no git directory. */
export async function planSessionDir(repoRoot: string): Promise<string | undefined> {
  const override = process.env.PI_ENSEMBLE_PLAN_SESSION_DIR?.trim();
  if (override && path.isAbsolute(override)) return override;
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeout: 10_000 },
    );
    const common = stdout.trim();
    return common ? path.join(common, "pi-plan-sessions") : undefined;
  } catch {
    return undefined;
  }
}

export function newSession(descriptor: string, type?: PlanType, context?: string): PlanSession {
  const now = new Date().toISOString();
  return {
    v: PLAN_SESSION_VERSION,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    descriptor,
    type,
    context,
    turn: 0,
    answers: [],
  };
}

const fileOf = (dir: string, id: string) => path.join(dir, `${id}.json`);

/** The session, `"missing"` when there is none, `"corrupt"` when the file cannot be read as one. */
export async function readSession(
  dir: string,
  id: string,
): Promise<PlanSession | "missing" | "corrupt"> {
  let raw: string;
  try {
    raw = await fs.readFile(fileOf(dir, id), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt";
  }
  try {
    const s = JSON.parse(raw) as PlanSession;
    const ok =
      s.v === PLAN_SESSION_VERSION &&
      s.id === id &&
      typeof s.descriptor === "string" &&
      typeof s.turn === "number" &&
      Array.isArray(s.answers);
    return ok ? s : "corrupt";
  } catch {
    return "corrupt";
  }
}

export async function writeSession(dir: string, s: PlanSession): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = fileOf(dir, s.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ ...s, updatedAt: new Date().toISOString() })}\n`);
  await fs.rename(tmp, file);
}

/** A lock from another host (a container) older than this is taken over: its liveness cannot be checked. */
export const FOREIGN_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a lock's holder may still be running. A lock is `{ pid, host, at, token }`.
 * On this host the pid answers, except our own pid: a fresh container often
 * reuses the pid of the run that left the lock. On another host only the age
 * answers. An unreadable lock is stale.
 */
function heldBy(raw: string, now: number): boolean {
  let lock: { pid?: unknown; host?: unknown; at?: unknown };
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    return false;
  }
  const { pid, host, at } = lock;
  if (typeof pid !== "number" || typeof host !== "string" || typeof at !== "number") return false;
  if (host !== os.hostname()) return now - at < FOREIGN_LOCK_STALE_MS;
  return pid !== process.pid && alive(pid);
}

/**
 * Take the session's lock. Returns the release function, or undefined when
 * another run holds it. A stale lock is moved aside under a unique name before
 * the lock is made again, so two runs that both judge it stale cannot both
 * remove the other's new lock; release removes the lock only while it is still
 * this run's.
 */
export async function lockSession(
  dir: string,
  id: string,
): Promise<(() => Promise<void>) | undefined> {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${id}.lock`);
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(lock, "wx");
      await fh.writeFile(body);
      await fh.close();
      return async () => {
        const now = await fs.readFile(lock, "utf8").catch(() => "");
        if (now === body) await fs.rm(lock, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const raw = await fs.readFile(lock, "utf8").catch(() => "");
      if (heldBy(raw, Date.now())) return undefined;
      const aside = `${lock}.${token}.stale`;
      try {
        await fs.rename(lock, aside);
      } catch {
        continue;
      }
      // Another run may have replaced the stale lock between the read and the rename.
      const moved = await fs.readFile(aside, "utf8").catch(() => "");
      if (moved !== raw) {
        // Put it back without overwriting a lock made since (link fails on an existing name).
        await fs.link(aside, lock).catch(() => undefined);
        await fs.rm(aside, { force: true });
        return undefined;
      }
      await fs.rm(aside, { force: true });
    }
  }
  return undefined;
}

/** The provenance every session turn drafts with: the session id is how a cut-off filing is found. */
export function sessionProvenance(id: string): PlanProvenance {
  return { line: `Planned in pi-rukas plan session ${id}`, marker: { "plan-session": id } };
}

/** The operator's context plus every answer so far, in the order given. */
export function sessionContext(s: PlanSession): string | undefined {
  if (s.answers.length === 0) return s.context;
  const parts = s.answers.map((a, i) => {
    const asked = a.asked.map((q) => `- ${q.id}: ${q.question}`).join("\n");
    const lead = a.shownTitle
      ? `The operator reviewed the drafted plan "${a.shownTitle}" and replied:`
      : "The operator answered:";
    return `### Answer ${i + 1}\n\n${asked ? `Questions asked:\n${asked}\n\n` : ""}${lead}\n\n${a.text}`;
  });
  const answers = `## Operator answers in this planning session\n\n${parts.join("\n\n")}`;
  return s.context ? `${s.context}\n\n${answers}` : answers;
}
