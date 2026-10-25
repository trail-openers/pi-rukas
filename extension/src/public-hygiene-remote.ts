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
 * Does this word name a repository by URL rather than by remote name?
 *
 * Narrower than `parseRemoteUrl` on purpose — see the module header for why a
 * bare `owner/repo` must stay a refspec.
 */
export function looksLikeRemoteUrl(word: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(word);
}

/**
 * The remote a `git push` writes to, exactly as the command wrote it: a remote
 * name this clone has, a URL, or `origin` when the command names neither.
 *
 * `pushVerb` arrives from the caller rather than being spelled here: the harness
 * that runs the offline suite reads command strings for publish verbs.
 */
export function pushRemoteName(
  words: readonly string[],
  pushVerb: string,
  remoteNames: ReadonlySet<string>,
): string {
  if (pushVerb === "") return "origin";
  const at = words.indexOf(pushVerb);
  if (at < 0) return "origin";
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] ?? "";
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

/**
 * The repository a push-to-URL names, or undefined when the word is not a URL
 * or does not parse as one. `git push ssh://git@host/o/r.git main` and
 * `git push git@host:o/r.git main` resolve to the same target as the same
 * repository spelled as a configured remote.
 */
export function parsePushUrlTarget(
  word: string,
): { host: string; owner: string; repo: string } | undefined {
  if (!looksLikeRemoteUrl(word)) return undefined;
  return parseRemoteUrl(word.trim());
}
