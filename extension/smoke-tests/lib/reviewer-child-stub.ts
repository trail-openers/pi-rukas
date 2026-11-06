/**
 * smoke-fixtures-1975 — the stub reviewer child, and the child_process seam that
 * swaps it in (#1975).
 *
 * Split from `test-reviewer-tree-isolation.ts` for the §12 size cap. The stub
 * child is a `node` script that prints the JSONL events a real child would emit
 * and exits, so the reviewer path exercises the REAL `spawnSpecialist` — its
 * cwd plumbing, its stdout pump, its done-detection — with no Pi binary, no
 * model and no token spend (the convention every sibling test states).
 *
 * Only the reviewer child is swapped: the discriminator is the child's own
 * `--mode rpc` argv, so git, the pi version probe and every other helper in the
 * process run for real.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

const REAL_CP = require("node:child_process") as typeof import("node:child_process");

/** The stub program: answers the kickoff prompt with an assistant `agent_end`
 * whose text is the reply the test names, and exits 0 when stdin closes. With
 * `REVIEWER_CHILD_FAIL` it exits non-zero without emitting anything — the shape
 * the lens retry loop reports as a failed attempt. */
const STUB_CHILD_FILE = path.join(
  mkdtempSync(path.join(os.tmpdir(), "rev-1975-prog-")),
  "child.js",
);
writeFileSync(
  STUB_CHILD_FILE,
  "const text = process.env.REVIEWER_REPLY_TEXT || 'clean';" +
    "let buf = '';process.stdin.on('data', d => {buf += d; if (buf.includes('prompt')) {" +
    "if (process.env.REVIEWER_CHILD_FAIL) { process.exit(1); return; }" +
    "console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',stopReason:'end_turn'," +
    "content:[{type:'text',text}]}]}));process.stdin.resume();}});" +
    "process.stdin.on('end', () => process.exit(0));\n",
);

/** Per-dispatch knobs the test sets before it spawns. */
export interface StubChild {
  /** The cwd the last stubbed child was spawned with — where the relocation is
   * observable, since that is the option the child actually received. Read
   * through the `as` cast below: `lastCwd` is the stub's own private field, kept
   * off this interface so a caller cannot write it. */
  lastChildCwd: () => string | undefined;
  /** Make the next child's `spawn()` itself throw (a spawn-layer failure). */
  throwSpawn: boolean;
  /** Make the next child exit non-zero without emitting an event. */
  childFail: boolean;
  /** The text the next child's assistant message carries. */
  reply: string;
  /** A body to run in the next child's cwd, before its process is created. */
  body: ((cwd: string) => void) | undefined;
}

/**
 * Install the stub for this test process and hand back its knobs.
 *
 * `env` is the isolated git env the fixture built (`gitTestEnv()`): the child
 * inherits it so a `git` it runs sees the same host-isolated view the fixture's
 * own git calls do.
 */
export function installStubChild(env: Record<string, string>): StubChild {
  const stub = {
    lastChildCwd: () => stub.lastCwd,
    throwSpawn: false,
    childFail: false,
    reply: "clean",
    body: undefined,
    lastCwd: undefined,
  } as StubChild & { lastCwd: string | undefined };
  mock.module("node:child_process", () => ({
    ...REAL_CP,
    spawn: (cmd: string, args?: unknown, opts?: { cwd?: string }) => {
      // Only the reviewer child is stubbed — `--mode rpc` is its own argv.
      if (!Array.isArray(args) || !args.includes("--mode") || !args.includes("rpc")) {
        return REAL_CP.spawn(cmd, args as string[] | undefined, opts);
      }
      if (stub.throwSpawn) throw new Error("spawn exploded");
      (stub as StubChild & { lastCwd: string | undefined }).lastCwd = opts?.cwd;
      const run = stub.body;
      stub.body = undefined;
      if (run) run(opts?.cwd ?? process.cwd());
      return REAL_CP.spawn(process.execPath, [STUB_CHILD_FILE], {
        ...opts,
        env: {
          ...env,
          REVIEWER_REPLY_TEXT: stub.reply,
          REVIEWER_CHILD_FAIL: stub.childFail ? "1" : "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  }));
  return stub;
}

/** `git -C dir …` returning trimmed stdout, under the fixture's isolated env. */
export function makeGit(dir: string, env: Record<string, string>) {
  // `gitTestEnv()` IS the caller's env plus the fixture's isolation, with the
  // git location variables removed: passing the two options separately would
  // have one silently win over the other (#1981).
  const scrubbed = gitTestEnv(env);
  const out = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: scrubbed })
      .toString()
      .trim();
  return { out, run: (...args: string[]) => void out(...args) };
}
