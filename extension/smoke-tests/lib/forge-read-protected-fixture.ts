/**
 * forge-read-protected-fixture.ts — the fixture home the #2638 forge-config
 * read rows are written against.
 *
 * The rule being judged is "a helper child cannot read the operator's forge
 * config directories", so the fixture IS an operator home: a `mkdtemp` tree
 * outside the suite's own HOME carrying FAKE gh and glab config files whose
 * contents are sentinel strings. **No real credential file is ever opened** —
 * the bug this suite pins is a child reading the operator's own `hosts.yml`
 * and `config.yml`, so every row points the resolvers at this tree through the
 * env the parent hands down (`protectedForgePathsFrom`).
 *
 * The canary is the second half of the fixture: a SECOND home, under a name the
 * parent's environment never mentions, whose credential file only the passwd entry
 * reaches. It is built as a sibling of the operator home (both under one `mkdtemp`
 * tree) rather than under the suite process's own `homedir()`, for two reasons: the
 * verify runner owns that home and its realpath is not ours to reason about, and a
 * canary inside a tree the fixture already protects proves nothing. The canary home
 * is passed to the resolver as the passwd entry (`ForgeHomes.passwdHome`), which is
 * how production reaches it too.
 *
 * Its `.config` is a SYMLINK into a third tree that holds the real files, so the
 * canary has two spellings — the typed one under the passwd home, and the resolved
 * one outside it. A row reads each, pinning that the guard judges BOTH: an
 * implementation that protected only the lexical form misses the resolved spelling,
 * and one that protected only the realpath misses the typed one.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The fake token in gh's credential file. Never a real token, always findable. */
export const GH_TOKEN_SENTINEL = "FAKE-OPERATOR-GH-TOKEN-do-not-rotate";

/** The fake token in glab's credential file. */
export const GLAB_TOKEN_SENTINEL = "FAKE-OPERATOR-GLAB-TOKEN-do-not-rotate";

/**
 * The directory name that makes the second home a passwd home: no `HOME`, `XDG_*`
 * or `*_CONFIG_DIR` in the fixture's env contains it, so only the passwd entry does.
 */
export const PASSWD_HOME_NAME = "passwd-entry";

/** The passwd-home canary's content. */
export const PASSWD_CANARY_SENTINEL = "FAKE-PASSWD-HOME-GH-TOKEN-do-not-rotate";

export interface ForgeFixture {
  /** The mkdtemp root. */
  root: string;
  /** The fake operator home. */
  home: string;
  /** The fake XDG config home (under `home`). */
  xdg: string;
  /** `<xdg>/gh` — the gh config dir the fixture's env names. */
  gh: string;
  /** `<xdg>/glab-cli` — the glab config dir the fixture's env names. */
  glab: string;
  /** gh's two credential files. */
  ghFiles: string[];
  /** glab's credential file. */
  glabFiles: string[];
  /** The SECOND home: the tree the parent's env never names, passed as the passwd entry. */
  passwdHome: string;
  /** The canary's gh credential file, at the spelling through the passwd home. */
  canaryTypedFile: string;
  /** The same file at its resolved spelling, which lies OUTSIDE `passwdHome`. */
  canaryLinkedFile: string;
  /** `canaryTypedFile`, kept for the rows that only need "the canary". */
  canaryFile: string;
}

/** The env a non-ops child's strip puts its own config roots on: an empty dir. */
export function childForgeDirUnder(root: string): string {
  const dir = path.join(root, "child-forge-empty");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Build one row's fixture: a fake operator home with FAKE forge configs, plus
 * the passwd-home canary the guard must judge without being told where it is.
 *
 * The canary is written under the process's REAL passwd home (`homedir()` — the
 * value the parent's `os.homedir()` answers, which under the verify runner is the
 * isolated home it exports) at `pi-rukas-2638-canary/hosts.yml`, and removed on
 * the row's cleanup. A guard that resolved the home from the child's env — or that
 * only protected what the env named — never produces that path, and the row that
 * reads it stays green with the passwd half of the rule deleted.
 */
export function buildForgeFixture(tag: string): ForgeFixture {
  const root = mkdtempSync(path.join(tmpdir(), `pi-2638-${tag}-`));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "operator-home");
  const xdg = path.join(home, ".config");
  const gh = path.join(xdg, "gh");
  const glab = path.join(xdg, "glab-cli");
  const ghFiles = [path.join(gh, "config.yml"), path.join(gh, "hosts.yml")];
  const glabFiles = [path.join(glab, "config.yml")];
  mkdirSync(gh, { recursive: true });
  mkdirSync(glab, { recursive: true });
  writeFileSync(ghFiles[0] as string, "editor: nano\n");
  writeFileSync(ghFiles[1] as string, `github.com:\n    oauth_token: ${GH_TOKEN_SENTINEL}\n`);
  writeFileSync(
    glabFiles[0] as string,
    `host:\n  gitlab.com:\n    token: ${GLAB_TOKEN_SENTINEL}\n`,
  );
  // The second home, named so no variable in the fixture's env can produce it. The
  // token files live in a THIRD tree and the home's `.config` is a link into it, so
  // the canary is reachable by two spellings and the guard has to know both.
  const passwdHome = path.join(root, PASSWD_HOME_NAME, "home");
  const linked = path.join(root, "passwd-config-target");
  const canaryFile = path.join(linked, "gh", "hosts.yml");
  mkdirSync(path.join(linked, "gh"), { recursive: true });
  mkdirSync(path.join(linked, "glab-cli"), { recursive: true });
  writeFileSync(canaryFile, `github.com:\n    oauth_token: ${PASSWD_CANARY_SENTINEL}\n`);
  writeFileSync(
    path.join(linked, "glab-cli", "config.yml"),
    `host:\n  gitlab.com:\n    token: ${GLAB_TOKEN_SENTINEL}\n`,
  );
  mkdirSync(passwdHome, { recursive: true });
  symlinkSync(linked, path.join(passwdHome, ".config"));
  return {
    root,
    home,
    xdg,
    gh,
    glab,
    ghFiles,
    glabFiles,
    passwdHome,
    canaryFile,
    canaryLinkedFile: canaryFile,
    canaryTypedFile: path.join(passwdHome, ".config", "gh", "hosts.yml"),
  };
}

/** The parent env a row pins so the resolvers name this fixture. */
export function forgeParentEnv(fx: ForgeFixture): Record<string, string> {
  return {
    HOME: fx.home,
    XDG_CONFIG_HOME: fx.xdg,
    GH_CONFIG_DIR: fx.gh,
    GLAB_CONFIG_DIR: fx.glab,
  };
}
