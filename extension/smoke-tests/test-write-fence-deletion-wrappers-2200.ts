#!/usr/bin/env bun
/**
 * #2200 — a remover behind a namespace, tracing, scheduling or sandboxing WRAPPER is still
 * that remover, split out of `test-write-fence-deletion-shapes-2200.ts` by the repo's
 * file-size cap.
 *
 * The deletion rule reads a wrapper segment from its RAW words: when the first word is a wrapper
 * (`WRAPPERS`), the segment is judged from the first word after it that names a command the rule owns
 * — `rm`, `rmdir`, `unlink`, `shred`, `find`, `git`, or a tabled interpreter — whatever options stand
 * in front of that word, and with no reasoning about what any option takes. If no owned name appears
 * after the wrapper, the segment is not a deletion at all. That is why the rows below name options no
 * wrapper table lists (`strace -p`, `ltrace -l`) or takes optionally (`watch -q [cycles]`, `env -S
 * <split-string>`): the rule never consults those tables, so a remover is reached whatever a table
 * claims about the option in front of it.
 *
 * The same reading is what keeps a wrapped build allowed: `make`, `cargo`, `ls`, `true` and a project
 * script are not names the rule owns, so nothing behind such a wrapper is judged, and a line whose
 * program is an ordinary one stays a line that deletes nothing. Two consequences are pinned in both
 * directions: an owned name that is only an argument to an ordinary program (`env VAR=1 echo rm
 * file`) is not judged, while the same name in the command slot is judged wherever it points — so
 * `env VAR=1 echo rm <outside>` is refused as the `rm` of that path, an over-refusal the rule accepts
 * rather than reason about `env -S`.
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
    // A wrapper's BOOLEAN flag takes no value, so the word after it is the command; a flag the table
    // calls value-taking, or one it does not name at all, is answered the same way now, because the
    // deletion side never asks a table what an option takes. Each row is a flag the wrapper's own
    // usage output spells without an argument.
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
      "a stacked wrapper: the `rm` is judged through the `strace` its `-u` swallowed",
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
    // `watch` runs whatever it is given, so an `rm` behind it is judged by the path it names — and a
    // path inside the child's roots is the cleanup it always was.
    [`watch -q rm -rf ${wt}/build`, "`watch -q rm -rf` of a build dir in the worktree"],
    [
      `sudo unshare -m nice -n 5 rm -rf ${wt}/build`,
      "stacked privilege, namespace and scheduling wrappers before an in-tree remover",
    ],
    // The boundary of the scan: only the FIRST owned name is taken as the command, and a segment with
    // no owned name behind its wrapper deletes nothing. `timeout 10 rm other` names a remover whose
    // operand is a relative path under the child's cwd, so it runs; `env VAR=1 echo rm file` names a
    // remover only as an argument of `echo`, which is not a name the rule owns; `ls <shared>` holds no
    // owned name at all. Each of these really runs (verified against the tools).
    [`timeout 10 rm other`, "a relative operand that happens to be named `rm`"],
    [`env VAR=1 echo rm file`, "an owned name that is an argument, not the program"],
    [`ls ${sharedTmp}`, "a non-owned command whose operand is the shared temp root"],
  ];
  for (const [command, why] of wrapperAllowed) {
    assert(refused(command, fenced) === undefined, `A11 allow: ${why} — \`${command}\``);
  }
  // The accepted false positive, named for itself: `env VAR=1 echo rm <outside>` is refused as the
  // `rm` of that path. The first name the rule owns after `env` is the `rm` sitting in `echo`'s
  // argument list, and the rule does not reason about `env -S` — which really would split the string
  // into words, so no single word on that line names the program the shell ends up running.
  assert(
    refused(`env VAR=1 echo rm ${foreignRun}/payload`, fenced) !== undefined,
    "A11 refuse: `env VAR=1 echo rm <outside>` — the accepted conservative false positive",
  );
  // A `watch`ed read-only command keeps its own head: the `git`, `node` and `bun` of these lines are
  // owned names, but what the wrapper execs is `git status`, `node x` and `bun run check`, and the
  // first owned name the scan reaches therefore names no path. Each really runs (verified against the
  // tools) and none deletes anything.
  for (const line of [`watch -q git status`, `watch -q node x`, `watch -q bun run check`]) {
    assert(
      refused(line, fenced) === undefined,
      `A11 allow: ${line} — the wrapper runs an ordinary command, so nothing is judged`,
    );
  }

  // A11b. The other direction of the same scan. A strip that swallows the word in the program's
  // slot is an escape only when that word is one this rule owns; a strip that swallows `make`,
  // `cargo` or a project script is a wrapped command that deletes nothing, and refusing it takes
  // the child's whole toolchain away. These nine lines were ALLOWED before the scan landed and
  // REFUSED after it; each really runs (verified against the tool) and none deletes anything. The
  // escape needs an OWNED name in the option's value slot — a wrapper in front of `make` supplies
  // none, whatever its option table says about `-n`, `-c`, `-p` or a duration.
  const wrappedAllowed: Array<[string, string]> = [
    ["nice -n 5 make", "`nice -n 5` before a build"],
    ["nohup make", "`nohup` before a build"],
    ["timeout 60 make", "`timeout <duration>` before a build"],
    ["ionice -c 3 make", "`ionice -c 3` before a build"],
    ["env -i PATH=/usr/bin make", "`env -i` with an assignment, before a build"],
    ["strace -p 1 ls", "an untabled option (`strace -p <pid>`) before a read-only command"],
    ["sudo -n true", "`sudo -n` before a no-op"],
    ["nice -n 5 cargo test", "`nice -n 5` before the test runner"],
    ["nohup ./scripts/build.sh", "`nohup` before a project script"],
  ];
  for (const [command, why] of wrappedAllowed) {
    assert(refused(command, fenced) === undefined, `A11b allow: ${why} — \`${command}\``);
  }
});

console.log(`\nexit ${exit}`);
process.exit(exit);
