/**
 * review-store-locator — THE computation of where the review findings store
 * lives (#1832 round 2), split out of review-state-path.ts (AGENTS.md §12
 * file-size gate; that module keeps every side effect).
 *
 * Why this is ONE function with two callers rather than a read path and a write
 * path that each spell the rules out: the open-CRITICAL probe
 * (review-findings-critical-probe.ts) and the round's own record path
 * (review-findings-store.ts) must agree on the file, on the override, on the
 * common-dir key and on the corrupt-token fallback. Two copies of those rules
 * drift, and drift shows up as the probe vetoing a delta on a store the round
 * cannot see — or, worse, the round recording rows somewhere the probe will never
 * look, which is memory lost one round at a time. `test-review-state-path-locator.ts`
 * pins the two answers file-for-file across the plain clone, an override, a
 * linked worktree and a corrupt token.
 *
 * Everything here is SIDE-EFFECT-FREE: no `mkdir`, no `chmod`, no token minting,
 * no migration, no cache write, and no `traceWarn`. A read of a clone whose store
 * was simply never created is not a fault, and a probe that warned on every
 * resolve would bury the warns the creating path exists to emit — those live with
 * the writes, in `review-state-path.ts`.
 *
 * The location itself is documented in review-state-path.ts's header (layout,
 * key derivation, token minting, failure policy); this module is the read-only
 * half of that contract. `agentDir()` is DEFINED here and re-exported from
 * review-state-path.ts (which owns the writes), so the root has one definition.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_OVERRIDE_ENV, cloneLedgerPathFor } from "./review-ledger-path.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { FINDINGS_FILE, STATE_LEAF } from "./review-state-names.ts";
import type { FindingsLocation } from "./review-state-types.ts";

/** Length of the derived per-clone key. Long enough to be unambiguous in a
 * listing, short enough to read. */
const REPO_KEY_HEX = 16;

/** The token's exact shape: 16 random bytes as lowercase hex. NOT a range — a
 * 16-char truncation of a partial write is a directory nobody can find again,
 * so a short token is as un-minted as an empty one. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

/** What the locator answers about one clone. */
export interface ComputedLocation {
  loc: FindingsLocation;
  /** The clone's git COMMON dir (the ledger's directory). */
  commonDir: string;
  /** `<agentDir>/review-state/<key>` — the clone's state root, token not yet known. */
  root: string;
  /** The cache key: realpath of the common dir, or its resolved path. */
  key: string;
  /** True when a findings file already sits at `loc.file`. Derived from the
   * location computed here, never recomputed, so it cannot describe a different
   * file: this is how the probe tells "no store yet" from "a file that will not
   * parse" without a second lookup that could disagree with the first. */
  exists: boolean;
}

/** The agent dir: Pi's own root, the same one transcripts and models config use.
 * DEFINED here (this is where the store's root is decided) and re-exported by
 * review-state-path.ts, so the accept guard and every caller of that module build
 * their root spellings from the one definition rather than a second literal. */
export function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** The realpath of `p`, or undefined when it cannot be resolved. The KEY is
 * taken from the realpath so a clone reached through a symlink and the same
 * clone reached directly are one store, not two. */
export function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** `<agentDir>/review-state/<key>` — the clone's state root, token not yet known.
 *
 * `commonDirReal` is already the realpath the caller resolved (the cache key and
 * the shared-dir answer): the hash is taken over THAT value, so the two paths
 * that derive a root — the creating resolver and the read-only lookup — cannot
 * key on different strings and answer about two different stores for one clone.
 */
export function stateRootFor(commonDirReal: string): string {
  const key = createHash("sha256").update(commonDirReal).digest("hex").slice(0, REPO_KEY_HEX);
  return path.join(agentDir(), STATE_LEAF, key);
}

/** Read a minted token, or undefined when the file holds nothing usable. A
 * token read out of a truncated write would name a directory nobody can find
 * again, so a malformed token counts as un-minted. */
export function readToken(tokenFile: string): string | undefined {
  try {
    const text = readFileSync(tokenFile, "utf8").trim();
    return TOKEN_RE.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The beside-the-ledger location, WITHOUT the warn. A path under the ledger's
 * own directory and the store's one basename — the same spelling the creating
 * path's warned fallback returns, so the read-only and creating arms cannot
 * disagree about it. */
export function fallbackBesideLedger(ledger: string): FindingsLocation {
  const dir = path.dirname(ledger);
  return { dir, file: path.join(dir, FINDINGS_FILE), ledger, fellBack: true };
}

/**
 * THE location computation for the findings store: override precedence, the
 * ledger's common dir, the repo-key hash, the token read, and the
 * beside-the-ledger fallback when the token is unreadable or malformed.
 *
 * Both arms of the location call this — the read-only locator returns its
 * `loc` verbatim, the creating path runs its mkdir/chmod/mint/migrate/cache work
 * AROUND the same answer — so no step is copied and the two can name only one
 * file. `process.env` is read here, which is precisely the property the store's
 * `locate()` relies on: a resolve takes the answer as an argument and never
 * caches an override, so changing `PI_ENSEMBLE_REVIEW_LEDGER_FILE` between two
 * rounds cannot leave a later round reading the first round's file.
 *
 * The CREATING path reads its own process cache BEFORE any of the writes below
 * run (review-state-path.ts), so a clone this process already set up answers from
 * memory and never re-reads or re-mints the token. This function is not consulted
 * on that hit and does not own the cache.
 *
 * Answers undefined only for "there is no clone to locate": no ledger at all
 * (not a git clone), or a clone whose git common dir does not exist — there is
 * then no key to hash and no ledger directory to sit beside, so any path either
 * arm returned would live under a directory that is not there.
 */
export async function computeLocation(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<ComputedLocation | undefined> {
  // The override is read BEFORE the ledger is resolved, because the two ledger
  // resolvers read it differently: `ledgerPathFor` returns an override verbatim
  // and makes no git call, while `cloneLedgerPathFor` ignores it and resolves the
  // real common dir. The findings store's historic location is the override's own
  // directory — that is what the whole offline suite isolates on — so this arm
  // decides from the override itself and keeps `cloneLedgerPathFor`'s answer only
  // as the ledger field (unchanged: the store is still guarded by the clone's own
  // ledger). Reversing this order would move every isolated fixture's store into
  // the real agent dir.
  const override = process.env[LEDGER_OVERRIDE_ENV]?.trim();
  const ledger = await cloneLedgerPathFor(execFn, cwd);
  if (!ledger) return undefined;

  if (override) {
    // Resolved the same tolerant way `ledgerPathFor` resolves it, so a relative
    // override cannot put the findings file somewhere the ledger is not.
    const file = path.isAbsolute(override) ? override : path.resolve(cwd, override);
    const dir = path.dirname(file);
    const loc = { dir, file: path.join(dir, FINDINGS_FILE), ledger, fellBack: false };
    return {
      loc,
      commonDir: path.dirname(ledger),
      root: dir,
      key: path.dirname(ledger),
      exists: existsSync(loc.file),
    };
  }

  const commonDir = path.dirname(ledger);
  if (!existsSync(commonDir)) return undefined;
  const key = realOrUndefined(commonDir) ?? path.resolve(commonDir);
  const root = stateRootFor(key);
  // A malformed or unreadable token is NOT a private mint: `tokenFor`'s `wx`
  // protocol is what makes two racing processes agree, and minting on a read path
  // would name a directory no later process can find. The creating arm mints and
  // only then falls back, with the warn that shape deserves.
  const token = readToken(path.join(root, "token"));
  const loc: FindingsLocation = token
    ? {
        dir: path.join(root, token),
        file: path.join(root, token, FINDINGS_FILE),
        ledger,
        fellBack: false,
      }
    : fallbackBesideLedger(ledger);
  return { loc, commonDir, root, key, exists: existsSync(loc.file) };
}
