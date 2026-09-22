/**
 * work-driver-lock — the integration lock (extracted from
 * work-driver-integrate.ts by #794 to keep that file under the 500-line
 * gate). The lock is the ONLY path that writes to repoRoot: it serialises
 * consolidation (cherry-pick / patch-apply) across workstreams AND across
 * concurrent driver processes in the same repo clone.
 *
 * Two layers, both required:
 *   - In-process: `integrationChain` promise chain (same-process serialisation).
 *   - Cross-process: an `O_EXCL` lockfile under `.git/` (`O_EXCL` — the
 *     create itself is the atomic test-and-set), swept when its holder has
 *     been gone for `LOCK_STALE_MS`.
 *
 * `acquireLockfile` fails OPEN on an unreadable / unwritable lock: the
 * in-process chain still serialises the current process, and a repo whose
 * `.git` is not writable is degraded enough that blocking hard on the lock
 * would cost more than the risk the lock guards against.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";

let integrationChain: Promise<unknown> = Promise.resolve();
const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "pi-rukas-integration.lock");
}

async function acquireLockfile(repoRoot: string): Promise<() => Promise<void>> {
  const file = lockPath(repoRoot);
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      // `wx` is O_EXCL: the create itself is the atomic test-and-set.
      const fh = await fs.open(file, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return async () => {
        await fs.rm(file, { force: true }).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Cannot create the lock at all (read-only .git, permissions).
        // Fail OPEN: the in-process chain still serialises this process.
        trace(`integration-lock: lockfile unavailable, continuing: ${(err as Error).message}`);
        return async () => undefined;
      }
      // Held. Sweep it if the holder is long gone, otherwise wait.
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as { at?: number };
        if (typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS) {
          trace("integration-lock: sweeping a stale lockfile");
          await fs.rm(file, { force: true }).catch(() => undefined);
          continue;
        }
      } catch {
        // Unreadable/corrupt lock — treat as stale rather than deadlocking.
        await fs.rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        trace("integration-lock: waited past the stale window, proceeding");
        return async () => undefined;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Run `fn` holding the integration lock. Never inherits a prior rejection. */
export function withIntegrationLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const run = integrationChain.then(
    () => guarded(repoRoot, fn),
    () => guarded(repoRoot, fn),
  );
  integrationChain = run.catch(() => undefined);
  return run;
}

async function guarded<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLockfile(repoRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Test seam: reset the in-process chain between fixtures. */
export function __resetIntegrationLock(): void {
  integrationChain = Promise.resolve();
}
