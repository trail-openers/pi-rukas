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
 * entry and creates a regular file, which is the difference these three cases
 * observe (each goes red on the pre-fix restore).
 *
 * Every case runs against a sentinel home from the caller's `sentinelHome`, so
 * the real operator home is never opened — writing it IS the bug #2019 is about.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { withOperatorConfigGuard } from "../../src/spawn-operator-config.ts";
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
        (res?.operatorConfig ?? [""])[0].includes("— restored"),
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
}
