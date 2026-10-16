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
 *   A. a real `SIGTERM`, with a no-op handler installed (the shape that keeps
 *      the process alive long enough for the listener to run) → `signal:SIGTERM`.
 *   B. stdin EOF, with the extension's `end` listener registered LAST — the
 *      rpc-mode ordering. Pi attaches its own `end` listener first (it reads
 *      commands from stdin), so Pi's shutdown runs before this module's
 *      listener is reached, and the value must already be right at that moment.
 *      That is what `process.stdin.readableEnded` buys: a fact on the stream
 *      that needs no listener of ours to have fired. Remove that read from
 *      `exit-cause.ts` and B goes red while A stays green.
 *   C. the first writer wins: an EOF already recorded is not overwritten by a
 *      later signal.
 *   D. nothing has happened yet → `unknown`, so the line names the gap rather
 *      than staying silent.
 *   E. arming is idempotent: the extension calls `armExitCause()` both at
 *      registration and on `session_start`; a second call must not add
 *      listeners that record a second, contradicting origin.
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
 * child's stdin is closed (EOF) or left open (only a signal can answer).
 * Every child is bounded: a hung child is killed and reported, not waited on.
 */
function runChild(
  script: string,
  opts: { endStdin: boolean; kill?: NodeJS.Signals; feed?: boolean },
): Promise<Child> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
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
    if (opts.feed) child.stdin.write("ping\n");
    if (opts.endStdin) child.stdin.end();
    if (opts.kill) {
      setTimeout(() => {
        child.kill(opts.kill);
      }, 300);
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
  // The no-op SIGTERM handler is what keeps the child alive for the tracker's
  // own listener to run: bun's default disposition would kill the process
  // before anything recorded a thing. stdin stays OPEN, so nothing else can
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
// red case — A, B2, C and D stay green, which is the proof that B1 exercises
// the stream flag and not the listener.
//
// B2 keeps the listener path itself under test, so the fix cannot be justified
// by a listener that never worked.
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
}

console.log(`\nexit ${exit}`);
process.exit(exit);
