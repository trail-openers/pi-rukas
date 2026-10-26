/**
 * review-state-path — the WRITE half of the review findings store's location
 * (#1764 phase 1), and the module every caller resolves through.
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
 * The pure location computation — override precedence, the common-dir lookup, the
 * key, the token read and the fallback spelling — is ONE function in
 * review-store-locator.ts that BOTH arms of `findingsStateDir` call (#1832
 * round 2). This module is the half that has side effects: the `mkdir`s, the
 * chmods, the token mint, the one-time migration, the process cache, and the
 * `traceWarn`s those steps earn.
 *
 * Failure policy — the store's location must never be a decision an agent's
 * review depends on:
 *   - Anything that cannot be created (an unwritable agent dir, a git that
 *     cannot answer, a state dir that will not hold 0700) falls back to the OLD
 *     location, the ledger's own directory, and returns a path rather than
 *     throwing. A relocated store that cannot be relocated is still a working
 *     store. Every such fallback goes out through `traceWarn`, not the debug-gated
 *     trace: an operator who does not set `PI_ENSEMBLE_DEBUG` still sees that the
 *     store did not move. A READ never warns — a clone that has simply never had a
 *     finding is not a fault.
 *   - The token is NEVER invented on a read. A token file that stays unreadable or
 *     malformed after the creating path's one retry falls back beside the ledger
 *     rather than minting a private token, because a minted-but-unwritten token
 *     would put this process's rows in a directory no later process can find: the
 *     memory would be lost silently, one round at a time.
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

import { randomBytes } from "node:crypto";
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
import path from "node:path";
import { LEDGER_OVERRIDE_ENV } from "./review-ledger-path.ts";
import type { LedgerExecFn } from "./review-ledger.ts";
import { FINDINGS_FILE, STATE_LEAF } from "./review-state-names.ts";
import type { FindingsLocation } from "./review-state-types.ts";
import {
  type ComputedLocation,
  computeLocation,
  fallbackBesideLedger,
  readToken,
} from "./review-store-locator.ts";
import { trace, traceWarn } from "./trace.ts";

/** The store's basename and the state leaf are declared once in
 * review-state-names.ts and re-exported here: the accept guard builds its refusal
 * spellings from those exports, so neither half of the locator may carry its own
 * copy of either literal. The agent root is declared in review-store-locator.ts
 * for the same reason — one definition of where the store actually lives. */
export { FINDINGS_FILE, STATE_LEAF } from "./review-state-names.ts";
export { agentDir } from "./review-store-locator.ts";

/** Marker written once per clone after the old beside-the-ledger file was moved. */
const MIGRATED_MARKER = "MIGRATED";

/** One resolved store: the directory, the file inside it, and where the ledger
 * that guards it lives (unchanged, under the git common dir). DECLARED in
 * review-state-types.ts — a leaf, because the pure computation constructs it and
 * this half returns it — and re-exported here so the two modules name ONE type and
 * every caller keeps importing it from this module. */
export type { FindingsLocation } from "./review-state-types.ts";

/**
 * Process cache keyed on the realpath of the clone's common dir. It carries the
 * clone's STATE ROOT alongside the location, so a cache hit can hand the creating
 * path the root its token lives in rather than making it derive one from the
 * token directory — the two are `dirname`/`dirname` apart and only
 * `computeLocation` knows which one was hashed.
 *
 * Only the NON-override branch ever writes or reads it:
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` is an explicit location that must answer
 * identically however often it is asked, and keying an entry on the clone's
 * common dir while answering from the override would let one fixture's answer
 * serve the next one that flips the variable. That is the whole offline suite's
 * isolation mechanism, so the cache is simply out of the picture when an override
 * is set.
 */
const resolved = new Map<string, { loc: FindingsLocation; root: string }>();

/** Clones whose one-time migration this process has already attempted. */
const attempted = new Set<string>();

/**
 * The answer for a clone whose store could not be created at the relocated path:
 * the old place, warned. The `traceWarn` is the operator's only signal that the
 * store did NOT move, so it belongs to the WRITE: a read of a clone that simply
 * has no store yet is not a fault worth a warn (see review-store-locator.ts), and
 * every reason an operator sees in the log names a resolve that actually tried to
 * create the store.
 */
function besideLedger(ledger: string, why: string): FindingsLocation {
  traceWarn(
    `review-state: the findings store stays beside the ledger at ${path.dirname(ledger)} — ${why}`,
  );
  return fallbackBesideLedger(ledger);
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
  return readToken(tokenFile);
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
 * the location comes from the ONE `computeLocation` both arms call, so the probe
 * and the record path cannot name two stores for one clone: not the override, not
 * the common-dir lookup, not the key, not the token, and not the corrupt-token
 * fallback, where the read-only arm names the SAME beside-the-ledger file the
 * creating path would have written. A read-only resolve does none of the writes:
 * no `mkdir`, no `chmod`, no token minting, no migration, and nothing cached (a
 * read must not seed the cache with an answer that predates the first real
 * resolve, and must not mint a token whose directory nobody else can find).
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
  // the suite.
  if (override) return loc;

  // From here the caller intends to WRITE, which is where every side effect of the
  // location belongs. The location itself was decided by `computeLocation`, so the
  // steps below can only make it real — they cannot change which file both arms
  // name.
  //
  // `loc.fellBack` from a READ is not an answer for a WRITE. `computeLocation`
  // never mints (minting on a read path would strand rows in a directory no later
  // process can find), so a clone whose token has simply never been minted reads
  // as "no token → fallback". The creating path must still mint — which is what
  // `tokenFor`'s `wx` protocol exists to do race-safely — and only a token that
  // stays unreadable or malformed after that mint is the real fallback.
  // Short-circuiting on the read's answer instead made every fresh clone's store
  // silently stay beside the ledger, because the first resolve of a clone is
  // usually a probe.
  try {
    makeStateDir(root);
    const token = tokenFor(root);
    // No usable token even after the mint: no reachable directory, and a token kept
    // in this process's memory would strand every row it writes. This is the same
    // fallback spelling `computeLocation` builds for the read-only arm, so the file
    // both arms name is one definition.
    if (!token) return besideLedger(loc.ledger, "the token file is unreadable or malformed");
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
    // relocated stores — never an answer derived from an override.
    resolved.set(key, { loc: created, root });
    return created;
  } catch (err) {
    return besideLedger(
      loc.ledger,
      `the state dir could not be created: ${(err as Error).message}`,
    );
  }
}

/** What `findingsStoreLocation` answers: the location plus whether a file already
 * sits at it. */
export type FindingsStoreLocation = FindingsLocation & { exists: boolean };

/**
 * The findings store's location for `cwd`, computed the SAME way the creating path
 * computes it (#1832 round 2) and with no side effects at all: no `mkdir`, no
 * `chmod`, no token minting, no migration, and nothing cached.
 *
 * `exists` distinguishes "there is no store here yet" from "a file sits here that
 * this process has not read" — the distinction the open-CRITICAL probe needs,
 * because a store that was never created holds no rows and therefore no CRITICAL,
 * while a file that cannot be read might. It is derived from the location
 * `computeLocation` produced, never recomputed, so it can never describe a
 * different file.
 */
export async function findingsStoreLocation(
  execFn: LedgerExecFn,
  cwd: string,
): Promise<FindingsStoreLocation | undefined> {
  const computed: ComputedLocation | undefined = await computeLocation(execFn, cwd);
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
