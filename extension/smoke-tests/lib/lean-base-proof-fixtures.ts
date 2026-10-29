/**
 * lean/base-proof test fixtures — a `git` the base proof believes.
 *
 * `proveBaseSha` asks git twice and the answer to each decides a different
 * outcome: the first (`rev-parse --verify --quiet <sha>^{commit}`) says whether
 * the value names a commit, the second (`cat-file -e <sha>^{commit}`) says
 * whether the clone holds it at all when the first could not say. A case cannot
 * reach the interesting states through a real repository — "a full sha that is
 * not a commit" is easy (`deadbeef…`), but "a git that could not answer" and "a
 * value that resolves to a DIFFERENT oid" are not things an object store will do
 * on request — so the cases stand in for the binary and the fixture keeps the
 * argv, which is what makes "the peel was skipped" a failure rather than a pass.
 *
 * `GIT_TIMEOUT` mirrors the bound `review-head-sha.ts` puts on its own read, so
 * a case that asserts a call carried a timeout is asserting against the number
 * the production reader uses rather than a copy of a copy.
 */

import { LOCAL_GIT_TIMEOUT_MS } from "../../src/review-patch-identity.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";

/** The bound `resolveHeadSha` puts on its rev-parse; the second probe must match it. */
export const GIT_TIMEOUT = LOCAL_GIT_TIMEOUT_MS;

/** The executor seam `proveBaseSha` is called with — the same type the config loader injects. */
export type FakeExec = VerifyExecFn;

/** What one stand-in git invocation returns: a result, or a rejection with the exec shape. */
export type GitReply =
  | { stdout?: string; stderr?: string }
  | { throw: { code?: number | null; stderr?: string; message?: string; killed?: boolean } };

/** Every call a fake made, so a case can assert the argv rather than trust a verdict. */
export interface ExecLog {
  cmd: string;
  argv: string[];
  cwd?: string;
  timeout?: number;
}

/** Did this argv ask the peel question (`git cat-file -e … <sha>^{commit}`)? */
export function isCatFileProbe(argv: string[]): boolean {
  const at = gitArgv(argv);
  return at[0] === "cat-file" && at[1] === "-e";
}

/** Did this argv ask the resolution question (`git rev-parse --verify --quiet …`)? */
export function isRevParse(argv: string[]): boolean {
  const at = gitArgv(argv);
  return at[0] === "rev-parse" && at[1] === "--verify";
}

/**
 * The argv with git's own `-C <dir>` prefix removed.
 *
 * `resolveHeadSha` passes `-C cwd` and the peel does not, so a case that
 * matched on positional 0 would be asserting on one call site's spelling of the
 * repo rather than on the question that was asked. Stripping the prefix is what
 * lets both reads be compared by the subcommand.
 */
export function gitArgv(argv: string[]): string[] {
  return argv[0] === "-C" ? argv.slice(2) : argv;
}

function rejected(r: Extract<GitReply, { throw: unknown }>): never {
  const e = r.throw;
  throw Object.assign(new Error(e.message ?? `Command failed: git\n${e.stderr ?? ""}`), {
    code: e.code === undefined ? null : e.code,
    signal: null,
    killed: e.killed === true,
    stdout: "",
    stderr: e.stderr ?? "",
  });
}

/**
 * A `git` that answers from a queue, one reply per call, in order.
 *
 * A queue rather than a matcher because the order IS the contract: the
 * resolution first and the second opinion only after a miss. A case queues the
 * replies that story needs and then asserts on `calls`, so a proof that skipped
 * the peel, ran it before the resolution, or bounded it with no timeout is
 * visible in the log instead of being inferred from a verdict that happened to
 * come out right.
 *
 * Anything the queue does not cover is a hard failure naming the argv: a
 * production change that starts asking a new git question must arrive with a
 * case that meant to ask it.
 */
// `execp` resolves for a REJECTION whose exit code is 0 (the exec wrapper
// rejects whenever stderr is non-empty, and git prints its refusal on stderr),
// so a fake that only ever rejects would let a "refused" run through the
// `probeCommitObject` success arm and report a refusal for the wrong reason.
// `{ stdout: "" }` is the queue entry for a resolution that printed nothing:
// same miss, no rejection, and — unlike a rejection — it does not arm the
// swallowed-failure counter case (i) pins.
export function fakeGit(replies: GitReply[]): { exec: FakeExec; calls: ExecLog[] } {
  const calls: ExecLog[] = [];
  const queue = [...replies];
  const exec: FakeExec = async (cmd, opts) => {
    // `opts` is optional in `VerifyExecFn`, so the optionals are read off a
    // local: `VerifyExecFn`'s own contract allows a caller with no options at
    // all, and a fake that threw there would blame the case for a signature.
    const argv = opts?.argv ?? [];
    calls.push({ cmd, argv, cwd: opts?.cwd, timeout: opts?.timeout });
    const reply = queue.shift();
    if (reply === undefined)
      throw new Error(`fake git: no queued reply for \`${cmd} ${argv.join(" ")}\``);
    if ("throw" in reply) return rejected(reply);
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { exec, calls };
}

/** A reply for a value that is no object at all — git's own wording, not ours. */
export function missingObject(sha: string): GitReply {
  return {
    throw: {
      code: 128,
      stderr: `fatal: Not a valid object name ${sha}^{commit}\n`,
      message: `Command failed: git\nfatal: Not a valid object name ${sha}^{commit}`,
    },
  };
}

/** A reply for a repository git could not read at all: no exit code, no verdict. */
export function gitFault(cause = "fatal: not a git repository"): GitReply {
  return { throw: { code: null, stderr: "", message: `${cause}: index.lock exists` } };
}

/**
 * A reply for a refusal exit whose stderr says something OTHER than "absent" —
 * what git actually prints when the object store cannot be opened. The three
 * strings are real git output (measured against a `chmod 000` fanout dir, and
 * against a `ulimit -n 0` run for the symlink-loop wording), not invented text:
 * each is the shape the old classifier read as "not a commit" and posted on an
 * issue whose clone was merely unreadable.
 */
export const FAULT_STDLERR = [
  "error: unable to open loose object 3e9d1e8b338e23aca0d9d08e080267ec8c7bc883: Permission denied\n",
  "error: unable to read sha1 file of 3e9d1e8b338e23aca0d9d08e080267ec8c7bc883 (Permission denied)\n",
  "fatal: Too many levels of symbolic links\n",
] as const;

/** A reply for git's own cat-file wording for an object it cannot resolve. */
export function couldNotGetObjectInfo(): GitReply {
  return {
    throw: {
      code: 128,
      stderr: "fatal: could not get object info\n",
      message: "Command failed: git\nfatal: could not get object info",
    },
  };
}
