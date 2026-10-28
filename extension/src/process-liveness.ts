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
 * #1871 added the OWNER IDENTITY to the same leaf: `<hostname> <boot-id>
 * <pid>`, the body a spawn slot or a path claim is written with. A bare
 * hostname + pid is not an identity inside a container fleet — containers
 * started with the same `--hostname` each see their own pid namespace, so
 * every one of them calls another's live owner a corpse and reaps it. The
 * boot id (`/proc/sys/kernel/random/boot_id`, distinct per boot and per
 * container) is what separates "that pid is gone" from "that pid is not
 * mine to judge".
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
 * refusing to resume, which is the safe direction.
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

/** Who owns a slot / claim / state file: where it was written, and by whom. */
export interface OwnerIdentity {
  host: string;
  bootId: string;
  pid: number;
}

/**
 * What a pid probe may answer for. `"foreign"` means the probe is NOT
 * consulted — the holder was written by some other host, or by some other
 * boot of this one, and a pid from that namespace proves nothing either way.
 */
export type OwnerVerdict = "alive" | "dead" | "foreign";

/** A boot id is a hex uuid; anything else is treated as no boot id at all. */
const BOOT_ID_PATTERN = /^[0-9A-Fa-f-]{8,64}$/;
/** The sentinel for "this host exposes no usable boot id" (e.g. macOS). */
export const NO_BOOT_ID = "-";

/** The kernel's boot id, trimmed and shape-validated; "-" when unavailable. */
function readBootId(): string {
  try {
    const raw = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return BOOT_ID_PATTERN.test(raw) ? raw : NO_BOOT_ID;
  } catch {
    return NO_BOOT_ID;
  }
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
  if (!selfCache) selfCache = { host: os.hostname(), bootId: readBootId(), pid: process.pid };
  return selfCache;
}

/** The wire form: `<host> <boot-id> <pid>`, read back by `parseIdentity`. */
export function formatIdentity(id: OwnerIdentity): string {
  return `${id.host} ${id.bootId} ${id.pid}`;
}

/**
 * Parse a holder body. A three-field body is the current format; a two-field
 * body is what pre-#1871 processes wrote and reads back with NO boot id, so
 * `judgeOwner` calls it foreign and it is never reaped. Anything else — an
 * empty, one-field or over-long body — parses to undefined, which every
 * caller also treats as foreign rather than as a corpse.
 */
export function parseIdentity(body: string | undefined): OwnerIdentity | undefined {
  const parts = body?.trim().split(" ");
  if (!parts || (parts.length !== 2 && parts.length !== 3)) return undefined;
  const host = parts[0] ?? "";
  const pid = Number(parts[parts.length - 1]);
  if (host === "" || !Number.isInteger(pid) || pid <= 0) return undefined;
  const bootId = parts.length === 3 ? parts[1] : undefined;
  return bootId === undefined || !BOOT_ID_PATTERN.test(bootId)
    ? { host, bootId: NO_BOOT_ID, pid }
    : { host, bootId, pid };
}

/**
 * May this process call that holder dead?
 *
 * The pid probe answers ONLY when hostname AND boot id both equal `self`'s.
 * Same host with a different boot id is a process from before a reboot (or a
 * sibling container); a different host with the same boot id is a machine this
 * process cannot see into; a body with no boot id is a pre-#1871 writer. All
 * three are `"foreign"` and are never reaped, deleted or swept — the same safe
 * direction as today's foreign-host rule. Two `"-"` boot ids on one host DO
 * count as matching, which keeps the pid probe working on hosts with no
 * `/proc` (macOS).
 *
 * Pure, and takes both identities as arguments: that is the whole test seam.
 */
export function judgeOwner(holder: OwnerIdentity | undefined, self: OwnerIdentity): OwnerVerdict {
  if (!holder) return "foreign";
  if (holder.host !== self.host || holder.bootId !== self.bootId) return "foreign";
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return "dead";
  if (holder.pid === self.pid) return "alive";
  return processAlive(holder.pid) ? "alive" : "dead";
}

/** The shape of a `WorkState.owner` / `PathClaimEntry` holder. */
export interface OwnerRecord {
  pid: number;
  host?: string;
  bootId?: string;
}

/**
 * Judge a state-file owner or a path-claim entry, legacy shape included.
 *
 * A record carrying NO `host`/`bootId` is what pre-#1871 processes wrote, and
 * Decision 6 pins its answer: today's pid-only verdict, unchanged. Calling it
 * "identity unknown" and answering `foreign` would make every pre-upgrade state
 * file unreadable-as-dead, which is the opposite failure — `work-driver-sweep-policy`
 * would sweep live cycles' worktrees on an upgrade. So the legacy branch
 * delegates to `processAlive` directly, and only a record that DOES carry an
 * identity goes through `judgeOwner`.
 *
 * Pure, and takes `self` as an argument: that is the test seam.
 */
export function judgeStateOwner(
  holder: OwnerRecord | undefined,
  self: OwnerIdentity,
): OwnerVerdict {
  if (!holder) return "foreign";
  if (holder.host === undefined && holder.bootId === undefined) {
    return processAlive(holder.pid) ? "alive" : "dead";
  }
  return judgeOwner(
    { host: holder.host ?? "", bootId: holder.bootId ?? NO_BOOT_ID, pid: holder.pid },
    self,
  );
}

/**
 * May this process treat a state-file owner / claim entry as GONE?
 *
 * `"foreign"` counts as ALIVE everywhere it is used: a holder this process
 * cannot verify is never reaped, never swept, never deleted, and a resume
 * refuses against it. That is the direction the registry and the worktree
 * sweep both take for an unprovable owner, and the accepted cost — a slot or
 * claim from a dead container stays until someone clears it — is documented in
 * docs/headless.md.
 */
export function ownerIsGone(holder: OwnerRecord | undefined, self: OwnerIdentity): boolean {
  return judgeStateOwner(holder, self) === "dead";
}
