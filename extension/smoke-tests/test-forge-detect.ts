#!/usr/bin/env bun
/**
 * #609 — forge-detect: forge classification from git remote URLs.
 *
 * S1 of epic #608 (dual-forge support). All 8 spec-mandated acceptance
 * criteria plus the edge cases the test-surface catalogue calls out.
 * Fully offline: git output is injected via `opts.execFn` and the probe
 * via `opts.probe` — no network, no real git (the stub returns canned
 * stdout and throws on absent keys, mirroring `git config --get`'s
 * exit-1-on-missing behaviour).
 *
 * Harness pattern: pinned literals, no framework (test-clip-title.ts shape).
 */

import {
  type ForgeType,
  type ProbeFn,
  detectForge,
  isCI,
  parseForgeConfig,
  parseRemoteUrl,
  shouldProbe,
  stripPort,
} from "../src/forge-detect.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} — got ${a}${a === e ? "" : `, expected ${e}`}`);
}

// ---- Stub execFn: canned git output, no real git, no network.

/**
 * Answers `git config --get remote.<name>.url` and `git remote` from a map.
 * `git config --get` exits 1 on an absent key — promisify(exec) rejects —
 * so the stub throws too. Returning empty stdout would mean "remote exists
 * with an empty URL", which detectForge (correctly) treats differently.
 */
function gitStub(remotes: Record<string, string>) {
  const execFn = async (cmd: string): Promise<{ stdout: string; stderr?: string }> => {
    const m = cmd.match(/^git config --get remote\.([a-zA-Z0-9_-]+)\.url$/);
    if (m) {
      const name = m[1];
      if (remotes[name] !== undefined) return { stdout: `${remotes[name]}\n` };
      throw new Error(`git config: key not found: remote.${name}.url`);
    }
    if (cmd === "git remote") {
      return {
        stdout: Object.keys(remotes)
          .map((r) => `${r}\n`)
          .join(""),
      };
    }
    throw new Error(`unexpected git command in stub: ${cmd}`);
  };
  return { execFn: execFn as never, forgeConfigContent: "" };
}

const noEnv = { PI_ENSEMBLE_FORGE: undefined };
const noProbe = { probe: (async (): Promise<undefined> => undefined) as ProbeFn };
const probeGitlab = { probe: (async (): Promise<ForgeType> => "gitlab") as ProbeFn };

// ======================================================================
// parseRemoteUrl — the 4 URL forms from the spec
// ======================================================================

console.log("\n--- parseRemoteUrl ---");

eq(
  parseRemoteUrl("git@github.com:owner/repo.git"),
  { host: "github.com", owner: "owner", repo: "repo" },
  "github.com SSH scp-style",
);
eq(
  parseRemoteUrl("https://github.com/owner/repo.git"),
  { host: "github.com", owner: "owner", repo: "repo" },
  "github.com HTTPS with .git",
);
eq(
  parseRemoteUrl("https://github.com/owner/repo"),
  { host: "github.com", owner: "owner", repo: "repo" },
  "github.com HTTPS without .git",
);
eq(
  parseRemoteUrl("git@gitlab.com:owner/repo.git"),
  { host: "gitlab.com", owner: "owner", repo: "repo" },
  "gitlab.com SSH scp-style",
);
eq(
  parseRemoteUrl("https://gitlab.com/owner/repo"),
  { host: "gitlab.com", owner: "owner", repo: "repo" },
  "gitlab.com HTTPS",
);
eq(
  parseRemoteUrl("ssh://git@mygitlab.example.com:2222/owner/repo.git"),
  { host: "mygitlab.example.com", owner: "owner", repo: "repo" },
  "ssh:// with user and non-standard port",
);
eq(
  parseRemoteUrl("ssh://gitlab.example.com/owner/repo"),
  { host: "gitlab.example.com", owner: "owner", repo: "repo" },
  "ssh:// without user",
);
eq(
  parseRemoteUrl("ssh://git@HOST:2222/owner/repo"),
  { host: "host", owner: "owner", repo: "repo" },
  "ssh://git@HOST:2222 (spec example, host lowercased)",
);
eq(
  parseRemoteUrl("git://github.com/owner/repo.git"),
  { host: "github.com", owner: "owner", repo: "repo" },
  "git:// scheme",
);

// Fail-closed: unparseable inputs
eq(parseRemoteUrl(""), undefined, "empty string → undefined");
eq(parseRemoteUrl("not a url"), undefined, "garbage → undefined");
eq(parseRemoteUrl("https://github.com"), undefined, "https with no path → undefined");
eq(parseRemoteUrl("git@github.com:owner"), undefined, "scp-style with no /owner/repo → undefined");

// ======================================================================
// stripPort
// ======================================================================

console.log("\n--- stripPort ---");

eq(stripPort("github.com"), "github.com", "no port → unchanged");
eq(stripPort("gitlab.com:2222"), "gitlab.com", "strips :port");
eq(stripPort("host:notaport"), "host:notaport", "non-numeric suffix → left alone");

// ======================================================================
// parseForgeConfig — .pi/forge file format
// ======================================================================

console.log("\n--- parseForgeConfig ---");

eq(
  parseForgeConfig("type=gitlab\nhost=gitlab.mycompany.com"),
  { type: "gitlab", host: "gitlab.mycompany.com" },
  "type + host",
);
eq(parseForgeConfig("type=github"), { type: "github" }, "type only");
eq(
  parseForgeConfig("# comment\ntype=gitlab\n  host=gl.example.com  "),
  { type: "gitlab", host: "gl.example.com" },
  "comments and whitespace",
);
eq(parseForgeConfig(""), undefined, "empty file → undefined");
eq(parseForgeConfig("type=unknown-forge"), undefined, "unknown type → undefined");
eq(parseForgeConfig("host=foo.com"), undefined, "host without type → undefined");
eq(parseForgeConfig("type=GITLAB"), undefined, "type is case-sensitive (must be lowercase)");

// ======================================================================
// isCI + shouldProbe — the probe gating logic
// ======================================================================

console.log("\n--- isCI / shouldProbe ---");

eq(isCI({}), false, "no CI env → not CI");
eq(isCI({ CI: "" }), false, "CI='' → not CI");
eq(isCI({ CI: "false" }), false, "CI=false → not CI");
eq(isCI({ CI: "true" }), true, "CI=true → CI");
eq(isCI({ CI: "GitHub Actions" }), true, "CI='GitHub Actions' → CI");

eq(shouldProbe({}), true, "no env at all → probe allowed (local default)");
eq(shouldProbe({ CI: "true" }), false, "CI set → probe off by default");
eq(shouldProbe({ PI_ENSEMBLE_FORGE_PROBE: "0" }), false, "PI_ENSEMBLE_FORGE_PROBE=0 → hard off");
eq(shouldProbe({ PI_ENSEMBLE_FORGE_PROBE: "1" }), true, "PI_ENSEMBLE_FORGE_PROBE=1 → hard on");

// ======================================================================
// detectForge — the 8 spec-mandated acceptance criteria
// ======================================================================

console.log("\n--- detectForge: spec acceptance criteria ---");

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@github.com:owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "github", "AC1: github.com SSH → github");
  eq(r.source, "known-host", "AC1: source is known-host");
  eq(r.host, "github.com", "AC1: host is github.com");
  eq(r.remote, "origin", "AC1: remote is origin");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "https://github.com/owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "github", "AC2: github.com HTTPS → github");
  eq(r.source, "known-host", "AC2: source is known-host");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@gitlab.com:owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "gitlab", "AC3: gitlab.com SSH → gitlab");
  eq(r.source, "known-host", "AC3: source is known-host");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "https://gitlab.com/owner/repo" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "gitlab", "AC4: gitlab.com HTTPS → gitlab");
  eq(r.source, "known-host", "AC4: source is known-host");
}

// 5. Self-hosted GitLab via .pi/forge config
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@gitlab.mycompany.com:owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=gitlab\nhost=gitlab.mycompany.com",
    ...noProbe,
  });
  eq(r.forge, "gitlab", "AC5: self-hosted GitLab via .pi/forge → gitlab");
  eq(r.source, "config", "AC5: source is config");
  eq(r.host, "gitlab.mycompany.com", "AC5: host from config");
}

// 5b. .pi/forge with no host field applies unconditionally
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@selfhosted.example.org:owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=gitlab",
    ...noProbe,
  });
  eq(r.forge, "gitlab", "AC5b: .pi/forge type=gitlab (no host) → gitlab");
  eq(r.source, "config", "AC5b: source is config");
}

// 6. Unknown host → unknown (no probe available)
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@unknown-host.example.com:owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "unknown", "AC6: unknown host → unknown");
  eq(r.source, "unknown", "AC6: source is unknown");
  eq(r.host, "unknown-host.example.com", "AC6: host is still reported");
}

// 6b. No remotes at all → unknown
{
  const r = await detectForge("/fake", { ...gitStub({}), env: noEnv, ...noProbe });
  eq(r.forge, "unknown", "AC6b: no remotes → unknown");
  eq(r.remote, undefined, "AC6b: no remote name");
}

// 7. PI_ENSEMBLE_FORGE=gitlab overrides github.com remote
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@github.com:owner/repo.git" }),
    env: { PI_ENSEMBLE_FORGE: "gitlab" },
    ...noProbe,
  });
  eq(r.forge, "gitlab", "AC7: PI_ENSEMBLE_FORGE=gitlab overrides github.com");
  eq(r.source, "env", "AC7: source is env");
  eq(r.host, "github.com", "AC7: host is still the remote's host");
}

// 7c. Unrecognized env value falls through to normal resolution
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@github.com:owner/repo.git" }),
    env: { PI_ENSEMBLE_FORGE: "bitbucket" },
    ...noProbe,
  });
  eq(r.forge, "github", "AC7c: unrecognized env value falls through to known-host");
  eq(r.source, "known-host", "AC7c: source is known-host");
}

// ======================================================================
// detectForge — remote resolution precedence
// ======================================================================

console.log("\n--- detectForge: remote resolution ---");

// origin wins over upstream
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@github.com:o/r.git", upstream: "git@gitlab.com:o/r.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.remote, "origin", "origin preferred over upstream");
  eq(r.forge, "github", "origin's forge wins");
}

// upstream used when no origin
{
  const r = await detectForge("/fake", {
    ...gitStub({ upstream: "git@gitlab.com:o/r.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.remote, "upstream", "upstream used when no origin");
  eq(r.forge, "gitlab", "upstream's forge");
}

// first remote in `git remote` order when neither origin nor upstream exists
{
  const r = await detectForge("/fake", {
    ...gitStub({ fork: "git@github.com:o/r.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.remote, "fork", "first remote in git remote order (fork)");
  eq(r.forge, "github", "fork's forge");
}

// ======================================================================
// detectForge — probe path
// ======================================================================

console.log("\n--- detectForge: probe path ---");

// Probe is called for unknown hosts when allowed
{
  let probedHost: string | undefined;
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@selfhosted.example.com:owner/repo.git" }),
    env: noEnv,
    allowProbe: true,
    probe: async (host: string) => {
      probedHost = host;
      return "gitlab" as const;
    },
  });
  eq(r.forge, "gitlab", "probe result is used");
  eq(r.source, "probe", "source is probe");
  eq(probedHost, "selfhosted.example.com", "probe received the host");
}

// Probe returning undefined → unknown
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@selfhosted.example.com:owner/repo.git" }),
    env: noEnv,
    allowProbe: true,
    ...noProbe,
  });
  eq(r.forge, "unknown", "probe returning undefined → unknown");
}

// Probe throwing → unknown (fail-closed)
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@selfhosted.example.com:owner/repo.git" }),
    env: noEnv,
    allowProbe: true,
    probe: (async () => {
      throw new Error("network error");
    }) as ProbeFn,
  });
  eq(r.forge, "unknown", "probe throwing → unknown (fail-closed)");
}

// Probe disallowed (CI default) → unknown even though a probe is available
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@selfhosted.example.com:owner/repo.git" }),
    env: noEnv,
    allowProbe: false,
    ...probeGitlab,
  });
  eq(r.forge, "unknown", "probe disallowed (CI) → unknown");
}

// ======================================================================
// detectForge — .pi/forge config edge cases
// ======================================================================

console.log("\n--- detectForge: config edge cases ---");

// Config with mismatched host → config ignored, falls through to unknown
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@otherhost.example.com:owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=gitlab\nhost=expectedhost.example.com",
    ...noProbe,
  });
  eq(r.forge, "unknown", "config host mismatch → config ignored → unknown");
  eq(r.source, "unknown", "source is unknown");
}

// Config with matching host → config applies
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@gitlab.mycompany.com:owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=gitlab\nhost=gitlab.mycompany.com",
    ...noProbe,
  });
  eq(r.forge, "gitlab", "config host match → config applies");
  eq(r.source, "config", "source is config");
}

// type=github for self-hosted GitHub Enterprise
{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@ghe.example.com:owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=github\nhost=ghe.example.com",
    ...noProbe,
  });
  eq(r.forge, "github", "type=github for GHE self-hosted");
  eq(r.source, "config", "source is config");
}

// ======================================================================
// ForgeType export contract (S2 import assertion) — compile-time check
// ======================================================================

console.log("\n--- ForgeType export contract ---");

const t1: ForgeType = "github";
const t2: ForgeType = "gitlab";
const t3: ForgeType = "unknown";
assert(t1 + t2 + t3 === "githubgitlabunknown", "ForgeType is exported and importable");

// ======================================================================
// ssh://git@HOST:2222 (spec explicit) + case insensitivity + ports
// ======================================================================

console.log("\n--- ssh://git@HOST:2222 + case + port handling ---");

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "ssh://git@gitlab.mycompany.com:2222/owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "unknown", "ssh://git@selfhosted:2222 without config → unknown");
  eq(r.host, "gitlab.mycompany.com", "host parsed from ssh:// with user+port");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "ssh://git@gitlab.mycompany.com:2222/owner/repo.git" }),
    env: noEnv,
    forgeConfigContent: "type=gitlab\nhost=gitlab.mycompany.com",
    ...noProbe,
  });
  eq(r.forge, "gitlab", "ssh://git@selfhosted:2222 with config → gitlab");
  eq(r.source, "config", "source is config");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@GITHUB.COM:owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "github", "uppercase GITHUB.COM → github (case-insensitive)");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "git@GitLab.COM:owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "gitlab", "mixed-case GitLab.COM → gitlab (case-insensitive)");
}

{
  const r = await detectForge("/fake", {
    ...gitStub({ origin: "https://github.com:443/owner/repo.git" }),
    env: noEnv,
    ...noProbe,
  });
  eq(r.forge, "github", "github.com:443 → github (port ignored in lookup)");
  eq(r.host, "github.com", "host has port stripped");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
