/**
 * public-hygiene-push-reads — the git reads a push scan makes ABOUT the clone
 * rather than about its commits: the clone's remote names, the destination the
 * command itself carries, and the wall clock each read runs under.
 *
 * Split out of `public-hygiene-push.ts` along the seam AGENTS.md §12 asks for:
 * that file owns the scan (the refspec range and the two `git log`s), this one
 * owns the two questions the scan asks before it reads a single commit. They
 * moved together because all three are reads of the transport rather than of the
 * range, and a scan that grew them in place went past the size cap.
 *
 * ## Why these are separate from the commit reads
 *
 * Both answer a question whose failure has a DIFFERENT consequence for the scan,
 * and the difference is the reason the answers are typed rather than collapsed:
 *
 * - the remote list (`pushRemoteNames`) anchors the refspec reader, so its
 *   failure is fatal for a named-remote push and harmless for a push-to-URL;
 * - the destination (`directPushTarget`) decides whether the command publishes to
 *   the public forge at all, so its failure is always fatal — a destination that
 *   could not be read is never a destination excused.
 *
 * `askFailed` is what keeps the first of those two facts expressible: an empty
 * list and no answer at all are different facts and get different sentences.
 */

import type { PushScanDeps } from "./public-hygiene-push.ts";
import { splitPushWords } from "./public-hygiene-refspecs.ts";
import { looksLikeRemoteUrl, parsePushUrlTarget, pushRemoteName } from "./public-hygiene-remote.ts";
import { PUSH_SCAN_TIMEOUT_MS } from "./public-hygiene-scan.ts";

/**
 * The sentinel the remote-list read resolves to when the executor never
 * settles. A module-level symbol rather than a local one so the read that uses
 * it stays a single expression; a hung guard is a guard an operator switches off.
 */
const askFailed = Symbol("ask-failed");

/**
 * Resolve `work`, or `fallback` once `ms` has passed. The guard's own wall
 * clock: `exec` is a seam the caller supplies, and an executor that ignores the
 * timeout it was handed would otherwise hang the `tool_call` hook forever — a
 * hung guard is a guard an operator switches off, which is the failure mode the
 * issue's criteria name. The losing promise is left to settle; nothing in this
 * module holds state that a late resolution can corrupt, and the scan is
 * read-only against git.
 */
export async function bounded<T>(ms: number, fallback: T, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask git for the clone's remote names, under the guard's own wall clock.
 * Resolves `askFailed` when the executor never settles — the fallback is the
 * `askFailed` symbol, so the caller can tell "never answered" from "answered
 * with no remotes", which are different facts and get different sentences.
 *
 * A `git remote` that FAILS is reported as a problem rather than as a clone with
 * no remotes (#1820): an empty list makes the refspec reader find no anchor, and
 * the caller then resolves HEAD and scans commits this push may not publish —
 * "I could not ask git what remotes exist" is not "this clone has none", and
 * reporting it as the second one would let a transient git failure read as a
 * clean scan. This is the one place the scan asks git for its remotes.
 */
export async function pushRemoteNames(
  deps: PushScanDeps,
  git: (args: string[]) => Promise<string>,
): Promise<{ names: string[]; problem?: string }> {
  const asked = await bounded(
    deps.timeoutMs ?? PUSH_SCAN_TIMEOUT_MS,
    askFailed,
    git(["remote"]).catch(() => askFailed),
  );
  if (asked === askFailed) {
    return { names: [], problem: "this clone's remotes could not be read (timed out)" };
  }
  return {
    names: asked
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

/** A destination read from the command: its host, or why it could not be read. */
export type DirectTarget = { kind: "host"; host: string } | { kind: "problem"; problem: string };

/**
 * The repository a `git push <url> …` pushes to, read out of the command.
 *
 * Returns undefined when the command names a configured remote (or none), which
 * is the case the clone's own remotes answer. When it names a URL the answer is
 * the URL's host, or a problem when the word looks like a URL and does not parse
 * as one: "the push destination could not be read" is not "the destination is not
 * the public forge", and the difference is the difference between a checked push
 * and one excused on a guess.
 *
 * THE SLOT IS READ ONCE (#1820): this function asks {@link pushRemoteName}, the
 * same reader the target resolver uses, rather than walking the words a second
 * time with its own option table. Two walkers drifted on the glued `--repo=<url>`
 * spelling: the scan never triggered and the resolver answered the visibility
 * question from the clone's own remote. The same drift made the SEPARATE-WORD
 * `--repo <url>` an option to skip: with no remote names handed over, the reader
 * could not tell `--repo https://github.com/o/r.git` from `--repo other`, so the
 * scan never triggered and the visibility question got answered from the clone's
 * own `origin` — a fail-OPEN. The real remote names are handed over here.
 */
export function directPushTarget(
  deps: PushScanDeps,
  remoteNames: ReadonlySet<string>,
): DirectTarget | undefined {
  const words = splitPushWords(deps.command ?? "");
  const pushVerb = deps.pushVerb ?? "";
  if (pushVerb === "" || words.indexOf(pushVerb) < 0) return undefined;
  const slot = pushRemoteName(words, pushVerb, remoteNames);
  // `pushRemoteName` defaults to `origin` when the command names no remote of
  // this clone and carries no URL — including the case where the first non-option
  // word is a bare refspec and git defaults the remote to `origin`. That is the
  // shape the clone's own remotes answer, so this reader says nothing. Only a
  // word that looks like a URL is a destination the command itself carries.
  if (!looksLikeRemoteUrl(slot)) return undefined;
  const parsed = parsePushUrlTarget(slot);
  if (parsed === undefined) {
    return { kind: "problem", problem: "the push destination URL could not be read" };
  }
  return { kind: "host", host: parsed.host };
}

/**
 * A directory in a refusal, basename only.
 *
 * The path an agent typed is agent-authored text, and a private project name can
 * live in a directory name — the same reason the source-resolution refusal never
 * quotes a refspec. The basename is enough for an agent to act on, and it is the
 * only part of a path this refusal has any business repeating.
 */
export function describeDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base === "" ? "/" : base;
}
