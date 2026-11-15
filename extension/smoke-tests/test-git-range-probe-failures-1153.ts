#!/usr/bin/env bun
/**
 * #1153 (fixture arms) — a probe that could not answer is never reported as a verdict.
 *
 * Split from `test-git-range-1153.ts` for the 500-line cap, along the seam the canary already
 * drew: the canary suite judges the module against REAL git and against the source text, while
 * everything here judges it against a SYNTHESISED failure — a child that was killed, died of a
 * signal, exited 1 with no stderr, or exited 1 with each of git's wordings. Those arms need no
 * repository and share nothing with the real-git arms but the module under test, so the split
 * is where the file already wanted to be cut.
 *
 * The rule all of them defend is one sentence from the #1153 review: `absent` is a claim about
 * a ref, and only git gets to make it. A `code: 1` that the harness produced — because it
 * killed the child, or because node refused to spawn it — says nothing about whether the ref
 * exists, and reading it as "never pushed" tells an operator their branch is gone when nobody
 * looked. So `absent` requires exit 1 AND git's own missing-ref wording, and every shape short
 * of that is `unknown`.
 */

import { errorText, refResolves, aheadOfBase } from "../src/git-range.ts";
import { assert, exit } from "./lib/assert-rig.ts";
import { failingExec } from "./lib/git-range-fixture-exec.ts";

{
  // node's child_process reports a killed child as `code: 1` + `killed: true`
  // + a `signal`. Reading that as "git says the ref does not exist" would tell
  // the operator the branch was never pushed, about a ref nobody read.
  // A killed probe on the real exec: `execFile`'s timeout kills the child,
  // which lands `code: null` + `killed: true` + a signal — so the code test
  // alone rejects it. The load-bearing fixture is the one below, where the
  // harness reports git's OWN numeric code alongside `killed: true`.
  const killed = await refResolves(
    failingExec({ code: 1, killed: true, signal: "SIGTERM", message: "killed" }),
    "/repo",
    "origin/feat",
  );
  assert(
    killed.state === "unknown",
    `refResolves: a killed probe is unknown (got ${JSON.stringify(killed)})`,
  );

  const signalled = await refResolves(
    failingExec({ code: 1, killed: false, signal: "SIGKILL", message: "signalled" }),
    "/repo",
    "origin/feat",
  );
  assert(
    signalled.state === "unknown",
    `refResolves: a probe that died of a signal is unknown (got ${JSON.stringify(signalled)})`,
  );

  // No numeric code at all — a spawn failure (`ENOENT`), not a git verdict.
  const noCode = await refResolves(
    failingExec({ code: "ENOENT", message: "spawn git ENOENT" }),
    "/repo",
    "origin/feat",
  );
  assert(
    noCode.state === "unknown",
    `refResolves: an error with no numeric code is unknown (got ${JSON.stringify(noCode)})`,
  );

  // The control: git's OWN exit 1, with nothing killed AND its own wording
  // saying the ref is missing, IS absent.
  const gitSaysNo = await refResolves(
    failingExec({
      code: 1,
      killed: false,
      signal: null,
      message: "Command failed: git rev-parse",
      stderr: "fatal: not a valid object name 'origin/feat'\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    gitSaysNo.state === "absent",
    `control: a clean git exit 1 with the missing-ref wording is absent (got ${JSON.stringify(gitSaysNo)})`,
  );

  // #1153 fix round — exit 1 alone is NOT absent: git's wording has to say
  // the ref is missing. An exit 1 with an EMPTY stderr is not evidence about
  // the ref (node rejects on the code alone, so a silent git would otherwise
  // be read as "this branch was never pushed").
  const silentExitOne = await refResolves(
    failingExec({ code: 1, killed: false, signal: null, message: "Command failed", stderr: "" }),
    "/repo",
    "origin/feat",
  );
  assert(
    silentExitOne.state === "unknown",
    `refResolves: exit 1 with no stderr is unknown, not absent (got ${JSON.stringify(silentExitOne)})`,
  );

  // Each of git's missing-ref wordings is absent. The fourth is git's own
  // wording for a name that is not in the object store at all
  // (`rev-parse --verify` on a non-revision), which the regex matches on
  // `not a valid object name` — listed here so a future narrowing of the
  // pattern has to account for it rather than silently dropping it.
  for (const wording of [
    "fatal: not a valid object name 'origin/feat'",
    "fatal: ambiguous argument 'origin/feat': unknown revision or path not in the working tree.",
    "fatal: needed a single revision",
    "fatal: Not a valid object name refs/remotes/origin/feat",
  ]) {
    const r = await refResolves(
      failingExec({
        code: 1,
        killed: false,
        signal: null,
        message: "Command failed",
        stderr: wording,
      }),
      "/repo",
      "origin/feat",
    );
    assert(
      r.state === "absent",
      `refResolves: wording "${wording.slice(0, 40)}…" is absent (got ${r.state})`,
    );
  }

  // Clone-level failures that DO exit 1 are still about the clone, not the
  // ref, so they stay unknown. These are the shapes the reviewer named.
  for (const shape of [
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: detected dubious ownership in repository at '/home/dev/project'\nTo add an exception for this directory, call:",
  ]) {
    const r = await refResolves(
      failingExec({
        code: 1,
        killed: false,
        signal: null,
        message: "Command failed",
        stderr: shape,
      }),
      "/repo",
      "origin/feat",
    );
    assert(
      r.state === "unknown",
      `refResolves: "${shape.slice(0, 34)}…" on exit 1 is unknown, not absent (got ${JSON.stringify(r)})`,
    );
    assert(
      r.state === "unknown" && r.error.startsWith("fatal:"),
      `refResolves: the clone-level reason survives in the error text (got ${JSON.stringify(r)})`,
    );
  }

  // git exits 128 (not 1) for a non-repo; either way it is unknown. This is
  // the real-git shape for a non-repo directory. The verdict is the FIRST
  // line here (git prints no advice after it), which is the other side of the
  // last-informative-line rule in `errorText`.
  const notGitRepo = await refResolves(
    failingExec({
      code: 128,
      killed: false,
      signal: null,
      message: "Command failed",
      stderr: "fatal: not a git repository (or any parent up to mount point /)\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    notGitRepo.state === "unknown",
    `refResolves: exit 128 is unknown (got ${JSON.stringify(notGitRepo)})`,
  );
  assert(
    notGitRepo.state === "unknown" && notGitRepo.error.startsWith("fatal: not a git repository"),
    `refResolves: the exit-128 reason survives in the error text (got ${JSON.stringify(notGitRepo)})`,
  );

  // errorText prefers the captured stderr over the generic node message, so
  // the note the operator reads names git's reason rather than the command.
  const stderrCarrying = await refResolves(
    failingExec({
      code: "ENOENT",
      message: "Command failed: git rev-parse --verify",
      stderr: "  fatal: not a git repository (or any of the parent directories): .git  \n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    stderrCarrying.state === "unknown" &&
      stderrCarrying.error.startsWith("fatal: not a git repository") &&
      !stderrCarrying.error.includes("Command failed"),
    `errorText: stderr is preferred over message (got ${JSON.stringify(stderrCarrying)})`,
  );

  // A stderr longer than the bound is sliced, never interpolated whole. Built
  // through `errorText` directly rather than through a probe: the point here is
  // the bound, and an all-`fatal:` stream would trip `gitSaysAbsent` into
  // `absent`, which has no `error` field to measure.
  const long = errorText({ stderr: "x".repeat(500) });
  assert(long.length === 200, `errorText: bounded to 200 chars (got ${long.length})`);

  // aheadOfBase propagates the distinction: a killed head probe is unknown,
  // not the "the branch was not pushed from here" reading `absent` produces.
  const aheadKilled = await aheadOfBase(
    failingExec({ code: 1, killed: true, signal: "SIGTERM", message: "killed" }),
    "/repo",
    "origin/main",
    "origin/feat",
  );
  assert(
    aheadKilled.kind === "unknown",
    `aheadOfBase: a killed probe is unknown, not unpushed (got ${JSON.stringify(aheadKilled)})`,
  );
}

// The real-git counterweight to every arm above lives in the canary suite
// (`test-git-range-1153.ts`, section 2): a missing ref in a real repository must reach
// `absent` through git's own wording. These fixture arms decide what a SYNTHESISED failure
// means, and the canary decides what real git means; a `gitSaysAbsent` that matched nothing
// would keep every arm here green and is caught there, not here.

process.exit(exit);
