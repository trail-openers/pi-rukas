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

import { execp } from "./exec.ts";
import { defaultProbe, shouldProbe } from "./forge-probe.ts";
import { trace } from "./trace.ts";

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
  /** The per-call bound on the remote-resolution git calls (default `FORGE_EXEC_TIMEOUT_MS`). */
  execTimeoutMs?: number;
}

/**
 * The bound on each forge-side exec the merge guard waits on (#962) — the
 * remote-resolution git calls here, and the guard's gh/glab/git reads
 * (merge-target.ts, merge-guard.ts). A stalled call must not hang the
 * tool_call hook; a git call that times out resolves no remote, and no
 * remote is an unknown forge — which the guard refuses.
 */
export const FORGE_EXEC_TIMEOUT_MS = 30_000;

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
 * A parsed remote: the host it names and every namespace segment of its path,
 * with any `.git` suffix and trailing separators dropped. `path` is the whole
 * namespace — `["group", "sub", "project"]`, not a two-field owner/repo — so a
 * caller that needs the repository slug takes the last segment and the rest.
 */
export interface ParsedRemote {
  host: string;
  path: string[];
}

/**
 * The forge whose depth rule applies to a path. `undefined` means the caller
 * does not know yet — it gets the host and the path and applies its own rule.
 */
export type ForgeArg = "github" | "gitlab";

/** A path segment both forges and git accept — the same grammar as the identity
 * rules in `plan-target.ts`, which is a separate surface with its own reasons
 * to refuse a string. */
const isSegment = (s: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);

/** The shallowest path that names a repository, and the deepest we accept. */
const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 5;

/**
 * Parse one remote URL into host + namespace path.
 *
 * Handles the four forms from the spec:
 *   - `https://[user@]HOST[:port]/path(.git)`
 *   - `git@HOST:path(.git)`                   (scp-style SSH)
 *   - `ssh://[user@]HOST[:port]/path(.git)`
 *   - `ssh://git@HOST:2222/path(.git)`
 *
 * How deep the path may be is the forge's rule, not the URL's. GitHub
 * publishes one repository per owner, so a GitHub path is exactly
 * `owner/repo`; GitLab nests projects under arbitrarily deep subgroups, so a
 * GitLab (or unknown-host) path may run two to five segments. A caller that
 * knows the forge passes it; one that does not gets the host and the path and
 * applies the rule itself — which is what `detectForge` does, since its own
 * resolution order decides the type only after the host parsed.
 *
 * Returns `undefined` for anything that is not one of these forms, or whose
 * path fails the depth bound or the segment grammar — fail-closed.
 */
export function parseRemoteUrl(url: string, forge?: ForgeArg): ParsedRemote | undefined {
  const u = url.trim();
  if (!u) return undefined;

  // 1. URL with a scheme (https://, ssh://, git://, http://).
  const scheme = u.match(/^[a-z][a-z0-9+.-]*:\/\/(.+)$/i);
  if (scheme && scheme[1] !== undefined) {
    const rest = scheme[1]; // [user@]host[:port]/path
    // Find the first '/' after the authority — the path starts there.
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) return undefined; // no path — not a repository URL
    const authority = rest.slice(0, slashIdx);
    const path = rest.slice(slashIdx + 1);
    // authority = [user@]host[:port]
    const atIdx = authority.lastIndexOf("@");
    const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
    const host = stripPort(hostPort).toLowerCase();
    if (!host) return undefined;
    const segments = parseNamespace(path, forge, host);
    if (!segments) return undefined;
    return { host, path: segments };
  }

  // 2. scp-style: user@host:group/sub/project(.git)
  const scp = u.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+(?:\.[A-Za-z0-9-]+)*):(.+)$/);
  if (scp && scp[1] !== undefined && scp[2] !== undefined) {
    const host = scp[1].toLowerCase();
    const segments = parseNamespace(scp[2], forge, host);
    if (!segments) return undefined;
    return { host, path: segments };
  }

  return undefined;
}

/**
 * `a/b/c(.git)` → every segment, or `undefined` when the path is not a
 * repository path on this forge. Trailing slash and `.git` tolerated; a
 * doubled slash yields an empty segment and therefore nothing.
 *
 * `host` is needed alongside `forge` because GitHub's one-repository-per-owner
 * rule is a fact about the site, not about what the caller believes: an
 * unqualified parse of a github.com URL is held to the GitHub rule, and a
 * caller that passes `forge` deliberately overrides it (that is the whole point
 * of the parameter).
 */
function parseNamespace(
  path: string,
  forge: ForgeArg | undefined,
  host: string,
): string[] | undefined {
  const p = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  const segments = p.split("/");
  if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) return undefined;
  if (!segments.every(isSegment)) return undefined;
  const githubish = forge === undefined ? host === "github.com" : forge === "github";
  if (githubish && segments.length !== MIN_SEGMENTS) return undefined;
  return segments;
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
 * Resolve which remote to use: `origin` → `upstream` → first remote.
 *
 * Returns `{ remote, url }` or `undefined` if no remotes exist.
 */
async function resolveRemote(
  execFn: typeof execp,
  cwd: string,
  timeoutMs: number,
): Promise<{ remote: string; url: string } | undefined> {
  // The timeout is passed to the exec AND raced here: an exec that ignores
  // it (or never settles) still cannot outlive the bound (#962).
  const git = (cmd: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([
      execFn(cmd, { cwd, maxBuffer: 64 * 1024, timeout: timeoutMs }),
      deadline,
    ]).finally(() => clearTimeout(timer));
  };
  const urlOf = async (name: string): Promise<string | undefined> => {
    try {
      const { stdout } = await git(`git config --get remote.${name}.url`);
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
    const { stdout } = await git("git remote");
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
  const timeoutMs = opts.execTimeoutMs ?? FORGE_EXEC_TIMEOUT_MS;
  const env = opts.env ?? process.env;
  const probeEnv = opts.probeEnv ?? env;

  // 1. Hard override: PI_ENSEMBLE_FORGE. Wins over config, remote, everything.
  const envForge = env[FORGE_ENV_KEY]?.trim().toLowerCase();
  if (envForge) {
    if (envForge === "github" || envForge === "gitlab") {
      // Still try to parse the remote for host/owner/repo context (best-effort).
      const remote = await resolveRemote(execFn, repoRoot, timeoutMs);
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
  const remote = await resolveRemote(execFn, repoRoot, timeoutMs);
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
