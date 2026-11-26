/**
 * lib/opcfg-glab-cases.ts — the glab half of `test-operator-config-guard.ts`.
 *
 * The snapshot guard watched git's and gh's config files and no glab path, and
 * glab's `config.yml` is where its token lives — the exact file the #2638 field
 * report's child opened. The rows here are the three ways a child can leave that
 * file not as it found it, each of which the restore must undo and report:
 *
 *  - an OVERWRITE (`printf … > <glab config>`), restored byte-for-byte;
 *  - a SYMLINK SWAPPED IN place of it, which the guard must never write through —
 *    it replaces the entry, so the decoy's bytes are untouched and the operator's
 *    bytes come back as a regular file;
 *  - a DELETION, restored by recreation from the snapshot.
 *
 * The sentinel home and the protected-path list live here too, because the
 * entry file reads them as its table of what is guarded and this half needs the
 * same tree to hold a glab file at all.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withOperatorConfigGuard } from "../../src/spawn-operator-config.ts";
import type { DispatchResult } from "../../src/types.ts";
import { assert } from "./assert-rig.ts";
import { withEnv } from "./env-scope.ts";

// glab's credential file belongs to the set the way gh's does: the snapshot guard
// restores what a child changed, and glab's config.yml carries its token.
const PROTECTED = [
  ".gitconfig",
  ".config/git/config",
  ".config/gh/config.yml",
  ".config/gh/hosts.yml",
  ".config/glab-cli/config.yml",
];

/**
 * A sentinel home under $TMPDIR, with the protected paths either present
 * or absent as the case asks. **The real `~/.gitconfig` is never opened**: the
 * bug was a child writing the operator's actual file, so every case here runs
 * against this tree and passes it through the env `protectedPaths` reads.
 */
function sentinelHome(
  tag: string,
  present: readonly string[] = PROTECTED,
): { home: string; env: Record<string, string> } {
  const root = mkdtempSync(path.join(tmpdir(), `pi-opcfg-${tag}-`));
  const home = path.join(root, "home");
  const xdg = path.join(home, ".config");
  // Both parent directories always exist: a "create" case must be able to write
  // the file a child would create, while the file itself stays absent.
  mkdirSync(path.join(xdg, "git"), { recursive: true });
  mkdirSync(path.join(xdg, "gh"), { recursive: true });
  mkdirSync(path.join(xdg, "glab-cli"), { recursive: true });
  const contents: Record<string, string> = {
    [path.join(home, ".gitconfig")]: "[user]\n\tname = Operator\n",
    [path.join(xdg, "git", "config")]: "[core]\n\teditor = vim\n",
    [path.join(xdg, "gh", "config.yml")]: "editor: nano\n",
    [path.join(xdg, "gh", "hosts.yml")]: "github.com:\n    oauth_token: oper\n",
    [path.join(xdg, "glab-cli", "config.yml")]: "host:\n  gitlab.com:\n    token: oper\n",
  };
  for (const [file, text] of Object.entries(contents)) {
    if (!present.includes(path.relative(home, file))) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return {
    home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GH_CONFIG_DIR: path.join(xdg, "gh"),
      GLAB_CONFIG_DIR: path.join(xdg, "glab-cli"),
    },
  };
}

/** Whether a path is itself a symlink (as opposed to the file it points at). */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A result shaped like the one spawn hands back; the wrapper annotates it. */
function result(): DispatchResult {
  return { role: "developer", ok: true, text: "done", toolUses: [], ms: 1, exitCode: 0 };
}

export { PROTECTED, sentinelHome };

/** The F2 section: glab's credential file under a write, a swap and a deletion. */
export async function runGlabCases(drainWarns: () => string): Promise<void> {
  // The field report is a developer child that unsets `GLAB_CONFIG_DIR`, reads the
  // operator's glab config and LEAVES IT CHANGED — the shape that leaked a token.
  {
    // A write, or a symlink swapped onto the real file so a later `gh`/`glab` run
    // reads the child's tree. The restore arm refuses to write through a symlink (it
    // replaces the entry), and the delete arm restores by recreation.
    const { home, env } = sentinelHome("glab-write");
    const target = path.join(home, ".config", "glab-cli", "config.yml");
    const original = readFileSync(target);
    const tokenLine = "host:\n  gitlab.com:\n    token: oper\n";
    assert(
      original.toString() === tokenLine,
      "glab fixture: the protected file holds the credential line",
    );
    let res: DispatchResult | undefined;
    await withEnv(env, async () => {
      res = await withOperatorConfigGuard("developer", async () => {
        writeFileSync(target, "host:\n  gitlab.com:\n    token: STOLEN\n");
        return result();
      });
    });
    const warns = drainWarns();
    assert(
      readFileSync(target).equals(original),
      "F2/glab: a child's write to glab's credential file is restored byte-for-byte",
    );
    assert(
      (res?.operatorConfig ?? []).length === 1 &&
        (res?.operatorConfig ?? []).some((l) => l.includes(target)),
      `F2/glab: the change is reported once, naming the path (${JSON.stringify(res?.operatorConfig)})`,
    );
    assert(
      warns.includes("operator-config:") && warns.includes(target),
      "F2/glab: the same line is on the trace, for a dispatch that renders no report",
    );

    // A symlink swapped IN by the child, in place of the real file: the guard must
    // not write THROUGH it (that would hand the child's target the operator's bytes),
    // and the entry must end as a regular file holding the ORIGINAL bytes. The swap is
    // the change the snapshot comparison is looking for, so it happens inside the run.
    const swap = sentinelHome("glab-symlink");
    const link = path.join(swap.home, ".config", "glab-cli", "config.yml");
    const decoy = path.join(swap.home, "decoy.yml");
    const stash = `${link}.real`;
    renameSync(link, stash); // the child's first move: hide the real file from the run's start
    renameSync(stash, link); // …and put it back, so the snapshot holds the operator's bytes
    writeFileSync(decoy, "host:\n  gitlab.com:\n    token: DECOY\n");
    let swapped: DispatchResult | undefined;
    await withEnv(swap.env, async () => {
      swapped = await withOperatorConfigGuard("developer", async () => {
        // `mv <real> <real>.bak; ln -s <decoy> <real>` — the exact shape that makes a
        // later `glab` run read the child's tree while the name still looks untouched.
        renameSync(link, `${link}.bak`);
        symlinkSync(decoy, link);
        return result();
      });
    });
    drainWarns();
    assert(
      readFileSync(decoy).toString() === "host:\n  gitlab.com:\n    token: DECOY\n",
      "F2/glab: a symlinked credential path is never written through — the target's bytes are untouched",
    );
    assert(
      readFileSync(link).toString() === "host:\n  gitlab.com:\n    token: oper\n" && !isLink(link),
      "F2/glab: the entry is replaced by a regular file holding the ORIGINAL bytes",
    );
    assert(
      (swapped?.operatorConfig ?? []).length === 1,
      `F2/glab: the swap is reported (${JSON.stringify(swapped?.operatorConfig)})`,
    );

    // Deletion of the credential file is a change too: restoring it is the only way
    // the next child sees the operator's config rather than an absent one.
    const del = sentinelHome("glab-delete");
    const file = path.join(del.home, ".config", "glab-cli", "config.yml");
    let deleted: DispatchResult | undefined;
    await withEnv(del.env, async () => {
      deleted = await withOperatorConfigGuard("developer", async () => {
        rmSync(file, { force: true });
        return result();
      });
    });
    drainWarns();
    assert(
      existsSync(file) && readFileSync(file).toString() === tokenLine,
      "F2/glab: a deleted credential file is restored with its original bytes",
    );
    assert(
      (deleted?.operatorConfig ?? []).length === 1 &&
        (deleted?.operatorConfig ?? []).some((l) => l.includes(file)),
      `F2/glab: the deletion is reported, naming the path (${JSON.stringify(deleted?.operatorConfig)})`,
    );
  }
}
