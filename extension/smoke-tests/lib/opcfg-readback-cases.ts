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
 * here is `open(target, "wx")` under a non-writable PARENT directory, which fails
 * EACCES for root too (the case arranges that itself, and root only has to be
 * able to `chmod`, which it always can).
 *
 * Every case runs against a sentinel home from the caller's `sentinelHome`; the
 * real operator home is never opened.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withOperatorConfigGuard } from "../../src/spawn-operator-config.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";

type Sentinel = { home: string; env: Record<string, string> };

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
        (res?.operatorConfig ?? [""])[0].includes("— restored"),
      `chmod-000: the unreadable path is reported as a violation, not silently passed (${JSON.stringify(res?.operatorConfig)})`,
    );
  }

  {
    // The NOT-restored arm without mode bits, so root cannot skip it: the child
    // removes the entry and leaves its payload; the guard's `rm` then succeeds
    // (the directory is still writable) but its `open(..., "wx")` fails, because
    // the PARENT has become a non-writable directory. Under the old mode-bit
    // fixture this arm only ran for a non-root uid, so CI running the image as
    // root never saw it; here the root branch merely pre-arms the read-only
    // parent (a `chmod` root always can) and the EACCES itself binds root.
    const { home, env } = sentinelHome("not-restored-as-root");
    const ghDir = join(home, ".config", "gh");
    const target = join(ghDir, "hosts.yml");
    let res: DispatchResult | undefined;
    try {
      if (process.getuid?.() === 0) chmodSync(ghDir, 0o555);
      await withEnv(env, async () => {
        res = await withOperatorConfigGuard("developer", async () => {
          rmSync(target, { force: true });
          writeFileSync(target, "github.com:\n    oauth_token: attacker\n");
          chmodSync(ghDir, 0o555);
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
    } finally {
      chmodSync(ghDir, 0o755);
    }
  }
}
