#!/usr/bin/env bun
/**
 * driver-commit-publishes-checked-message (#1820 lens round 1, M1) — the message
 * the driver COMMITS is the message the hygiene seam JUDGED.
 *
 * ## The defect this file pins
 *
 * `integrate()`'s two late commit sites — the fast-forward path
 * (`work-driver-integrate-ff.ts`) and the cherry-pick/patch path
 * (`work-driver-integrate.ts`'s own `git commit -m …` exec) — asked the
 * refusal-only projection of the driver publish seam and then committed the
 * strings they had been handed. The seam is not refusal-only: on the
 * public-or-unknown branch it rewrites this host's paths out of the text
 * (`<repo>/…`, `~/…`) and hands the rewritten bytes back precisely so the caller
 * publishes them. Both sites threw that return value away, so at those two sites
 * the rewrite was a no-op while the check still read the rewritten text — the
 * inverse of the invariant every other driver publish honours.
 *
 * ## What each block proves
 *
 * 1. **The fast-forward site commits the rewrite**: a message naming the repo
 *    root is committed as `<repo>/…`, and no committed argument carries the root.
 * 2. **The same message, checked at the seam, says `<repo>`** — so (1) is the
 *    seam's own output rather than this test's expectation.
 * 3. **A refusal still refuses**, at the same site, before any commit exec.
 * 4. **The cherry-pick gate hands its caller the bytes to write**, and refuses
 *    with the `apply` failure instead of throwing.
 *
 * Offline: a recording executor stands in for git, so no real repository, host
 * name or home path appears anywhere in this file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { fastForwardOnto } from "../src/work-driver-integrate-ff.ts";
import { cherryPickCommitGate } from "../src/work-driver-commit-message-publish.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "driver-commit-publish-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# synthetic list\n${TERM}\n`, "utf8");

/** The scratch "repository root": every path this test commits is under it. */
const repoRoot = path.join(dir, "work", "example-project");

/** One recorded exec: `git commit` argv captured for the assertions below. */
interface Recorded {
  cmd: string;
  argv?: string[];
  cwd?: string;
}

/** A git stand-in: public repo (a `false` visibility answer), commits recorded. */
function recordingExec(recorded: Recorded[]): ExecRecorder {
  const fn = async (cmd: string, opts?: { argv?: string[]; cwd?: string }) => {
    const argv = opts?.argv;
    recorded.push({ cmd: argv ? cmd : cmd.split(" ")[0] ?? cmd, argv, cwd: opts?.cwd });
    const head = argv?.[0] ?? "";
    if (head === "remote" && argv?.[1] === "get-url") {
      return { stdout: "https://github.com/example-owner/example-repo.git\n" };
    }
    if (head === "api") return { stdout: "false\n" };
    // `stagePorcelainPaths` reads `git status --porcelain -z` as a command
    // string; report one untracked entry so the fast-forward path stages and
    // commits rather than short-circuiting on a clean tree.
    if (cmd.startsWith("git status")) return { stdout: "?? src/example.ts\0" };
    if (head === "rev-parse") return { stdout: `${"a".repeat(40)}\n` };
    return { stdout: "" };
  };
  return fn as unknown as ExecRecorder;
}

type ExecRecorder = (cmd: string, opts?: { argv?: string[]; cwd?: string }) => Promise<{
  stdout: string;
  stderr?: string;
}>;

const commitArgsOf = (recorded: Recorded[]): string[][] =>
  recorded.filter((r) => r.cmd === "git" && r.argv?.[0] === "commit").map((r) => r.argv as string[]);

/** The message the fast-forward site committed, or undefined when it committed none. */
function committedMessage(recorded: Recorded[]): { title: string; body: string } | undefined {
  const commits = commitArgsOf(recorded);
  if (commits.length === 0) return undefined;
  const argv = commits[0] as string[];
  const titleAt = argv.indexOf("-m");
  if (titleAt < 0) return undefined;
  return { title: argv[titleAt + 1] ?? "", body: argv[titleAt + 3] ?? "" };
}

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath }, async () => {
  resetDenylistCacheForTests();

  // ── 1 + 2: the fast-forward commit site publishes the rewrite ─────────────
  const recorded: Recorded[] = [];
  const ff = await fastForwardOnto(
    recordingExec(recorded),
    repoRoot,
    ["ws-a"],
    { "ws-a": path.join(repoRoot, ".worktrees", "issue-9-x") },
    {
      title: `feat(x): read the log at ${path.join(repoRoot, "tmp", "verify.log")}`,
      body: `Fixes #9\n\nSee ${path.join(repoRoot, ".worktrees", "issue-9-x")}.`,
    },
    9,
  );
  assert(
    !("_publishRefusal" in ff),
    `a clean message passes the fast-forward gate (got ${JSON.stringify(ff).slice(0, 120)})`,
  );
  const committed = committedMessage(recorded);
  assert(committed !== undefined, "the fast-forward site made its commit");
  const joined = `${committed?.title}\n${committed?.body}`;
  assert(
    joined.includes("<repo>/"),
    `the COMMITTED message carries the fold, not the host root (got ${JSON.stringify(joined).slice(0, 200)})`,
  );
  assert(
    !joined.includes(repoRoot),
    "no committed argument carries the repository root",
  );
  assert(
    committed?.title === `feat(x): read the log at <repo>/tmp/verify.log`,
    `the subject is the seam's own rewritten bytes (got ${JSON.stringify(committed?.title)})`,
  );

  // ── 3: a refusal still refuses, and nothing is committed ──────────────────
  const refusedRun: Recorded[] = [];
  const refused = await fastForwardOnto(
    recordingExec(refusedRun),
    repoRoot,
    ["ws-a"],
    { "ws-a": path.join(repoRoot, ".worktrees", "issue-9-x") },
    { title: `feat(x): mention ${TERM}`, body: "Fixes #9" },
    9,
  );
  assert(
    "_publishRefusal" in refused,
    "a message with a private term is refused at the fast-forward site",
  );
  assert(
    commitArgsOf(refusedRun).length === 0,
    "and nothing was committed: the check runs before the first stage",
  );

  // ── 4: the cherry-pick gate returns the bytes to write, not a bare verdict ─
  const gateRun: Recorded[] = [];
  const gate = await cherryPickCommitGate(
    recordingExec(gateRun),
    {
      commitTitle: `feat(x): write to ${path.join(repoRoot, "out", "report.txt")}`,
      commitBody: "Fixes #9",
      issue: 9,
    },
    repoRoot,
    async () => ({}) as never,
    () => "the checkout is restored",
  );
  assert(
    !("refusalResult" in gate),
    `a clean cherry-pick message passes the gate (got ${JSON.stringify(gate).slice(0, 140)})`,
  );
  assert(
    (gate as { title: string }).title.includes("<repo>/") &&
      !(gate as { title: string }).title.includes(repoRoot),
    `the cherry-pick caller receives the folded title to commit (got ${JSON.stringify(gate).slice(0, 160)})`,
  );

  const gateRefused = await cherryPickCommitGate(
    recordingExec(gateRun),
    { commitTitle: `feat(x): mention ${TERM}`, commitBody: "Fixes #9", issue: 9 },
    repoRoot,
    async () => ({}) as never,
    () => "the checkout is restored",
  );
  assert(
    "refusalResult" in gateRefused &&
      gateRefused.refusalResult.ok === false &&
      gateRefused.refusalResult.failure === "apply",
    "a refused cherry-pick message is a parked apply failure, never a throw",
  );
  assert(
    gateRun.every((r) => !(r.cmd === "git" && r.argv?.[0] === "commit")),
    "the cherry-pick path never execs a commit the gate did not approve",
  );
});

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
