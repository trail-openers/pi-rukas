/**
 * headless/build — which pi-rukas build is running (#1326), so a host can
 * tell whether a fix is in the build that produced a result instead of
 * inferring it from image labels.
 *
 * The commit is, in order: the marker the image build bakes into
 * `<installRoot>/.pi/pi-rukas-commit`; else the HEAD of the install root when
 * it is itself a git checkout (a dev tree); else null. It is only ever a full
 * 40-hex SHA, so a host can run `git merge-base --is-ancestor` on it safely;
 * the release version is reported separately, never in its place.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GIT_LOCATION_VARS } from "../git-env.ts";

/** The pi-rukas checkout this module runs from (extension/src/headless → root). */
export const INSTALL_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * Read the version baked into extension/package.json. `0.0.0` when the file
 * is missing or unreadable.
 */
export function readBuildVersion(pkgJsonPath?: string): string {
  const p = pkgJsonPath ?? path.join(INSTALL_ROOT, "extension", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Git environment variables removed from the checkout probe's child env.
 * Each one redirects a git command at some OTHER repository, and each is
 * honoured ahead of `-C <root>`:
 *
 *   - `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` — object database and
 *     work tree (`GIT_DIR` alone makes a non-checkout answer with some other
 *     repository's HEAD, the example-owner/pi-rukas#32 shape);
 *   - `GIT_INDEX_FILE` — which index a status/revision read consults;
 *   - `GIT_NAMESPACE` — rewrites every ref name before lookup;
 *   - `GIT_OBJECT_DIRECTORY` / `GIT_ALTERNATE_OBJECT_DIRECTORIES` — where
 *     objects are read from, so a foreign ODB answers `rev-parse HEAD`;
 *   - `GIT_CEILING_DIRECTORIES` — changes where git decides the repository
 *     ENDS, which is what `--show-toplevel` reports;
 *   - `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` — can set `core.worktree` /
 *     `extensions.*` and change what the probe resolves at all.
 *
 * They are inherited into a pi-rukas process by any harness that itself ran
 * inside a git hook or a `git -C` wrapper, so scrubbing them is what makes
 * the probe answer for `root` alone.
 */
const GIT_ENV_SCRUB = [
  ...GIT_LOCATION_VARS,
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
];

/**
 * Read the commit baked into `<root>/.pi/pi-rukas-commit` by the image build.
 * `null` when the file is missing, empty or not a 40-hex SHA — never a
 * fabricated or partial string.
 */
export function readBakedCommit(root: string): string | null {
  try {
    const raw = readFileSync(path.join(root, ".pi", "pi-rukas-commit"), "utf8")
      .trim()
      .toLowerCase();
    return SHA.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * HEAD of `root` when `root` is the top of its own git checkout. A root that
 * merely sits inside some other repository reports `null`, not that
 * repository's HEAD.
 */
export function readCheckoutCommit(root: string): string | null {
  try {
    // The git environment can point every one of these probes at another
    // repository (GIT_DIR/GIT_WORK_TREE are honoured ahead of `-C` for the
    // object database and the work tree). They are removed from the child env
    // so the probe answers for `root` alone — an inherited GIT_DIR otherwise
    // makes a non-checkout report some other repository's HEAD.
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const name of GIT_ENV_SCRUB) delete env[name];
    const out = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env,
    });
    const [top, head] = out.trim().split("\n");
    if (!top || !head) return null;
    // macOS publishes $TMPDIR (and /tmp) through symlinks: `--show-toplevel`
    // canonicalises ("/private/var/…") where the caller passed "/var/…", so
    // both sides are realpath'd before comparing — a plain string compare
    // misreads a checkout as "merely inside some other repository". Each side
    // is realpath'd ONCE, and a side whose realpath throws falls back to
    // `resolve` for that side only; when both throw, the uncanonicalised
    // strings are all that is left to compare.
    const realpathOr = (p: string): string | null => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    };
    const want = realpathOr(root) ?? path.resolve(root);
    const got = realpathOr(top) ?? path.resolve(top);
    if (want !== got) return null;
    return SHA.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** The commit this build was made from, or `null` when nothing records it. */
export function readBuildCommit(root: string = INSTALL_ROOT): string | null {
  return readBakedCommit(root) ?? readCheckoutCommit(root);
}
