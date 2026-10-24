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
 * Keyed on `host` plus `OWNER/REPO` in one process-wide table (see
 * `CACHE_GLOBAL` for why that table hangs off a plain global rather than a
 * `Symbol.for` key). A repository's visibility does not
 * change while a session runs, and a TTL is a knob nobody would set correctly.
 * The table holds the in-flight PROMISE as well as the answer, so twenty
 * concurrent publishes in one repository ask `gh` once rather than twenty times.
 *
 * **Only an obtained answer is cached** (#1788 round 2). A lookup that threw or
 * never answered inside its bound is an absence of information, not information,
 * and pinning it for the life of the process meant one transient network blip at
 * the start of a long session silenced the visibility gate for every later
 * publish to that repository — the exact fail-open the module's own headline
 * rule forbids. A failed lookup is traced (slug plus error name only) and left
 * out of the table, so the next publish asks again.
 *
 * The host is part of the key because a slug says nothing on its own: two
 * forges can host `acme/widget` and disagree about its visibility, and a cached
 * answer carried from one to the other would be a wrong answer delivered with
 * full confidence.
 *
 * ## The resolver is injected
 *
 * `VisibilityFn` is the seam: production asks `gh`, every test hands in a
 * function. Nothing in this module reaches the network on its own — the default
 * lookup is passed an executor by its caller — so the offline suite cannot dial
 * a forge by accident.
 *
 * A non-GitHub `host` is the explicit "unknown, so check" outcome: answered
 * without a lookup, traced once per slug, and never cached — the outcome follows
 * from the host alone, so re-deriving it costs nothing and a cached trace would
 * be the only reason to keep the entry.
 */

import { execp } from "./exec.ts";
import { trace, traceWarn } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/** The one host whose repository visibility `gh` can answer for. */
const GITHUB_HOST = "github.com";

/** Bound on the visibility question. Generous over a normal `gh api` round trip. */
export const VISIBILITY_TIMEOUT_MS = 10_000;

/** `OWNER/REPO` as it arrived from a flag, an endpoint, a remote URL or a forge. */
export interface RepoTarget {
  owner: string;
  repo: string;
  /**
   * The host the target came from, when the caller knows it (a forge adapter
   * knows its own; a remote URL parses one). Part of the cache key, and the
   * thing that makes a non-GitHub host an explicit "unknown, so check".
   */
  host?: string;
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
 * The process-wide visibility cache, keyed on `host` plus `OWNER/REPO`, held in
 * the one place two module instances of this file can both reach.
 */
const CACHE_KEY = Symbol.for("pi-rukas.publicHygiene.visibility");

/**
 * Where the table actually lives: a PLAIN named global, not `Symbol.for`.
 *
 * The table used to hang off a `Symbol.for` key on the theory that two copies of
 * this module in one process share it. They do not. Bun's module registry hands
 * out a distinct module instance per distinct import SPECIFIER, so a test that
 * reaches this file by one path and the guard that reaches it by another each
 * got their own `Symbol.for` slot — and the twenty concurrent publishes that are
 * supposed to share one repository answer re-asked `gh`, because the cache each
 * believed it was writing to was the one its own copy owned. A string key on
 * `globalThis` is the only place two instances of this file genuinely meet, and
 * it carries the package name for the same reason the symbol did. The symbol is
 * kept as the cache's identity in traces and tests; the string is its address.
 */
const CACHE_GLOBAL = "__piRukasPublicHygieneVisibilityCache";

/** The cache key: a slug on one host is not the same repository on another. */
function cacheKey(host: string | undefined, slug: string): string {
  return `${host ?? GITHUB_HOST} ${slug}`;
}

/** Slug → already traced, so a repeated call does not repeat the line. */
const TRACED_KEY = Symbol.for("pi-rukas.publicHygiene.visibilityTraced");

function tracedTable(): Set<string> {
  const g = globalThis as Record<symbol, Set<string> | undefined>;
  g[TRACED_KEY] ??= new Set();
  return g[TRACED_KEY] as Set<string>;
}

/** Trace `line` the first time this process sees it, and only then. */
function traceOnce(line: string): void {
  const seen = tracedTable();
  if (seen.has(line)) return;
  seen.add(line);
  trace(line);
}

/**
 * The sentinel a failed or timed-out lookup resolves to.
 *
 * It is deliberately NOT `false`. `false` is a real answer — "this repository is
 * public, check it" — and a failure must not be able to impersonate one. The
 * first shape of this code used `false` for both, and the rule that drops a
 * failed lookup from the cache then dropped every legitimate public answer with
 * it: the cache held nothing and every publish re-asked the forge, which is the
 * opposite of what a cache is for. The sentinel is a value no honest lookup
 * returns, so the two cases stay distinguishable at the one place it matters.
 *
 * A caller still sees `false` either way — that is the guard's standing rule
 * that "could not tell" is never "clean", applied to the lookup's own failure.
 */
const LOOKUP_FAILED = "failed" as const;

/** An in-flight lookup's result: an answer, or the sentinel. */
type LookupOutcome = boolean | typeof LOOKUP_FAILED;

interface CachedAnswer {
  /** The obtained answer, or undefined while the lookup is still in flight. */
  answer: boolean | undefined;
  /** The in-flight promise, shared so concurrent publishes ask `gh` once. */
  pending: Promise<LookupOutcome>;
}

function cacheTable(): Map<string, CachedAnswer> {
  const g = globalThis as unknown as Record<string, Map<string, CachedAnswer> | undefined>;
  g[CACHE_GLOBAL] ??= new Map();
  return g[CACHE_GLOBAL] as Map<string, CachedAnswer>;
}

/** Test seam: forget every visibility answer this process holds. */
export function resetVisibilityCacheForTests(): void {
  cacheTable().clear();
}

/**
 * How many lookups THIS CACHE holds an obtained answer for. Read from the
 * table's size rather than a counter, so a test that resets the cache also
 * resets the count — and the assertion stays about the cache, which is the
 * thing under test. An entry appears only once its answer is obtained, so a
 * failed or timed-out lookup leaves the count exactly where it was.
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
  const slug = targetSlug(target);
  // The caller's host wins; a target that carries its own (a forge adapter, a
  // parsed remote) supplies it without the caller repeating the fact.
  const host = opts.host ?? target.host;
  // A host the resolver could not read is not evidence of github.com: `git
  // remote get-url` can hand back a bare slug or a path, and the resolver leaves
  // `host` undefined for those rather than guessing. Undefined or blank therefore
  // still asks `gh` (a lookup that fails resolves to "check", so an unknown host
  // is never a pass) but goes through the shared lookup path below.
  if (host !== undefined && host !== "" && host !== GITHUB_HOST) {
    // An explicit "unknown, so check": `gh` has no idea what a GitLab or
    // self-hosted project's visibility is, and a wrong `false` there would be
    // an unverified claim rather than a conservative one. Said once per slug —
    // the answer is derived from the host every time and never stored, so the
    // trace is the only thing a repeated call would duplicate.
    traceOnce(`public-hygiene: ${slug} is on ${host}, not github.com — checking`);
    return Promise.resolve(false);
  }
  const key = cacheKey(host, slug);
  const table = cacheTable();
  const hit = table.get(key);
  if (hit !== undefined) {
    // An in-flight entry is shared rather than re-issued, which is the whole
    // point of caching the promise: twenty publishes in one repository ask
    // `gh` once.
    if (hit.answer === undefined) {
      // Still in flight — the caller joins this lookup rather than starting
      // another one, and gets the plain-boolean reading of the outcome.
      return hit.pending.then((outcome) => (outcome === LOOKUP_FAILED ? false : outcome));
    }
    return Promise.resolve(hit.answer);
  }
  const lookup =
    opts.lookup ??
    ((t: RepoTarget) => ghVisibility(t, opts.exec ?? execp, opts.cwd ?? ".", opts.timeoutMs));
  // A bounded question: an executor that ignores the timeout it is handed must
  // not hang a tool_call hook, because a guard that hangs a session is a guard
  // an operator disables. A lookup that never answers comes back as
  // `LOOKUP_FAILED`, which the caller below turns into "check it".
  const pending: Promise<LookupOutcome> = bounded(
    // The caller's bound wins when it gave one: an executor that hangs must not
    // be allowed to hold a publish open for the 10 s default when the caller
    // asked for 50 ms. With no bound from the caller this is the module default.
    opts.timeoutMs ?? VISIBILITY_TIMEOUT_MS,
    Promise.resolve()
      .then(() => lookup(target))
      .catch((err: unknown) => {
        // The reason is a category, never repository text beyond the slug.
        traceWarn(
          `public-hygiene: visibility lookup failed for ${slug} (${errName(err)}) — treating as public`,
        );
        return LOOKUP_FAILED;
      }),
  );
  // The in-flight entry goes in NOW, so twenty concurrent publishes to one
  // repository share this promise and ask `gh` once — the behaviour the cache
  // existed for. An entry is an object rather than a bare promise because an
  // entry whose `answer` is still `undefined` is a LOOKUP IN FLIGHT (its
  // `pending` is what a concurrent call joins) while an entry with an answer is
  // a RESULT, and only a result may survive: a failed or timed-out lookup
  // removes its own entry, so the next publish asks again (see the header).
  const entry: CachedAnswer = { answer: undefined, pending };
  table.set(key, entry);
  void pending.then((outcome) => {
    // The entry this call installed is the one a failure invalidates — the
    // entry under `key` may by now be some later call's in-flight lookup, and
    // deleting THAT would re-open a cache hit the process is still relying on.
    if (outcome === LOOKUP_FAILED) {
      if (table.get(key) === entry) table.delete(key);
      return;
    }
    // Answered: the same entry object, now carrying the result, so an in-flight
    // entry becomes a RESULT and nothing else about the table changes. A real
    // `false` — public, check it — is an answer, and it stays.
    entry.answer = outcome;
  });
  // The public surface is a plain boolean either way: a failed lookup means
  // "check it", which is `false`, and that is the guard's rule, not a verdict.
  return pending.then((outcome) => (outcome === LOOKUP_FAILED ? false : outcome));
}

/** A rejection's name/code, the only thing a trace may print about it. */
function errName(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return err instanceof Error && err.name ? err.name : "error";
}

/** Resolve `work`, or `LOOKUP_FAILED` once `ms` has passed. */
async function bounded(ms: number, work: Promise<LookupOutcome>): Promise<LookupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LookupOutcome>((resolve) => {
    timer = setTimeout(() => resolve(LOOKUP_FAILED), ms);
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
