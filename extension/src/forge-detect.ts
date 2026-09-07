/**
 * forge-detect — which forge does this repository live on? (S1 of epic #608)
 *
 * Parses the git remote URL to classify the host: `github` (github.com),
 * `gitlab` (gitlab.com), `unknown` (anything else). Everything here is
 * fail-closed: an unresolvable remote, an unparseable URL, or an unconfirmed
 * probe all land on `unknown` — the module never guesses.
 *
 * ## Resolution precedence
 *
 *   1. `PI_ENSEMBLE_FORGE` env var — hard override, wins over everything.
 *   2. `.pi/forge` config file — `type=gitlab`, `host=…` (self-hosted).
 *   3. Known-host table — `github.com` → github, `gitlab.com` → gitlab
 *      (case-insensitive, port ignored).
 *   4. API probe for unknown hosts — opt-in (see below), injectable.
 *   5. `unknown` — the explicit fail-closed outcome.
 *
 * ## Remote resolution
 *
 * `origin` → `upstream` → first remote in `git remote` order. The winning
 * name is reported in the result so a caller can say *which* remote
 * decided.
 *
 * ## The probe seam
 *
 * The optional API probe (GET `/api/v4/version` for GitLab, the
 * `X-GitHub-Request-Id` response header for GHE, GET `/api/v1/version` for
 * Gitea/Forgejo) is deliberately injectable: `opts.probe` replaces
 * `defaultProbe` wholesale, so tests stay fully offline. Whether the *real*
 * probe runs at all is decided by `shouldProbe()`: **off in CI by default**
 * (a driver cycle in CI must never wait on the network), on locally.
 * `PI_ENSEMBLE_FORGE_PROBE=0` forces it off anywhere; `=1` forces it on.
 * An absent `CI` variable means "not CI" — which is the right reading of
 * the GitHub variable convention: `CI=0`/`CI=false` are treated as unset.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";

const execp = promisify(exec);

/**
 * The forge this repo is on. Fail-closed union: `unknown` is a real variant
 * downstream modules must handle, not an error string.
 */
export type ForgeType = "github" | "gitlab" | "unknown";

/** The shape of a forge's API version endpoint, per the epic #608 spec. */
export type ProbeKind = "gitlab" | "github" | "gitea";

/** The one thing a probe may return: a confident forge type, or nothing. */
export type ProbeResult = ForgeType;

/** A probe is a host + kind → verdict. Injectable so tests stay offline. */
export type ProbeFn = (host: string, kind: ProbeKind) => Promise<ProbeResult | undefined>;

/** `.pi/forge` config: `type=github|gitlab`, optional `host=…`. */
export interface ForgeConfig {
  type: "github" | "gitlab";
  host?: string;
}

/**
 * Everything detectForge hands to downstream modules (S2's forge.ts needs
 * more than the type: the resolved host for `glab -R` / project lookups).
 */
export interface ForgeDetection {
  forge: ForgeType;
  /**
   * The resolved host. For env/config/known-host cases this is the host of
   * the URL parsed (or the config's host); for an unparseable URL with a
   * non-env forge this may be undefined — the type is authoritative.
   */
  host: string | undefined;
  /** The name of the remote that was used: "origin" | "upstream" | other. */
  remote: string | undefined;
  /** Which remote URL was classified, when one was parsed. */
  url: string | undefined;
  /** Where the answer came from. */
  source: "env" | "config" | "known-host" | "probe" | "unknown";
}

export interface DetectForgeOpts {
  /**
   * Shell executor (injected for tests; same signature the driver's git
   * helpers use — command string, not an argv array, mirroring
   * `memory-panel.ts`'s `execp`).
   */
  execFn?: typeof execp;
  /** The environment to read `PI_ENSEMBLE_FORGE` from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** The environment to read `CI` / `PI_ENSEMBLE_FORGE_PROBE` from. */
  probeEnv?: Record<string, string | undefined>;
  /** Injected `.pi/forge` content; `undefined` reads the file from disk. */
  forgeConfigContent?: string;
  /** Injectable probe fn; `undefined` means "use the default, gated by shouldProbe". */
  probe?: ProbeFn;
  /** Force-enable or force-disable the probe, overriding `shouldProbe`. */
  allowProbe?: boolean;
}

const FORGE_ENV_KEY = "PI_ENSEMBLE_FORGE";

/**
 * The known-host table. Keyed on the bare host (lowercase, port stripped);
 * the lookup is case-insensitive by construction.
 */
const KNOWN_HOSTS: Record<string, ForgeType> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

/** Strip a trailing `:port` from a host. `gitlab.com:2222` → `gitlab.com`. */
export function stripPort(host: string): string {
  // Hostnames never contain a colon; scp-style ports appear as `:port`
  // after the last colon. Only strip a port that actually looks like one.
  const idx = host.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(host.slice(idx + 1))) return host.slice(0, idx);
  return host;
}

/**
 * Parse one remote URL into host + path (owner/repo).
 *
 * Handles the four forms from the spec:
 *   - `https://[user@]HOST[:port]/owner/repo(.git)`
 *   - `git@HOST:owner/repo(.git)`           (scp-style SSH)
 *   - `ssh://[user@]HOST[:port]/owner/repo(.git)`
 *   - `ssh://git@HOST:2222/owner/repo(.git)`
 *
 * Returns `undefined` for anything that is not one of these — fail-closed.
 */
export function parseRemoteUrl(
  url: string,
): { host: string; owner: string; repo: string } | undefined {
  const u = url.trim();
  if (!u) return undefined;

  // 1. URL with a scheme (https://, ssh://, git://, http://).
  const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
  if (scheme && scheme[1] !== undefined) {
    const rest = scheme[1]; // [user@]host[:port]/path
    // Find the first '/' after the authority — the path starts there.
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) return undefined; // no path — not owner/repo
    const authority = rest.slice(0, slashIdx);
    const path = rest.slice(slashIdx + 1);
    // authority = [user@]host[:port]
    const atIdx = authority.lastIndexOf("@");
    const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    const host = stripPort(hostPort).toLowerCase();
    if (!host) return undefined;
    const or = parseOwnerRepo(path);
    if (!or) return undefined;
    return { host, owner: or.owner, repo: or.repo };
  }

  // 2. scp-style: user@host:owner/repo(.git)
  const scp = u.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+(?:\.[A-Za-z0-9-]+)*):(.+)$/);
  if (scp && scp[1] !== undefined && scp[2] !== undefined) {
    const host = scp[1].toLowerCase();
    const or = parseOwnerRepo(scp[2]);
    if (!or) return undefined;
    return { host, owner: or.owner, repo: or.repo };
  }

  return undefined;
}

/** `owner/repo(.git)` → {owner, repo}. Trailing slash and .git tolerated. */
function parseOwnerRepo(path: string): { owner: string; repo: string } | undefined {
  const p = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = p.match(/^([^/]+)\/([^/]+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return undefined;
  return { owner: m[1], repo: m[2] };
}

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
 * Read the `.pi/forge` config file.
 *
 * Format (one `key=value` per line, `#` comments):
 * ```
 * type=gitlab
 * host=gitlab.mycompany.com
 * ```
 * Returns `undefined` for a missing file, malformed `type`, or empty file.
 */
export function parseForgeConfig(content: string): ForgeConfig | undefined {
  const lines = content.split("\n");
  let type: "github" | "gitlab" | undefined;
  let host: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === "type") {
      if (value === "github" || value === "gitlab") type = value;
      // unknown type → ignore the line
    } else if (key === "host") {
      if (value) host = value;
    }
  }
  if (!type) return undefined;
  return host ? { type, host } : { type };
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
const defaultProbe: ProbeFn = async (
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

/**
 * Resolve which remote to use: `origin` → `upstream` → first remote.
 *
 * Returns `{ remote, url }` or `undefined` if no remotes exist.
 */
async function resolveRemote(
  execFn: typeof execp,
  cwd: string,
): Promise<{ remote: string; url: string } | undefined> {
  const urlOf = async (name: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFn(`git config --get remote.${name}.url`, {
        cwd,
        maxBuffer: 64 * 1024,
      });
      const url = stdout.trim();
      return url || undefined;
    } catch {
      return undefined;
    }
  };
  for (const name of ["origin", "upstream"]) {
    const url = await urlOf(name);
    if (url) return { remote: name, url };
  }
  // Fall back to the first remote in `git remote` order.
  try {
    const { stdout } = await execFn("git remote", { cwd, maxBuffer: 64 * 1024 });
    const first = stdout.trim().split("\n")[0]?.trim();
    if (first) {
      const url = await urlOf(first);
      if (url) return { remote: first, url };
    }
  } catch {
    /* no remotes at all */
  }
  return undefined;
}

/**
 * The main entry point. See the module header for the resolution precedence.
 *
 * `repoRoot` is the directory the git commands run in. Every failure path
 * (no remotes, unparseable URL, unreadable config) lands on `unknown` —
 * never a guess.
 */
export async function detectForge(
  repoRoot: string,
  opts: DetectForgeOpts = {},
): Promise<ForgeDetection> {
  const execFn = opts.execFn ?? execp;
  const env = opts.env ?? process.env;
  const probeEnv = opts.probeEnv ?? env;

  // 1. Hard override: PI_ENSEMBLE_FORGE. Wins over config, remote, everything.
  const envForge = env[FORGE_ENV_KEY]?.trim().toLowerCase();
  if (envForge) {
    if (envForge === "github" || envForge === "gitlab") {
      // Still try to parse the remote for host/owner/repo context (best-effort).
      const remote = await resolveRemote(execFn, repoRoot);
      const parsed = remote?.url ? parseRemoteUrl(remote.url) : undefined;
      return {
        forge: envForge,
        host: parsed?.host ?? undefined,
        remote: remote?.remote,
        url: remote?.url,
        source: "env",
      };
    }
    // Unrecognized env value — fall through to the normal resolution rather
    // than silently guessing. The env var is a hard override *only* when it
    // names a known forge.
    trace(`forge-detect: unrecognized ${FORGE_ENV_KEY}="${envForge}", ignoring`);
  }

  // 2. .pi/forge config file.
  let config: ForgeConfig | undefined;
  try {
    if (opts.forgeConfigContent !== undefined) {
      config = parseForgeConfig(opts.forgeConfigContent);
    } else {
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(`${repoRoot}/.pi/forge`, "utf8");
      config = parseForgeConfig(raw);
    }
  } catch {
    config = undefined; // no config file, or unreadable — fall through
  }

  // 3. Resolve the remote URL.
  const remote = await resolveRemote(execFn, repoRoot);
  const parsed = remote?.url ? parseRemoteUrl(remote.url) : undefined;
  const host = parsed?.host;

  // 4. Known-host table (github.com, gitlab.com — case-insensitive, port ignored).
  if (host && remote) {
    const known = KNOWN_HOSTS[host];
    if (known) {
      return {
        forge: known,
        host,
        remote: remote.remote,
        url: remote.url,
        source: "known-host",
      };
    }
  }

  // 5. .pi/forge config: self-hosted. The config names the forge type for
  //    the host in question. It wins over "unknown" — the operator wrote it
  //    down precisely because the known-host table does not.
  if (config) {
    // The config's host (if given) should match the remote's host for the
    // answer to be meaningful. If the config has no host, apply it unconditionally.
    if (config.host && host && config.host.toLowerCase() !== host) {
      // Config names a different host — it does not apply to this remote.
      trace(
        `forge-detect: .pi/forge host=${config.host} does not match remote host=${host}, ignoring config`,
      );
    } else {
      return {
        forge: config.type,
        host: config.host ?? host,
        remote: remote?.remote,
        url: remote?.url,
        source: "config",
      };
    }
  }

  // 6. Optional API probe for unknown hosts. Off in CI by default.
  if (host && remote) {
    const allowed = opts.allowProbe ?? shouldProbe(probeEnv);
    if (allowed) {
      const probeFn = opts.probe ?? defaultProbe;
      try {
        // The kind is a hint for the probe; the default probe ignores it
        // and confirms by response shape. An injected probe may use it.
        const result = await probeFn(host, "gitlab");
        if (result && result !== "unknown") {
          return {
            forge: result,
            host,
            remote: remote.remote,
            url: remote.url,
            source: "probe",
          };
        }
      } catch {
        // Probe failure → unknown. Fail-closed.
      }
    }
  }

  // 7. Fail-closed: unknown.
  return {
    forge: "unknown",
    host,
    remote: remote?.remote,
    url: remote?.url,
    source: "unknown",
  };
}
