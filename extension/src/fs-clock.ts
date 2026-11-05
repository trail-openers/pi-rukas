/**
 * fs-clock — a reading of "now" that agrees with a file's own inode times.
 *
 * `spawn-operator-config.ts` decides that a `$HOME` entry is NEW by comparing the
 * entry's `stat()` birth time against an instant it took around the child. The two
 * readings are not on one scale: an inode time is stamped by the kernel at the write
 * and `Date.now()` is read in userspace, so the two can disagree by a millisecond or
 * two. That is enough for `born >= stamp` to read FALSE for a file written *after*
 * the stamp — the one case the check exists to catch, and the reason a naive
 * timestamp window drops every real leftover.
 *
 * `FsClock` keeps the comparison inside one clock domain: the bound is stamped into a
 * sentinel file by the kernel, on the same filesystem and through the same syscall
 * path as the write being judged, so bound and birth time are readings of a kind
 * that may be compared. The sentinel is a dotfile carrying this module's own prefix,
 * which is how the caller tells its bookkeeping apart from an entry a child left.
 *
 * Readings are held strictly monotone within one clock, so a window never closes on
 * itself (two bounds in the same millisecond must not tie, or an instant's write
 * falls outside it). Where the sentinel cannot be written — a read-only mount, a
 * `chmod 500` home — the reading falls back to `Date.now()`, the ordinary untestable
 * case, which the caller reports rather than accuses on.
 *
 * This is a clock, not evidence. The caller still names an entry only on the facts it
 * can show: absent from the baseline listing, and present in the one after.
 */

import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The sentinel's name: a dotfile under the watched directory, prefixed so the listing
 * that reports a child's leftovers can recognise the guard's own bookkeeping and skip
 * it. A child would have to guess both the prefix and the suffix to have one of its
 * own entries swallowed.
 */
export const FS_CLOCK_SENTINEL = ".pi-rukas-fs-clock-probe";

/** Is `name` this module's own clock sentinel rather than a child's entry? */
export function isFsClockSentinel(name: string): boolean {
  return name === FS_CLOCK_SENTINEL;
}

/** One bounds-taking clock over one watched directory. */
export interface FsClock {
  /**
   * "Now", as the watched filesystem stamped it. Strictly greater than every
   * previous reading from this clock.
   */
  now(): Promise<number>;
  /** Remove the sentinel this clock wrote. Best-effort; a leftover is inert. */
  clear(): Promise<void>;
}

/**
 * A clock over `dir`, whose bounds are stamped by `dir`'s own filesystem.
 *
 * The sentinel lives in the watched directory on purpose: the kernel stamps its inode
 * with the same clock that stamps the entry being judged, so a bound taken moments
 * before or after a child's write is comparable with that write's birth time. A bound
 * taken from another filesystem (a scratch tmpfs, `/tmp`) would be the cross-clock
 * comparison this exists to remove.
 */
export function createFsClock(dir: string): FsClock {
  const sentinel = path.join(dir, FS_CLOCK_SENTINEL);
  let last = 0;
  return {
    now: async () => {
      let stamped: number | null = null;
      try {
        await writeFile(sentinel, "");
        const st = await stat(sentinel);
        stamped = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      } catch {
        // No sentinel, no filesystem reading: the system clock is all there is.
        stamped = null;
      }
      const candidate = Math.max(stamped ?? 0, Date.now());
      // Strictly increasing, so the two bounds of a window can never be equal and an
      // entry written between them is always inside it.
      last = candidate > last ? candidate : last + 0.001;
      return last;
    },
    clear: () => rm(sentinel, { force: true }).catch(() => undefined),
  };
}
