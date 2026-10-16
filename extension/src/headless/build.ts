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
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_NAMESPACE",
      "GIT_COMMON_DIR",
    ])
      delete env[name];
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
    // misreads a checkout as "merely inside some other repository".
    try {
      if (path.resolve(fs.realpathSync(top)) !== path.resolve(fs.realpathSync(root))) return null;
    } catch {
      if (path.resolve(top) !== path.resolve(root)) return null;
    }
    return SHA.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** The commit this build was made from, or `null` when nothing records it. */
export function readBuildCommit(root: string = INSTALL_ROOT): string | null {
  return readBakedCommit(root) ?? readCheckoutCommit(root);
}
