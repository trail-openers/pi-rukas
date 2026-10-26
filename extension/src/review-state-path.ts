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
 *   pi-rukas artefact (transcripts, models config) uses. `agentDir()` and
 *   `STATE_LEAF` are exported: the accept guard builds its spellings from them
 *   rather than repeating the literals, so the two cannot disagree.
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
 *     cannot answer, a state dir that will not hold 0700) falls back to the OLD
 *     location, the ledger's own directory, and returns a path rather than
 *     throwing. A relocated store that cannot be relocated is still a working
 *     store. Every such fallback goes out through `traceWarn`, not the
 *     debug-gated trace: an operator who does not set `PI_ENSEMBLE_DEBUG` still
 *     sees that the store did not move.
 *   - The token is NEVER invented. A token file that stays unreadable or
 *     malformed after one retry falls back beside the ledger rather than minting
 *     a private token, because a minted-but-unwritten token would put this
 *     process's rows in a directory no later process can find: the memory would
 *     be lost silently, one round at a time.
 *   - The override `PI_ENSEMBLE_REVIEW_LEDGER_FILE` keeps its old meaning: the
 *     findings file stays in the override's directory. That variable is what
 *     every offline smoke test isolates on, and a redirect the tests set is a
 *     redirect they own.
 *
 * Permissions are part of the design, not hygiene: directories 0700, files 0600,
 * so the store is readable by its owner's tools and by nobody else's. A state
 * dir that cannot be made 0700 is not a state dir — the store stays beside the
 * ledger instead.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_OVERRIDE_ENV, cloneLedgerPathFor } from "./review-ledger-path.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { trace, traceWarn } from "./trace.ts";

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

/** The directory under the agent dir holding every clone's state. Exported so
 * the accept guard derives its spellings from here, not from its own literal. */
export const STATE_LEAF = "review-state";

/** Marker written once per clone after the old beside-the-ledger file was moved. */
const MIGRATED_MARKER = "MIGRATED";

/** Length of the derived per-clone key. Long enough to be unambiguous in a
 * listing, short enough to read. */
const REPO_KEY_HEX = 16;

/** The token's exact shape: 16 random bytes as lowercase hex. NOT a range — a
 * 16-char truncation of a partial write is a directory nobody can find again,
 * so a short token is as un-minted as an empty one. */
const TOKEN_RE = /^[0-9a-f]{32}$/;

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

/** Process cache keyed on the realpath of the clone's common dir. It carries the
 * clone's STATE ROOT alongside the location, so a cache hit can hand the creating
 * path the root its token lives in rather than making it derive one from the
 * token directory — the two are `dirname`/`dirname` apart and only `computeLocation`
 * knows which one was hashed.
 *
 * Only the NON-override branch ever writes or reads it: `PI_ENSEMBLE_REVIEW_LEDGER_FILE`
 * is an explicit location that must answer identically however often it is asked,
 * and keying an entry on the clone's common dir while answering from the override
 * would let one fixture's answer serve the next one that flips the variable.
 * That is the whole offline suite's isolation mechanism, so the cache is simply
 * out of the picture whenever an override is set. */
const resolved = new Map<string, { loc: FindingsLocation; root: string }>();

/** Clones whose one-time migration this process has already attempted. */
const attempted = new Set<string>();

/** The agent dir: Pi's own root, the same one transcripts and models config use.
 * Exported so the accept guard builds its root spellings from the one definition
 * that decides where the store actually lives. */
export function agentDir(): string {
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

/** `<agentDir>/review-state/<key>` — the clone's state root, token not yet known.
 *
 * `commonDirReal` is already the realpath the caller resolved (the cache key in
 * `findingsStateDir`, and the shared-dir answer in `guessCommonDir`): the hash is
 * taken over THAT value, so the two paths that derive a root — the creating
 * resolver and the read-only lookup — cannot key on different strings and answer
 * about two different stores for one clone.
 */
function stateRootFor(commonDirReal: string): string {
  const key = createHash("sha256").update(commonDirReal).digest("hex").slice(0, REPO_KEY_HEX);
  return path.join(agentDir(), STATE_LEAF, key);
}

/** Read a minted token, or undefined when the file holds nothing usable. A
 * token read out of a truncated write would name a directory nobody can find
 * again, so a malformed token counts as un-minted. */
function readToken(tokenFile: string): string | undefined {
  try {
    const text = readFileSync(tokenFile, "utf8").trim();
    return TOKEN_RE.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The clone's random token, or undefined when it cannot be read. `open(..., "wx")`
 * IS the race guard: the winner creates and writes, the loser gets EEXIST, and
 * both read the same bytes — so two processes resolving the store at the same
 * instant cannot produce two stores for one clone.
 *
 * A token is never returned unless it is ON DISK. One retry covers the race in
 * which this process read the file while the winner's write was still landing;
 * anything that still fails returns undefined, and the caller falls back beside
 * the ledger. Minting a token this process keeps to itself would write rows into
 * a directory no later resolve can name — memory gone without a word.
 */
function tokenFor(root: string): string | undefined {
  const tokenFile = path.join(root, "token");
  const first = readToken(tokenFile);
  if (first) return first;
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
  // One NAMED retry, not a chain of reads that looks like two rules. The first
  // read can land while the winning process is still writing its bytes, and a
  // re-read is the only way to tell that apart from a token that is genuinely
  // unreadable or malformed. Exactly one more attempt is made: an unreadable
  // token file stays unreadable, and the caller falls back beside the ledger
  // rather than minting a private token whose directory nobody can find again.
  const raced = readToken(tokenFile);
  if (raced) return raced;
  return undefined;
}

/**
 * The state directory, created at 0700. The explicit chmod is what makes 0700 a
 * fact rather than an intent: `mkdirSync`'s `mode` is masked by umask, and a
 * recursive create applies the mode to the leaf inconsistently across platforms.
 *
 * When the chmod fails the mode is READ BACK: on a mount that ignores ownership
 * bits the mode is whatever the filesystem says, and if it is not 0700 the
 * directory is not private, so it is not a state dir and the caller falls back.
 */
function makeStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
    return;
  } catch (err) {
    trace(`review-state: chmod 0700 on ${dir} failed (${(err as Error).message})`);
  }
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    throw new Error(`${dir} is not 0700 after a failed chmod`);
  }
}

/**
 * One-time relocation of a clone's existing findings file out of the git common
 * dir. Copy BEFORE delete, always: a migration that loses memory is worse than
 * one that leaves a stale copy behind.
 *
 * The marker is written LAST and the old file unlinked BEFORE it, so every
 * interrupted state converges:
 *   - old absent, no live, no marker → nothing to move; marker written anyway;
 *   - old absent, live present, no marker → a copy that landed before the
 *     process died: the rows are already where they belong, so only the marker
 *     is missing and only the marker is written;
 *   - old and live present with IDENTICAL bytes → the copy landed, the unlink
 *     did not: unlink the old, then the marker. Nothing is lost and nothing is
 *     set aside — the bytes are already the live ones;
 *   - old and live present with DIFFERENT bytes → the live store was written
 *     after the move started, so the old bytes go aside at `.pre-migration`
 *     (never overwritten) and the old file is unlinked;
 *   - marker present → this clone has been dealt with once; nothing runs again.
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
  const live = path.join(dir, FINDINGS_FILE);
  try {
    if (existsSync(marker)) return;
    if (!existsSync(oldFile)) {
      // An interrupted migration that had already moved the bytes, or a clone
      // with nothing to move: either way the only thing missing is the marker.
      writeFileSync(marker, "migrated\n", { mode: 0o600 });
      return;
    }
    const bytes = readFileSync(oldFile);
    if (existsSync(live)) {
      if (readFileSync(live).equals(bytes)) {
        // The copy landed and the unlink did not. Same bytes, so the unlink is
        // safe and the marker follows it — the order the crash interrupted.
        unlinkSync(oldFile);
        writeFileSync(marker, "migrated\n", { mode: 0o600 });
        trace(`review-state: ${oldFile} matched the live store and was removed`);
        return;
      }
      // Both exist with different rows: never overwrite what a round has
      // already recorded. The old bytes are kept where an operator can find them.
      const aside = `${live}.pre-migration`;
      if (!existsSync(aside)) writeFileSync(aside, bytes, { mode: 0o600 });
      unlinkSync(oldFile);
      writeFileSync(marker, "both\n", { mode: 0o600 });
      trace(`review-state: ${oldFile} was set aside as ${aside} — the state dir already had rows`);
      return;
    }
    writeFileSync(live, bytes, { mode: 0o600 });
    unlinkSync(oldFile);
    writeFileSync(marker, "migrated\n", { mode: 0o600 });
    trace(`review-state: moved the findings store from ${oldFile} to ${live}`);
  } catch (err) {
    // A migration that cannot complete leaves the OLD file exactly where it was.
    // The resolver still answers with the new path, so the round starts from an
    // empty store rather than losing data — and the operator sees it, because
    // the reason the memory did not come along is not a debug-level detail.
    traceWarn(
      `review-state: migration from ${oldFile} did not complete (${(err as Error).message}) — the store at ${live} starts without the rows that were under the git dir`,
    );
  }
}

/** The answer for a clone whose store could not be relocated: the old place.
 * The `traceWarn` is the operator's only signal that the store did NOT move, so
 * it is a SIDE EFFECT: `computeLocation` builds this location without warning
 * (a read of a clone that simply has no store yet is not a fault worth a warn),
 * and the creating path calls this — or `warnBesideLedger` — whenever it returns
 * a fallback. Every reason an operator sees in the log therefore names a resolve
 * that actually tried to create the store. */
function besideLedger(ledger: string, why: string): FindingsLocation {
  traceWarn(
    `review-state: the findings store stays beside the ledger at ${ledgerDir(ledger)} — ${why}`,
  );
  return fallbackBesideLedger(ledger);
}

/** The beside-the-ledger location, WITHOUT the warn. A path under the ledger's own
 * directory and the store's one basename — the same spelling `besideLedger`
 * returns, so the read-only and creating arms cannot disagree about it. */
function fallbackBesideLedger(ledger: string): FindingsLocation {
  const dir = ledgerDir(ledger);
  return { dir, file: path.join(dir, FINDINGS_FILE), ledger, fellBack: true };
}

/** Warn about a fallback location `computeLocation` already decided, with the
 * reason only the creating path knows (it is the path that failed to create). */
function warnBesideLedger(ledger: string, why: string): FindingsLocation {
  traceWarn(
    `review-state: the findings store stays beside the ledger at ${ledgerDir(ledger)} — ${why}`,
  );
  return fallbackBesideLedger(ledger);
}

function ledgerDir(ledger: string): string {
  return path.dirname(ledger);
}

/**
 * Resolve the findings store for `cwd`: the directory, the file, and the ledger
 * that guards it. Returns undefined only when there is no git common dir at all
 * (not a clone) — which every caller already treats as "no store".
 *
 * Never throws: every fault on the way to the relocated store falls back to the
 * ledger's own directory, warned, and returns a path. A store that cannot move
 * is still a store.
 *
 * `readOnly` (#1832 round 2) answers the SAME question as the creating path —
 * the location is computed by ONE function, `computeLocation`, which both arms
 * call, so the probe and the record path cannot name two stores for one clone.
 * Not the override, not the common-dir lookup, not the key, not the token, and
 * not the corrupt-token fallback: where the creating path would fall back beside
 * the ledger, the read-only arm names that SAME beside-the-ledger file (with no
 * `.corrupt-*` copy, no `mkdir`, no `chmod`, no token minting and nothing
 * cached — a read-only resolve must not seed the cache with an answer that
 * predates the first real resolve). A read-only resolve therefore never creates
 * anything, and `exists` says whether a store already sits at that location.
 */
export async function findingsStateDir(
  execFn: LedgerExecFn,
  cwd: string,
  opts: { readOnly?: boolean } = {},
): Promise<FindingsLocation | undefined> {
  const computed = await computeLocation(execFn, cwd);
  if (!computed) return undefined;
  if (opts.readOnly === true) return computed.loc;

  const { loc, commonDir, root, key } = computed;
  const override = process.env[LEDGER_OVERRIDE_ENV]?.trim();

  // An explicit override IS the location: nothing is created, no token is minted
  // and no migration runs, in either arm. That is not an optimisation — the
  // override is how every offline fixture isolates its store, and a fixture that
  // pinned the ledger to a temp file must not have a state root, a token or a
  // `MIGRATED` marker appear under the real agent dir as a side effect of running
  // the suite. `computeLocation` already resolved the spelling; both arms return it.
  if (override) return loc;

  // From here the caller intends to WRITE, which is where every side effect of
  // the location belongs: the directories, the token, the one-time migration and
  // the process cache. The location itself was decided by `computeLocation`, so
  // the steps below can only make it real — they cannot change which file both
  // arms name.
  //
  // `loc.fellBack` from a READ is not an answer for a WRITE. `computeLocation`
  // reads the token and never mints one (minting on a read path would strand rows
  // in a directory no later process can find), so a clone whose token has simply
  // never been minted reads as "no token → fallback". The creating path must
  // still mint — which is what `tokenFor`'s `wx` protocol exists to do race-safely
  // — and only a token that stays unreadable or malformed after that mint is the
  // real fallback. Short-circuiting on the read's answer instead made every fresh
  // clone's store silently stay beside the ledger, because the first resolve of a
  // clone is usually a probe.
  try {
    makeStateDir(root);
    const token = tokenFor(root);
    // No usable token even after the mint: no reachable directory, and a token
    // kept in this process's memory would strand every row it writes. This is the
    // same fallback `computeLocation` builds for the read-only arm — the same
    // helper, so the file both arms name is one spelling.
    if (!token) return warnBesideLedger(loc.ledger, "the token file is unreadable or malformed");
    const dir = path.join(root, token);
    makeStateDir(dir);
    const created: FindingsLocation = {
      dir,
      file: path.join(dir, FINDINGS_FILE),
      ledger: loc.ledger,
      fellBack: false,
    };
    migrateOnce(commonDir, dir);
    // The override arm returns before this point, so the cache only ever holds
    // relocated stores — never an answer derived from `PI_ENSEMBLE_REVIEW_LEDGER_FILE`.
    if (!override) resolved.set(key, { loc: created, root });
    return created;
  } catch (err) {
    return besideLedger(
      loc.ledger,
      `the state dir could not be created: ${(err as Error).message}`,
    );
  }
}

/** What `computeLocation` answers: the location, the clone's git COMMON dir,
 * the clone's state root, and whether a findings file already sits at `loc.file`. */
interface ComputedLocation {
  loc: FindingsLocation;
  commonDir: string;
  root: string;
  /** The cache key: realpath of the common dir, or its resolved path. */
  key: string;
  exists: boolean;
}

/**
 * THE location computation for the findings store (#1832 round 2): override
 * precedence, the ledger's common dir, the repo-key hash, the token read, and
 * the beside-the-ledger fallback when the token is unreadable or malformed. It
 * has NO side effects — no `mkdir`, no `chmod`, no token minting, no migration,
 * no cache write — and it never throws for a fault on the way to the relocated
 * store: any such fault answers with the fallback location, exactly as the
 * creating path does.
 *
 * The creating path (`findingsStateDir` without `readOnly`) calls THIS and then
 * does its mkdir/chmod/mint/migrate/cache work around the answer it gave; the
 * read-only path returns the answer verbatim. That is the whole reason the
 * function is one and not two: a probe with its own copy of these rules drifts,
 * and drift shows up as the probe vetoing on a store the round cannot see (or
 * the reverse). `test-review-state-path.ts` pins the two answers file-for-file
 * across the plain clone, an override, a linked worktree and a corrupt token.
 *
 * Answers undefined only for "there is no clone to locate": no ledger at all, or
 * no git common dir and no location to fall back on.
 *
 * `besideLedger`'s fallback location is built here WITHOUT its `traceWarn`: a
 * clone whose store was simply never created is not a fault, and a read path that
 * warned on every resolve would bury the warns the creating path exists to emit.
 * The creating arm warns for the same shape (see `warnBesideLedger`), because
 * there the fallback IS a failure to create.
 */
async function computeLocation(
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
  // The cache is consulted on the NON-override path only (see `resolved`), and
  // HERE rather than in the creating arm: a clone this process already resolved
  // answers from the cached entry without a token read, a `mkdir`, or a `wx`
  // mint. Dropped, that cache hit would fall through to the creating path's token
  // minting and hand back a brand-new private directory — a second store for a
  // clone that already has one.
  const key = realOrUndefined(commonDir) ?? path.resolve(commonDir);
  const cached = resolved.get(key);
  if (cached)
    return {
      loc: cached.loc,
      commonDir,
      root: cached.root,
      key,
      exists: existsSync(cached.loc.file),
    };

  if (!existsSync(commonDir)) {
    // Nothing to key on and no ledger directory to sit beside: the clone's git
    // dir is gone, so there is no location either arm could defend. The creating
    // path used to answer a fallback path under a directory that does not exist.
    return undefined;
  }
  const root = stateRootFor(key);
  // A malformed or unreadable token is NOT a private mint: `tokenFor`'s `wx`
  // protocol is what makes two racing processes agree, and minting here would
  // name a directory no later process can find. Both arms therefore take the
  // same fallback — this one reads, the creating path also warns.
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

/**
 * The findings store's location for `cwd`, computed the SAME way the creating
 * path computes it (#1832 round 2) and with no side effects at all: no `mkdir`,
 * no `chmod`, no token minting, no migration, and nothing cached. `exists`
 * distinguishes "there is no store here yet" from "a file sits here that this
 * process has not read" — the distinction the open-CRITICAL probe needs, because
 * a store that was never created holds no rows and therefore no CRITICAL, while
 * a file that cannot be read might. It is derived from the location `computeLocation`
 * produced, never recomputed, so it can never describe a different file.
 */
export async function findingsStoreLocation(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<(FindingsLocation & { exists: boolean }) | undefined> {
  const computed = await computeLocation(execFn, cwd);
  if (!computed) return undefined;
  return { ...computed.loc, exists: computed.exists };
}

/**
 * Clear the process caches. A test that moves `PI_AGENT_DIR` between fixtures
 * must not inherit the previous fixture's answer; production never calls this.
 */
export function resetFindingsStateCache(): void {
  resolved.clear();
  attempted.clear();
}
