#!/usr/bin/env bun
/**
 * #1247 — the origin a `session_shutdown` came from, under the two shapes that
 * actually produce it.
 *
 * Both of this seam's answers come from a real process event, and neither can
 * be faked in-process: a signal has to be delivered by the kernel, and stdin
 * EOF has to be produced by a parent closing the pipe. So every case here runs
 * a fresh child (`bun -e`) that arms the real trackers and prints
 * `exitOrigin()` from a shutdown-like call, and the parent asserts the printed
 * value against a FIXED expectation.
 *
 *   A. a real `SIGTERM` reaching this module's listener, with the tracker
 *      installed FIRST and a co-handler added after it that reads the origin and
 *      exits → `signal:SIGTERM`.
 *   G. the born-EOF stdin, which is the #1247 round-2 fix. The same signal,
 *      delivered to the SAME script, but with stdin bound to `/dev/null` —
 *      what `stdio: "ignore"` and a shell's `< /dev/null` give a child — must
 *      report `signal:SIGTERM` and NOT `stdin-eof`: fd 0 was already at EOF
 *      when the process started, so no caller closed anything. And the same
 *      born-EOF child that exits on its own must report `unknown`.
 *      That pair is the whole claim of the `fstatSync(0)` FIFO/socket guard:
 *      remove the guard and G1 goes red (it reads `stdin-eof`, the mislabel the
 *      issue is about) while A stays green — A's stdin is a pipe, which the
 *      guard admits either way. Verified by mutation.
 *   B. stdin EOF, with the extension's `end` listener registered LAST — the
 *      rpc-mode ordering. Pi attaches its own `end` listener first (it reads
 *      commands from stdin), so Pi's shutdown runs before this module's
 *      listener is reached, and the value must already be right at that moment.
 *      That is what `process.stdin.readableEnded` buys: a fact on the stream
 *      that needs no listener of ours to have fired.
 *      MEASURED, so these claims are load-bearing and were re-checked rather
 *      than inherited. Two mutations of `exit-cause.ts`, run in full:
 *        • the `readableEnded` READ removed — **B1 is the only red case**.
 *          A, B2, C and D stay green: B2 and C reach the origin through the
 *          `end` LISTENER, which records it before anything reads it, so the
 *          listener carries them and they cannot falsify the stream read. B1 is
 *          the only case that reads from a handler installed BEFORE this
 *          module's, which is why it is the only one that reddens.
 *        • the `end` LISTENER removed — **C is the only red case**, and B2
 *          STAYS GREEN. B2 passed the old header's claim that it falsified the
 *          listener, and the reason is this module's own read: with the listener
 *          gone, `exitOrigin()` still answers `stdin-eof` from `readableEnded`,
 *          so the case cannot tell "the listener recorded it" from "the stream
 *          flag said so". C does falsify it, because its `AFTER_LATE_SIGNAL`
 *          line only holds when the listener wrote the first origin. So the
 *          listener path is under test by C, not by B2 — a claim about which
 *          cases a mutation reddens has to be re-measured whenever the fix
 *          changes shape, or it becomes doctrine nobody can falsify.
 *   C. the first writer wins: an EOF already recorded is not overwritten by a
 *      later signal.
 *   D. nothing has happened yet → `unknown`, so the line names the gap rather
 *      than staying silent.
 *   E. arming is idempotent: the extension calls `armExitCause()` both at
 *      registration and on `session_start`; a second call must not add
 *      listeners that record a second, contradicting origin.
 *   H. the default signal disposition survives arming. Installing a listener
 *      replaces a signal's default action, and SIGTERM is fatal by default — so
 *      a tracker that only recorded the origin would make `kill <pi>` stop
 *      killing Pi. A child armed with NO other SIGTERM handler must still die
 *      of the signal; a child that also installs a handler of its own must
 *      survive it, because that process decided to handle the signal and this
 *      module has no business killing it.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import {
  armExitCause,
  exitOrigin,
  recordExitCauseForTesting,
  resetExitCauseForTesting,
} from "../src/exit-cause.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const MOD = path.resolve(import.meta.dirname, "..", "src", "exit-cause.ts");

interface Child {
  code: number | null;
  sig: string | null;
  out: string;
  err: string;
}

/**
 * Run `script` in a fresh `bun -e` child. `endStdin` decides whether the
 * child's stdin is closed (EOF) or left open (only a signal can answer); both
 * are PIPES, so a caller can close them and the stdin-EOF origin is available.
 * `devNullStdin` instead binds fd 0 to /dev/null — the shape `stdio: "ignore"`
 * gives — where the stream is born at EOF and no caller could have closed it,
 * which is what the FIFO/socket guard has to refuse to blame (cases G).
 * `externalSignal` delivers the signal from this parent after the child has
 * armed, rather than from a timer inside it. Every child is bounded: a hung
 * child is killed and reported, not waited on.
 */
function runChild(
  script: string,
  opts: {
    endStdin: boolean;
    kill?: NodeJS.Signals;
    feed?: boolean;
    devNullStdin?: boolean;
    externalSignal?: boolean;
  },
): Promise<Child> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: opts.devNullStdin ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code, sig) => resolve({ code, sig, out, err }));
    // A byte before EOF: some bun versions only deliver `end` once the stream
    // has been in flowing mode with data, and a case that never sees EOF would
    // fail for the wrong reason.
    if (opts.feed) child.stdin?.write("ping\n");
    if (opts.endStdin) child.stdin?.end();
    if (opts.kill) {
      if (opts.externalSignal) {
        // The parent is the only thing that can tell "a caller closed the
        // pipe" from "someone signalled me" for the G and H cases, so the
        // signal has to come from outside. A child that never armed would be
        // killed by the default disposition and report nothing; a child whose
        // tracker is armed survives and prints, which IS the observation.
        // Under `devNullStdin` there is no stdin stream at all to guard.
        child.stdin?.on("error", () => {});
        setTimeout(() => {
          child.kill(opts.kill);
        }, 400);
      } else {
        setTimeout(() => {
          child.kill(opts.kill);
        }, 300);
      }
    }
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, sig: "child-timeout", out, err });
    }, 8000);
  });
}

const IMPORT = `import { armExitCause, exitOrigin, recordExitCauseForTesting } from ${JSON.stringify(MOD)};\n`;

// ---------------------------------------------------------------------------
// A. A real SIGTERM names the signal.
// ---------------------------------------------------------------------------
{
  // A co-handler installed AFTER armExitCause() is what keeps the child alive
  // for the tracker's own listener to run: with ours the only listener the
  // tracker removes itself and re-raises the default fatal disposition (case H)
  // and nothing would print. stdin stays an OPEN PIPE, so nothing else can
  // answer — `signal:SIGTERM` here is the signal and nothing else.
  const script = `${IMPORT}armExitCause();\nprocess.stdin.resume();\nprocess.on("SIGTERM", () => { process.stdout.write("ORIGIN:" + exitOrigin() + "\\n"); process.exit(0); });\nsetTimeout(() => { process.stdout.write("TIMEOUT:" + exitOrigin() + "\\n"); process.exit(1); }, 3000);\n`;
  const r = await runChild(script, { endStdin: false, kill: "SIGTERM" });
  assert(
    r.out.includes("ORIGIN:signal:SIGTERM"),
    `A: a real SIGTERM with a no-op handler yields signal:SIGTERM (got ${JSON.stringify(r.out || r.err)})`,
  );
}

// ---------------------------------------------------------------------------
// B. stdin EOF yields stdin-eof THROUGH the readableEnded read.
//
// B1 is the case #1247 is about, and the only one that can prove the fix. The
// listener path alone proves nothing: a listener that fires and then reads the
// origin has already recorded it, so the read is checking a value the same
// mechanism wrote. The child therefore installs a PREPENDED `end` handler — the
// rpc-mode shape, where Pi's own stdin `end` listener runs first and calls
// `shutdown()` — and that handler reads the origin SYNCHRONOUSLY and exits
// before this module's listener can ever be reached. `origin` is still
// undefined at that instant; only `process.stdin.readableEnded`, Node's own
// record on the stream that needs no listener of ours, can answer. The handler
// prints `readableEnded` on the same line, so a red B1 means the read is gone
// from `exitOrigin()` rather than the stream having behaved differently.
// Verified by mutation: with the `readableEnded` branch removed, B1 is the only
// red case — A, B2, C and D stay green. B2 and C do NOT falsify the read: both
// reach the origin through this module's own `end` LISTENER, which has already
// recorded it by the time anything reads it, so the listener carries them. Only
// B1 reads before that listener can run, which is exactly why it is the case
// that reddens. (Measured, not assumed — see the header.)
//
// B2 keeps the listener path itself under test — MEASURED, it does not: with
// this module's `end` listener removed from `exit-cause.ts` B2 still passes,
// because `exitOrigin()` answers from `readableEnded` regardless. C is the case
// that actually falsifies the listener (its `AFTER_LATE_SIGNAL` line needs the
// listener to have written the first origin). B2 stays as the plain-stream check.
// ---------------------------------------------------------------------------
{
  const script = `${IMPORT}armExitCause();
process.stdin.on("data", () => {});
// Pi's listener runs first (rpc-mode.js attaches it before extensions load).
// It reads the origin synchronously and exits, so nothing after it ever runs.
process.stdin.prependListener("end", () => {
  process.stdout.write("ENDED:" + process.stdin.readableEnded + "\\n");
  process.stdout.write("SHUTDOWN:" + exitOrigin() + "\\n");
  process.exit(0);
});
setTimeout(() => { process.stdout.write("TIMEOUT\\n"); process.exit(1); }, 3000);`;
  const r = await runChild(script, { endStdin: true, feed: true });
  assert(
    r.out.includes("ENDED:true") && r.out.includes("SHUTDOWN:stdin-eof"),
    `B1: read before this module's listener can run, EOF still yields stdin-eof via readableEnded (got ${JSON.stringify(r.out || r.err)})`,
  );
}
{
  const script = `${IMPORT}armExitCause();
process.stdin.on("data", () => {});
process.stdin.on("end", () => { process.stdout.write("LISTENER:" + exitOrigin() + "\\n"); process.exit(0); });`;
  const r = await runChild(script, { endStdin: true });
  assert(
    r.out.includes("LISTENER:stdin-eof"),
    `B2: ...and the listener path still records it on its own (got ${JSON.stringify(r.out || r.err)})`,
  );
}

// ---------------------------------------------------------------------------
// C. The first writer wins.
// ---------------------------------------------------------------------------
{
  // EOF records first; a signal arriving afterwards must not replace it.
  // `recordExitCauseForTesting` stands in for the second listener: the point
  // under test is the guard in `record`, not the listener wiring (A and B
  // cover that with the real thing).
  const lines = [
    `${IMPORT}armExitCause();`,
    'process.on("SIGTERM", () => {});',
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    '  process.stdout.write("AFTER_EOF:" + exitOrigin() + "\\n");',
    '  recordExitCauseForTesting("signal:SIGTERM");',
    '  process.stdout.write("AFTER_LATE_SIGNAL:" + exitOrigin() + "\\n");',
    "  process.exit(0);",
    "});",
  ].join("\n");
  const r = await runChild(lines, { endStdin: true });
  assert(
    r.out.includes("AFTER_EOF:stdin-eof") && r.out.includes("AFTER_LATE_SIGNAL:stdin-eof"),
    `C: the first origin wins and a later one is ignored (got ${JSON.stringify(r.out || r.err)})`,
  );
}

// ---------------------------------------------------------------------------
// D. Nothing has happened: the gap is named, not left blank.
// ---------------------------------------------------------------------------
{
  // stdin is never ended (a write keeps the stream live), so nothing has
  // fired and nothing has ended.
  const lines = [
    `${IMPORT}armExitCause();`,
    'process.stdin.on("data", () => {});',
    'process.stdout.write("BEFORE:" + exitOrigin() + "\\n");',
    "setTimeout(() => { process.exit(0); }, 150);",
  ].join("\n");
  const r = await runChild(lines, { endStdin: false });
  assert(
    r.out.includes("BEFORE:unknown"),
    `D: with no signal and no EOF the origin is unknown, naming the gap (got ${JSON.stringify(r.out || r.err)})`,
  );
}

// ---------------------------------------------------------------------------
// G. A born-EOF stdin is not a cause (#1247 round 2).
//
// `stdio: "ignore"` and a shell's `< /dev/null` give the child a character
// device on fd 0 that is already at EOF when the process starts. Node reports
// `readableEnded` for it, so an unguarded read blamed every such session's quit
// on "the caller closed stdin" — including a SIGTERM that arrived, and a Pi
// that exited of its own accord. There is no caller to close anything, so there
// is no stdin cause. Both cases take the signal from THIS parent, at a moment
// the parent chooses: only the parent can separate "the pipe closed" from
// "someone signalled me", and a born-EOF stdin means the pipe answer is not
// available at all.
// ---------------------------------------------------------------------------
const G_SIGNAL_COHANDLER = `armExitCause();
process.stdin.resume();
process.on("SIGTERM", () => {
  process.stdout.write("ORIGIN:" + exitOrigin() + "\\n");
  process.exit(0);
});
setTimeout(() => { process.stdout.write("TIMEOUT:" + exitOrigin() + "\\n"); process.exit(1); }, 3000);`;
{
  // Same signal, same script shape as A — only fd 0 differs (a pipe there, a
  // character device here). That single difference is the fix: with the FIFO /
  // socket guard removed this is the one case that flips, from `signal:SIGTERM`
  // to `stdin-eof`, because `readableEnded` is true for a born-EOF stream and
  // the guard is what stops the read from believing it.
  const r = await runChild(`${IMPORT}${G_SIGNAL_COHANDLER}`, {
    endStdin: false,
    kill: "SIGTERM",
    devNullStdin: true,
    externalSignal: true,
  });
  assert(
    r.out.includes("ORIGIN:signal:SIGTERM"),
    `G1: /dev/null stdin + a real SIGTERM still yields signal:SIGTERM, never stdin-eof (got ${JSON.stringify(r.out || r.err)})`,
  );
}
{
  // The self-exit: nothing fired, and the born-EOF stream must not be read as
  // something that happened. `unknown` is the honest answer, and it is the
  // answer the operator's log needs — "we do not know" rather than a cause that
  // never existed. The trailing timer is the H1 lesson applied here: the child
  // has to still be alive when this parent looks at it, or `code 0` would be
  // the exit of a process that finished before anything was observed.
  const r = await runChild(
    `${IMPORT}armExitCause();\nprocess.stdin.resume();\nprocess.stdout.write("ORIGIN:" + exitOrigin() + "\\n");\nsetTimeout(() => { process.exit(0); }, 200);`,
    { endStdin: false, devNullStdin: true },
  );
  assert(
    r.out.includes("ORIGIN:unknown"),
    `G2: /dev/null stdin and a self-exit yields unknown, not stdin-eof (got ${JSON.stringify(r.out || r.err)})`,
  );
}

// ---------------------------------------------------------------------------
// H. Arming must not change what a signal DOES.
//
// `process.on("SIGTERM", …)` replaces the signal's default disposition, and
// SIGTERM's default is to kill the process. A tracker that only recorded the
// origin would therefore make `kill <pi>` stop killing Pi — so the handler hands
// the disposition back when it is the only listener. These two cases are the
// pair that pins it: armed alone the child still dies of the signal; armed
// alongside a handler of its own it must survive, because the process decided
// to handle the signal and a tracker must not murder it for deciding.
// ---------------------------------------------------------------------------
{
  // `process.stdin.resume()` is load-bearing, not decoration: bun lets a child
  // with no pending work exit the moment its script finishes, and a child that
  // is already gone reports code 0 for a signal that was never delivered — a
  // green H1 would then prove nothing. Keeping stdin flowing is the one thing
  // that reliably holds the loop open, so the SIGTERM below lands on a live
  // process. The assertion on `!out.includes("TIMEOUT")` is the guard that says
  // the same thing from the other side: had the signal not arrived, the child
  // would have printed TIMEOUT and exited 1.
  const r = await runChild(
    `${IMPORT}armExitCause();\nprocess.stdin.resume();\nprocess.stdout.write("A\\n");\nsetTimeout(() => { process.stdout.write("TIMEOUT\\n"); process.exit(1); }, 3000);`,
    { endStdin: false, kill: "SIGTERM", externalSignal: true },
  );
  assert(
    r.sig === "SIGTERM" && !r.out.includes("TIMEOUT"),
    `H1: a bare process armed with no other handler still dies of SIGTERM, disposition preserved (got ${JSON.stringify({ code: r.code, sig: r.sig, out: r.out })})`,
  );
}
{
  const r = await runChild(
    `${IMPORT}armExitCause();\nprocess.stdin.resume();\nprocess.on("SIGTERM", () => { process.stdout.write("HANDLED\\n"); process.exit(0); });\nprocess.stdout.write("A\\n");\nsetTimeout(() => { process.stdout.write("TIMEOUT\\n"); process.exit(1); }, 3000);`,
    { endStdin: false, kill: "SIGTERM", externalSignal: true },
  );
  assert(
    r.code === 0 && r.out.includes("HANDLED"),
    `H2: a process with its own SIGTERM handler survives it — the tracker re-raises only as sole listener (got ${JSON.stringify({ code: r.code, sig: r.sig, out: r.out })})`,
  );
}

// ---------------------------------------------------------------------------
// E. The first writer wins, in-process, and the test-only reset works.
// ---------------------------------------------------------------------------
{
  const armedTwice = () => {
    // In-process: `armExitCause()` is called twice exactly as index.ts calls it
    // (registration, then `session_start`), and a double-armed listener set must
    // not change the answer. C proves the same guard across a process boundary;
    // this covers the reset the rest of the suite relies on.
    resetExitCauseForTesting();
    armExitCause();
    armExitCause();
    recordExitCauseForTesting("signal:SIGHUP");
    assert(exitOrigin() === "signal:SIGHUP", "E: a recorded origin is what the readers see");
    recordExitCauseForTesting("stdin-eof");
    assert(
      exitOrigin() === "signal:SIGHUP",
      "E: arming twice and recording twice still keeps the first origin",
    );
    resetExitCauseForTesting();
    assert(exitOrigin() === "unknown", "E: the test-only reset returns it to unknown");
  };
  armedTwice();
}

// ---------------------------------------------------------------------------
// F. The seam is what index.ts arms. The registration-time call is the fix for
//    rpc mode never emitting `session_start`; a canary here keeps the import
//    honest so the call cannot be dropped in a refactor.
// ---------------------------------------------------------------------------
{
  const src = await Bun.file(path.resolve(import.meta.dirname, "..", "src", "index.ts")).text();
  assert(
    /armExitCause\(\);/.test(src),
    "F: index.ts arms the trackers (registration-time call and/or session_start)",
  );
  assert(
    /readableEnded/.test(await Bun.file(MOD).text()),
    "F: exit-cause.ts reads process.stdin.readableEnded — the listener-independent path",
  );
  // The two guards the read depends on, pinned at the source: a refactor that
  // drops either silently re-opens the mislabel G1 is the counterexample for.
  const mod = await Bun.file(MOD).text();
  assert(
    /fstatSync\(0\)/.test(mod) && /isFIFO\(\)/.test(mod) && /isSocket\(\)/.test(mod),
    "F: exit-cause.ts gates the stdin read on fstat(0) being a FIFO or socket — a born-EOF stdin is not a cause",
  );
  assert(
    /process\.kill\(process\.pid,\s*sig\)/.test(mod),
    "F: exit-cause.ts re-raises the signal so arming does not swallow the default fatal disposition",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
