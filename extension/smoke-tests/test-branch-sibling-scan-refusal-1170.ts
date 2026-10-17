#!/usr/bin/env bun
/**
 * #1170 — an unreadable `git worktree list` during the branch step's sibling
 * scan REFUSES the cycle (step-failed:branch → handoff). It must never fall
 * through to the LLM ops fallback, which would create the worktree unscanned.
 * The refusal is a WorktreeScanError (not a DirtyWorktreeError: there is no
 * worktree path to name), and the sibling scan's fail-open contract for its
 * other callers is unchanged. Also pins the ref charset `assertSafeRef`
 * accepts (`_`, `+`) and rejects shell metacharacters, and (#1396 six-lens)
 * that a listing which HANGS is bounded by a per-attempt timeout rather than
 * holding the integration lock forever.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import { assertSafeRef } from "../src/worktree-loss.ts";
import {
  DirtyWorktreeError,
  type ExecFn,
  WORKTREE_LIST_TIMEOUT_MS,
  WorktreeScanError,
  findDirtySameIssueLeftover,
  listWorktreeStrict,
  scanWorktrees,
  worktreeCreate,
} from "../src/worktree.ts";
import { git, realExec } from "./lib/worktree-fake-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1170-sibling-"));
const TITLE = "sibling scan refusal";
const TITLE_ARTIFACT = path.join(root, "issue-title.txt");
writeFileSync(TITLE_ARTIFACT, `title: ${TITLE}\n`);

/** Every `git worktree list` fails with a git-style error; everything else is real. */
const unreadableListing: ExecFn = async (cmd, o) => {
  if (cmd.includes("worktree list")) throw new Error("git: unable to read worktree list");
  return realExec(cmd, o);
};

try {
  // ---- branch step with an unreadable worktree listing
  const originDir = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await git(root, ["init", "--bare", "--initial-branch=main", originDir]);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  let dispatches = 0;
  const execFn: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("gh ")) return { stdout: "[]" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return unreadableListing(cmd, o);
  };
  const ctx = {
    host: {} as DriverContext["host"],
    issue: 1170,
    issues: [1170],
    restart: true,
    repoRoot: repo,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn: async () => {
      dispatches++;
      return { role: "ops", ok: true, text: "noop", toolUses: [], ms: 0, exitCode: 0 };
    },
  } as unknown as DriverContext;
  const st = initialState(1170);
  st.pipelineState.issueBodyArtifact = TITLE_ARTIFACT;

  const out = await runBranch(ctx, st, 1000).catch((e) => {
    console.error(`runBranch threw: ${(e as Error).message}`);
    return undefined;
  });
  // The FIRST cap the cycle hits is now the residue pass's own refusal
  // (`worktree-listing-unreadable`, #1396 round 3 — the same unreadable listing
  // it had been reading as "no leftovers"), and the `step-failed:branch` cap
  // below it is still the sibling scan's. The scan is what this test is about,
  // so it is selected by name rather than by "the first cap".
  const cap = out?.eventLog.find((e) => e.kind === "cap-hit" && e.cap === "step-failed:branch");
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.cap === "step-failed:branch",
    "an unreadable sibling listing yields a step-failed:branch cap",
  );
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.nextStep === "handoff",
    "the refusal routes to handoff",
  );
  assert(dispatches === 0, "no LLM ops dispatch runs after the refusal (no unscanned creation)");
  assert(
    out?.pipelineState.plumbReports?.some((r) =>
      r.body.includes("unable to read worktree list"),
    ) === true,
    "the plumb report carries the git error",
  );

  // ---- the scan's own contracts (#1170, #1396 round 3)
  // `scanWorktrees`' fail-open contract is UNCHANGED (an unreadable listing
  // reads as no siblings) — the round-3 refusal lives at the one caller that
  // would act on `[]` unsafely, not here. Asserted as it was before the change.
  const failOpen = await scanWorktrees(unreadableListing, repo, "HEAD", [".worktrees/issue-1170"]);
  assert(failOpen.length === 0, "scanWorktrees keeps its fail-open contract (no siblings)");

  let scanErr: unknown;
  try {
    await findDirtySameIssueLeftover(
      unreadableListing,
      repo,
      "HEAD",
      "issue-1170",
      "issue-1170-x",
      undefined,
      true,
    );
  } catch (e) {
    scanErr = e;
  }
  assert(
    scanErr instanceof WorktreeScanError && !(scanErr instanceof DirtyWorktreeError),
    "findDirtySameIssueLeftover: an unreadable listing throws WorktreeScanError, not DirtyWorktreeError",
  );
  assert(
    scanErr instanceof Error && scanErr.message.includes("unable to read worktree list"),
    "WorktreeScanError carries the git error",
  );

  // ---- the strict listing retries once (#1170 r3): one transient failure proceeds
  let listCalls = 0;
  const flakyOnce: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("git worktree list") && ++listCalls === 1) {
      throw new Error("fatal: transient lock");
    }
    return realExec(cmd, o);
  };
  const retried = await findDirtySameIssueLeftover(
    flakyOnce,
    repo,
    "HEAD",
    "issue-1170",
    "issue-1170-x",
    undefined,
    true,
  ).then(
    () => "ok",
    (e: unknown) => e,
  );
  assert(
    retried === "ok" && listCalls === 2,
    `a transient listing failure is retried once and proceeds (calls: ${listCalls})`,
  );

  // Two failures refuse, and the message names the attempt count.
  listCalls = 0;
  const alwaysFails: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("git worktree list")) {
      listCalls++;
      throw new Error("fatal: unable to read worktree list");
    }
    return realExec(cmd, o);
  };
  const twice = await findDirtySameIssueLeftover(
    alwaysFails,
    repo,
    "HEAD",
    "issue-1170",
    "issue-1170-x",
    undefined,
    true,
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert(
    twice instanceof WorktreeScanError &&
      listCalls === 2 &&
      twice.message.includes("after 2 attempts"),
    `a listing that fails twice refuses after 2 attempts (calls: ${listCalls})`,
  );

  // ---- #1396 six-lens: a listing that HANGS is bounded, like one that fails.
  // `git worktree list` under a stale lock can sit there forever, and the
  // integrate step holds the integration lock while it waits — so the retry
  // loop must be able to see the attempt fail at all. Every attempt now
  // carries WORKTREE_LIST_TIMEOUT_MS; the fake honours it (a production
  // executor does too — `promisify(exec)` kills the child at the bound) and
  // never resolves on its own. The test overrides the bound to 50 ms so the
  // suite does not wait 30 s.
  {
    const seenTimeouts: Array<number | undefined> = [];
    let hangCalls = 0;
    const neverAnswers: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git worktree list")) {
        hangCalls++;
        seenTimeouts.push(o?.timeout);
        // Honour the bound the way the real executor does: no bound, no return.
        const ms = o?.timeout;
        return new Promise<{ stdout: string }>((_resolve, reject) => {
          if (ms === undefined) return; // a true hang — the defect this pins
          const t = setTimeout(() => reject(new Error("timed out")), ms);
          t.unref?.();
        });
      }
      return realExec(cmd, o);
    };
    const started = Date.now();
    const hung = await listWorktreeStrict(neverAnswers, repo, 50).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    assert(
      hung instanceof WorktreeScanError && hung.message.includes("after 2 attempts"),
      `#1396 a HANGING \`git worktree list\` becomes a bounded WorktreeScanError (${hung instanceof Error ? hung.message.slice(0, 70) : "resolved"})`,
    );
    assert(
      hangCalls === 2,
      `#1396 the hung attempt is retried and then gives up (calls: ${hangCalls})`,
    );
    assert(
      seenTimeouts.length === 2 && seenTimeouts.every((t) => t === 50),
      `#1396 every attempt carries the caller's timeout (${seenTimeouts.map(String).join(", ") || "none"})`,
    );
    assert(
      elapsed < 5_000,
      `#1396 the hang does not hold the integration lock indefinitely — it returned in ${elapsed}ms`,
    );
    // The production default is a real bound, not an omission: a caller that
    // passes no timeout still gets one.
    const defaults: Array<number | undefined> = [];
    const spy: ExecFn = async (cmd, o) => {
      if (cmd.startsWith("git worktree list")) {
        defaults.push(o?.timeout);
        throw new Error("fatal: stop after recording the default");
      }
      return realExec(cmd, o);
    };
    await listWorktreeStrict(spy, repo).catch(() => undefined);
    assert(
      defaults.length === 2 && defaults.every((t) => t === WORKTREE_LIST_TIMEOUT_MS),
      `#1396 the default per-attempt bound is WORKTREE_LIST_TIMEOUT_MS (${String(defaults[0])})`,
    );
    assert(
      WORKTREE_LIST_TIMEOUT_MS === 30_000,
      `#1396 the bound matches the other local git reads, GIT_TIMEOUT_MS (30s) — got ${WORKTREE_LIST_TIMEOUT_MS}`,
    );
  }

  // ---- a non-branch create caller keeps the fail-open sibling scan (#1170 r3)
  const depCreate = await worktreeCreate(unreadableListing, {
    repoRoot: repo,
    name: "issue-1170-dep",
    fromRef: "HEAD",
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert(
    !(depCreate instanceof WorktreeScanError),
    "a non-branch create caller (no strictSiblingListing) is not refused on an unreadable listing",
  );

  // ---- ref charset
  for (const ok of ["fix/issue_12", "feature/a+b", "release/1.2.3", "feature/x-y@{1}"]) {
    let threw = false;
    try {
      assertSafeRef(ok);
    } catch {
      threw = true;
    }
    assert(!threw, `assertSafeRef accepts ${ok}`);
  }
  for (const bad of ["feature/x;rm -rf /", "a$(id)", "a`id`", "a b", "-x"]) {
    let threw = false;
    try {
      assertSafeRef(bad);
    } catch {
      threw = true;
    }
    assert(threw, `assertSafeRef rejects ${JSON.stringify(bad)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
