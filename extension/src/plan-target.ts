/**
 * plan-target — the repository a /plan run files INTO (#1854).
 *
 * `start_plan_driver` used to resolve its target from the session: `ctx.cwd`,
 * `git rev-parse --show-toplevel`, and every consumer — forge detection, the
 * create call, the pre-filing label read, the investigation children, the cache
 * lineage — keyed off that one path. A spec about another repository therefore
 * filed into the session's tracker while every message the run emitted looked
 * internally consistent, because each consumer was right about the repository it
 * had actually been handed. The only escape hatch was naming the destination
 * inside `context`, which is inert data: children read the session tree and
 * re-derive the session repo anyway.
 *
 * So the tool gains a caller-settable target, and this module decides what that
 * input may be. The rules, and why each one exists:
 *
 *   1. **A repository identity, never a directory.** The input is a host plus a
 *      namespace path — `github.com/owner/repo`, a self-hosted
 *      `gitlab.example.com/group/sub/project`, or the bare `owner/repo` form the
 *      forge CLIs take for the default host. A filesystem path is refused: a path
 *      lets a caller redirect filing into any checkout on the machine, fork
 *      included, and the label check would then certify labels for a repository
 *      that is not where the issue lands.
 *   2. **Resolution is by origin, among the clones this session already owns.**
 *      git has no query that finds a clone of a URL, so the candidate set is the
 *      session repo plus its registered worktrees — the ordinary shape of the
 *      observed case, a pi-rukas spec filed from a session in another clone or
 *      worktree of the same repository. No local clone of the named identity is
 *      a REFUSAL, never a fallback to the session repo: a silent fallback is the
 *      bug this module exists to remove.
 *   3. **A supplied target that resolves to the session repo is refused.** The
 *      caller asked for a different repository and got the one it was already in;
 *      that passes every check the run makes and files into the wrong tracker,
 *      so "it resolved" is not evidence the run is aimed.
 *   4. **Supplied-but-refused fails before anything is dispatched**, and the
 *      message names both identities: what was asked for, and the repository this
 *      session actually is.
 *
 * When the input is omitted nothing here resolves anything: the tool passes the
 * session repo through, which is the byte-identical pre-#1854 behaviour.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRemoteUrl } from "./forge-detect.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

/** The default host a bare `owner/repo` names — the forge CLIs' own convention. */
export const DEFAULT_HOST = "github.com";

/**
 * The ONLY channel by which a target may be satisfied by a checkout outside the
 * session's own clone and its registered worktrees: a comma-separated (or, for an
 * absolute-value list, platform-path-separated) set of directories, each of which
 * must still prove it clones the wanted identity. Nothing reads a path from the
 * `targetRepository` parameter, so an agent cannot aim a filing at an arbitrary
 * directory by writing one; the operator sets this in the environment, and
 * resolution still fails closed when no listed directory matches.
 */
export const PLAN_TARGET_OVERRIDE_ENV = "PI_ENSEMBLE_PLAN_TARGET_DIRS";

/** A canonical repository identity: lower-cased host, case-preserved path segments. */
export interface RepoIdentity {
  host: string;
  /** Path segments with any `.git` suffix dropped — `["owner", "repo"]`. */
  segments: string[];
}

/** The canonical text form of an identity: `host/owner/repo`. */
export function identityText(i: RepoIdentity): string {
  return `${i.host}/${i.segments.join("/")}`;
}

/**
 * A path segment both forges and git accept. The ONE definition: `forge-detect.ts`
 * parses the same namespace out of a remote URL, and the two surfaces must not
 * disagree about what a segment is — a remote the parser accepts and the identity
 * rules refuse (or the other way round) is a repository that exists on one seam
 * and not the other.
 */
export const isSegment = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);

/** A first segment is a host only when it has a dot and every label is DNS-shaped. */
const isHost = (s: string): boolean =>
  s.includes(".") &&
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s.toLowerCase());

/**
 * `host/owner/repo` (or a bare `owner/repo` for `defaultHost`) → an identity, or
 * `undefined` for anything that is not exactly one repository identity: a path,
 * a URL with a scheme or credentials, a comma list, an option-looking string, a
 * traversal, or a namespace path with no repository segment.
 */
export function parseRepoIdentity(
  raw: string,
  defaultHost: string = DEFAULT_HOST,
): RepoIdentity | undefined {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s || s.length > 200) return undefined;
  // One identity per parameter: a caller that means two repositories makes two
  // calls, rather than a list one half of which gets silently dropped.
  if (s.startsWith("-") || s.includes(",") || /[\\#?%:*~<>@^|"'`\s]|\.\./.test(s)) return undefined;
  // An absolute or `~`-rooted string is a DIRECTORY, and the first segment of one
  // (`/home/user/repo` → "home") is otherwise shaped exactly like a namespace
  // segment — so the leading separator has to be refused on its own terms, not
  // left to the segment grammar.
  if (s.startsWith("/") || s.startsWith("~")) return undefined;
  const segments = s.split("/").filter((x) => x.length > 0);
  if (segments.length === 0 || segments.some((x) => x === "." || x === "..")) return undefined;
  let host = defaultHost;
  if (segments.length >= 3 && isHost(segments[0] as string)) host = segments.shift() as string;
  if (segments.length < 2 || !segments.every(isSegment)) return undefined;
  return { host: host.toLowerCase(), segments };
}

/**
 * The identity the clone at `dir` files into, read from its `origin` URL.
 * Undefined when the directory is not a clone, has no origin, or carries a URL
 * that is not a repository (a bare local path, an scp target with no owner).
 */
export async function repoIdentityAt(dir: string): Promise<RepoIdentity | undefined> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "config", "--get", "remote.origin.url"], {
      timeout: 10_000,
    });
    const parsed = parseRemoteUrl(stdout.trim());
    if (!parsed) return undefined;
    // The identity is the whole namespace path, so a clone of a GitLab subgroup
    // matches a target that names it. Case is preserved, as `parseRepoIdentity`
    // preserves it; a github.com clone deeper than `owner/repo` names no
    // repository the way github.com serves one, so it is no identity.
    if (parsed.host === DEFAULT_HOST && parsed.path.length !== 2) return undefined;
    return { host: parsed.host, segments: parsed.path };
  } catch {
    return undefined;
  }
}

/** A candidate clone: a directory and, when git answered, the identity it clones. */
interface Candidate {
  dir: string;
  identity?: RepoIdentity;
}

/**
 * A checkout the caller ALREADY has: an environment override naming a directory
 * whose origin matches the wanted identity.
 *
 * The one legitimate case for a clone outside the session's own tree is an
 * operator who pointed at it, and the only channel for that is the environment —
 * the parameter is an identity precisely so it cannot carry a path. An unset
 * variable, or one naming no clone of the wanted repository, is undefined and
 * resolution falls back to the session's clones plus its registered worktrees: the
 * default path is exactly the pre-existing behaviour, so an unset environment can
 * never change which repository a plan lands in.
 */
async function overrideClone(
  wanted: RepoIdentity,
  identityFn: (dir: string) => Promise<RepoIdentity | undefined>,
): Promise<Candidate | undefined> {
  const raw = process.env[PLAN_TARGET_OVERRIDE_ENV]?.trim();
  if (!raw) return undefined;
  // Split on comma, semicolon and colon. An absolute path contains the POSIX
  // delimiter (`:`) but no comma, and a comma-joined list of absolute paths
  // contains both — so no single separator serves both spellings. The cost is that
  // a Windows drive path (`C:\…`) is split at its colon; that entry then fails the
  // identity check below and the run refuses, so the mis-split fails closed rather
  // than aiming a filing somewhere else. Each entry still has to prove it clones the
  // wanted identity.
  const dirs = raw
    .split(/[,;:]/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  for (const dir of dirs) {
    const identity = await identityFn(dir);
    // The identity is carried, not re-read later: every consumer compares the same
    // value the resolver matched on, so a match cannot be lost between matching and
    // use by a second read that fails.
    if (sameIdentity(identity, wanted)) return { dir, identity };
  }
  return undefined;
}

/**
 * The clones worth consulting for one target: the session repo and the worktrees
 * git has registered for it. Both are directories this session already owns, so
 * resolving a target cannot wander the filesystem for a checkout nobody pointed
 * at — which is the property that keeps a label check from certifying a fork.
 */
async function candidates(
  sessionRepoRoot: string,
  identityFn: (dir: string) => Promise<RepoIdentity | undefined>,
): Promise<Candidate[]> {
  const dirs = [sessionRepoRoot];
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", sessionRepoRoot, "worktree", "list", "--porcelain"],
      { timeout: 10_000 },
    );
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const dir = line.slice("worktree ".length).trim();
      if (dir && dir !== sessionRepoRoot) dirs.push(dir);
    }
  } catch {
    // Not a clone, or git is unavailable: the session root is the only candidate,
    // and the refusal text reports the session identity as unreadable.
  }
  return Promise.all(dirs.map(async (dir) => ({ dir, identity: await identityFn(dir) })));
}

/** Two identities name one repository when host and every segment agree. */
export function sameIdentity(a: RepoIdentity | undefined, b: RepoIdentity | undefined): boolean {
  if (!a || !b) return false;
  return a.host === b.host && a.segments.join("/") === b.segments.join("/");
}

/** A resolved target: the clone the run files into, reads from, and reports. */
export interface PlanTarget {
  /** The directory every consumer keys off: forge cwd, children's cwd, cache root. */
  repoRoot: string;
  /** The repository that directory clones — named in launch, report and refusals. */
  identity?: RepoIdentity;
  /** True only when the caller named a target AND it is not the session's repo. */
  crossRepo: boolean;
  /** The session's own repository — the other half of every refusal message. */
  sessionIdentity?: RepoIdentity;
}

/**
 * Where the caller's target resolves, or why it may not be used. Every arm
 * besides `ok` is a refusal the tool returns BEFORE it launches a job, so a
 * mis-typed identity costs one tool call rather than a five-minute pipeline that
 * then files in the wrong tracker.
 */
export type TargetResolution = { ok: true; target: PlanTarget } | { ok: false; problem: string };

/**
 * Resolve a caller-supplied repository identity against the clones this session
 * can reach. Omit `raw` and this returns the session repo unchanged — the path
 * every existing caller, and every existing plan smoke test, takes.
 *
 * `identityFn` is the seam a test injects to describe clones without building a
 * fixture per repository; production passes nothing and gets `repoIdentityAt`.
 */
export async function resolvePlanTarget(
  raw: unknown,
  sessionRepoRoot: string,
  identityFn: (dir: string) => Promise<RepoIdentity | undefined> = repoIdentityAt,
): Promise<TargetResolution> {
  const session = await identityFn(sessionRepoRoot);
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      target: {
        repoRoot: sessionRepoRoot,
        crossRepo: false,
        ...(session ? { sessionIdentity: session } : {}),
      },
    };
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      problem:
        'targetRepository must be a repository identity such as "owner/repo" or "host/owner/repo"',
    };
  }
  const wanted = parseRepoIdentity(raw);
  if (!wanted) {
    return {
      ok: false,
      problem: `${JSON.stringify(raw)} is not a repository identity — pass "host/owner/repo" or "owner/repo" (a namespace path is allowed). A filesystem path is not accepted: the target of a filing is a repository, not a directory on this machine, and a path would certify labels for a checkout that is not where the issue lands.`,
    };
  }
  const wantedText = identityText(wanted);
  const override = await overrideClone(wanted, identityFn);
  const list = override
    ? [override, ...(await candidates(sessionRepoRoot, identityFn))]
    : await candidates(sessionRepoRoot, identityFn);
  const match = list.find((c) => sameIdentity(c.identity, wanted));
  if (!match) {
    const here = session ? identityText(session) : "(this session's directory is not a git clone)";
    const known = [
      ...new Set(list.map((c) => (c.identity ? identityText(c.identity) : ""))),
    ].filter((t) => t.length > 0);
    const tried = known.length > 0 ? ` (this session's clones cover: ${known.join(", ")})` : "";
    trace(`plan-target: no local clone of ${wantedText}${tried}`);
    return {
      ok: false,
      problem: `no local clone of ${wantedText} was found${tried} — this session is in ${here}. Clone the target repository (or start the session inside it) and re-call start_plan_driver; the spec was NOT filed into ${here} as a fallback.`,
    };
  }
  if (sameIdentity(session, match.identity)) {
    // The named target IS the session's repository. A second clone of that
    // repository is still the same tracker, so it is refused too: at filing time it
    // is indistinguishable from the defect this parameter exists to remove — a spec
    // landing in the session tracker while every message says it resolved. The
    // comparison is between the two identities git reports, never between
    // directories: two checkouts of one repository are one destination, and two
    // checkouts of different repositories on one host are not.
    return {
      ok: false,
      problem: `targetRepository ${wantedText} is the repository this session is ALREADY in, so the call is refused rather than run: a target that names its own session repo is indistinguishable, at filing time, from the defect this parameter exists to remove — a spec landing in the session tracker while every message says it resolved. Omit targetRepository to plan this repository, or name the repository you mean.`,
    };
  }
  return {
    ok: true,
    target: {
      repoRoot: match.dir,
      ...(match.identity ? { identity: match.identity } : {}),
      crossRepo: true,
      ...(session ? { sessionIdentity: session } : {}),
    },
  };
}

/**
 * What the ORCHESTRATOR reports about a resolved target. Lives beside the
 * resolution because the two must agree: the digest/lineage term and the
 * operator-facing label are the same identity, derived once.
 */
export interface PlanTargetFacts {
  /**
   * The canonical identity the `reviewedDigest` and the cache lineage key on.
   * Derived from the CALLER's parameter, not from the resolved clone — what the
   * digest authorises is filing into the repository the operator was shown, so
   * deriving it from whatever checkout was found this time would let one reviewed
   * spec file into any of several clones.
   *
   * An unparseable value yields the empty identity (`"/"`), a distinct digest
   * term from any real repository and from absent, so it can never borrow another
   * run's reviewed spec. The tool refuses such a value before the job launches;
   * this is the driver's own guarantee, because `PlanDriverInput` is exported and
   * its callers are not only that tool.
   */
  targetIdentity?: string;
  /**
   * The repository to name in operator-facing text, or undefined when there is
   * nothing to add: an omitted target, or one that resolved to the session
   * repository, prints no target line at all — which is what keeps an omitted
   * input's launch notice and steer byte-identical.
   */
  label?: string;
  /** The session's own repository, named alongside the label. */
  sessionLabel?: string;
}

export function planTargetFacts(targetRepository?: string, target?: PlanTarget): PlanTargetFacts {
  return {
    ...(targetRepository !== undefined
      ? {
          targetIdentity: identityText(
            // The `??` arm is the unparseable case: an empty identity, which
            // renders "/" and hashes as a term no real repository produces.
            parseRepoIdentity(targetRepository) ?? { host: "", segments: [] },
          ),
        }
      : {}),
    ...(target?.crossRepo
      ? {
          label: target.identity ? identityText(target.identity) : target.repoRoot,
          ...(target.sessionIdentity ? { sessionLabel: identityText(target.sessionIdentity) } : {}),
        }
      : {}),
  };
}
