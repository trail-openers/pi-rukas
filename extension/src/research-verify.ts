import type { ClaimVerification, ResearchClaim } from "./research-types.ts";
import { trace } from "./trace.ts";
/**
 * research-verify — the deterministic verification layer of /research.
 *
 * The landscape review found verification is the thinnest layer in every
 * surveyed harness, and prescribes layering: URL liveness first (cheap,
 * deterministic), claim grounding second. For a SOFTWARE repo the canonical
 * grounding unit is the pinned commit — "does this path/symbol actually
 * exist in the version cited?" — which no surveyed general product runs as
 * a named stage (outputs/research-driver-landscape.md §2). This module runs
 * both deterministic checks driver-side; the expensive LLM entailment layer
 * is deep-tier-only and lives with the deep tier (follow-up PR), per the
 * FaithJudge caveat that automated hallucination detection is <72% F1 and
 * must never be a silent quality claim.
 *
 * Everything is injectable (fetch, exec) so the smoke tests run offline;
 * the default fetch is the bare global-fetch + AbortSignal.timeout pattern
 * from forge-detect.ts — the repo's only HTTP precedent.
 */
import type { ExecFn } from "./worktree.ts";

export type LivenessStatus = "live" | "dead" | "unreachable";

/** Minimal fetch shape (injectable for offline tests). */
export type FetchLike = (
  url: string,
  init: { method: string; redirect: "follow"; signal: AbortSignal },
) => Promise<{ status: number }>;

/** Bound the liveness pass: unique URLs past the cap stay unchecked. */
export const LIVENESS_URL_CAP = 30;
export const LIVENESS_TIMEOUT_MS = 5000;

/**
 * Classify one HTTP status. Bot filters (403/429) and method rejection
 * (405) are `unreachable`, NOT `dead` — the landscape report's own
 * provenance convention: a page that refuses automation still exists.
 * `dead` is reserved for confident absence (404/410 and other 4xx/5xx).
 */
export function classifyLiveness(status: number): LivenessStatus {
  if (status < 400) return "live";
  if (status === 403 || status === 405 || status === 429) return "unreachable";
  return "dead";
}

/**
 * Check each unique URL once (GET, redirects followed, 5s timeout). A
 * thrown fetch (network error, timeout) is `unreachable` — absence of an
 * answer is not evidence of death.
 */
export async function checkUrlLiveness(
  urls: readonly string[],
  fetchFn: FetchLike = (u, init) => fetch(u, init),
): Promise<Map<string, LivenessStatus>> {
  const unique = [...new Set(urls)].slice(0, LIVENESS_URL_CAP);
  const out = new Map<string, LivenessStatus>();
  await Promise.all(
    unique.map(async (url) => {
      try {
        const res = await fetchFn(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS),
        });
        out.set(url, classifyLiveness(res.status));
      } catch {
        out.set(url, "unreachable");
      }
    }),
  );
  return out;
}

/** Resolve the commit the code-grounding checks pin to ("unknown" on failure). */
export async function pinnedCommit(execFn: ExecFn, repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFn("git rev-parse HEAD", { cwd: repoRoot });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ground one code source (`path` or `path#symbol`) against the working tree
 * at HEAD: the path must be tracked (`git ls-files`), and the symbol — when
 * given — must occur somewhere in tracked content (`git grep -l -F`). Both
 * commands exiting non-zero means "not found"; an exec failure of any other
 * shape degrades to ungrounded=false being UNKNOWABLE, so the claim is left
 * unchecked rather than condemned (same posture as claim-scan's fail-open
 * lookup: a check that could not run must not manufacture a finding).
 */
export async function groundCodeSource(
  execFn: ExecFn,
  repoRoot: string,
  source: string,
): Promise<"grounded" | "ungrounded" | "unchecked"> {
  const [rawPath, symbol] = source.split("#", 2);
  const p = (rawPath ?? "").trim();
  if (!p) return "unchecked";
  try {
    const { stdout } = await execFn(`git ls-files -- ${JSON.stringify(p)}`, { cwd: repoRoot });
    if (!stdout.trim()) return "ungrounded";
    if (symbol?.trim()) {
      try {
        const { stdout: hits } = await execFn(
          `git grep -l -F -- ${JSON.stringify(symbol.trim())}`,
          {
            cwd: repoRoot,
          },
        );
        return hits.trim() ? "grounded" : "ungrounded";
      } catch {
        // git grep exits 1 on zero matches (promisified exec throws).
        return "ungrounded";
      }
    }
    return "grounded";
  } catch {
    return "unchecked";
  }
}

/**
 * Annotate every claim with its deterministic verification outcome:
 * url sources → liveness class; code sources → grounding against HEAD;
 * doc/none → unchecked. Returns new claim objects (input never mutated).
 */
export async function verifyClaims(
  claims: readonly ResearchClaim[],
  repoRoot: string,
  execFn: ExecFn,
  fetchFn?: FetchLike,
): Promise<ResearchClaim[]> {
  const urls = claims.filter((c) => c.sourceKind === "url").map((c) => c.source);
  const liveness = await checkUrlLiveness(urls, fetchFn);
  const out: ResearchClaim[] = [];
  for (const c of claims) {
    let verification: ClaimVerification = { check: "none", status: "unchecked" };
    if (c.sourceKind === "url") {
      const status = liveness.get(c.source);
      if (status) verification = { check: "url-liveness", status };
    } else if (c.sourceKind === "code") {
      const status = await groundCodeSource(execFn, repoRoot, c.source);
      if (status !== "unchecked") verification = { check: "code-grounding", status };
    }
    out.push({ ...c, verification });
  }
  const dead = out.filter(
    (c) => c.verification.check === "url-liveness" && c.verification.status === "dead",
  ).length;
  const ungrounded = out.filter(
    (c) => c.verification.check === "code-grounding" && c.verification.status === "ungrounded",
  ).length;
  if (dead + ungrounded > 0)
    trace(`research-verify: ${dead} dead URL(s), ${ungrounded} ungrounded code claim(s)`);
  return out;
}

/**
 * A claim counts as VERIFIED for the abstention decision when it is a
 * finding whose deterministic check affirmed it (live URL or grounded
 * code), or a finding with an unchecked-but-named doc source. Findings with
 * dead/ungrounded sources, unsourced findings, and non-finding kinds do not
 * count — zero verified findings triggers the honest abstention artifact.
 */
export function isVerifiedFinding(c: ResearchClaim): boolean {
  if (c.kind !== "finding") return false;
  const v = c.verification;
  if (v.check === "url-liveness") return v.status !== "dead";
  if (v.check === "code-grounding") return v.status === "grounded";
  return c.sourceKind === "doc";
}
