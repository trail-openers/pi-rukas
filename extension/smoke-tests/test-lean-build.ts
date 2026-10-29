#!/usr/bin/env bun
/**
 * lean/build — the step that hands the frozen tests to a developer and makes
 * ONE provable commit out of whatever comes back.
 *
 * Every case runs against a real temp git repo whose HEAD already holds the
 * frozen acceptance-test commit, with a registered worktree on the run's
 * branch at that head (lib/lean-build-fixture.ts). Only the model is a stub, so
 * every claim asserted here — "the commit's parent is the head the step found",
 * "no frozen path is in it", "the tree is clean" — is git's answer, not the
 * fixture's.
 *
 *   (a) child edits `src/` only            -> ok, one commit on headBefore, frozen intact
 *   (b) child edits a frozen test          -> the test is restored and excluded from the commit
 *   (c) child commits on its own           -> folded and normalised to ONE driver commit
 *   (d) child edits `.pi/` and `.github/`  -> both reverted
 *   (e) child leaves a symlink + hard link -> both dropped, no outside bytes
 *   (f) child changes nothing              -> exhausted
 *   (g) a frozen record that does not match -> THROW, and the child is never dispatched
 *   (h) child resets HEAD to an older commit -> THROW
 *   (i) a re-entry `verify:red` in the log  -> the reason reaches the prompt
 *   (j) child deletes a tracked file        -> the deletion is committed
 *   (k) child adds an executable script     -> committed with mode 100755
 *   (l) a worktree that is not ours        -> THROW before the dispatch
 *   (m) child edits agents.json + .gitmodules -> both reverted, the tracked one restored
 *
 * The wiring and config cases live in test-lean-build-wiring.ts; the link and
 * kind-change cases live in test-lean-build-tree.ts.
 *
 * Every git call the step makes carries the hook and fsmonitor guard (case a).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BuildInfraError } from "../src/lean/build-errors.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import {
  AGENTS_JSON,
  ROOTS,
  RUNNER,
  SPEC_BODY,
  TEST,
  buildFixture,
  childCommit,
  commitPaths,
  git,
  hardlinkFromOutside,
  outsideDir,
  put,
  putOutside,
  runBuild,
  sha,
  status,
  subject,
  subjectsAbove,
  symlink,
} from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------- (a) the honest child
{
  const r = await runBuild({
    issue: 101,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => { retryTwice(); };\n"),
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(a) ok, got ${r.outcome?.kind}`);
  assert(r.dispatched === 1, `(a) exactly one developer dispatched (got ${r.dispatched})`);
  assert(
    subjectsAbove(wt, r.headBefore).length === 1,
    `(a) exactly one commit above headBefore (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD^") === r.headBefore,
    "(a) the build commit sits directly on the head the step found",
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(a) the commit holds the implementation and nothing else (got ${commitPaths(wt).join(", ")})`,
  );
  assert(
    git(wt, "show", "HEAD:tests/AC1-retry.test.sh") === TEST.trimEnd(),
    "(a) the frozen test is intact at HEAD",
  );
  assert(status(wt) === "", `(a) the worktree is clean after the commit (got ${status(wt)})`);
  assert(
    subject(wt) === "build: attempt 1 for #101",
    `(a) the commit subject names the attempt and the issue (got ${subject(wt)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("1 file(s) changed"),
    `(a) the reason reports the change count (got ${r.outcome?.reason})`,
  );
  assert(
    r.gitArgvs.length > 0 &&
      r.gitArgvs.every(
        (argv) =>
          argv.includes("core.hooksPath=/dev/null") && argv.includes("core.fsmonitor=false"),
      ),
    `(a) every git call carries the hook and fsmonitor guard (${r.gitArgvs.length} calls)`,
  );
}

// --------------------------------------------- (b) the child edits a frozen test
{
  const r = await runBuild({
    issue: 102,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 2;\n");
      // Weaken the contract to green — the one thing the step must undo.
      put(wt, "tests/AC1-retry.test.sh", "#!/bin/sh\nexit 0\n");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(b) ok, got ${r.outcome?.kind}`);
  assert(
    readFileSync(path.join(wt, "tests/AC1-retry.test.sh"), "utf8") === TEST,
    "(b) the frozen test on disk is the recorded bytes again",
  );
  assert(
    !commitPaths(wt).includes("tests/AC1-retry.test.sh"),
    `(b) the commit excludes the frozen test (got ${commitPaths(wt).join(", ")})`,
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(b) the commit holds only the implementation (got ${commitPaths(wt).join(", ")})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("restored: tests/AC1-retry.test.sh"),
    `(b) the reason names the restored test (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(b) clean after the commit (got ${status(wt)})`);
}

// ------------------------------------ (c) the child commits on its own, test included
{
  const r = await runBuild({
    issue: 103,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => { backoff(); };\n");
      put(wt, "tests/AC1-retry.test.sh", "#!/bin/sh\nexit 0\n");
      childCommit(wt, "my own work");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(c) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(c) ok, got ${r.outcome?.kind}`);
  assert(
    subjectsAbove(wt, r.headBefore).join() === "build: attempt 1 for #103",
    `(c) the child's commit is folded into exactly one driver commit (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD^") === r.headBefore,
    "(c) the single commit's parent is the head the step found",
  );
  assert(
    git(wt, "show", "HEAD:tests/AC1-retry.test.sh") === TEST.trimEnd(),
    "(c) the frozen test is intact at HEAD even though the child committed over it",
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(c) the folded commit holds the implementation only (got ${commitPaths(wt).join(", ")})`,
  );
  assert(status(wt) === "", `(c) clean after the commit (got ${status(wt)})`);
}

// ------------------------------------- (d) the child edits the protected paths
//
// `.pi/` and `.github/` are UNTRACKED in the fixture, which is the harder
// shape: a tracked edit would come back from the reset even if the step did
// nothing, while an untracked one only leaves if the reset really cleans.
{
  const r = await runBuild({
    issue: 104,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 1;\n");
      put(wt, ".pi/work.json", '{ "verify": { "test": "true {file}" } }\n');
      put(wt, ".github/x.yml", "on: push\njobs: {}\n");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(d) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(d) ok, got ${r.outcome?.kind}`);
  assert(
    !existsSync(path.join(wt, ".pi/work.json")),
    "(d) the .pi file the child invented is gone",
  );
  assert(
    !existsSync(path.join(wt, ".github/x.yml")),
    "(d) the .github file the child invented is gone",
  );
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(d) neither protected path reached the commit (got ${commitPaths(wt).join(", ")})`,
  );
  const reverted = ((r.outcome?.reason ?? "").match(/reverted: ([^;]*)/) ?? [])[1] ?? "";
  assert(
    reverted.split(", ").sort().join() === ".github/x.yml,.pi/work.json",
    `(d) the reason names both reverted paths (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(d) clean after the commit (got ${status(wt)})`);
}

// ------- (e) the child leaves a symlink and a hard link, both to OUTSIDE files
//
// Both targets live outside the repo on purpose: a link to something inside
// would commit the same bytes either way, and the claim this case makes — the
// step committed none of the outside bytes — would be unfalsifiable.
{
  const outside = outsideDir();
  const linkTarget = putOutside(
    path.join(outside, "payload.txt"),
    "OUTSIDE SYMLINK TARGET BYTES\n",
  );
  const hardTarget = putOutside(path.join(outside, "secret.txt"), "OUTSIDE HARD LINK BYTES\n");
  const r = await runBuild({
    issue: 105,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 3;\n");
      symlink(wt, "src/linked.ts", linkTarget);
      hardlinkFromOutside(wt, "src/hard.ts", hardTarget);
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(e) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(e) ok, got ${r.outcome?.kind}`);
  assert(!existsSync(path.join(wt, "src/linked.ts")), "(e) the symlink is gone");
  assert(!existsSync(path.join(wt, "src/hard.ts")), "(e) the hard link is gone");
  assert(
    git(wt, "show", "HEAD:src/retry.ts") === "export const retry = () => 3;",
    "(e) the real src edit is committed",
  );
  const committed = commitPaths(wt);
  assert(
    committed.join() === "src/retry.ts",
    `(e) the commit holds the implementation only (got ${committed.join(", ")})`,
  );
  const blobText = git(wt, "show", "HEAD:src/retry.ts");
  assert(!blobText.includes("OUTSIDE"), "(e) no outside bytes reached the commit");
  const allRemoved = ((r.outcome?.reason ?? "").match(/(?:removed|deleted): ([^;]*)/g) ?? [])
    .map((s) => s.replace(/^(?:removed|deleted): /, ""))
    .join(", ");
  assert(
    allRemoved
      .split(", ")
      .filter((p) => p !== "")
      .map((p) => p.replace(/ \(.*$/, ""))
      .sort()
      .join() === "src/hard.ts,src/linked.ts",
    `(e) the reason accounts for both dropped links (got ${r.outcome?.reason})`,
  );
  assert(
    !existsSync(path.join(wt, "outside")),
    "(e) nothing the child invented outside the contract is left in the tree",
  );
  assert(status(wt) === "", `(e) clean after the commit (got ${status(wt)})`);
}

// ------------------------------------------------- (f) the child produced nothing
{
  const r = await runBuild({ issue: 106 });
  assert(r.threw === undefined, `(f) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "exhausted",
    `(f) exhausted, got ${r.outcome?.kind ?? r.threw?.message}`,
  );
  assert(
    r.outcome?.reason === "the developer produced no change",
    `(f) the reason says so (got ${r.outcome?.reason})`,
  );
  assert(subjectsAbove(r.worktree, r.headBefore).length === 0, "(f) nothing was committed");
}

// --------------------------- (g) a frozen record that does not match the commit
{
  const r = await runBuild({ issue: 107, frozenSha: sha("a test nobody committed") });
  assert(r.threw !== undefined, "(g) the step throws rather than building against a bad record");
  assert(r.threw instanceof BuildInfraError, "(g) the throw is infrastructure, not a verdict");
  assert(
    (r.threw?.message ?? "").includes("frozen tests do not match the record"),
    `(g) the throw names the failure (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(g) the developer was never dispatched (got ${r.dispatched})`);
  assert(subjectsAbove(r.worktree, r.headBefore).length === 0, "(g) nothing was committed");
}

// --------------------------------------- (h) the child moved HEAD somewhere else
{
  const r = await runBuild({
    issue: 108,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 4;\n");
      // The child rewinds its own HEAD to the base, taking the frozen commit
      // off the branch — the step must refuse rather than fold onto that.
      git(wt, "reset", "--hard", "HEAD^");
    },
  });
  assert(r.threw !== undefined, "(h) the step throws when HEAD is not a descendant");
  assert(r.threw instanceof BuildInfraError, "(h) the throw is infrastructure, not a verdict");
  assert(
    (r.threw?.message ?? "").includes("moved HEAD away from"),
    `(h) the throw says what the child did (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 1, "(h) the child ran first — the move is only knowable afterwards");
}

// ------------------------------------ (i) the re-entry reason reaches the prompt
{
  const reason = "AC1 tests/AC1-retry.test.sh: exited 1 — retry gave up on the first failure";
  const r = await runBuild({
    issue: 109,
    extraSteps: [
      { key: "109:build:0", state: "build", startedAt: 3, outcome: { kind: "ok" } },
      { key: "109:challenge:0", state: "challenge", startedAt: 4, outcome: { kind: "none" } },
      { key: "109:verify:0", state: "verify", startedAt: 5, outcome: { kind: "red", reason } },
      { key: "109:build:1", state: "build", startedAt: 6 },
    ],
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 5;\n"),
  });
  assert(r.threw === undefined, `(i) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(i) ok, got ${r.outcome?.kind}`);
  const prompt = r.prompts[0] ?? "";
  assert(prompt.includes(reason), "(i) the prompt carries the verify-red reason verbatim");
  assert(prompt.includes("Why this round exists"), "(i) the prompt frames the round as a fix");
  assert(
    prompt.includes("The retry helper gives up on the first transient failure."),
    "(i) the prompt carries the spec's problem verbatim",
  );
  assert(
    prompt.includes("retries a transient failure twice"),
    "(i) the criteria are in the prompt",
  );
  assert(
    prompt.includes("tests/AC1-retry.test.sh"),
    "(i) the frozen test path is named in the prompt",
  );
  assert(
    prompt.includes(RUNNER),
    `(i) the runner template is in the prompt (looked for ${RUNNER})`,
  );
  assert(
    prompt.includes("do NOT modify these"),
    "(i) the prompt states the frozen tests must not be modified",
  );
  assert(
    prompt.includes("Do not commit"),
    "(i) the prompt tells the child to leave the commit to the parent",
  );
  assert(
    r.specs[0]?.role === "developer" && r.specs[0]?.cwd === r.worktree,
    `(i) dispatched as developer in the worktree (got ${r.specs[0]?.role} @ ${r.specs[0]?.cwd})`,
  );
  assert(SPEC_BODY.includes("pi-spec v1"), "(i) the fixture's body really carries a pi-spec block");
}

// ------------------------------------------ (j) the child deletes a tracked file
{
  const r = await runBuild({
    issue: 111,
    child: (wt) => {
      put(wt, "src/other.ts", "export const other = 1;\n");
      git(wt, "rm", "-q", "-f", "src/retry.ts");
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(j) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(j) ok, got ${r.outcome?.kind}`);
  assert(
    commitPaths(wt).includes("src/other.ts"),
    `(j) the file the child added is committed (got ${commitPaths(wt).join(", ")})`,
  );
  assert(
    !existsSync(path.join(wt, "src/retry.ts")),
    "(j) the deletion the child made is applied to the tree",
  );
  assert(
    git(wt, "ls-tree", "-r", "--name-only", "HEAD").includes("src/retry.ts") === false,
    "(j) the deletion is in the commit — the file is gone from HEAD",
  );
  assert(
    (r.outcome?.reason ?? "").includes("deleted: src/retry.ts"),
    `(j) the reason names the deletion (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(j) clean after the commit (got ${status(wt)})`);
}

// --------------------------------------- (k) the child adds an executable script
{
  const r = await runBuild({
    issue: 112,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 6;\n");
      put(wt, "scripts/run.sh", "#!/bin/sh\nexit 0\n", 0o755);
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(k) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(k) ok, got ${r.outcome?.kind}`);
  assert(
    git(wt, "ls-tree", "HEAD", "scripts/run.sh").includes("100755"),
    `(k) the script is committed with mode 100755 (got ${git(wt, "ls-tree", "HEAD", "scripts/run.sh")})`,
  );
  assert(status(wt) === "", `(k) clean after the commit (got ${status(wt)})`);
}

// ------------------------------------------ (l) the worktree must exist and be ours
{
  const built = buildFixture(110);
  // Somebody else's directory at the path the step expects.
  git(built.repoRoot, "worktree", "remove", "--force", built.worktree);
  const r = await runBuild({ issue: 110, built });
  assert(r.threw !== undefined, "(l) a missing worktree is infrastructure, not a verdict");
  assert(r.threw instanceof BuildInfraError, "(l) the throw is a BuildInfraError");
  assert(
    (r.threw?.message ?? "").includes("does not exist"),
    `(l) the throw names the missing worktree (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, "(l) the developer was never dispatched");
}

// ------------------------- (m) the child edits agents.json and .gitmodules
//
// `agents.json` is TRACKED at the base, so the reset has to bring the bytes back
// (a clean alone would not). `.gitmodules` is untracked, so it must be gone.
{
  const r = await runBuild({
    issue: 113,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => 7;\n");
      put(wt, "agents.json", '{"project-manager":{"write":"allow"}}\n');
      put(wt, ".gitmodules", '[submodule "x"]\n');
    },
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(m) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(m) ok, got ${r.outcome?.kind}`);
  assert(
    readFileSync(path.join(wt, "agents.json"), "utf8") === AGENTS_JSON,
    "(m) the tracked agents.json is back to the base bytes",
  );
  assert(!existsSync(path.join(wt, ".gitmodules")), "(m) the untracked .gitmodules is gone");
  assert(
    commitPaths(wt).join() === "src/retry.ts",
    `(m) neither protected path reached the commit (got ${commitPaths(wt).join(", ")})`,
  );
  const reverted = ((r.outcome?.reason ?? "").match(/reverted: ([^;]*)/) ?? [])[1] ?? "";
  assert(
    reverted.split(", ").sort().join() === ".gitmodules,agents.json",
    `(m) the reason names both reverted paths (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(m) clean after the commit (got ${status(wt)})`);
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
