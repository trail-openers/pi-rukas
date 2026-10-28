/**
 * process-liveness — the one answer this repo gives to "is that pid there?".
 *
 * Extracted from `work-driver-resume.ts` when the stale-lock sweep needed the
 * same predicate (#1740). It was previously imported out of the resume module,
 * which made a lockfile judge depend on the state-file machinery for a
 * two-syscall question; a leaf with no imports is what both callers should
 * depend on. `work-driver-resume.ts` re-exports it, so existing importers keep
 * working and the resume tests keep naming the module they were written
 * against.
 *
 * #1871 added the OWNER IDENTITY to the same leaf: `<host> <pidns> <pid>
 * <starttime>`, the body a spawn slot or a path claim is written with. A bare
 * hostname + pid is not an identity inside a container fleet — containers
 * started with the same `--hostname` each see their own pid namespace, so
 * every one of them calls another's live owner a corpse and reaps it. The pid
 * namespace inode (`/proc/self/ns/pid`) is what separates "that pid is gone"
 * from "that pid is not mine to judge".
 *
 * Not the boot id. `/proc/sys/kernel/random/boot_id` is IDENTICAL on the host
 * and in every container on it — they share one kernel — so it separates
 * nothing in the deployment this identity exists for. And a pid namespace
 * inode is recycled by the kernel once its last process exits, so two holders
 * can legitimately share one inode; the process start time (field 22 of
 * `/proc/<pid>/stat`) tells a recycled pid apart from the original.
 *
 * The leaf property holds: only node built-ins, no project imports.
 */

import fs from "node:fs";
import os from "node:os";

/**
 * Is this process still alive?
 *
 * `kill(pid, 0)` sends no signal and only tests reachability. EPERM means the
 * pid exists but belongs to another user — still alive, so still an owner.
 * Pid reuse can in principle make a dead owner look live; the failure mode is
 * refusing to resume, which is the safe direction. The start time in the
 * identity is what a probe cannot fake.
 *
 * A SIGSTOPped process, and a zombie whose parent never reaped it, also answer
 * here. Neither can release a lockfile, which is why a liveness voucher alone
 * must never be the last word on a stale lock — see `stale-lock-sweep.ts`'s
 * hard ceiling.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Field 22 of `/proc/<pid>/stat` — starttime, clock ticks since the boot that
 * started the process — as text. Read AFTER the last `)`, because field 2 is a
 * command name in parentheses and may itself contain spaces and parentheses;
 * splitting the raw line on whitespace shifts every field after it.
 *
 * `"-"` when the file or the field is unavailable: macOS has no `/proc`, and a
 * procfs mounted hidepid can refuse another user's stat. `"-"` is the same
 * sentinel `pidns` uses, and means the same thing here: this field cannot tell
 * two holders apart, so it must not make them agree either.
 */
function readProcField22(procStatPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(procStatPath, "utf8");
  } catch {
    return NO_ID_FIELD;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return NO_ID_FIELD;
  const tail = raw.slice(close + 1).trim();
  const field = tail.split(/\s+/)[19] ?? "";
  return /^\d+$/.test(field) ? field : NO_ID_FIELD;
}

/** The kernel's pid-namespace inode for this process, as decimal text. */
function readSelfPidNs(): string {
  try {
    const link = fs.readlinkSync("/proc/self/ns/pid");
    const inode = /^pid:\[(\d+)\]$/.exec(link)?.[1];
    return inode === undefined ? NO_ID_FIELD : inode;
  } catch {
    return NO_ID_FIELD;
  }
}

/** The "this field is unavailable" sentinel — see `readProcField22`. */
export const NO_ID_FIELD = "-";

/** The character set a host name is accepted from; anything else is not a host. */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** The shape of a `WorkState.owner` / `PathClaimEntry` holder record. */
export interface OwnerRecord {
  pid: number;
  host?: string;
  pidns?: string;
  startTime?: string;
}

/** Who owns a slot / claim / state file: where it was written, and by whom. */
export interface OwnerIdentity {
  host: string;
  /** Decimal pid-namespace inode, or "-" when `/proc` is unavailable. */
  pidns: string;
  pid: number;
  /** Field 22 of `/proc/<pid>/stat`, or "-" when unavailable. */
  startTime: string;
}

/**
 * What a pid probe may answer for. `"foreign"` means the probe is NOT
 * consulted — the holder lives in a pid namespace this process cannot see
 * into, or carries an identity this process cannot read, and a pid from there
 * proves nothing either way.
 */
export type OwnerVerdict = "alive" | "dead" | "foreign";

/** A holder's start time as it must be read from `/proc`, never assumed. */
export type StartTimeReader = (pid: number) => string;

/** The real reader production uses; injectable so the pure judge is testable. */
export const startTimeOfPid: StartTimeReader = (pid) => readProcField22(`/proc/${pid}/stat`);

/**
 * An identity is comparable only field-by-field. Unknown (`"-"`) on both sides
 * agrees; unknown against a value does NOT — an unreadable field must not
 * certify that two holders are the same process, which is how a recycled pid
 * namespace would otherwise be allowed to pass for a live one.
 */
function sameIdField(mine: string, theirs: string): boolean {
  return mine === theirs;
}

let selfCache: OwnerIdentity | undefined;

/**
 * This process's owner identity, read once and cached for the process life.
 *
 * Lazy rather than at module load, so one process can exercise both a
 * matching and a non-matching identity in a single run — the tests pass
 * `self` to `judgeOwner` explicitly and never reset this cache.
 */
export function selfIdentity(): OwnerIdentity {
  if (!selfCache)
    selfCache = {
      host: os.hostname(),
      pidns: readSelfPidNs(),
      pid: process.pid,
      startTime: readProcField22("/proc/self/stat"),
    };
  return selfCache;
}

/** The wire form: `<host> <pidns> <pid> <starttime>`, read back by `parseIdentity`. */
export function formatIdentity(id: OwnerIdentity): string {
  return `${id.host} ${id.pidns} ${id.pid} ${id.startTime}`;
}

/** Is `host` a host name we are willing to treat as an identity field? */
export function validHost(host: string): boolean {
  return HOST_PATTERN.test(host);
}

/**
 * Parse a holder body. A four-field body is the current format; a two-field
 * body is what the last release wrote (before #1871 ever shipped) and keeps
 * that release's verdict — see `judgeOwner`. Anything else — empty, one field,
 * three, five — or a body whose host fails `validHost`, parses to undefined,
 * which every caller also treats as foreign rather than as a corpse. The host
 * is validated HERE because a parsed identity is what handoff markdown renders.
 */
export function parseIdentity(body: string | undefined): OwnerIdentity | undefined {
  const parts = body?.trim().split(" ");
  if (!parts || (parts.length !== 2 && parts.length !== 4)) return undefined;
  const host = parts[0] ?? "";
  if (!validHost(host)) return undefined;
  // The pid is field 3 of the four-field body and field 2 of the legacy one —
  // never the LAST field, which for the current format is the start time.
  const pid = Number(parts[2] ?? parts[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (parts.length === 2) {
    // The legacy shape keeps `pidns: "-"` to say "no namespace was written";
    // it is the ABSENCE of both fields that marks it, so they are absent here
    // too rather than silently "-" (which would make it indistinguishable from
    // a Linux writer whose /proc happened to be unreadable).
    return { host, pidns: NO_ID_FIELD, pid, startTime: "" };
  }
  const pidns = parts[1] ?? "";
  const startTime = parts[3] ?? "";
  if (!/^\d+$/.test(pidns) && pidns !== NO_ID_FIELD) return undefined;
  if (!/^\d+$/.test(startTime) && startTime !== NO_ID_FIELD) return undefined;
  return { host, pidns, pid, startTime };
}

/**
 * May this process call that holder dead?
 *
 * The pid probe answers ONLY when hostname AND pid namespace both equal
 * `self`'s — two `"-"` namespaces on one host DO count as matching, which
 * keeps the probe working on hosts with no `/proc` (macOS). Everything else is
 * `"foreign"`, never reaped, deleted or swept: the same safe direction as the
 * foreign-host rule it sits behind. Two `"-"` start times likewise match; a
 * known start time against a `"-"` is unknown, not equal.
 *
 * Pure, and takes the holder, `self` and (for a probed holder) a start-time
 * reader as arguments: that is the whole test seam.
 */
export function judgeOwner(
  holder: OwnerIdentity | undefined,
  self: OwnerIdentity,
  startTimeOf: StartTimeReader = startTimeOfPid,
): OwnerVerdict {
  if (!holder) return "foreign";
  if (!validHost(holder.host) || holder.host !== self.host) return "foreign";
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return "foreign";
  // The pre-#1871 released body is `<host> <pid>`: no namespace, no start
  // time. `startTime` is then "" (absent), NOT the "-" a Linux writer uses for
  // "readable namespace, unreadable start time" — the two shapes must stay
  // distinguishable or a real identity could borrow the legacy verdict.
  // Decision D3 pins the answer to that release's: this host, pid liveness.
  if (holder.startTime === "") {
    if (holder.pid === self.pid) return "alive";
    return processAlive(holder.pid) ? "alive" : "dead";
  }
  if (!sameIdField(holder.pidns, self.pidns)) return "foreign";
  if (!processAlive(holder.pid)) return "dead";
  // `self.pid` is the JUDGING process, not the holder: a holder that names it
  // is a pid the kernel handed out again after the holder wrote its body, so
  // the start time is the only thing that can tell the two apart. Comparing
  // the recorded start time against `/proc/<pid>/stat` is exactly what D2
  // asks for, and skipping it here would make every pid-reuse case alive.
  if (holder.startTime === NO_ID_FIELD || self.startTime === NO_ID_FIELD) return "alive";
  return startTimeOf(holder.pid) === holder.startTime ? "alive" : "dead";
}

/**
 * Judge a state-file owner or a path-claim entry, legacy shape included.
 *
 * A record carrying NO identity field at all is what pre-#1871 processes
 * wrote, and Decision D3 pins its answer: that release's pid-only verdict,
 * unchanged. Calling it "identity unknown" and answering `foreign` would make
 * every pre-upgrade state file unreadable-as-dead, which is the opposite
 * failure — `work-driver-sweep-policy` would sweep live cycles' worktrees on an
 * upgrade. So the legacy branch delegates to `processAlive` directly.
 *
 * A record carrying SOME but not all of `host`/`pidns`/`startTime` is
 * `"foreign"`, and the probe is never reached (Decision D4): a half-written
 * identity is not evidence of anything, and reading it as "no identity" would
 * hand a foreign holder the pid-only verdict this change exists to remove.
 *
 * Pure, and takes `self` as an argument: that is the test seam.
 */
export function judgeStateOwner(
  holder: OwnerRecord | undefined,
  self: OwnerIdentity,
  startTimeOf: StartTimeReader = startTimeOfPid,
): OwnerVerdict {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return "foreign";
  const fields = [holder.host, holder.pidns, holder.startTime];
  const present = fields.filter((f) => f !== undefined).length;
  if (present === 0) return processAlive(holder.pid) ? "alive" : "dead";
  if (present !== fields.length) return "foreign";
  return judgeOwner(
    {
      host: holder.host as string,
      pidns: holder.pidns as string,
      pid: holder.pid,
      startTime: holder.startTime as string,
    },
    self,
    startTimeOf,
  );
}

/**
 * May this process treat a state-file owner / claim entry as GONE?
 *
 * `"foreign"` counts as ALIVE everywhere it is used: a holder this process
 * cannot verify is never reaped, never swept, never deleted, and a resume
 * refuses against it. That is the direction the registry and the worktree
 * sweep both take for an unprovable owner, and the accepted cost — a slot or
 * claim from a dead container stays until someone clears it, or past the lease
 * in `host-spawn-slots.ts` — is documented in docs/headless.md.
 */
export function ownerIsGone(
  holder: OwnerRecord | undefined,
  self: OwnerIdentity,
  startTimeOf: StartTimeReader = startTimeOfPid,
): boolean {
  return judgeStateOwner(holder, self, startTimeOf) === "dead";
}
