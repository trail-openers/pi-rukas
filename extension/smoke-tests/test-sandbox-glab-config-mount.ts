#!/usr/bin/env bun
/**
 * Sandbox glab config continuity — #2236.
 *
 * The image ships `glab` (.devcontainer/Dockerfile installs the release deb and
 * asserts `command -v glab`), but the wrapper mounted no glab config, so a
 * GitLab project's sandbox had nothing behind its GitLab CLI while the GitHub
 * path got both a `~/.config/gh` bind and a `GH_TOKEN`. This gate pins the
 * GitLab half of that symmetry:
 *
 *   1. The wrapper resolves the host glab config dir the way a shell does —
 *      absolute `GLAB_CONFIG_DIR`, else absolute `XDG_CONFIG_HOME/glab-cli`,
 *      else `$HOME/.config/glab-cli` — and IGNORES a relative value in either
 *      override. A relative source would classify as a NAMED VOLUME in
 *      `run_container`'s mount parser (a source with no `/` is a volume) and
 *      land on `PI_ENSEMBLE_VOLUME_MOUNTS`, where the image entrypoint treats it
 *      as repairable.
 *   2. With the dir present it is bind-mounted read-only at `.config/glab-cli`
 *      under the container home, and `GLAB_CONFIG_DIR` is exported as exactly
 *      that container path — appended AFTER the env passthrough, so a host value
 *      cannot point the container's glab at a host path. No dir: no mount row
 *      and no variable, leaving the container's own default in force.
 *   3. GitLab auth rides the wholesale passthrough — `GITLAB_TOKEN` and
 *      `GITLAB_HOST` reach the container once each. `glab` prints no token, so
 *      there is deliberately no extraction: a keychain-only host login does not
 *      reach the container, and the docs say so.
 *   4. `GITLAB_CI` is on the exact-match blocklist, so a host export cannot
 *      switch the container's glab to CI job-token auth. Only that exact name —
 *      `GITLAB_CI_*` job variables are unbounded and keep flowing.
 *
 * The extracted body is run with the comment lines stripped: it documents the
 * `PI_ENSEMBLE_*` pattern it deliberately does NOT read, and a text check for
 * "no new knob" must read the code, not the prose.
 *
 * Method (same shape as test-pi-min-version.ts and the host-alias probe in
 * test-headless-inputs-wrapper.ts): the bodies are extracted from
 * `bin/lib-pi-rukas-shell.sh` by their `# >>> glab-config` / `# <<< glab-config`
 * markers and prepended to the offline driver script
 * (`lib/sandbox-glab-driver.sh`), which is then run in a fresh bash with a
 * scratch HOME, a scratch XDG_CONFIG_HOME and a stub PATH carrying a fake `gh`.
 * The driver's env path reproduces build_env's passthrough with the wrapper's
 * OWN `blocklist_exact` string read out of bin/pi-rukas, so the drop list cannot
 * drift from the real one. The wrapper itself is never executed: no docker, no
 * network, no host `gh` consulted.
 *
 * Canaries: a relative override must still resolve to the `$HOME` default, the
 * passthrough probe must drop a listed name and keep an unlisted one, and the
 * env body must emit nothing without a config dir — so the real-file assertions
 * cannot pass vacuously on a probe that produced no rows either way.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const WRAPPER = path.join(REPO_ROOT, "bin", "pi-rukas");
const SHELL_LIB = path.join(REPO_ROOT, "bin", "lib-pi-rukas-shell.sh");
const DRIVER_TEMPLATE = path.join(import.meta.dirname, "lib", "sandbox-glab-driver.sh");

const OPEN_MARKER = "# >>> glab-config";
const CLOSE_MARKER = "# <<< glab-config";

/** The container home, as the wrapper's gh mount row writes it. */
const CONTAINER_HOME = "/home/vscode";
const GLAB_CONTAINER_DIR = `${CONTAINER_HOME}/.config/glab-cli`;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The lines strictly between the glab-config markers in bin/lib-pi-rukas-shell.sh.
 * Throws when a marker is missing, duplicated or out of order — a refactor that
 * moves or renames the bodies has to move the markers deliberately.
 */
function extractGlabBlock(source: string): string {
  const lines = source.split("\n");
  const opens = lines
    .map((l, i) => (l.trimStart().startsWith(OPEN_MARKER) ? i : -1))
    .filter((i) => i !== -1);
  const closes = lines
    .map((l, i) => (l.trimStart().startsWith(CLOSE_MARKER) ? i : -1))
    .filter((i) => i !== -1);
  if (opens.length !== 1 || closes.length !== 1) {
    throw new Error(
      `glab-config markers in bin/lib-pi-rukas-shell.sh are not exactly one pair (opens=${opens.length}, closes=${closes.length}) — update the script and this test deliberately`,
    );
  }
  const start = opens[0] as number;
  const end = closes[0] as number;
  if (end < start) {
    throw new Error(
      `glab-config markers out of order in bin/lib-pi-rukas-shell.sh (open=${start}, close=${end})`,
    );
  }
  const body = lines.slice(start + 1, end).join("\n");
  for (const required of ["build_glab_mount()", "build_glab_env()", "_glab_config_dir()"]) {
    if (!body.includes(required)) {
      throw new Error(`glab-config block in bin/lib-pi-rukas-shell.sh is missing ${required}`);
    }
  }
  return body;
}

/** `source` without its comment lines — the prose explains what the code does
 * NOT do, so checks on the code must not see it. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * The exact-match blocklist the wrapper applies to the host env, read out of
 * bin/pi-rukas rather than copied — so a name added to or dropped from the real
 * list moves this probe too, instead of leaving a copy green either way.
 */
function blocklistExact(wrapper: string): string[] {
  const raw = wrapper.match(/^\s*local blocklist_exact="([^"]*)"/m)?.[1];
  if (raw === undefined) throw new Error("bin/pi-rukas: blocklist_exact not found — renamed or removed");
  return raw
    .trim()
    .split(/\s+/)
    .filter((n) => n !== "");
}

const shellLib = readFileSync(SHELL_LIB, "utf8");
const wrapper = readFileSync(WRAPPER, "utf8");
const block = extractGlabBlock(shellLib);
const blocklist = blocklistExact(wrapper);

const TMP = mkdtempSync(path.join(os.tmpdir(), "pi-rukas-glab-"));

/** The driver template with the live body spliced in, plus the blocklist export. */
function writeDriver(): string {
  const template = readFileSync(DRIVER_TEMPLATE, "utf8");
  const o = template.indexOf("# >>> driver-body");
  const c = template.indexOf("# <<< driver-body");
  if (o === -1 || c === -1 || c < o) {
    throw new Error("lib/sandbox-glab-driver.sh is missing its driver-body markers");
  }
  const file = path.join(TMP, "glab-driver.sh");
  writeFileSync(file, `${block}\n${template}`);
  chmodSync(file, 0o755);
  return file;
}

/** A PATH with a fake `gh` that always answers a token: the untouched gh branch must still run. */
function stubbedPath(): string {
  const bin = path.join(TMP, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, "gh");
  writeFileSync(
    exe,
    '#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = token ]; then echo stub-gh-token; exit 0; fi\nexit 1\n',
  );
  chmodSync(exe, 0o755);
  return `${bin}:${process.env.PATH}`;
}

const DRIVER = writeDriver();
const STUB_PATH = stubbedPath();

/** Names the wrapper would otherwise inherit from the runner's own environment
 * and silently decide a case with: each is unset unless the case sets it. The
 * `?? undefined` makes an explicit `delete` in the case's own object mean "unset
 * this name" rather than "inherit it" — a plain spread cannot remove a key. */
const ALWAYS_UNSET = ["GLAB_CONFIG_DIR", "XDG_CONFIG_HOME", "GITLAB_TOKEN", "GITLAB_HOST", "GITLAB_CI"];

/** Run one driver verb in a fresh bash; returns the rows it emitted. */
function run(verb: string, env: Record<string, string | undefined>): string[] {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...Object.fromEntries(ALWAYS_UNSET.map((n) => [n, undefined])),
    ...env,
    PATH: STUB_PATH,
    __BL: ` ${blocklist.join(" ")} `,
  };
  for (const name of ALWAYS_UNSET) if (merged[name] === undefined) delete merged[name];
  const r = spawnSync("bash", [DRIVER, verb], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: merged,
    timeout: 15_000,
  });
  if (r.error || r.status === null) {
    throw new Error(
      `glab probe (${verb}) did not run: ${r.error?.message ?? `signal ${r.signal}`}\n${r.stderr ?? ""}`,
    );
  }
  if (r.status !== 0) {
    throw new Error(`glab probe (${verb}) exited ${r.status}:\n${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").split("\n").filter((l) => l !== "");
}

/** The `-v` rows build_glab_mount appended, for a given host layout. */
function mountRows(opts: { home: string; xdg?: string; glabDir?: string }): string[] {
  const env: Record<string, string | undefined> = { HOME: opts.home };
  if (opts.xdg !== undefined) env.XDG_CONFIG_HOME = opts.xdg;
  if (opts.glabDir !== undefined) env.GLAB_CONFIG_DIR = opts.glabDir;
  return run("mount", env);
}

/** The container's `-e` rows for a host env, built the way build_env builds them. */
function envRows(host: Record<string, string>, home = HOME_WITH_GLAB): string[] {
  return run("env", { ...host, HOME: home });
}

/** A host home that DOES carry a glab config dir — the layout most cases use. */
const HOME_WITH_GLAB = path.join(TMP, "home-with-glab");
mkdirSync(path.join(HOME_WITH_GLAB, ".config", "glab-cli"), { recursive: true });

/** The mount row the wrapper must emit for a host dir at `src`. */
function mountRow(src: string): string {
  return `-v ${src}:${GLAB_CONTAINER_DIR}:ro`;
}

// ------------------------------------------------------ (1) mount: dir present

{
  const rows = mountRows({ home: HOME_WITH_GLAB });
  assert(rows.includes(mountRow(`${HOME_WITH_GLAB}/.config/glab-cli`)), "an existing host glab config dir is bind-mounted read-only at the container home");
  assert(
    rows.every((r) => !r.includes(`${CONTAINER_HOME}/.config/gh`)),
    "the glab mount body does not touch the gh config mount",
  );
}

// ------------------------------------- (2) mount: no dir → no row (with control)

{
  const home = path.join(TMP, "home-without-glab");
  mkdirSync(path.join(home, ".config"), { recursive: true });
  assert(mountRows({ home }).length === 0, "no host glab config dir means no mount row");
  assert(
    mountRows({ home: HOME_WITH_GLAB }).length === 1,
    "control: the same probe emits exactly one row when the dir exists",
  );
}

// ------------------------- (3) absolute GLAB_CONFIG_DIR wins; relative ignored

{
  const custom = path.join(TMP, "custom-glab");
  mkdirSync(custom, { recursive: true });
  assert(
    mountRows({ home: HOME_WITH_GLAB, glabDir: custom }).includes(mountRow(custom)),
    "an absolute GLAB_CONFIG_DIR is the mounted source",
  );
  assert(
    mountRows({ home: HOME_WITH_GLAB, glabDir: "relative/glab" }).every((r) => !r.includes("relative/glab")),
    "a relative GLAB_CONFIG_DIR is ignored (a source without `/` would read as a named volume)",
  );
}

// ------------------- (4) absolute XDG_CONFIG_HOME/glab-cli, else $HOME/.config

{
  const xdg = path.join(TMP, "xdg-config");
  mkdirSync(path.join(xdg, "glab-cli"), { recursive: true });
  assert(
    mountRows({ home: HOME_WITH_GLAB, xdg }).includes(mountRow(`${xdg}/glab-cli`)),
    "an absolute XDG_CONFIG_HOME/glab-cli is the fallback source",
  );
  assert(
    mountRows({ home: HOME_WITH_GLAB, xdg: "relative/xdg" }).includes(
      mountRow(`${HOME_WITH_GLAB}/.config/glab-cli`),
    ),
    "a relative XDG_CONFIG_HOME falls back to $HOME/.config/glab-cli",
  );
}

// --------------------------------- (5) env: token + host once, GITLAB_CI out

{
  const rows = envRows({
    GITLAB_TOKEN: "glpat-host",
    GITLAB_HOST: "gitlab.example.com",
    GITLAB_CI: "true",
    GITLAB_CI_JOB_ID: "42",
  });
  assert(
    rows.filter((r) => r === "-e GITLAB_TOKEN=glpat-host").length === 1,
    "exactly one GITLAB_TOKEN row reaches the container",
  );
  assert(
    rows.filter((r) => r === "-e GITLAB_HOST=gitlab.example.com").length === 1,
    "exactly one GITLAB_HOST row reaches the container",
  );
  assert(rows.every((r) => r !== "-e GITLAB_CI=true"), "the exact GITLAB_CI switch is not forwarded");
  assert(
    rows.every((r) => !/^-e GITLAB_CI=/.test(r)),
    "no row sets GITLAB_CI at all (the blocklist entry is what keeps it out)",
  );
  assert(
    rows.some((r) => r === "-e GITLAB_CI_JOB_ID=42"),
    "GITLAB_CI_* job variables still ride the passthrough (only the exact name is dropped)",
  );
  assert(
    rows.some((r) => r === `-e GLAB_CONFIG_DIR=${GLAB_CONTAINER_DIR}`),
    `GLAB_CONFIG_DIR is exported as the container path (${GLAB_CONTAINER_DIR})`,
  );
  const tokenAt = rows.findIndex((r) => r.startsWith("-e GITLAB_TOKEN="));
  const glabCfgAt = rows.findIndex((r) => r.startsWith("-e GLAB_CONFIG_DIR="));
  assert(
    tokenAt >= 0 && glabCfgAt >= 0 && tokenAt < glabCfgAt,
    "GLAB_CONFIG_DIR is appended after the passthrough, so a host value cannot win",
  );
  assert(
    rows.some((r) => r === "-e GH_TOKEN=stub-gh-token"),
    "the untouched gh token extraction still contributes its GH_TOKEN row",
  );
  // A host GLAB_CONFIG_DIR is the resolver's INPUT — it decides WHICH host dir
  // gets mounted — but it must never be what the container is told. The single
  // `-e GLAB_CONFIG_DIR=` row has to carry the container path, and no row may
  // carry the host path: docker takes the LAST `-e` for a name, so a stray host
  // row would point the container's glab at a path that does not exist in it.
  const hostOnly = path.join(TMP, "host-only-glab");
  mkdirSync(hostOnly, { recursive: true });
  const override = run("env", { HOME: HOME_WITH_GLAB, GLAB_CONFIG_DIR: hostOnly });
  const glabRows = override.filter((r) => r.startsWith("-e GLAB_CONFIG_DIR="));
  assert(
    glabRows.length === 1 && glabRows[0] === `-e GLAB_CONFIG_DIR=${GLAB_CONTAINER_DIR}`,
    "a host GLAB_CONFIG_DIR yields exactly one row, carrying the container path",
  );
  assert(
    override.every((r) => !r.includes(hostOnly)),
    "the host glab path never reaches the container env",
  );
  // …and the mount that variable selected is the one that got bound.
  assert(
    mountRows({ home: HOME_WITH_GLAB, glabDir: hostOnly }).includes(mountRow(hostOnly)),
    "an absolute host GLAB_CONFIG_DIR is the dir that gets mounted",
  );
}

// ------------------------------- (6) the wrapper wires the bodies in, gh intact

{
  assert(/^\s*build_glab_mount$/m.test(wrapper), "build_mounts() calls build_glab_mount");
  assert(/^\s*build_glab_env$/m.test(wrapper), "build_env() calls build_glab_env");
  assert(
    /^\s*build_glab_mount$/m.test(wrapper.slice(0, wrapper.indexOf("build_env()"))),
    "the mount call sits inside build_mounts()",
  );
  assert(
    /^\s*build_glab_env$/m.test(wrapper.slice(wrapper.indexOf("build_env()"))),
    "the env call sits inside build_env()",
  );
  assert(
    wrapper.includes('mounts+=(-v "$HOME/.config/gh:/home/vscode/.config/gh:ro")'),
    "the literal gh mount row is unchanged",
  );
  assert(` ${blocklist.join(" ")} `.includes(" GITLAB_CI "), "GITLAB_CI is on the exact-match blocklist");
  assert(
    !/GITLAB_CI\*/.test(wrapper),
    "GITLAB_CI is not pattern-blocklisted (GITLAB_CI_* job variables keep flowing)",
  );
  assert(
    !/glab auth token/.test(wrapper) && !/glab auth token/.test(block),
    "no `glab auth token` extraction was added (glab prints no token)",
  );
  assert(!/\bgh auth token\b/.test(block), "the gh token extraction was not moved into the glab body");
  assert(
    !/PI_ENSEMBLE_[A-Z0-9_]+/.test(withoutComments(block)),
    "the glab body reads no PI_ENSEMBLE_* knob (no new wrapper variable)",
  );
}

// --------------------------------------------------------------------- canaries

{
  // A relative override must still resolve to the $HOME default — a resolver
  // that honoured it would emit the relative name as the source, and one that
  // rejected everything would emit nothing.
  const rows = mountRows({ home: HOME_WITH_GLAB, glabDir: "relative/glab" });
  assert(
    rows.length === 1 && rows[0] === mountRow(`${HOME_WITH_GLAB}/.config/glab-cli`),
    "canary: relative override resolves to exactly the $HOME default row",
  );

  // The passthrough probe drops a listed name and keeps an unlisted one, so the
  // GITLAB_CI assertions are the wrapper's own list deciding — not a probe that
  // produced no rows at all.
  const probe = envRows({ GITLAB_CI: "true", GITLAB_KEEP_ME: "yes" });
  assert(
    probe.every((r) => r !== "-e GITLAB_CI=true") && probe.some((r) => r === "-e GITLAB_KEEP_ME=yes"),
    "canary: the blocklist probe drops a listed name and keeps an unlisted one",
  );

  // With no host config dir the env body emits no row — the mount row and the
  // variable ship together or not at all.
  const noDir = path.join(TMP, "home-env-nodir");
  mkdirSync(path.join(noDir, ".config"), { recursive: true });
  assert(
    run("env-only", { HOME: noDir }).length === 0,
    "canary: the env body alone emits no row without a host glab dir",
  );
  assert(
    run("env-only", { HOME: HOME_WITH_GLAB }).length === 1,
    "canary: the env body alone emits the GLAB_CONFIG_DIR row with a host glab dir",
  );

  // The blocklist reader tells GITLAB_CI present from absent — an empty capture
  // would make the real-file assertion above vacuous.
  const extract = (text: string) => ` ${text.match(/local blocklist_exact="([^"]*)"/)?.[1] ?? ""} `;
  assert(
    !extract('local blocklist_exact=" PATH HOME SSH_AUTH_SOCK DOCKER_HOST "').includes(" GITLAB_CI ") &&
      extract('local blocklist_exact=" PATH HOME GITLAB_CI DOCKER_HOST "').includes(" GITLAB_CI "),
    "canary: the blocklist check tells GITLAB_CI present from absent",
  );

  // The marker extractor refuses a body without the pair, so a markerless
  // refactor cannot read as "no glab behaviour to test".
  const throws = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(throws(() => extractGlabBlock('echo "no markers here"')), "canary: a markerless body throws");
  assert(
    throws(() => extractGlabBlock(`${CLOSE_MARKER}\nx\n${OPEN_MARKER}`)),
    "canary: out-of-order markers throw",
  );
  assert(
    throws(() => extractGlabBlock(`${OPEN_MARKER}\n# nothing\n${CLOSE_MARKER}`)),
    "canary: a block missing the expected functions throws",
  );
}

console.log(exit === 0 ? "\nAll sandbox glab-config-mount checks passed." : "\nFAILED");
process.exit(exit);
