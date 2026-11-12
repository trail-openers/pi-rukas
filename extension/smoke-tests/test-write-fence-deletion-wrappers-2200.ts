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
 * The tables cannot be complete, so the reader does not rely on them alone: when a wrapper's
 * head after the strip is not a command the rule owns, the reader scans that segment's words
 * for the first command it owns and judges from there. The rows that pin that are the ones
 * whose option the table does not list at all (`strace -p`, `ltrace -l`) and whose value is
 * OPTIONAL (`nsenter -S [uid]`, `watch -q [cycles]`, `env -S <s>`) — with each table fixed to
 * name them the strip would find the remover and the same rows stay green, which is why they
 * are the class rather than a list.
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
const { base, wt, scratch, childTmp, foreignRun, sharedTmp } = buildDeletionFixture("wrappers");
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
    // …and the class those tables cannot close: an option the table does not list at all, and an
    // option whose value is OPTIONAL (`[=<uid>]` in the usage output), so the word the reader
    // swallows is the remover rather than a value. Each row is a flag that does not take a value
    // on the real tool, listed where the wrapper's own table missed it.
    [`strace -p 1 rm -rf ${foreignRun}`, "`strace -p <pid>` — an option absent from strace's table"],
    [`strace -u nobody rm -rf ${foreignRun}`, "`strace -u <user>` — an option absent from strace's table"],
    [`strace -a 40 rm -rf ${foreignRun}`, "`strace -a <columns>` — an option absent from strace's table"],
    [`nsenter -S 1000 rm -rf ${foreignRun}`, "`nsenter -S [uid]` — the value is OPTIONAL, so `-S rm` runs rm"],
    [`nsenter -G 1000 rm -rf ${foreignRun}`, "`nsenter -G [gid]` — the value is OPTIONAL, so `-G rm` runs rm"],
    [`ltrace -l lib rm -rf ${foreignRun}`, "`ltrace -l <lib>` — an option absent from ltrace's table"],
    [`watch -q rm -rf ${foreignRun}`, "`watch -q` with no cycles value, so the next word is the command"],
    [`env -S rm -rf ${foreignRun}`, "`env -S` with no split-string value"],
    [
      `sudo -u nobody strace -p 1 rm -rf ${foreignRun}`,
      "a stacked wrapper whose own option swallows the next wrapper's boolean",
    ],
  ];
  for (const [command, why] of wrapperRefused) {
    assert(refused(command, fenced) !== undefined, `A11 refuse: ${why} — \`${command}\``);
  }
  assert(
    refused(`busybox rm -rf ${wt}/build`, fenced) === undefined,
    "A11 allow: `busybox rm -rf` of a build dir in the worktree",
  );
  // The scan that finds the remover behind a mis-tabled option must not turn an in-tree cleanup
  // into a refusal: the same spellings aimed inside the child's roots are ordinary cleans.
  const wrapperAllowed: Array<[string, string]> = [
    [`strace -p 1 rm -rf ${wt}/build`, "`strace -p 1 rm -rf` of a build dir in the worktree"],
    [
      `sudo unshare -m nice -n 5 rm -rf ${wt}/build`,
      "stacked privilege, namespace and scheduling wrappers before an in-tree remover",
    ],
    // The boundary of the scan: it reads only the word that holds the slot a wrapper's program
    // occupies, so an owned name that appears anywhere else is not a command. `rm other` and
    // `echo rm file` hold a remover's name and are judged as the `timeout`/`env` lines they are;
    // `ls <shared>` holds no owned command at all, so it is judged as `ls`, which deletes nothing.
    // Each of these really runs (verified against the tools), so a scan that read further than the
    // program slot would refuse an ordinary command.
    [`timeout 10 rm other`, "a relative operand that happens to be named `rm`"],
    [`env VAR=1 echo rm file`, "an owned name that is an argument, not the program"],
    [`ls ${sharedTmp}`, "a non-owned command whose operand is the shared temp root"],
  ];
  for (const [command, why] of wrapperAllowed) {
    assert(refused(command, fenced) === undefined, `A11 allow: ${why} — \`${command}\``);
  }
  // `watch -q` takes an OPTIONAL cycles value, so the strip reads the word after it as that value
  // and no command survives for the reader to resolve. The scan has nothing to judge on such a
  // segment — the only word the strip left is an operand, and an operand is an argument — so the
  // line is refused wherever its target lies, in the worktree included. The child runs the delete
  // as its own command, which is the shape the rule can read.
  assert(
    refused(`watch -q rm -rf ${wt}/build`, fenced) !== undefined,
    "A11 refuse: `watch -q rm -rf` — an OPTIONAL value left no command, so it is refused in-tree too",
  );
  // The same miscount one wrapper deeper, where the survivor is not even a path: `watch -q` read
  // `git` for its optional cycles and the segment begins at git's VERB, so the tree the forcing
  // clean clears is named by a line whose program is gone. Refused outside the roots, and refused
  // in them, for the same reason.
  assert(
    refused(`watch -q git clean -fdx ${foreignRun}`, fenced) !== undefined,
    "A11 refuse: `watch -q git <verb> -fdx` — the strip ate `git`, so the tree is unjudged",
  );
  assert(
    refused(`watch -q git clean -fdx ${wt}/build`, fenced) !== undefined,
    "A11 refuse: `watch -q git <verb> -fdx` in-tree — no program, so no judgement",
  );
  // A wrapper whose program this rule cannot read at all is a line it refuses to guess at, whoever
  // that program is: `watch -q <program>` never leaves a command for the reader, so it is refused
  // whether the program deletes anything or nothing. The child drops the wrapper and runs it.
  for (const line of [`watch -q git status`, `watch -q node x`, `watch -q bun run check`]) {
    assert(refused(line, fenced) !== undefined, `A11 refuse: ${line} leaves no command to read`);
  }
});

console.log(`\nexit ${exit}`);
process.exit(exit);
