/**
 * Shared fixture for test-verify-gate-reuse.ts (#1415): the dynamically loaded
 * reuse seam, the counting executor, the git repo/worktree fixture and the
 * record helpers. Split out of the test (AGENTS.md §12 size cap); the suite's
 * cases and their paired controls stay in the test file.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { runConsolidatedVerify } from "../../src/work-driver-consolidated-verify.ts";
import type { AlreadyVerifiedTree } from "../../src/work-driver-verify-tree.ts";
import { verifyTreeId } from "../../src/work-driver-verify-tree.ts";

/**
 * The reuse seam task A owns (#1415). Loaded by a DYNAMIC import at run time:
 * the module does not exist in this worktree while task A writes it, and a
 * top-level import would take the whole file down with it — including the
 * controls that prove the red cases are red for the right reason.
 *
 * `seam` is undefined until the sibling lands. Every case that needs it says
 * so in its own failure text, so a red run distinguishes "task A has not
 * landed" from "the behaviour is wrong" without reading the source.
 */
let seam: Record<string, unknown> | undefined;
try {
  seam = (await import("../../src/work-driver-verify-reuse.ts")) as unknown as Record<
    string,
    unknown
  >;
} catch {
  seam = undefined;
}
/** The exports the suite calls on task A's seam, and why each is load-bearing. */
export const REQUIRED_SEAM_EXPORTS = ["consolidatedVerifyReuse", "recordVerifiedTree"] as const;

/** Call a seam export by name if it exists; `undefined` when it or the module is absent. */
function callSeam(name: string, ...args: unknown[]): unknown {
  const fn = seam?.[name];
  return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown)(...args) : undefined;
}

const seamMissing = (name: string) =>
  `task A's reuse seam is unavailable to this worktree (src/work-driver-verify-reuse.ts is task A's file) — '${name}' could not be called, so no record was established and this run cannot say whether the gate reuses`;

function missingSeamExports(): string[] {
  if (seam === undefined) return [...REQUIRED_SEAM_EXPORTS];
  return REQUIRED_SEAM_EXPORTS.filter((n) => typeof seam[n] !== "function");
}

export const execFileP = promisify(execFile);
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

export const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1415-reuse-"));

/** A counted verify run: where the project's command executed. */
export type Runs = Array<{ cwd: string }>;

/**
 * The executor: real git, but a verify-command run is counted and replaced by
 * a canned outcome. `verifyCmd` is matched by exact command text, so the
 * `sh -c 'echo run >> …'` marker commands the fixture installs are the only
 * things that count as a gate execution.
 */
export function makeExec(
  counts: { runs: Runs; repoRoot: string },
  opts: { fail?: (cwd: string) => boolean } = {},
): NonNullable<Parameters<typeof runConsolidatedVerify>[0]> {
  return async (cmd, o) => {
    if (cmd.startsWith("sh -c 'echo run >>")) {
      const cwd = o?.cwd ?? "?";
      counts.runs.push({ cwd });
      if (opts.fail?.(cwd)) {
        throw Object.assign(new Error("verify command exited non-zero"), {
          stdout: "",
          stderr: "✗ verify asserted\n",
        });
      }
      return { stdout: "" };
    }
    const execOpts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
    try {
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, execOpts)
        : await execFileP("/bin/sh", ["-c", cmd], execOpts);
      return { stdout };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      e.stdout = e.stdout ?? "";
      e.stderr = e.stderr ?? "";
      throw e;
    }
  };
}

/** A repo with a bare origin, one detached worktree per id, and `.pi/` ready. */
export async function fixture(name: string, ids: string[]) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    await git(wt, ["config", "user.email", "t@example.com"]);
    await git(wt, ["config", "user.name", "T"]);
    worktrees[id] = wt;
  }
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  return { dir, repo, baseSha, worktrees };
}

/** Install the project's verify command; it appends to a marker file, then passes. */
export function installVerifyCmd(repo: string, marker: string) {
  const cmd = `sh -c 'echo run >> ${marker}'`;
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), `${cmd}\n`);
  return cmd;
}

/** Commit one file in a worktree and return its tree identity, read from git. */
export async function commitAndIdentify(
  wt: string,
  file: string,
  msg: string,
): Promise<AlreadyVerifiedTree> {
  writeFileSync(path.join(wt, file), `${file}\n`);
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", msg]);
  const treeHash = await verifyTreeId(async (cmd, o) => {
    const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
    const { stdout } = o?.argv
      ? await execFileP(cmd, o.argv, opts)
      : await execFileP("/bin/sh", ["-c", cmd], opts);
    return { stdout };
  }, wt);
  if (treeHash === undefined) throw new Error(`no tree identity for ${wt}`);
  return { treeHash, worktree: wt };
}

export const consOpts = (
  f: { repo: string; baseSha: string; dir: string },
  worktrees: Record<string, string>,
  verifyCmd: string,
  extra: Record<string, unknown> = {},
) => ({
  repoRoot: f.repo,
  baseSha: f.baseSha,
  worktrees,
  scratchDir: path.join(f.dir, "scratch"),
  verifyCmd,
  timeoutMs: 30_000,
  ...extra,
});

/**
 * Establish "a previous consolidated pass judged THIS tree" the way task A's
 * seam does it: record the tree, then ask the probe to reuse it. The record
 * goes through the seam's own recorder rather than a literal this file
 * invents, so the suite exercises the shape task A actually reads (a record
 * this file made up and a record the seam writes can disagree, and only one
 * of those is the product).
 *
 * Returns the opts fragment for `runConsolidatedVerify`. When task A's seam is
 * absent from this worktree, the fragment carries nothing and the case's own
 * assertion goes red naming the missing seam — see `seamMissing`.
 */
export function asRecord(
  t: AlreadyVerifiedTree,
  cmd: string,
  timeoutMs = 30_000,
): Record<string, unknown> {
  callSeam("recordVerifiedTree", t.worktree, t, Date.now(), cmd, timeoutMs);
  const reuse = callSeam("consolidatedVerifyReuse", t.worktree, t, cmd, timeoutMs, Date.now());
  if (seam === undefined) throw new Error(seamMissing("consolidatedVerifyReuse"));
  return typeof reuse === "object" && reuse !== null
    ? { reusedVerifiedTree: reuse as AlreadyVerifiedTree }
    : {};
}

const seamAbsent = missingSeamExports();
if (seamAbsent.length > 0) {
  // One loud line naming exactly what is missing, so a red run in the
  // pre-integration phase reads as "task A has not landed these two exports"
  // rather than as a behaviour failure. The cases that DO NOT need the seam —
  // every anti-vacuity control below — still run, because a suite that skips
  // everything when one sibling is missing has stopped guarding the half it
  // could guard.
  console.error(`⚠ ${seamMissing(seamAbsent.join("', '"))}`);
}

/** Whether a case that needs the seam may run at all. */
export const seamReady = seamAbsent.length === 0;
