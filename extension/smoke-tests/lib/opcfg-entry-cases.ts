/**
 * The entry-hardening cases of `test-operator-config-guard.ts` (section D2),
 * split out for the 500-line gate (AGENTS.md §12).
 *
 * What these pin is the shape of what the guard writes back, not its bytes: a
 * restore that goes *through* the entry the child left behind is a restore the
 * child can defeat. `writeFile`/`rm` both resolve a symlink, so a child that
 * swaps `~/.config/gh/hosts.yml` for a link of its own ended up with the
 * operator's token written into the child's own file, `hosts.yml` left as the
 * link, and a report line claiming `— restored`. `restoreOne` now unlinks the
 * entry and creates a regular file, which is the difference the first three
 * cases observe (each goes red on the pre-fix restore).
 *
 * Every case runs against a sentinel home from the caller's `sentinelHome`, so
 * the real operator home is never opened — writing it IS the bug #2019 is about.
 *
 * The last case drives the in-place open directly (`__openInPlaceForTest`): the
 * entry check runs BEFORE the open and `open()` re-resolves the path, so a link
 * created in that window is the one thing the check cannot see. The open carries
 * `O_NOFOLLOW` for exactly that, and the case puts a link at the target at the
 * moment of the open to prove it refuses — a timing race would prove nothing.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  __openInPlaceForTest,
  withOperatorConfigGuard,
} from "../../src/spawn-operator-config.ts";
import type { DispatchResult } from "../../src/types.ts";
import { withEnv } from "./env-scope.ts";

type Sentinel = { home: string; env: Record<string, string> };

export async function runEntryHardeningCases(
  assert: (cond: boolean, msg: string) => void,
  sentinelHome: (tag: string) => Sentinel,
  drainWarns: () => string,
  result: () => DispatchResult,
): Promise<void> {
  {
    // The child still controls the file its link points at, so the payload has
    // to stay out of the operator's path even after the child writes it again.
    const { home, env } = sentinelHome("symlink-swap");
    const target = path.join(home, ".config", "gh", "hosts.yml");
    const childFile = path.join(path.dirname(home), "child-controlled.yml");
    const operator = readFileSync(target);
    writeFileSync(childFile, "github.com:\n    oauth_token: ATTACKER_BACK\n");
    let res: DispatchResult | undefined;
    await withEnv(env, async () => {
      res = await withOperatorConfigGuard("ops", async () => {
        unlinkSync(target);
        symlinkSync(childFile, target);
        return result();
      });
    });
    drainWarns();
    assert(
      lstatSync(target).isFile(),
      "symlink swap: the protected path is a REGULAR file after the restore, not the child's link",
    );
    assert(
      readFileSync(target).equals(operator),
      "symlink swap: the operator's bytes are at the protected path itself",
    );
    writeFileSync(childFile, "github.com:\n    oauth_token: ATTACKER_BACK\n");
    assert(
      readFileSync(target).equals(operator),
      "symlink swap: the child's payload cannot come back by writing the file it still controls",
    );
    assert(
      (res?.operatorConfig ?? []).length === 1 &&
        (res?.operatorConfig ?? [""])[0]?.includes("— restored") === true,
      "symlink swap: the swap is reported once, as a restored violation",
    );
  }

  {
    // The link's target does not exist, so a write-through restore would CREATE
    // a file outside the protected set — a path the guard then never watches.
    const { home, env } = sentinelHome("symlink-dangling");
    const target = path.join(home, ".config", "gh", "config.yml");
    const victim = path.join(path.dirname(home), "victim.yml");
    await withEnv(env, async () => {
      await withOperatorConfigGuard("developer", async () => {
        unlinkSync(target);
        symlinkSync(victim, target);
        return result();
      });
    });
    drainWarns();
    assert(
      !existsSync(victim),
      "dangling symlink: the restore creates nothing outside the protected set",
    );
    assert(
      lstatSync(target).isFile() && readFileSync(target).includes("editor"),
      "dangling symlink: the protected path itself is a regular file with the operator's bytes",
    );
  }

  {
    // `hosts.yml` carries the gh token, so a restored file is 0600. A restore
    // that only truncates the existing file keeps whatever mode the child set.
    const { home, env } = sentinelHome("mode");
    const target = path.join(home, ".config", "gh", "hosts.yml");
    chmodSync(target, 0o600);
    await withEnv(env, async () => {
      await withOperatorConfigGuard("adversarial-developer", async () => {
        writeFileSync(target, "github.com:\n    oauth_token: attacker\n");
        chmodSync(target, 0o666);
        return result();
      });
    });
    drainWarns();
    assert(
      (statSync(target).mode & 0o777) === 0o600,
      `mode: a restored credential file is 0600, not the 0${(statSync(target).mode & 0o777).toString(8)} the child set`,
    );
  }

  {
    // The in-place arm's own open, driven with a symlink ALREADY at the target.
    // `inPlaceWritable` checked `isFile()` before the open and `open()` resolves
    // the path again, so a link put at the target after that check is the one
    // shape the check cannot see — which is why the open carries `O_NOFOLLOW`,
    // and why the case arranges the link directly rather than racing the guard.
    // Asserted for both link shapes: a live target (a write-through would put
    // the operator's bytes in the child's file) and a dangling one (it would
    // CREATE a file outside the protected set).
    const { home } = sentinelHome("inplace-open-nofollow");
    const target = path.join(home, ".config", "git", "config");
    const OPERATOR = "[core]\n\teditor = vim\n";
    const CHILD = "[core]\n\teditor = pwned\n";
    for (const kind of ["live", "dangling"] as const) {
      const linked = path.join(path.dirname(home), `victim-${kind}`);
      rmSync(target, { force: true });
      rmSync(linked, { force: true });
      if (kind === "live") writeFileSync(linked, CHILD);
      symlinkSync(linked, target);
      // `approved: "absent"` is what makes this O_NOFOLLOW's own case rather
      // than the identity check's: with no inode to compare against, the only
      // thing that can refuse the link is the flag on the open itself.
      assert(
        (await __openInPlaceForTest(target, Buffer.from(OPERATOR), "absent")) === "replace",
        `O_NOFOLLOW (${kind} link): the in-place open refuses the link and defers to the replace arm`,
      );
      assert(
        !existsSync(linked) || readFileSync(linked).equals(Buffer.from(CHILD)),
        `O_NOFOLLOW (${kind} link): nothing was written through the link — its target holds ${kind === "live" ? "the child's own bytes" : "still nothing"}`,
      );
      // And the arm the open defers to, for the same entry: it turns the link
      // into a regular file of the guard's own.
      await restoreByEntry(target, Buffer.from(OPERATOR));
      assert(
        lstatSync(target).isFile() && readFileSync(target).equals(Buffer.from(OPERATOR)),
        `O_NOFOLLOW (${kind} link): the replace arm left a regular file with the operator's bytes at the target`,
      );
      assert(
        (statSync(target).mode & 0o777) === 0o600,
        `O_NOFOLLOW (${kind} link): the file the replace arm created is 0600`,
      );
      rmSync(linked, { force: true });
    }
  }
}

/**
 * The replace arm, run outside the guard so the O_NOFOLLOW case can observe it
 * for the entry its open refused: `rm` drops the link (never its target) and
 * `open("wx")` creates a fresh regular file the child does not own.
 */
async function restoreByEntry(target: string, bytes: Buffer): Promise<void> {
  const { open, rm } = await import("node:fs/promises");
  await rm(target, { force: true, recursive: true });
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
