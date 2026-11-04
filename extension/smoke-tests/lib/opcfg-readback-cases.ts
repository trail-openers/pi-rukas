/**
 * The post-child-read cases of `test-operator-config-guard.ts` (section D3),
 * split out for the 500-line gate (AGENTS.md §12).
 *
 * `readSnapshot` returns `undefined` for "could not read", and that one value
 * crosses two moments in a run. BEFORE the child it means "no baseline", so the
 * path is left alone (section D). AFTER the child the baseline exists and the
 * same `undefined` can only mean "I cannot prove this is unchanged" — which is a
 * violation to repair. Reading it as "no change" was the hole these cases exist
 * for: `rm hosts.yml && mkdir hosts.yml`, or `chmod 000` on it, as the child's
 * last act, left the child's payload on a gh credential path with no violation
 * line anywhere. Both cases below go red on a `differsFrom` that maps a failed
 * post-child read to `false`, and the directory one additionally goes red on a
 * `restoreOne` whose `rm` lacks `recursive` (a plain `rm` on a non-empty
 * directory throws ERR_FS_EISDIR and the child's tree stays in place).
 *
 * The NOT-restored case is the one `docs/troubleshooting.md` says needs the
 * operator, so it is asserted for any uid: root ignores mode bits, but the fault
 * here is creating a NEW entry under a non-writable PARENT directory, which the
 * EACCES binds for root too (the case arranges that itself, and root only has to
 * be able to `chmod`, which it always can).
 *
 * A REGULAR file is restored IN PLACE (open/write/truncate), never unlinked
 * first: unlinking needs write permission on the parent, so a child that made
 * the parent non-writable would defeat a `rm`-then-`create` restore and keep its
 * payload behind a `— restored` line. The `parent-dir-immutable` case below is
 * the mutant for exactly that: it goes red on a `restoreOne` that unlinks before
 * it writes.
 *
 * In place is safe only while the guard holds the only name for that inode, so
 * the in-place arm refuses an entry whose `nlink` is above 1 and opens with
 * `O_NOFOLLOW`. The `hardlink-alias` case below is the mutant for the first:
 * `ln` the protected file to a sibling, leave it writable, and an in-place
 * restore writes the operator's token through BOTH names — the child keeps a
 * readable copy of the credential and the line still says `— restored`.
 *
 * Every case runs against a sentinel home from the caller's `sentinelHome`; the
 * real operator home is never opened.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  __openInPlaceForTest,
  withOperatorConfigGuard,
} from "../../src/spawn-operator-config.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";

type Sentinel = { home: string; env: Record<string, string> };

/**
 * The env a hostile `sh` child runs with. `execFile*` does NOT see the caller's
 * `withEnv` overrides — it inherits the real `process.env` — so a child that
 * expands `$HOME` would reach the OPERATOR's home, which is the exact file
 * #2019 exists to protect. Every subprocess case passes this instead, and the
 * target paths are handed to the child as absolute argv, never derived from its
 * own environment.
 */
function hostileChildEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

export async function runPostChildReadCases(
  assert: (cond: boolean, msg: string) => void,
  sentinelHome: (tag: string) => Sentinel,
  drainWarns: () => string,
  result: () => DispatchResult,
): Promise<void> {
  {
    // A non-empty DIRECTORY where the credential file was: the compare read now
    // fails EISDIR, which is a violation, and the restore has to remove a tree
    // the child owns rather than leave it (a plain `rm` on a non-empty directory
    // throws ERR_FS_EISDIR, so this is the case that pins `recursive`).
    //
    // The mutation runs in a real subprocess on purpose: `restoreOne` removes the
    // entry before it can fail, so a hostile step that throws would reach the
    // suite through the guard's rethrow instead of showing up as the failures
    // below. A subprocess also makes the payload the child's, not the test's.
    const { home, env } = sentinelHome("dir-at-exit");
    const target = join(home, ".config", "gh", "hosts.yml");
    const payload = join(dirname(home), "child-owns.txt");
    const operator = readFileSync(target);
    await withEnv(env, async () => {
      await withOperatorConfigGuard("ops", async () => {
        execFileSync("sh", ["-c", 'rm -f "$1"; mkdir "$1"; printf PWNED > "$2"', "sh", target, payload], {
          stdio: "ignore",
          env: hostileChildEnv(env),
        });
        return result();
      });
    });
    const warns = drainWarns();
    assert(
      lstatSync(target).isFile() && readFileSync(target).equals(operator),
      "dir-at-exit: the child's directory is gone and the operator's bytes are back",
    );
    assert(
      (statSync(target).mode & 0o777) === 0o600,
      "dir-at-exit: the replacement is the guard's own file, mode 0600",
    );
    assert(
      warns.includes("modified during the ops run — restored") &&
        !warns.includes("NOT restored"),
      `dir-at-exit: an unreadable path with a baseline reports a restored violation (${warns.trim().slice(0, 150)})`,
    );
  }

  {
    // `chmod 000`: the compare read now fails EACCES. Same reasoning, different
    // errno, and a file the guard must replace rather than write through.
    const { home, env } = sentinelHome("unreadable-at-compare");
    const target = join(home, ".gitconfig");
    const operator = readFileSync(target);
    let res: DispatchResult | undefined;
    await withEnv(env, async () => {
      res = await withOperatorConfigGuard("adversarial-developer", async () => {
        writeFileSync(target, "[user]\n\tname = HIJACKED\n");
        chmodSync(target, 0o000);
        return result();
      });
    });
    drainWarns();
    assert(
      readFileSync(target).equals(operator),
      "chmod-000: a file made unreadable at the compare step is still restored",
    );
    assert(
      (res?.operatorConfig ?? []).length === 1 &&
        (res?.operatorConfig ?? [""])[0]?.includes("— restored") === true,
      `chmod-000: the unreadable path is reported as a violation, not silently passed (${JSON.stringify(res?.operatorConfig)})`,
    );
  }

  {
    // The child cannot delete or replace the entry, only overwrite it: the
    // parent directory is left non-writable while the FILE stays writable. An
    // unlink-first restore needs write permission on the PARENT, so it fails
    // EACCES here and the child's payload survives under a `— restored` line;
    // the in-place restore only needs the file to be writable, which is exactly
    // what the child cannot take away without making the file itself unreadable
    // (the `chmod 000` arm above). Skipped as root, where mode bits bind
    // nobody: a root run of this file is not evidence either way, so the case
    // says so instead of passing vacuously.
    if (process.getuid?.() === 0) {
      assert(true, "parent-dir-immutable: skipped running as root — mode bits do not bind uid 0");
    } else {
      const { home, env } = sentinelHome("parent-dir-immutable");
      const ghDir = join(home, ".config", "gh");
      const target = join(ghDir, "hosts.yml");
      const operator = readFileSync(target);
      let res: DispatchResult | undefined;
      try {
        // The env is pinned OUTSIDE the guard call: `withOperatorConfigGuard`
        // snapshots before the callback runs, so a `withEnv` nested inside it
        // would have the guard read the ambient home rather than this sentinel.
        await withEnv(env, async () => {
          // `res` is captured, not discarded: a rejected `withOperatorConfigGuard`
          // whose value nobody awaits surfaces as an unhandled rejection (a
          // `void`-style call here killed the process outright), while awaiting
          // it lets the case assert the guard's own answer.
          res = await withOperatorConfigGuard("developer", async () => {
            execFileSync(
              "sh",
              [
                "-c",
                // rm then write, as the incident did: a cooperative `printf >`
                // would leave the file the OPERATOR owns, which is writable
                // through any directory and would not pin this arm at all.
                'rm -f "$1"; printf \'github.com:\\n    oauth_token: attacker\\n\' > "$1"; chmod 0644 "$1"; chmod 0555 "$(dirname "$1")"',
                "sh",
                target,
              ],
              { stdio: "ignore", env: hostileChildEnv(env) },
            );
            return result();
          });
        });
        const warns = drainWarns();
        const lines = res?.operatorConfig ?? [];
        const line = lines.join("\n");
        assert(
          lines.length === 1 &&
            line.includes(target) &&
            line.includes("modified") &&
            !line.includes("NOT restored"),
          `parent-dir-immutable: the restore reports success rather than NOT restored (${line.slice(0, 160) || "no line"})`,
        );
        assert(
          existsSync(target) && readFileSync(target).equals(operator),
          "parent-dir-immutable: the child's payload is gone and the operator's bytes are back under a non-writable parent",
        );
        assert(
          !warns.includes("NOT restored") && warns.includes("modified"),
          "parent-dir-immutable: the traceWarn channel agrees that the restore landed",
        );
        assert(
          lstatSync(target).isFile() && (statSync(target).mode & 0o777) === 0o600,
          "parent-dir-immutable: the restored file is a regular file at mode 0600, not the child's 0644",
        );
      } finally {
        chmodSync(ghDir, 0o755);
      }
    }
  }

  {
    // The child cannot delete the entry, only share it: one `ln` gives the same
    // inode a second name the child knows, and the file is left writable so the
    // in-place arm is the arm the guard would choose. `O_TRUNC` + write on that
    // inode changes the bytes behind BOTH names, so the guard's own restore
    // would hand the operator's token back to the child — every other assert
    // still passes, and the line still reads `— restored`. That is why
    // `inPlaceWritable` refuses `nlink > 1` and the entry goes through unlink
    // and create instead: `rm` drops this one name and `open("wx")` makes an
    // inode nothing else shares.
    const { home, env } = sentinelHome("hardlink-alias");
    const target = join(home, ".config", "gh", "hosts.yml");
    const alias = join(dirname(home), "child-alias.yml");
    const operator = readFileSync(target);
    const payload = "github.com:\n    oauth_token: attacker\n";
    let res: DispatchResult | undefined;
    await withEnv(env, async () => {
      res = await withOperatorConfigGuard("developer", async () => {
        execFileSync(
          "sh",
          [
            "-c",
            // rm then rewrite so the entry is the child's own, then chmod 0666
            // (writable: the in-place arm is the one the guard would choose)
            // and `ln` it into the child's tree. The payload stays at the
            // protected path — that is the change the guard must repair — and
            // the alias is written last, so a restore that wrote the operator's
            // bytes through the shared inode is caught by the alias assert.
            'rm -f "$1"; printf \'%s\' "$3" > "$1"; chmod 0666 "$1"; ln "$1" "$2"; printf \'%s\' "$4" > "$2"',
            "sh",
            target,
            alias,
            payload,
            "ALIAS-OWNED-BY-CHILD\n",
          ],
          { stdio: "ignore", env: hostileChildEnv(env) },
        );
        return result();
      });
    });
    const warns = drainWarns();
    assert(
      existsSync(target) && readFileSync(target).equals(operator),
      "hardlink-alias: the protected path holds the operator's bytes",
    );
    assert(
      !readFileSync(alias).equals(operator),
      `hardlink-alias: the child's alias never receives the restored bytes (it holds ${JSON.stringify(readFileSync(alias).toString().slice(0, 40))})`,
    );
    assert(
      lstatSync(alias).nlink === 1 && lstatSync(target).nlink === 1,
      `hardlink-alias: the restore broke the share — alias nlink ${lstatSync(alias).nlink}, target nlink ${lstatSync(target).nlink}`,
    );
    assert(
      (res?.operatorConfig ?? []).length === 1 &&
        (res?.operatorConfig ?? [""])[0]?.includes("— restored") === true,
      `hardlink-alias: the child's write is reported as a restored violation (${JSON.stringify(res?.operatorConfig)})`,
    );
    assert(
      !warns.includes("NOT restored") && warns.includes("modified"),
      `hardlink-alias: the traceWarn channel agrees the restore landed (${warns.trim().slice(0, 150)})`,
    );
    assert(
      (statSync(target).mode & 0o777) === 0o600,
      "hardlink-alias: the restored credential file is 0600, not the 0666 the child set",
    );
    rmSync(alias, { force: true });
  }

  {
    // The TOCTOU the in-place arm exists to close: the predicate stats the entry
    // and `open()` resolves the path AGAIN, so the file the open truncates need
    // not be the one the check approved. Arranged with no ordering assumption:
    // the child hard-links the operator's entry to a path of its own, then
    // recreates the protected path as a fresh file of its own. The alias keeps
    // the approved inode ALIVE under a second name, and an inode with a live
    // link is never handed back out by `open(O_CREAT)` — so the entry the check
    // approved and the entry the open reaches are two different files by
    // construction, and the alias is the witness to the first.
    //
    // The predicate itself cannot refuse this: at the moment it stats, the entry
    // is a singly-linked regular file. The only thing that can catch it is the
    // comparison the open makes against the identity the check settled on, so
    // that is what this asserts — with the identity captured BEFORE the swap.
    // Remove the comparison and the answer below becomes `open`: the guard
    // truncates the child's file and pours the operator's token into it.
    const { home, env } = sentinelHome("entry-swap-inflight");
    const target = join(home, ".config", "gh", "hosts.yml");
    const operator = readFileSync(target);
    const payload = "github.com:\n    oauth_token: attacker\n";
    const tap = join(dirname(home), "tap-alias");
    rmSync(tap, { force: true });
    // The identity the predicate would have approved, taken before the swap.
    // Passing it in is what makes the post-open comparison meaningful: an open
    // checked against a stat it took itself only ever agrees with itself.
    const approved = await lstat(target);
    execFileSync(
      "sh",
      [
        "-c",
        'ln "$1" "$3"; rm -f "$1"; printf \'%s\' "$2" > "$1"; chmod 0666 "$1"',
        "sh",
        target,
        payload,
        tap,
      ],
      { stdio: "ignore", env: hostileChildEnv(env) },
    );
    assert(
      approved.ino !== lstatSync(target).ino &&
        readFileSync(target).equals(Buffer.from(payload)) &&
        readFileSync(tap).equals(operator),
      `entry-swap-inflight: the precondition holds — the path is now a different inode holding the child's payload, while the approved inode lives on as the child's alias (${JSON.stringify(readFileSync(target).toString().slice(0, 26))} / ${JSON.stringify(readFileSync(tap).toString().slice(0, 26))})`,
    );
    assert(
      (await __openInPlaceForTest(target, operator, approved)) === "replace",
      "entry-swap-inflight: the in-place open refuses the entry the path now holds, because it is not the inode the check approved",
    );
    assert(
      readFileSync(target).equals(Buffer.from(payload)),
      `entry-swap-inflight: the refused open truncated nothing — the child's file still holds its own payload, not the operator's token (${JSON.stringify(readFileSync(target).toString().slice(0, 34))})`,
    );
    assert(
      lstatSync(target).isFile() && lstatSync(tap).isFile(),
      "entry-swap-inflight: the refusal destroyed neither name, so the replace arm still has the entry to repair",
    );
    rmSync(tap, { force: true });
    void env;
  }

  {
    // The same TOCTOU one syscall later, and the one shape the identity check is
    // blind to. `post.stat()` runs on the fd, so the inode it describes is by
    // construction the one the open reached and the one the predicate approved;
    // a name raced in AFTER the check shares that inode and the `dev`/`ino`
    // comparison agrees with itself. The open would then truncate and write the
    // operator's bytes out under the child's second name. The predicate cannot
    // refuse it either — at `lstat` time there was nothing to refuse. Only the
    // link count on the post-open stat sees it, so this asserts that half of the
    // verdict on the PRESENT arm, where the identity matches and nothing else
    // can. Deterministic by arrangement: the alias exists before the helper is
    // called, and its inode is asserted to be the approved one, so `replace`
    // here has exactly one possible cause.
    //
    // `nlink` is read from `post` on BOTH arms; with it moved back inside the
    // `approved === "absent"` branch this goes red while the absent-arm case in
    // `lib/opcfg-entry-cases.ts` stays green — which is why the arm is asserted
    // here rather than argued from the shared expression.
    const { home } = sentinelHome("post-open-hardlink");
    const target = join(home, ".config", "gh", "hosts.yml");
    const operator = readFileSync(target);
    const payload = "github.com:\n    oauth_token: attacker\n";
    const alias = join(dirname(home), "late-alias");
    rmSync(alias, { force: true });
    // The child's payload sits at the protected path: the violation `restoreOne`
    // is being asked to repair, and the byte that must NOT reach the alias.
    writeFileSync(target, payload);
    const approved = await lstat(target);
    // The second name, raced in after the predicate's `lstat` and before the
    // open: same inode, so only `nlink` can see it.
    linkSync(target, alias);
    assert(
      lstatSync(alias).nlink === 2 && lstatSync(target).ino === approved.ino,
      `post-open-hardlink: the precondition holds — the approved inode has a second name (${lstatSync(alias).nlink} links, same ino ${lstatSync(target).ino === approved.ino})`,
    );
    assert(
      (await __openInPlaceForTest(target, operator, approved)) === "replace",
      "post-open-hardlink: the in-place open refuses the approved inode because a second name shares it",
    );
    assert(
      readFileSync(alias).equals(Buffer.from(payload)),
      `post-open-hardlink: the refused open wrote nothing through the child's alias — it still holds the child's payload, not the operator's token (${JSON.stringify(readFileSync(alias).toString().slice(0, 34))})`,
    );
    assert(
      readFileSync(target).equals(Buffer.from(payload)),
      "post-open-hardlink: the refusal truncated nothing, so the replace arm still has the entry to repair",
    );
    rmSync(alias, { force: true });
  }

  {
    // The arm the guard cannot fix: the child owns the entry (it recreated it)
    // and the parent is `0555`, so the guard can neither write it in place (it
    // does not own the file, so it could not `chmod` it back either) nor unlink
    // it. `NOT restored` is the honest answer, and `ok` stays true. Skipped as
    // root, where mode bits bind nobody: as uid 0 both the unlink and the create
    // would succeed and the case would pass for the wrong reason — it would be
    // asserting the shape of a violation that did not happen.
    if (process.getuid?.() === 0) {
      assert(true, "NOT-restored: skipped running as root — the unrestorable EACCES needs mode bits to bind");
    } else {
      const { home, env } = sentinelHome("not-restored");
      const ghDir = join(home, ".config", "gh");
      const target = join(ghDir, "hosts.yml");
      let res: DispatchResult | undefined;
      try {
        // Env pinned outside the guard, as in the case above: the snapshot is
        // taken before the callback runs.
        await withEnv(env, async () => {
          // Captured, not discarded — same reason as the case above.
          res = await withOperatorConfigGuard("developer", async () => {
            execFileSync(
              "sh",
              [
                "-c",
                // rm, then the payload at 0400: the compare read fails EACCES
                // (so the path is a violation), the guard cannot own it (so it
                // cannot write in place) and the 0555 parent blocks the unlink.
                // That triple is the shape `NOT restored` names.
                'rm -f "$1"; printf \'github.com:\\n    oauth_token: attacker\\n\' > "$1"; chmod 0400 "$1"; chmod 0555 "$(dirname "$1")"',
                "sh",
                target,
              ],
              { stdio: "ignore", env: hostileChildEnv(env) },
            );
            return result();
          });
        });
        const warns = drainWarns();
        const line = (res?.operatorConfig ?? []).join("\n");
        assert(
          line.includes(target) && line.includes("NOT restored"),
          `NOT-restored: an unrestorable entry reports NOT restored (${line.slice(0, 160)})`,
        );
        assert(
          warns.includes("NOT restored") && warns.includes("developer"),
          "NOT-restored: the traceWarn channel carries the same line, naming the role",
        );
        assert(
          res?.ok === true,
          "NOT-restored: an unrestorable violation never changes ok",
        );
        assert(
          existsSync(target) && readFileSync(target).includes("attacker"),
          "NOT-restored: the unrestorable payload really is still there (the line is honest, not decorative)",
        );
      } finally {
        chmodSync(ghDir, 0o755);
      }
    }
  }
}
