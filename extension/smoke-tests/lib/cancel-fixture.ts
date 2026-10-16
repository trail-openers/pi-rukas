/**
 * The fake `pi` fixture test-cancel.ts and lib/cancel-escalation.ts share
 * (issue #1382), extracted so both stay inside the 500-line limit
 * (AGENTS.md §12).
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/kill-outcome.ts`); coverage comes
 * through the test file that imports it.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The command every variant of the fake `pi` runs — the shape the suite has
 * always used, with the duration supplied by `fakeSleepCmd`.
 *
 * The duration is NOT a free parameter: the literal `sleep 300` below is what
 * the fixtures ran for the whole life of this test, and it is also what made
 * an orphan a five-minute leak. It is NOT parameterised over an arbitrary
 * string and it carries no identity token, both of which look like
 * improvements and both of which were measured to break the fixture. `sleep`
 * reads its first operand as a duration and rejects anything else —
 * `sleep 300 pi1382fixture` and `sleep pi1382fixture 300` each die with
 * `sleep: invalid time interval 'pi1382fixture'`, exit 1 — so the fake `pi`
 * never reaches the state a probe is meant to observe, and every assertion
 * reads `killCause=undefined`, which is indistinguishable from a kill path
 * that stopped attributing. Whatever the leak check identifies, it must not
 * have to write into the child's argv.
 */
const FAKE_SLEEP_SHAPE = "sleep";

/**
 * The shortest sleep that still outlives every wait a probe takes over it.
 *
 * `test-cancel.ts` derives this from its own bounds — the probe ceiling plus
 * both escalation polls, i.e. `PROBE_CEILING_MS + 2 * KILL_GRACE_MS * 4` —
 * and passes it in, because the fixture cannot import the test file. 300 s
 * was the value from before those bounds existed, and it is the reason the
 * orphan problem was a leak rather than a nuisance: a sleep reaped by nothing
 * (dash defers its EXIT trap while blocked in `wait`) sat at ppid=1 for five
 * minutes, and they accumulated across runs — measured 3, then 7, then 13
 * `sleep 300` processes at ppid=1 after successive runs of the suite. At the
 * derived bound the same orphan expires on its own within the window in which
 * the test that spawned it was still running, so `pgrep -fa 'sleep'` shows no
 * survivors from a finished run.
 *
 * It must stay comfortably above that window: a sleep that ends early is a
 * child that finished on its own, which every probe here reads as
 * `killCause=undefined` / `ok=true` — indistinguishable from a kill path that
 * stopped attributing. Hence the floor below.
 */
export const MIN_FAKE_SLEEP_MS = 30_000;

/** The sleep duration a fixture runs when the caller does not bound it. */
const DEFAULT_FAKE_SLEEP_MS = 120_000;

function fakeSleepCmd(ms: number): string {
  const seconds = Math.max(Math.ceil(ms / 1000), Math.ceil(MIN_FAKE_SLEEP_MS / 1000));
  return `${FAKE_SLEEP_SHAPE} ${seconds}`;
}

/**
 * A fake `pi` that stays alive until killed.
 *
 * `pidFile` is not decoration: the test needs pids it can poll, and
 * `spawnSpecialist` exposes neither a pid nor the ChildProcess. `echo $$` and
 * `echo $!` are the child naming its own leader and its own grandchild, so the
 * death evidence is a pid the OS can be asked about rather than one the test
 * guessed.
 *
 * `run` chooses which kill path the fake exercises:
 *
 *  - `"exec"` — a well-behaved child that answers SIGTERM and is killed by it.
 *    It does NOT `exec` the sleep: a directly-`exec`'d sleep leaves nothing in
 *    the script that could ever reap it, so when the interactive abort resolved
 *    the spawn without reaping the child, the ref'd `sleep` pinned the test's
 *    event loop and the run outlived its own ceiling (measured: 30 s of hang
 *    with nothing left to assert on). It runs the sleep in a subshell under an
 *    EXIT trap instead — dash runs that trap on SIGTERM as well as SIGKILL, so
 *    the child is gone however it dies. The abort still lands on a live process
 *    that is killed by it, which is all this variant is asked to prove.
 *  - `"trap"` — the escalation's subject: it IGNORES SIGTERM, so only the SIGKILL
 *    timer ends it. Its backgrounded sleep is a real grandchild, and a
 *    SIGKILLed leader cannot run a signal trap, so the reaper is an EXIT trap:
 *    dash runs those on SIGKILL, which means the sleep is reaped on the healthy
 *    path and on the broken one alike. The fixture therefore never leaves a
 *    sleep behind however the product behaves, and the RED signal comes solely
 *    from the OS poll — not from a leak the product was never asked to prevent.
 *    (A `trap … TERM` reaper cannot do this: it only runs when the leader
 *    survives to receive a signal, so the broken path cleaned up and the
 *    healthy path orphaned — measured, one sleep per run.) The first
 *    `trap "" TERM` is what makes the shell ignore SIGTERM at all.
 *
 * Both variants end in `wait`, and neither may drop it: without a foreground
 * command dash runs the EXIT trap and leaves immediately, so the sleep has
 * barely started when the script is gone and every probe observes a child that
 * finished on its own (`killCause` undefined, `ok` true) rather than one the
 * product was asked to kill. The cost of that `wait` is that dash defers the
 * EXIT trap while blocked in it, so the reaper is best-effort and an
 * unreaped descendant can outlive the spawn — which is why the ceiling in
 * `test-cancel.ts` checks liveness before it declares a hang.
 *
 * The subshell around the backgrounded sleep is deliberate too: dash's EXIT
 * trap does NOT reap a directly-backgrounded child (measured — the sleep
 * survived a group SIGKILL and was reparented to init), but it does reap one
 * nested in a subshell. The subshell is an extra process, not an extra
 * generation: the sleep stays a descendant of the leader, which is what
 * #1024's group kill reaches and what this test's poll watches.
 *
 * The `pi --version` guard is answered so binary resolution succeeds against
 * the fixture; it stays the one-line short-circuit the fixtures in this suite
 * use, which exits non-zero when the argument is not `--version`.
 *
 * `sleepMs` bounds how long a sleep the fixture leaves behind can survive its
 * own reaper — see `FAKE_SLEEP_MS` for the derivation and `MIN_FAKE_SLEEP_MS`
 * for the floor the caller's bound is clamped to.
 */
export function writeFakePi(
  fakeDir: string,
  run: "exec" | "trap",
  pidFile: string,
  grandPidFile?: string,
  sleepMs: number = DEFAULT_FAKE_SLEEP_MS,
) {
  const FAKE_SLEEP_CMD = fakeSleepCmd(sleepMs);
  const leader = `echo $$ > ${pidFile}`;
  const backgrounded = grandPidFile
    ? `( ${FAKE_SLEEP_CMD} ) &
echo $! > ${grandPidFile}`
    : `( ${FAKE_SLEEP_CMD} ) &`;
  const trapping = [
    "trap '' TERM",
    backgrounded,
    "trap 'kill -KILL $! 2>/dev/null' EXIT",
    "wait",
  ].join("\n");
  // SIGTERM-honouring sibling of `trapping`: same subshell + EXIT reaper, no
  // `trap '' TERM`, so the first signal ends it. See the `run` doc above for
  // why this shape is a reaped subshell and not a bare `exec`.
  const obedient = [backgrounded, "trap 'kill -KILL $! 2>/dev/null' EXIT", "wait"].join("\n");
  writeFileSync(
    join(fakeDir, "pi"),
    [
      "#!/bin/sh",
      '[ "$1" = "--version" ] && { echo 0.0.0; exit 0; }',
      leader,
      run === "trap" ? trapping : obedient,
    ].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
}
