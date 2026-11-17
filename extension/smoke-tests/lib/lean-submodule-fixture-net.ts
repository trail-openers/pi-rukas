/**
 * lib/lean-submodule-fixture-net — the recording exec that makes "no network was asked for"
 * a FACT rather than an assumption, plus the small assertions cases make about a tree.
 *
 * Split from `lean-submodule-local-fixture` along the seam that separates building a base
 * (which needs a working git and nothing else) from judging a run (which needs to know what
 * the code under test ASKED git). The exec refuses an argv that could only mean an off-host
 * read — a scheme, an `ssh`/`scp` form, or a `fetch`/`clone`/`pull`/`push`/`ls-remote` whose
 * operand is not a local path — BEFORE the child spawns, so a fix that quietly fell back to
 * the recorded URL is red on a laptop with internet and red on CI without one. Every child
 * also runs with `GIT_TERMINAL_PROMPT=0` and an empty proxy set, so a credential prompt or a
 * proxy detour fails rather than succeeding quietly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { INSIDE, SUB, gitEnv, gitIn } from "./lean-submodule-local-fixture.ts";

/** One git call the recording exec saw. */
export interface RecordedCall {
  cmd: string;
  argv: string[];
  cwd: string;
}

/**
 * An `ExecFn` that records every call and refuses anything that could reach the
 * network. The refusal happens before the child spawns, so the argv is the evidence
 * and the host's connectivity is not part of the verdict. See the module header.
 */
export function offlineExec(): { exec: ExecFn; calls: RecordedCall[]; network: string[] } {
  const calls: RecordedCall[] = [];
  const network: string[] = [];
  const exec: ExecFn = async (cmd, o) => {
    const argv = o?.argv ?? [];
    const cwd = o?.cwd ?? process.cwd();
    calls.push({ cmd, argv: [...argv], cwd });
    if (isNetworkArgv(argv)) {
      const shown = `${cmd} ${argv.join(" ")}`;
      network.push(shown);
      const err = new Error(`offline exec refused a network-shaped call: ${shown}`) as Error & {
        code?: number;
      };
      err.code = 128;
      throw err;
    }
    return execp(cmd, {
      ...o,
      env: {
        ...gitEnv(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_PROXY_UNKNOWN_PROTOCOL: "abort",
        http_proxy: "",
        https_proxy: "",
        ...(o?.env ?? {}),
      },
    });
  };
  return { exec, calls, network };
}

/**
 * argv shapes that can only mean "ask something off-host".
 *
 * The scheme forms are matched anywhere in the argv — no path on this host is named
 * `http://…`, so a match can only be a remote. The verb forms are matched on the
 * WHOLE argv, not per word, for two reasons: a submodule fetch carries its remote's
 * URL in the same invocation (`fetch --update-shallow -q --progress origin <url>`),
 * and git's own `--recurse-submodules` fetches sit two levels below the verb the
 * caller typed, so judging only the word after `fetch` reads a remote fetch as a
 * local one.
 */
const REMOTE_SHAPE: readonly RegExp[] = [
  /\b(?:https?|git|ssh|ftps?):\/\/\S/,
  /\bgit@\S+:/,
  /\bssh:\S+@\S/,
];
/** The verbs whose whole point is moving commits between hosts. */
const FETCH_VERB = /^(?:fetch|ls-remote|pull|push|clone)$/;

/**
 * Does this argv ask git for commits this host does not already hold?
 *
 * A scheme, an `scp`-style remote, or an `ssh:` form anywhere is a remote: no path on
 * this host is named `http://…`, so only a remote can match, and the match is made
 * on the word as git received it — a path made absolute here would turn a relative
 * one into something that looks local. Beyond that, a fetch-family verb with any
 * operand that is not an option, a `-c k=v` config assignment, or a path is a remote
 * read: git's own submodule fetches carry the remote's URL among the arguments
 * (`fetch --update-shallow -q origin <url>`), so the scan runs over every word and
 * not only the one after the verb. A local `git clone /abs/path` — what the fix
 * issues — answers false.
 */
function isNetworkArgv(argv: string[]): boolean {
  if (argv.some((a) => REMOTE_SHAPE.some((re) => re.test(a)))) return true;
  if (!argv.some((a) => FETCH_VERB.test(a))) return false;
  return argv.some((a) => !a.startsWith("-") && !a.includes("=") && a !== "." && !looksLikePath(a));
}

/** Is `a` a filesystem path rather than a remote name? (Any spelling with a `/`.) */
function looksLikePath(a: string): boolean {
  return a.includes("/") || a.includes(path.sep);
}

/** The submodule's HEAD as the tree reports it, or `undefined` when it has none. */
export function submoduleHead(dir: string, rel = SUB): string | undefined {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: path.join(dir, rel),
    encoding: "utf8",
    env: gitEnv(),
  });
  if (r.status !== 0) return undefined;
  const sha = (r.stdout ?? "").trim();
  return sha === "" ? undefined : sha;
}

/** Does the tree hold `rel` (a submodule's committed file)? */
export function populated(dir: string, rel = INSIDE): boolean {
  return existsSync(path.join(dir, rel));
}

/** Read a file, or `undefined` when it is not there. */
export function readOrNull(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `git -C`-style helper for a case's own assertions. */
export function show(dir: string, ...args: string[]): string {
  return gitIn(dir, ...args);
}
