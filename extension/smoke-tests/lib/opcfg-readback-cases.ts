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
 * Every case runs against a sentinel home from the caller's `sentinelHome`; the
 * real operator home is never opened.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withOperatorConfigGuard } from "../../src/spawn-operator-config.ts";
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
