/**
 * headless/build — which pi-rukas build is running (#1326), so a host can
 * tell whether a fix is in the build that produced a result instead of
 * inferring it from image labels.
 *
 * The commit is, in order: the marker the image build bakes into
 * `<installRoot>/.pi/pi-rukas-commit`; else the HEAD of the install root when
 * it is itself a git checkout (a dev tree); else none. `buildCommit` falls
 * back to the release (`v<version>`) so a result always names its build.
 */

import { execFileSync } from "node:child_process";
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

/**
 * Read the commit baked into `<root>/.pi/pi-rukas-commit` by the image build.
 * `null` when the file is missing or empty — never a fabricated string.
 */
export function readBakedCommit(root: string): string | null {
  try {
    const raw = readFileSync(path.join(root, ".pi", "pi-rukas-commit"), "utf8").trim();
    return raw.length > 0 ? raw : null;
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
    const out = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    const [top, head] = out.trim().split("\n");
    if (!top || !head || path.resolve(top) !== path.resolve(root)) return null;
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** The commit this build was made from, or `null` when nothing records it. */
export function readBuildCommitSha(root: string = INSTALL_ROOT): string | null {
  return readBakedCommit(root) ?? readCheckoutCommit(root);
}

/** The commit, else `v<version>`: always names the build. */
export function readBuildCommit(root: string = INSTALL_ROOT): string {
  return (
    readBuildCommitSha(root) ?? `v${readBuildVersion(path.join(root, "extension", "package.json"))}`
  );
}
