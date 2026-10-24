/**
 * public-hygiene-visibility — is the repository this publish writes to PUBLIC?
 * (#1788 round 1, PM design decision)
 *
 * The guard exists to protect PUBLIC repositories. A private one — a personal
 * backlog, a downstream factory's private project — has no public to protect,
 * and refusing its commit messages, PR bodies and pushes because a term sits on
 * the operator's list is not privacy: it is the friction that gets the whole
 * guard switched off for the repositories that do publish. So every surface is
 * asked one question first — which repository does this write to, and is that
 * repository private?
 *
 * ## Only a positive `private: true` skips a check
 *
 * `gh api repos/OWNER/REPO --jq .private` answers, in argv form under a wall
 * clock, once per OWNER/REPO for the life of the process. `true` means skip the
 * surface; `false` means check it. Every other answer — no remote, an
 * unparseable URL, a non-GitHub host (`gh` knows nothing about a GitLab
 * project's visibility, and pretending otherwise would report a private GitLab
 * repo as public), no `gh` on PATH, a network failure, an unknown repository, an
 * unparseable body, or a lookup that never finished inside its bound — means
 * CHECK. That is the guard's standing rule that "could not tell" is never
 * "clean", and it is also the cheap direction to be wrong in: a failed lookup
 * costs a checked private repo, while the other direction costs a leak. There is
 * therefore no third answer.
 *
 * ## The cache
 *
 * Keyed on `OWNER/REPO` alone, in a `Symbol.for` global so two copies of this
 * module in one process still share it (the same trick the guard's
 * once-per-process registration flag uses). A repository's visibility does not
 * change while a session runs, and a TTL is a knob nobody would set correctly.
 * The cache holds the PROMISE, so twenty concurrent publishes in one repository
 * ask `gh` once rather than twenty times.
 *
 * ## The resolver is injected
 *
 * `VisibilityFn` is the seam: production asks `gh`, every test hands in a
 * function. Nothing in this module reaches the network on its own — the default
 * lookup is passed an executor by its caller — so the offline suite cannot dial
 * a forge by accident.
 */

import { execp } from "./exec.ts";
import { traceWarn } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** The one host whose repository visibility `gh` can answer for. */
const GITHUB_HOST = "github.com";

/** Bound on the visibility question. Generous over a normal `gh api` round trip. */
export const VISIBILITY_TIMEOUT_MS = 10_000;

/** `OWNER/REPO` as it arrived from a flag, an endpoint, a remote URL or a forge. */
export interface RepoTarget {
  owner: string;
  repo: string;
}

/** `owner/repo`, for the cache key and the one trace line this module writes. */
export function targetSlug(t: RepoTarget): string {
  return `${t.owner}/${t.repo}`;
}

/**
 * Asks whether a repository is private. `true` ONLY on a positive private
 * answer; a resolver that throws or hangs is treated as public (check).
 */
export type VisibilityFn = (target: RepoTarget) => Promise<boolean>;

/**
 * The process-wide visibility cache, keyed on `OWNER/REPO`. A `Symbol.for` key
 * so a second instance of this module (a test importing it by another
 * specifier) shares the answers rather than re-asking the forge.
 */
const CACHE_KEY = Symbol.for("pi-rukas.publicHygiene.visibility");

function cacheTable(): Map<string, Promise<boolean>> {
  const g = globalThis as Record<symbol, Map<string, Promise<boolean>> | undefined>;
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY] as Map<string, Promise<boolean>>;
}

/** Test seam: forget every visibility answer this process holds. */
export function resetVisibilityCacheForTests(): void {
  cacheTable().clear();
}

/**
 * How many lookups THIS CACHE has issued. Read from the table's size rather
 * than a counter, so a test that resets the cache also resets the count — and
 * the assertion stays about the cache, which is the thing under test.
 */
export function visibilityLookupCount(): number {
  return cacheTable().size;
}

/**
 * Is `target` a private repository? `false` (check it) on any doubt at all.
 *
 * `host`, when supplied, is the host of the remote the target came from: a
 * non-GitHub host is answered without a lookup, because `gh` has no idea what a
 * GitLab or self-hosted project's visibility is and a wrong `false` there would
 * be an unverified claim rather than a conservative one.
 */
export function isPrivateTarget(
  target: RepoTarget,
  opts: {
    host?: string;
    lookup?: VisibilityFn;
    exec?: ExecFn;
    cwd?: string;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  if (opts.host !== undefined && opts.host !== GITHUB_HOST) return Promise.resolve(false);
  const slug = targetSlug(target);
  const table = cacheTable();
  const hit = table.get(slug);
  if (hit !== undefined) return hit;
  const lookup =
    opts.lookup ?? ((t: RepoTarget) => ghVisibility(t, opts.exec ?? execp, opts.cwd ?? "."));
  // A bounded question: an executor that ignores the timeout it is handed must
  // not hang a tool_call hook, because a guard that hangs a session is a guard
  // an operator disables. `never` resolves to `false`, i.e. "check it".
  const pending = bounded(
    opts.timeoutMs ?? VISIBILITY_TIMEOUT_MS,
    Promise.resolve()
      .then(() => lookup(target))
      .catch((err: unknown) => {
        // The reason is a category, never repository text beyond the slug.
        traceWarn(
          `public-hygiene: visibility lookup failed for ${slug} (${errName(err)}) — treating as public`,
        );
        return false;
      }),
  );
  table.set(slug, pending);
  return pending;
}

/** A rejection's name/code, the only thing a trace may print about it. */
function errName(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return err instanceof Error && err.name ? err.name : "error";
}

/** Resolve `work`, or `false` once `ms` has passed. */
async function bounded(ms: number, work: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask `gh` whether OWNER/REPO is private. argv form, so the slug is one
 * argument and cannot carry a flag; any failure at all resolves `false`.
 */
export async function ghVisibility(
  target: RepoTarget,
  exec: ExecFn,
  cwd: string,
  timeoutMs = VISIBILITY_TIMEOUT_MS,
): Promise<boolean> {
  const { stdout } = await exec("gh", {
    argv: ["api", `repos/${target.owner}/${target.repo}`, "--jq", ".private"],
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
  });
  // The answer is one word. Anything else — a usage banner on stdout, a page of
  // JSON, an empty body — said nothing, and "said nothing" is not "private".
  return stdout.trim().toLowerCase() === "true";
}
