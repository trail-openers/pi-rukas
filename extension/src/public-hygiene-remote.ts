/**
 * public-hygiene-remote — the words a `git push` names as its remote (#1788).
 *
 * Split from `public-hygiene-target.ts` along the §12 seam: that module answers
 * "WHICH repository does this surface write to" and owns four resolvers; this one
 * owns the single question the push half asks first — which word in the command
 * is the remote, and what does it name.
 *
 * ## git resolves the remote first, and a URL in that slot is a remote
 *
 * `git push [remote] [refspec…]` takes the remote as its first non-option
 * argument, and git resolves that word as a remote before it resolves anything
 * as a refspec. So the first word after the verb that names a remote this clone
 * actually has IS the remote, and `origin` is git's own default when the command
 * names none. The other legitimate form is a URL — `git push
 * https://host/o/r.git main` pushes directly to a repository that has no name in
 * this clone at all, and is not a refspec.
 *
 * ## Why a URL that names no remote must still be scanned
 *
 * The push scan triggers on the host the remote resolves to. When the command
 * names a URL, the clone's own `origin` can say nothing about where the commits
 * go: a clone whose `origin` is a private forge can push straight to github.com,
 * and a scan that asked `origin` would report "not this guard's business" for a
 * push that publishes. So the URL the command carries IS the target — parsed
 * with the same `parseRemoteUrl` every other remote read uses, so scp-style and
 * scheme-form spellings resolve identically.
 *
 * ## Why a bare `owner/repo` is not a URL
 *
 * `parseRemoteUrl` would read `o/r` as a relative path with an inferred host. A
 * refspec may legitimately look like that (`git push origin features/foo`), and
 * adopting it as the target would move the scan off the clone's own remote and
 * ask about a repository nobody named. `looksLikeRemoteUrl` is therefore
 * deliberately narrower than the parser: a scheme, or an `@host:` prefix.
 */

import { parseRemoteUrl } from "./forge-detect.ts";

/** The option words whose value arrives as the NEXT word, and so never occupies
 * the remote slot: `git push --repo other origin main` pushes to `origin`. */
export const PUSH_VALUE_OPTIONS = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
]);

/**
 * The value of a glued push option (`--repo=x`, `-o=x`), or undefined.
 *
 * git's own synopsis spells these `--repo=<repository>` and
 * `--push-option=<string>`, so the value can arrive ATTACHED rather than as the
 * next word. A reader that only skips the bare flag lets `--repo=x` fall through
 * as an ordinary option and then adopts the NEXT word — a refspec — as the
 * remote, which is how a push whose destination the command itself carried came to
 * be judged against the clone's own `origin` (#1820 adversarial round).
 */
export function pushOptionGluedValue(word: string): string | undefined {
  const eq = word.indexOf("=");
  if (eq <= 0 || !word.startsWith("-")) return undefined;
  const flag = word.slice(0, eq);
  const value = word.slice(eq + 1);
  if (value === "" || !PUSH_VALUE_OPTIONS.has(flag)) return undefined;
  return flag === "--repo" || flag === "-o" || flag === "--push-option" ? value : undefined;
}

/**
 * The repository a push-to-URL names, or undefined when the word is not a URL
 * or does not parse as one. `git push ssh://git@host/o/r.git main` and
 * `git push git@host:o/r.git main` resolve to the same target as the same
 * repository spelled as a configured remote.
 *
 * ## Why this module parses the bare `host:path` form itself
 *
 * `parseRemoteUrl` (forge-detect.ts) is the forge detector's parser and has
 * callers across the driver — `detectForge` feeds it every clone's remote URL to
 * decide GitHub-vs-GitLab. Teaching IT to accept `github.com:o/r.git` would make
 * a local path or a stray `name:path` remote a forge candidate for the whole
 * driver, which is a wider claim than this guard needs. So the scp-without-user
 * spelling is parsed HERE, behind this one export, and `parseRemoteUrl` is asked
 * only for the shapes it already understands. git itself resolves the two
 * spellings identically (verified: `git ls-remote github.com:o/r.git` reaches the
 * host), so a push that names its destination this way is a public push and must
 * not slip past the scan (#1820).
 */
export function parsePushUrlTarget(
  word: string,
): { host: string; owner: string; repo: string } | undefined {
  if (!looksLikeRemoteUrl(word)) return undefined;
  const w = word.trim();
  const viaShared = parseRemoteUrl(w);
  if (viaShared !== undefined) return viaShared;
  // The one shape the shared parser does not cover: `host:path` with no `user@`.
  const bare = scpHostPath(w);
  if (bare === undefined) return undefined;
  const or = ownerRepo(bare.path);
  if (or === undefined) return undefined;
  return { host: bare.host.toLowerCase(), owner: or.owner, repo: or.repo };
}

/** `host:path` with no `user@`; undefined unless the word has that shape. */
function scpHostPath(word: string): { host: string; path: string } | undefined {
  if (word.includes("://")) return undefined;
  const colon = word.indexOf(":");
  if (colon <= 0) return undefined;
  const host = word.slice(0, colon);
  const path = word.slice(colon + 1);
  if (path === "" || path.startsWith("/") || host.includes("/")) return undefined;
  if (!HOST_LABEL.test(host)) return undefined;
  return { host, path };
}

/** `owner/repo(.git)` with any trailing separators dropped. */
function ownerRepo(path: string): { owner: string; repo: string } | undefined {
  const p = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = p.match(/^([^/]+)\/([^/]+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { owner: m[1], repo: m[2] };
}

/** A dotted host label, as used by both URL tests in this module. */
const HOST_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z]{2,}$/;

/**
 * Does this word name a repository by URL rather than by remote name?
 *
 * Narrower than `parseRemoteUrl` on purpose — see the module header for why a
 * bare `owner/repo` must stay a refspec. Three shapes count:
 *
 * - a SCHEME (`https://`, `ssh://`, `git://`, and yes `file://` — see below);
 * - an `@host:` prefix (`git@github.com:o/r.git`);
 * - a bare `host:path` with no `/` before the first `:`
 *   (`github.com:owner/repo.git`). git treats that as a URL even though it
 *   carries no `user@`; requiring one made the scan and the target resolver both
 *   blind to the commonest non-scheme spelling of a push-to-URL.
 *
 * A LOCAL path (`/srv/bare/repo`, `./repo`, `../repo`) is deliberately NOT a URL
 * even though git accepts it as a remote: no remote host publishes through it, and
 * the guard's business is the public forge. `file://` DOES carry a scheme and is
 * therefore matched: it names a repository the way a URL does, and the scan's
 * rule for a destination it cannot resolve to the public host is to read the
 * commits anyway and refuse on anything unreadable — the conservative direction,
 * and the one a reader can predict from the shape of the command.
 */
export function looksLikeRemoteUrl(word: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(word)) return true;
  return scpHostPath(word) !== undefined;
}

/**
 * The remote a `git push` writes to, exactly as the command wrote it: a remote
 * name this clone has, a URL, or `origin` when the command names neither.
 *
 * `pushVerb` arrives from the caller rather than being spelled here: the harness
 * that runs the offline suite reads command strings for publish verbs.
 *
 * THE ONE WALK. Both the scan (`public-hygiene-push.ts`) and the target resolver
 * (`public-hygiene-target.ts`) ask this question, and a second walker would
 * disagree with this one about an option's operand, a glued `--repo=`, or a
 * scp-style URL — which is precisely how a push destination escaped the scan
 * while the visibility question was answered from the wrong remote (#1820).
 */
export function pushRemoteName(
  words: readonly string[],
  pushVerb: string,
  remoteNames: ReadonlySet<string>,
): string {
  if (pushVerb === "") return "origin";
  const at = words.indexOf(pushVerb);
  if (at < 0) return "origin";
  // A `+` prefix is a refspec's force flag, never a remote's: git resolves
  // `+origin` as a remote NAME and fails (verified against git 2.x: `git push
  // +origin main` reports `'+origin' does not appear to be a git repository`).
  // Stripping it here would turn a command git rejects into one this reader
  // confidently resolves, so the slot reader does NOT strip it — and a word that
  // only looks like a remote once a `+` is removed is not a remote.
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] ?? "";
    // A glued option (`--repo=https://host/o/r.git`) CARRIES the destination in
    // the flag itself: it is the remote slot, not an option to skip (#1820).
    const glued = pushOptionGluedValue(w);
    if (glued !== undefined) {
      if (w.startsWith("--repo") && (looksLikeRemoteUrl(glued) || remoteNames.has(glued))) {
        return glued;
      }
      continue;
    }
    // An option's separate-word operand is its value, never the remote.
    if (PUSH_VALUE_OPTIONS.has(w)) {
      i += 1;
      continue;
    }
    if (w.startsWith("-")) continue;
    // A name this clone really has, or a URL. A bare refspec (`main`,
    // `HEAD:refs/heads/x`, `features/foo`) is neither, and guessing which of
    // them to read as the remote is how a scan ends up asking about the wrong
    // repository.
    if (remoteNames.has(w) || looksLikeRemoteUrl(w)) return w;
  }
  return "origin";
}
