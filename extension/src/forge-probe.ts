/**
 * forge-probe — the network half of forge detection, kept out of `forge-detect`
 * so the classifier stays offline by construction.
 *
 * Two questions live here, both about *whether the network is asked at all*:
 * `shouldProbe` (the operator's switch and the CI default) and `defaultProbe`
 * (the real calls). Neither is reachable from a test that injects `opts.probe`
 * — `detectForge` replaces this whole seam wholesale — which is what keeps the
 * offline suite from ever dialling a host.
 */

import type { ForgeType, ProbeFn, ProbeKind } from "./forge-detect.ts";

/**
 * Is this a CI environment? Reads `CI` from the given env.
 *
 * GitHub Actions, GitLab CI, Circle, Jenkins etc. all set `CI=true` (or a
 * similar truthy string). `CI=0`/`CI=false`/empty are treated as "not CI".
 */
export function isCI(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CI;
  if (v === undefined || v === "") return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Should the real (network) probe run?
 *
 * - `PI_ENSEMBLE_FORGE_PROBE=0` → never (hard off, wins over everything).
 * - `PI_ENSEMBLE_FORGE_PROBE=1` → always (hard on, operator override).
 * - No explicit setting → **on locally, off in CI** (the spec's default).
 */
export function shouldProbe(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.PI_ENSEMBLE_FORGE_PROBE;
  if (v === "0") return false;
  if (v === "1") return true;
  return !isCI(env);
}

/**
 * The default (real, network) probe. Only ever called when `shouldProbe`
 * allows AND the host is not in the known table.
 *
 * Tries GitLab first (`/api/v4/version` — the most common self-hosted forge),
 * then GitHub (`X-GitHub-Request-Id` response header on any endpoint),
 * then Gitea/Forgejo (`/api/v1/version`). Any probe that fails to confirm
 * returns `undefined`, so the overall result stays `unknown`.
 *
 * This function is never called in tests — the injected `opts.probe`
 * replaces it wholesale.
 */
export const defaultProbe: ProbeFn = async (
  host: string,
  kind: ProbeKind,
): Promise<ForgeType | undefined> => {
  // The `kind` param is the caller's *guess* at what's on the host; the
  // real probe ignores it and tries each endpoint in turn, confirming by
  // response shape rather than by trust.
  void kind;
  // GitLab: GET /api/v4/version → {"version":"17.x", ...}
  try {
    const res = await fetch(`https://${host}/api/v4/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === "string") return "gitlab";
    }
  } catch {
    /* not gitlab */
  }
  // GitHub (incl. GHE): the X-GitHub-Request-Id response header is
  // authoritative — gitlab.com does not set it.
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(5000) });
    if (res.headers.get("x-github-request-id")) return "github";
  } catch {
    /* not github */
  }
  // Gitea / Forgejo: GET /api/v1/version → {"version":"1.x"}
  try {
    const res = await fetch(`https://${host}/api/v1/version`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === "string") return "gitea" as ForgeType;
    }
  } catch {
    /* not gitea */
  }
  return undefined;
};
