/**
 * execp's argv form must give a CLI a stdin it cannot hang on (#2342 R3).
 *
 * Measured on node 22 and bun 1.4 alike: `promisify(execFile)` leaves the child
 * on a fresh PIPE for fd 0 and silently drops a caller's `stdio` option
 * (`execFile` builds its own stdio), while `stdio:"inherit"` reproduces the
 * parent's inode. A pipe is not the harness's keyboard, but a CLI that decides
 * to prompt — `glab mr create` without its `-y`, anything that consults
 * `GIT_TERMINAL_PROMPT` — blocks reading that pipe, and the argv form carries no
 * timeout unless the caller passes one. The argv form therefore runs through
 * `spawn` with fd 0 `ignore`d, and `/dev/null` answers EOF at once.
 *
 * The pins, in order: fd 0 is /dev/null and reads as EOF; the argv contract of
 * #1279 still holds (argv is run, and argv is data); and the error shapes the
 * argv form inherits from `execFile` are unchanged — failure fields, `maxBuffer`
 * overflow, and timeout — because #2342 replaced `promisify(execFile)` with a
 * hand-rolled `spawn`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { execTree } from "../src/exec-tree.ts";
import { gitCatFileSaysAbsent } from "../src/git-range.ts";

let exit = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The child reports its own fd 0: dev, whether it is a character device, and one read. */
const FD0_PROBE = [
  "const fs=require('fs');",
  "const s=fs.fstatSync(0);",
  "let r;",
  "try{const n=fs.readSync(0,Buffer.alloc(16),0,16);r=n===0?'EOF':('BYTES'+n)}catch(e){r='ERR:'+e.code}",
  "process.stdout.write(s.dev+'|'+s.isCharacterDevice()+'|'+r)",
].join("");

/** Linux's /dev/null: character device, inode 5, so fd 0 was `ignore`d. */
const DEV_NULL = "7|true|EOF";

const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error & Record<string, unknown>) => e,
  );

async function main() {
  // ── 1. fd 0 is closed for the child ──────────────────────────────────────
  const { stdout } = await execp("node", { argv: ["-e", FD0_PROBE] });
  assert(stdout.trim() === DEV_NULL, `argv form gives the child fd 0 = /dev/null, EOF on read (got ${stdout.trim()})`);

  const group = await execp("node", { argv: ["-e", FD0_PROBE], killGroup: true });
  assert(group.stdout.trim() === DEV_NULL, `the killGroup argv path keeps stdin ignored (got ${group.stdout.trim()})`);

  const tree = await execTree("node", { argv: ["-e", FD0_PROBE] });
  assert(tree.stdout.trim() === DEV_NULL, `execTree's argv form keeps stdin ignored (got ${tree.stdout.trim()})`);

  // A CLI that reads stdin at all gets EOF now, rather than waiting for a reply.
  const read = await execp("node", {
    argv: ["-e", 'const n=require("fs").readSync(0,Buffer.alloc(8),0,8);process.stdout.write("n="+n)'],
    timeout: 5_000,
  });
  assert(read.stdout.trim() === "n=0", `a stdin read on the argv form returns EOF, never blocks (got ${read.stdout})`);

  // ── 2. the #1279 argv contract still holds after the transport change ────
  const version = await execp("git", { argv: ["--version"] });
  assert(version.stdout.startsWith("git version"), `the argv form really runs the argv (got ${version.stdout.trim().slice(0, 30)})`);
  const literal = await execp("echo", { argv: ["$(echo injected)", "a|b", "x && y"] });
  assert(
    literal.stdout.trim() === "$(echo injected) a|b x && y",
    `an argv element is data, never shell syntax (got ${JSON.stringify(literal.stdout.trim())})`,
  );

  // ── 3. the rejection shapes the argv form inherited from execFile ────────
  // Characterised against the real `promisify(execFile)` on this node, which is
  // what this path was: a non-zero exit carries `code`/`killed:false`/`signal`
  // and `Command failed: <cmd>` + stderr in the message; an overflow carries
  // only `code`; a timeout carries `code:null`/`killed:true`/`signal`.
  const failed = await errOf(
    execp("node", { argv: ["-e", 'process.stderr.write("bad-2342");process.exit(1)'] }),
  );
  assert(
    failed?.code === 1 &&
      failed.killed === false &&
      failed.signal === null &&
      failed.message.startsWith("Command failed: node") &&
      failed.message.includes("bad-2342"),
    `a non-zero exit rejects with execFile's shape (got code=${String(failed?.code)} killed=${String(failed?.killed)})`,
  );

  const failedOut = await errOf(
    execp("node", { argv: ["-e", 'process.stdout.write("to");process.exit(3)'] }),
  );
  assert(failedOut?.code === 3, `a non-zero exit reports the exit code (got ${String(failedOut?.code)})`);

  // The rejection carries the captured streams, not just the message. This is
  // not decoration: `gitCatFileSaysAbsent` classifies a git probe out of
  // `err.stderr` ALONE, so a rejection that lost its stderr turns a real
  // "that path is not in that commit" into a `git-failed` refusal — a gate file
  // the repository does have would read as unreadable. Read it through the real
  // consumer, not just the field.
  // A git repo of our own, so the probe below answers locally and its wording is
  // git's real absence text rather than whatever a network remote says.
  const repo = mkdtempSync(path.join(tmpdir(), "pi-ens-2342-"));
  await execp("git", { argv: ["init", "-q", repo] });

  const absent = await errOf(
    execp("git", {
      argv: ["-C", repo, "cat-file", "-t", "1111111111111111111111111111111111111111:.pi/merge-authors"],
    }),
  );
  assert(
    typeof absent?.stderr === "string" && absent.stderr.length > 0,
    `a git probe rejection carries stderr on the Error (got ${JSON.stringify(String(absent?.stderr)).slice(0, 60)})`,
  );
  assert(
    gitCatFileSaysAbsent(absent) === true,
    `gitCatFileSaysAbsent still calls git's absence what it is (got ${String(gitCatFileSaysAbsent(absent))})`,
  );
  assert(
    gitCatFileSaysAbsent({ ...absent, stderr: undefined }) === false,
    "and the classifier's answer DOES depend on that stderr — an error without it is not absence (so the field is load-bearing)",
  );

  const missing = await errOf(execp("no-such-binary-2342", { argv: [] }));
  rmSync(repo, { recursive: true, force: true });
  assert(
    missing !== undefined && String(missing.code) === "ENOENT",
    `a spawn failure (ENOENT) rejects with execFile's code (got ${String(missing?.code)})`,
  );

  const overflow = await errOf(
    execp("node", { argv: ["-e", 'process.stdout.write("x".repeat(5000))'], maxBuffer: 100 }),
  );
  assert(
    overflow?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
      overflow.message === "stdout maxBuffer length exceeded",
    `a stdout past maxBuffer rejects with execFile's overflow code and message (got ${String(overflow?.code)} / ${String(overflow?.message)})`,
  );

  const hung = await errOf(
    execp("node", { argv: ["-e", "setTimeout(()=>{},30000)"], timeout: 300 }),
  );
  assert(
    hung?.killed === true && hung.code === null && hung.signal === "SIGTERM",
    `a hung argv run is stopped at its timeout with execFile's kill shape (got killed=${String(hung?.killed)} code=${String(hung?.code)} signal=${String(hung?.signal)})`,
  );

  // The byte-exactness a blob read depends on is unchanged by the transport.
  const bytes = await execp("node", {
    argv: ["-e", "process.stdout.write(Buffer.from([0xc3,0xa9,0xff]))"],
    stdoutEncoding: "latin1",
  });
  assert(
    Buffer.from(bytes.stdout, "latin1").toString("hex") === "c3a9ff",
    `a latin1 stdout read returns the command's exact bytes (got ${Buffer.from(bytes.stdout, "latin1").toString("hex")})`,
  );

  // The default executor of a forge adapter call carries no timeout, so the
  // prompt-safety of R3 is what makes a prompting glab survivable at all.
  const noTimeout = await execp("node", {
    argv: ["-e", 'const n=require("fs").readSync(0,Buffer.alloc(8),0,8);process.stdout.write(String(n))'],
  });
  assert(noTimeout.stdout.trim() === "0", `with NO timeout the stdin read still settles (got ${noTimeout.stdout})`);

  console.log(`\nexit ${exit}`);
}

await main();
process.exit(exit);
