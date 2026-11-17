/**
 * execp's argv form must give a CLI a stdin it cannot hang on (#2342), and keep
 * the rejection fields its callers read.
 *
 * The transport is `promisify(execFile)`, which builds its own stdio and drops a
 * caller's `stdio` option (verified on node and bun alike), so the child starts
 * on a fresh PIPE for fd 0. A CLI that decides to prompt — `glab mr create`
 * without its `-y`, anything that consults `GIT_TERMINAL_PROMPT` — blocks reading
 * that pipe, and the argv form carries no timeout unless the caller passes one.
 * `execp` therefore ends the child's stdin right after spawning, via the
 * ChildProcess `promisify` exposes as `.child`; the child reads EOF at once.
 *
 * The pins: a stdin-reading child gets EOF promptly — with NO timeout, so a
 * regression is a test failure rather than a hung suite; the #1279 argv contract
 * still holds; and a rejection still carries the captured `stdout`/`stderr`,
 * which `gitCatFileSaysAbsent` reads its verdict out of.
 *
 * The `end()` itself must be guarded. Node emits EPIPE on a pipe ASYNCHRONOUSLY,
 * so a child that exits before stdin closed leaves an `error` event on the
 * handle with no listener, and an unhandled `error` on a stream is an
 * uncaughtException that terminates the host process — the #932 incident, on
 * EVERY argv caller of `execp`. The pin for that is `test-epipe-host-survives`
 * below, which runs the real argv form in a REAL child process and reads its
 * exit code: no `uncaughtException` handler here could witness it.
 */

import { spawnSync } from "node:child_process";
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

/** How long a stdin read may take before this pin calls it a hang. */
const STDIN_SETTLE_MS = 5_000;

/** A child that reads stdin, plus a watchdog: no stdin end means no answer at all. */
async function readStdinWithin(argv: string[], ms = STDIN_SETTLE_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("__HANG__"), ms);
  });
  try {
    const run = execp("node", { argv });
    return await Promise.race([run.then((r) => r.stdout.trim()), settle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error & Record<string, unknown>) => e,
  );

const READS_STDIN = 'const n=require("fs").readSync(0,Buffer.alloc(8),0,8);process.stdout.write("n="+n)';

/**
 * A child of THIS test, run with the real argv form against a child that exits
 * immediately without reading its stdin. The write is 2 MB so the EPIPE is
 * queued and lands AFTER the child is gone (a small write to a stream whose
 * child is still alive never errors — that is what made this path look safe).
 *
 * It must exit 0. Without the stdin error guard the unhandled `error` event
 * becomes an uncaughtException and the runtime terminates the process: bun
 * exits 1 with `EPIPE: broken pipe, write` on stderr, node exits 1 with
 * `Unhandled 'error' event`. Both are witnessed here as a non-zero exit.
 */
const EPIPE_CHILD = `
import { execp } from ${JSON.stringify(new URL("../src/exec.ts", import.meta.url).pathname)};
const run = execp("node", { argv: ["-e", "process.exit(0)"] });
run.child.stdin.write(Buffer.alloc(2 * 1024 * 1024, 65));
run.child.stdin.end();
await run;
`;

async function epipeHostSurvives(): Promise<{ ok: boolean; status: number; tail: string }> {
  const r = spawnSync(process.execPath, ["-e", EPIPE_CHILD], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    encoding: "utf8",
    timeout: 20_000,
  });
  const tail = String(r.stderr ?? "").trim().split("\n").slice(0, 2).join(" | ");
  return { ok: r.status === 0, status: r.status ?? -1, tail };
}

async function main() {
  // ── 1. a stdin-reading child gets EOF, promptly, with no timeout to save it ─
  // This is THE pin: delete the `.end()` in exec.ts and both rows below report
  // __HANG__ (the child sits on a pipe nobody writes to), not a pass.
  const read = await readStdinWithin(["-e", READS_STDIN]);
  assert(read === "n=0", `a stdin read on the argv form returns EOF, never blocks (got ${read})`);

  // And with the stream drained through an `end` event rather than one read.
  const drained = await readStdinWithin([
    "-e",
    'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("GOT("+d+")"))',
  ]);
  assert(drained === "GOT()", `a child waiting on stdin's end event is released at once (got ${drained})`);

  // ── 1b. the `end()` must not be able to kill the host ─────────────────────
  // A child that exits immediately, ignoring stdin, must not raise an unhandled
  // `error` on its stdin handle. Witnessed OUT OF PROCESS, because that is what
  // the defect is: an uncaughtException terminates the process, so an in-process
  // listener would only hide it. See `EPIPE_CHILD` for why the write is large.
  const survives = await epipeHostSurvives();
  assert(
    survives.ok,
    `a child that exits without reading stdin cannot raise an unhandled stdin error (host exit ${survives.status}; ${survives.tail})`,
  );

  // execTree already closed fd 0 explicitly; it must keep doing so.
  const tree = await execTree("node", {
    argv: ["-e", 'const n=require("fs").readSync(0,Buffer.alloc(8),0,8);process.stdout.write("n="+n)'],
  });
  assert(tree.stdout.trim() === "n=0", `execTree's argv form keeps stdin closed (got ${tree.stdout.trim()})`);

  // ── 2. the #1279 argv contract still holds ────────────────────────────────
  const version = await execp("git", { argv: ["--version"] });
  assert(version.stdout.startsWith("git version"), `the argv form really runs the argv (got ${version.stdout.trim().slice(0, 30)})`);
  const literal = await execp("echo", { argv: ["$(echo injected)", "a|b", "x && y"] });
  assert(
    literal.stdout.trim() === "$(echo injected) a|b x && y",
    `an argv element is data, never shell syntax (got ${JSON.stringify(literal.stdout.trim())})`,
  );

  // ── 3. the rejection still carries the captured streams ───────────────────
  // Not decoration: `gitCatFileSaysAbsent` classifies a git probe out of
  // `err.stderr` ALONE, so a rejection that lost its stderr turns a real "that
  // path is not in that commit" into a `git-failed` refusal — a gate file the
  // repository does have would read as unreadable. Read it through the real
  // consumer, not just the field.
  // A git repo of our own, so the probe below answers locally and its wording is
  // git's real absence text rather than "not a git repository" — the classifier
  // returns false for a non-repo, which would make the pin below vacuous. The
  // directory is created empty and passed as `cwd` to `git init`, because bun's
  // spawn reports ENOENT for a cwd that does not exist yet.
  const repo = mkdtempSync(path.join(tmpdir(), "pi-ens-2342-"));
  await execp("git", { argv: ["init", "-q"], cwd: repo });
  const isRepo = await execp("git", { argv: ["rev-parse", "--is-inside-work-tree"], cwd: repo });
  assert(
    isRepo.stdout.trim() === "true",
    `the fixture really is a git repository, so the classifier below is not being handed a non-repo (got ${JSON.stringify(isRepo.stdout.trim())})`,
  );

  const absent = await errOf(
    execp("git", {
      argv: ["cat-file", "-t", "1111111111111111111111111111111111111111:.pi/merge-authors"],
      cwd: repo,
    }),
  );
  assert(
    typeof absent?.stdout === "string" && typeof absent?.stderr === "string",
    `a rejection carries string stdout and stderr (got ${typeof absent?.stdout}/${typeof absent?.stderr})`,
  );
  assert(
    typeof absent?.stderr === "string" && /does not exist/i.test(absent.stderr),
    `a git probe rejection carries git's own absence text on the Error (got ${JSON.stringify(String(absent?.stderr)).slice(0, 70)})`,
  );
  assert(
    gitCatFileSaysAbsent(absent) === true,
    `gitCatFileSaysAbsent still calls git's absence what it is (got ${String(gitCatFileSaysAbsent(absent))})`,
  );
  assert(
    gitCatFileSaysAbsent({ ...absent, stderr: undefined }) === false,
    "and the classifier's answer DOES depend on that stderr — an error without it is not absence (so the field is load-bearing)",
  );

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

  const missing = await errOf(execp("no-such-binary-2342", { argv: [] }));
  rmSync(repo, { recursive: true, force: true });
  assert(
    missing !== undefined && String(missing.code) === "ENOENT",
    `a spawn failure (ENOENT) rejects with execFile's code (got ${String(missing?.code)})`,
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

  console.log(`\nexit ${exit}`);
}

await main();
process.exit(exit);
