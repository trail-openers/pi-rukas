#!/usr/bin/env bun
/**
 * #2200 — a remover behind a namespace, tracing, scheduling or sandboxing WRAPPER is still
 * that remover, split out of `test-write-fence-deletion-shapes-2200.ts` by the repo's
 * file-size cap.
 *
 * The reader strips every wrapper in its table before the command it runs, so what each
 * wrapper's option table claims about its options decides whether the remover is seen at all:
 * an option listed as value-taking consumes the following word, and when that option is
 * really a BOOLEAN flag the word it swallows is `rm` itself — a remover the rule never judged,
 * which is how `unshare -m rm -rf <shared temp root>` ran. Each row below is therefore read
 * against the wrapper's own usage output, and the two directions are pinned: a boolean flag
 * before a remover must still be refused, and a genuinely value-taking option's value must
 * still be skipped rather than read as the command.
 *
 * Run: cd extension && bun smoke-tests/test-write-fence-deletion-wrappers-2200.ts
 */

import { CHILD_TMP_ENV, deletionRootsFrom } from "../src/write-fence-deletion.ts";
import {
  buildDeletionFixture,
  deletionHost,
  withDeletionHost,
} from "./lib/write-fence-deletion-fixture.ts";
import { assert, exit, refused } from "./lib/write-fence-deletion-harness.ts";

// Every row runs inside this block: the rule consults process.env for the home it refuses
// (os.homedir) and for the temp root its ancestor walk seeds on (os.tmpdir), so an unpinned
// runner could make a row green or red by where it happened to put TMPDIR. See withDeletionHost.
const { base, wt, scratch, childTmp, foreignRun } = buildDeletionFixture("wrappers");
const HOST = deletionHost(base);
await withDeletionHost(HOST, async () => {
  const FENCED_ENV = {
    PI_ENSEMBLE_WRITE_ROOT: wt,
    PI_ENSEMBLE_WRITE_REPO: base,
    PI_ENSEMBLE_WRITE_SCRATCH: scratch,
    [CHILD_TMP_ENV]: childTmp,
  };
  const fenced = deletionRootsFrom(FENCED_ENV, wt);

  const wrapperRefused: Array<[string, string]> = [
    [`busybox rm -rf ${foreignRun}`, "`busybox rm -rf` of another run's dir"],
    [`strace -f rm -rf ${foreignRun}`, "`strace -f rm -rf` outside the roots"],
    [`unshare rm -rf ${foreignRun}`, "`unshare rm -rf` outside the roots"],
    [`nsenter -t 1 rm -rf ${foreignRun}`, "`nsenter -t 1 rm -rf` outside the roots"],
    [`chroot / rm -rf ${foreignRun}`, "`chroot / rm -rf` outside the roots"],
    // `chroot` takes the new root as a POSITIONAL before the program it runs — exactly one word.
    // Consume two and the remover itself leaves the reader's view, which is the shape that would let
    // this line run; consume none and `/bin` reads as the command. `firejail` takes no positional, so
    // its first word is already the command whatever its options.
    [
      `chroot /bin rm -rf ${foreignRun}`,
      "`chroot /bin rm -rf` — one positional root, the remover still read",
    ],
    [
      `busybox chroot / rm -rf ${foreignRun}`,
      "`busybox chroot / rm -rf` — a wrapper stacked before the positional root",
    ],
    [
      `firejail --quiet --noprofile rm -rf ${foreignRun}`,
      "`firejail --quiet --noprofile rm -rf` — flags, no positional to consume",
    ],
    // A wrapper's BOOLEAN flag takes no value, so the word after it is the command. A table that
    // lists a boolean as value-taking consumes `rm` itself as that option's value and the remover
    // leaves the reader's view entirely — which is how `unshare -m rm -rf <outside>` ran. Each row
    // here is a flag the wrapper's own usage output spells without an argument.
    [`unshare -m rm -rf ${foreignRun}`, "`unshare -m` (mount ns) before a remover"],
    [`unshare -p -f rm -rf ${foreignRun}`, "`unshare -p -f` before a remover"],
    [`nsenter -m rm -rf ${foreignRun}`, "`nsenter -m` (mount ns) before a remover"],
    [`nsenter -a rm -rf ${foreignRun}`, "`nsenter -a` (all namespaces) before a remover"],
    [`strace -ff rm -rf ${foreignRun}`, "`strace -ff` before a remover"],
    [`ltrace -f rm -rf ${foreignRun}`, "`ltrace -f` before a remover"],
    [`sudo -n rm -rf ${foreignRun}`, "`sudo -n` (non-interactive) before a remover"],
    [`ionice -t rm -rf ${foreignRun}`, "`ionice -t` (ignore failures) before a remover"],
    [`watch -x rm -rf ${foreignRun}`, "`watch -x` (exec) before a remover"],
    [`watch --equexit 3 rm -rf ${foreignRun}`, "`watch --equexit <cycles>` before a remover"],
    [`timeout -p rm -rf ${foreignRun}`, "`timeout -p` (preserve status) before a remover"],
    // …and the same wrappers' genuinely value-taking options, whose value the reader must still
    // skip rather than read as the command. `strace -U` is the counter-row: it looks like a boolean
    // cluster letter but its usage output gives it a value, so a table that dropped it would read
    // `20` as the command.
    [`strace -o /dev/null rm -rf ${foreignRun}`, "`strace -o <file>` before a remover"],
    [`strace -U 20 rm -rf ${foreignRun}`, "`strace -U <columns>` before a remover"],
    [`ltrace -o /dev/null rm -rf ${foreignRun}`, "`ltrace -o <file>` before a remover"],
    [`strace -e trace=file rm -rf ${foreignRun}`, "`strace -e <expr>` before a remover"],
    [
      `unshare --map-users 0:0:1 rm -rf ${foreignRun}`,
      "`unshare --map-users <map>` before a remover",
    ],
    [`nsenter -t 1 -m rm -rf ${foreignRun}`, "`nsenter -t 1 -m` before a remover"],
  ];
  for (const [command, why] of wrapperRefused) {
    assert(refused(command, fenced) !== undefined, `A11 refuse: ${why} — \`${command}\``);
  }
  assert(
    refused(`busybox rm -rf ${wt}/build`, fenced) === undefined,
    "A11 allow: `busybox rm -rf` of a build dir in the worktree",
  );
});

console.log(`\nexit ${exit}`);
process.exit(exit);
