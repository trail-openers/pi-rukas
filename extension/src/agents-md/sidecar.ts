/**
 * sidecar — the git-tracked `.pi/agents-md-state.json` persistence for the
 * decision ledger (post-#680 M1).
 *
 * The decision-ledger used to be rendered IN-FILE as a managed section of
 * AGENTS.md. Post-#680 M1 it moves to a sidecar file so the rendered
 * AGENTS.md stays pure prose — no HTML comment bookkeeping, no machine
 * tables. The sidecar is **git-tracked** (NOT gitignored — a smoke test
 * asserts `git check-ignore` exits non-zero on it), preserving the
 * "travels with the repo across checkouts" property the in-file design had.
 *
 * The sidecar path is `<repoRoot>/.pi/agents-md-state.json`. It is derived
 * from `root` (the same root the verb already receives) so the check-ignore
 * test can invoke `git -C <root> check-ignore -- .pi/agents-md-state.json`
 * independently of the process cwd.
 *
 * The file format is a JSON array of `{key, value, provenance, date}`
 * objects (see ledger.ts `renderLedger`/`parseLedger`). A 0-byte sidecar
 * parses to `[]` (the legitimate "no rows yet" state). A non-empty
 * unparseable sidecar is a defined, deterministic refusal state (exit 2) —
 * never silently re-derived, never silently lost.
 */

import type { LedgerRow } from "./ledger.ts";
import { parseLedger } from "./ledger.ts";
import { MarkerError } from "./markers.ts";

export const SIDECAR_RELATIVE_PATH = ".pi/agents-md-state.json";

/** Resolve the sidecar's absolute path from the repo root. */
export function sidecarPath(root: string): string {
  return `${root}/${SIDECAR_RELATIVE_PATH}`;
}

/** The parent directory of the sidecar file (e.g. `<root>/.pi`). */
export function sidecarDir(root: string): string {
  return `${root}/.pi`;
}

/** The sidecar's write plan, surfaced in `Plan.sidecar` for the operator. */
export interface SidecarPlan {
  /** The sidecar's absolute path (for the operator / test assertions). */
  path: string;
  /** The current sidecar bytes ("" when absent). */
  oldBytes: string;
  /** The exact bytes that WOULD be written (== oldBytes for a no-op). */
  newBytes: string;
  /** True when newBytes !== oldBytes. */
  wouldWrite: boolean;
}

/**
 * Read and parse the sidecar at `path`, or `null` when it is absent.
 *
 * Throws `MarkerError` when the sidecar exists but is not valid JSON or has
 * a malformed row shape — the caller (checkAgent / updateAgent) maps that to
 * a defined refusal state (exit 2), never silently re-deriving or dropping
 * an operator's `asked` row.
 */
export function readSidecar(
  path: string,
  read: (p: string) => string,
  stat: (p: string) => boolean,
): LedgerRow[] | null {
  if (!stat(path)) return null;
  const raw = read(path);
  // A malformed sidecar throws; the caller catches and refuses.
  return parseLedger(raw);
}

/**
 * Read the sidecar, returning `null` for the absent case AND for the corrupt
 * case — the caller must distinguish them by also checking `stat` first
 * (see checkAgent). Kept simple: `null` is "no usable rows", and the
 * caller's `stat`-first flow is what maps corrupt → refuse.
 */
export function readSidecarSafe(
  path: string,
  read: (p: string) => string,
  stat: (p: string) => boolean,
): { rows: LedgerRow[] | null; corrupt: boolean } {
  if (!stat(path)) return { rows: null, corrupt: false };
  try {
    return { rows: parseLedger(read(path)), corrupt: false };
  } catch (e) {
    if (e instanceof MarkerError) return { rows: null, corrupt: true };
    throw e;
  }
}
