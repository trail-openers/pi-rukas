/**
 * review-state-path — where the review FINDINGS store lives (#1764 phase 1).
 *
 * The findings file used to sit beside the review ledger, under the git common
 * dir, and the #1105 accept guard had to recognise every shell shape that could
 * name it. Measured on fieldbox, 2026-10-21/22, that guard refused ~6,400
 * ordinary agent commands across 421 of 576 children: a `grep` whose pattern
 * held a `$`, a heredoc with a quoted tag. Narrowing the string match was
 * attempted in #1767 and five review rounds each found a new under-refusal.
 *
 * The fix taken instead is to move the data out of bash's reach: the store now
 * lives under the agent dir, in a per-clone directory keyed on a random token
 * that is not derived from anything an agent is told. The guard's remaining job
 * — phase 2 — is to stop an agent learning the location, which is a far smaller
 * surface than modelling shell semantics.
 *
 * What STAYS where it is: the review ledger and its lock. This module resolves
 * the findings store only, and deliberately does not touch `ledgerPathFor` /
 * `cloneLedgerPathFor` (review-ledger-path.ts) — the #912 merge guard reads the
 * ledger from under the git common dir exactly as before.
 *
 * Layout, per clone:
 *
 *     <agentDir>/review-state/<repo-key>/<token>/review-findings.json
 *
 * - `<agentDir>` is `$PI_AGENT_DIR` or `~/.pi/agent`, the same root every other
 *   pi-rukas artefact (transcripts, models config) uses.
 * - `<repo-key>` is the first 16 hex chars of sha256 over the realpath of the
 *   clone's git COMMON dir, so the main checkout and every linked worktree of
 *   one clone share one store — the property the old beside-the-ledger layout
 *   had, and the one `cloneGitDir`'s `worktrees/` fold exists to provide.
 * - `<token>` is 32 hex chars minted once per clone with `open("wx")`. Two
 *   processes racing to mint it both get the same answer: the loser gets EEXIST
 *   and re-reads what the winner wrote. A path segment nobody can derive is
 *   what makes the directory unreachable by guessing.
 *
 * Failure policy — the store's location must never be a decision an agent's
 * review depends on:
 *   - Anything that cannot be created (an unwritable agent dir, a git that
 *     cannot answer) falls back to the OLD location, the ledger's own directory,
 *     traced, and returns a path rather than throwing. A relocated store that
 *     cannot be relocated is still a working store.
 *   - The override `PI_ENSEMBLE_REVIEW_LEDGER_FILE` keeps its old meaning: the
 *     findings file stays in the override's directory. That variable is what
 *     every offline smoke test isolates on, and a redirect the tests set is a
 *     redirect they own.
 *
 * Permissions are part of the design, not hygiene: directories 0700, files 0600,
 * so the store is readable by its owner's tools and by nobody else's.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_OVERRIDE_ENV, cloneLedgerPathFor } from "./review-ledger-path.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { trace } from "./trace.ts";

/**
 * The findings file's basename — inside the state dir from #1764 on, and the
 * name its `.tmp` / `.corrupt-*` / `.pre-migration` siblings are built from.
 * The name is deliberately UNCHANGED by the relocation: a redirect of
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` still puts the store beside the override
 * under the one name every offline fixture builds its paths from.
 *
 * It is also the name the one-time migration looks for under the git common dir,
 * which is where it lived before #1764.
 */
export const FINDINGS_FILE = "review-findings.json";

/** The directory under the agent dir holding every clone's state. */
const STATE_ROOT = "review-state";

/** Marker written once per clone after the old beside-the-ledger file was moved. */
const MIGRATED_MARKER = "MIGRATED";

/** Length of the derived per-clone key. Long enough to be unambiguous in a
 * listing, short enough to read. */
const REPO_KEY_HEX = 16;

/** One resolved store: the directory, the file inside it, and where the ledger
 * that guards it lives (unchanged, under the git common dir). */
export interface FindingsLocation {
  /** The store's directory — `<agentDir>/review-state/<key>/<token>`. */
  dir: string;
  /** The findings file inside `dir`. */
  file: string;
  /** The ledger that guards writes to it (still under the git common dir). */
  ledger: string;
  /** True when the store could NOT be relocated and lives beside the ledger. */
  fellBack: boolean;
}

/** Process cache keyed on the realpath of the clone's common dir. */
const resolved = new Map<string, FindingsLocation>();

/** Clones whose one-time migration this process has already attempted. */
const attempted = new Set<string>();

/** The agent dir: Pi's own root, the same one transcripts and models config use. */
function agentDir(): string {
  return process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** The realpath of `p`, or undefined when it cannot be resolved. The KEY is
 * taken from the realpath so a clone reached through a symlink and the same
 * clone reached directly are one store, not two. */
function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** `<agentDir>/review-state/<key>` — the clone's state root, token not yet known. */
function stateRootFor(commonDirReal: string): string {
  const key = createHash("sha256").update(commonDirReal).digest("hex").slice(0, REPO_KEY_HEX);
  return path.join(agentDir(), STATE_ROOT, key);
}

/** Read a minted token, or undefined when the file holds nothing usable. A
 * token read out of a truncated write would name a directory nobody can find
 * again, so a malformed token counts as un-minted. */
function readToken(tokenFile: string): string | undefined {
  try {
    const text = readFileSync(tokenFile, "utf8").trim();
    return /^[0-9a-f]{16,64}$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The clone's random token, minted once. `open(..., "wx")` IS the race guard:
 * the winner creates and writes, the loser gets EEXIST, and both read the same
 * bytes — so two processes resolving the store at the same instant cannot
 * produce two stores for one clone.
 */
function tokenFor(root: string): string {
  const tokenFile = path.join(root, "token");
  const existing = readToken(tokenFile);
  if (existing) return existing;
  const minted = randomBytes(16).toString("hex");
  try {
    // "wx": fail if the file already exists. That is the whole race protocol —
    // the winner writes, the loser gets EEXIST, and both end up reading the
    // same bytes from `readToken` below.
    const fd = openSync(tokenFile, "wx", 0o600);
    try {
      writeFileSync(fd, `${minted}\n`, "utf8");
    } finally {
      // `writeFileSync` on a descriptor does not close it, and a long-lived Pi
      // process would leak one per clone whose mint raced.
      try {
        closeSync(fd);
      } catch {
        /* the token is on disk; nothing else matters */
      }
    }
  } catch {
    /* EEXIST means somebody else minted it; anything else falls through to the read */
  }
  return readToken(tokenFile) ?? minted;
}

/**
 * The state directory, created at 0700. The explicit chmod is what makes 0700 a
 * fact rather than an intent: `mkdirSync`'s `mode` is masked by umask, and a
 * recursive create applies the mode to the leaf inconsistently across platforms.
 */
function makeStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a read-only mount surfaces as the write failing, which is handled there */
  }
}

/**
 * One-time relocation of a clone's existing findings file out of the git common
 * dir. Copy BEFORE delete, always: a migration that loses memory is worse than
 * one that leaves a stale copy behind.
 *
 * Three shapes, each traced:
 *   - nothing at the old location → mark migrated, do nothing else;
 *   - old file, nothing at the new → copy (0600), mark, then unlink the old;
 *   - both present → the new one is the live store (a round wrote it after the
 *     move started), so the old bytes are set aside beside it with a
 *     `.pre-migration` suffix and unlinked from the git dir.
 *
 * The `MIGRATED` marker makes this once-per-clone rather than once-per-resolve;
 * this module additionally remembers the clone for the life of the process so
 * the steady state pays one `existsSync` per store, not per round.
 */
function migrateOnce(commonDir: string, dir: string): void {
  if (attempted.has(commonDir)) return;
  attempted.add(commonDir);
  const oldFile = path.join(commonDir, FINDINGS_FILE);
  const marker = path.join(dir, MIGRATED_MARKER);
  try {
    if (!existsSync(oldFile) || existsSync(marker)) return;
    const live = path.join(dir, FINDINGS_FILE);
    const bytes = readFileSync(oldFile);
    if (existsSync(live)) {
      // Both exist: never overwrite rows a round has already recorded. The old
      // bytes are kept where an operator can still find them.
      const aside = `${live}.pre-migration`;
      if (!existsSync(aside)) writeFileSync(aside, bytes, { mode: 0o600 });
      unlinkSync(oldFile);
      writeFileSync(marker, "both\n", { mode: 0o600 });
      trace(`review-state: ${oldFile} was set aside as ${aside} — the state dir already had rows`);
      return;
    }
    writeFileSync(live, bytes, { mode: 0o600 });
    writeFileSync(marker, "migrated\n", { mode: 0o600 });
    unlinkSync(oldFile);
    trace(`review-state: moved the findings store from ${oldFile} to ${live}`);
  } catch (err) {
    // A migration that cannot complete leaves the OLD file exactly where it was.
    // The resolver still answers with the new path, so the round starts from an
    // empty store rather than losing data, and the trace says why.
    trace(`review-state: migration from ${oldFile} did not complete: ${(err as Error).message}`);
  }
}

/** The answer for a clone whose store could not be relocated: the old place. */
function besideLedger(ledger: string): FindingsLocation {
  const dir = path.dirname(ledger);
  return { dir, file: path.join(dir, FINDINGS_FILE), ledger, fellBack: true };
}

/**
 * Resolve the findings store for `cwd`: the directory, the file, and the ledger
 * that guards it. Returns undefined only when there is no git common dir at all
 * (not a clone) — which every caller already treats as "no store".
 *
 * Never throws: every fault on the way to the relocated store falls back to the
 * ledger's own directory, traced. A store that cannot move is still a store.
 */
export async function findingsStateDir(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<FindingsLocation | undefined> {
  const ledger = await cloneLedgerPathFor(execFn, cwd);
  if (!ledger) return undefined;

  // The override keeps the store where the operator (or the whole offline suite)
  // pointed the ledger: it is an explicit location, and a test that isolates its
  // ledger by redirecting it must not have its findings land in the real agent
  // dir. Resolved the same tolerant way `ledgerPathFor` resolves it, so a
  // relative override cannot put the findings file somewhere the ledger is not.
  const override = process.env[LEDGER_OVERRIDE_ENV]?.trim();
  if (override) {
    const file = path.isAbsolute(override) ? override : path.resolve(cwd, override);
    const dir = path.dirname(file);
    return { dir, file: path.join(dir, FINDINGS_FILE), ledger, fellBack: false };
  }

  const commonDir = path.dirname(ledger);
  const key = realOrUndefined(commonDir) ?? path.resolve(commonDir);
  const cached = resolved.get(key);
  if (cached) return cached;

  try {
    if (!existsSync(commonDir)) return besideLedger(ledger);
    const root = stateRootFor(key);
    makeStateDir(root);
    const dir = path.join(root, tokenFor(root));
    makeStateDir(dir);
    const loc: FindingsLocation = {
      dir,
      file: path.join(dir, FINDINGS_FILE),
      ledger,
      fellBack: false,
    };
    migrateOnce(commonDir, dir);
    resolved.set(key, loc);
    return loc;
  } catch (err) {
    trace(
      `review-state: cannot create the state dir for ${key} (${(err as Error).message}) — the findings store stays beside the ledger`,
    );
    return besideLedger(ledger);
  }
}

/**
 * Clear the process caches. A test that moves `PI_AGENT_DIR` between fixtures
 * must not inherit the previous fixture's answer; production never calls this.
 */
export function resetFindingsStateCache(): void {
  resolved.clear();
  attempted.clear();
}
