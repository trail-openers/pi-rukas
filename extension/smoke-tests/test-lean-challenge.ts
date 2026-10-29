#!/usr/bin/env bun
/**
 * lean/challenge — one adversary round after build, against the current head.
 *
 * Every case runs against a real temp git repo whose HEAD is base + the frozen
 * acceptance-test commit + a real build commit (lib/lean-challenge-fixture.ts,
 * which reuses the build fixture for that shape). Only the model is a stub, so
 * "the commit's parent is the head the step found", "no frozen path is in it"
 * and "the frozen map at HEAD still matches\" are git's answers, not the
 * fixture's.
 *
 *   (a) a red edge case          -> new-tests, committed on headBefore, frozen map is the UNION
 *   (b) a test that passes on HEAD -> none, nothing committed, the child's file gone
 *   (c) a submission naming a frozen path -> refused; only the new file is frozen
 *   (d) an adversary whose dispatch died -> THROW, never `none`
 *   (e) a runner that cannot start -> THROW
 *   (f) the child commits on its own -> normalised to ONE driver commit
 *   (g) the frozen map at HEAD matches after the challenge commit
 *   (h) a frozen record that does not match at HEAD -> THROW before the dispatch
 *   (i) the prompt names the frozen tests, asks for new ones, ties them to criteria
 *   (j) no runner configured -> THROW (a round that could only say `none` judged nothing)
 *   (k) the worktree is not ours -> THROW before the dispatch
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { phase1Handlers } from "../src/lean/command.ts";
import type { Step } from "../src/lean/state.ts";
import {
  ROOTS,
  RUNNER,
  SPEC_BODY,
  SpecifyInfraError,
  blobSha,
  challengeFixture,
  childCommitOf,
  commitPaths,
  git,
  greenEdge,
  put,
  putOutside,
  redEdge,
  runChallenge,
  sha,
  status,
  subject,
  subjectsAbove,
  submit,
} from "./lib/lean-challenge-fixture.ts";

/** Is this throw the infrastructure family? Both steps name their own subclass. */
function isInfra(err: Error | undefined): boolean {
  return err instanceof SpecifyInfraError || err?.name === "ChallengeInfraError";
}

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FROZEN = "tests/AC1-retry.test.sh";
const EDGE = "tests/AC1-edge-second-failure.test.sh";

// ------------------------------------------------------- (a) a real red edge case
{
  const r = await runChallenge({
    issue: 201,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "new-tests", `(a) new-tests, got ${r.outcome?.kind}`);
  assert(r.dispatched === 1, `(a) exactly one adversary dispatched (got ${r.dispatched})`);
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === EDGE,
    `(a) the outcome freezes exactly the new test (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    r.outcome?.frozen?.[EDGE] === sha(redEdge(EDGE)),
    `(a) frozen carries the committed blob's sha256 (got ${r.outcome?.frozen?.[EDGE]})`,
  );
  assert(
    JSON.stringify(r.outcome?.tests) === JSON.stringify({ AC1: [EDGE] }),
    `(a) tests maps the criterion to the new file (got ${JSON.stringify(r.outcome?.tests)})`,
  );
  assert(
    subjectsAbove(wt, r.headBefore).join() === "test: challenge tests for #201",
    `(a) exactly one commit above the head the step found (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD^") === r.headBefore,
    "(a) the challenge commit sits directly on the head the step found",
  );
  assert(
    commitPaths(wt).join() === EDGE,
    `(a) the commit holds the new test and nothing else (got ${commitPaths(wt).join(", ")})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("froze 1 red test file(s)"),
    `(a) the reason reports the freeze (got ${r.outcome?.reason})`,
  );
  assert(status(wt) === "", `(a) the worktree is clean after the commit (got ${status(wt)})`);
  assert(
    r.gitArgvs.length > 0 &&
      r.gitArgvs.every((argv) => {
        // `NO_HOOKS` is a four-word prefix, so a guarded call's verb sits at
        // index 4 and an unguarded one at index 0. The rule reads the VERB, not
        // the index, so a call cannot dodge it by adding a flag: `git show` is
        // the one verb legitimately run without the hook guard, because it reads
        // an object rather than the working tree — no repo-supplied hook or
        // fsmonitor can reach what it returns. It may carry the guard or not
        // (`committedBlob` omits it, `blobAt` includes it); no other verb may
        // omit it, because every other verb in this family MUTATES the tree.
        const verb = argv[0] === "-c" ? (argv[4] as string) : (argv[0] as string);
        if (verb === "show") return true;
        return argv.includes("core.hooksPath=/dev/null") && argv.includes("core.fsmonitor=false");
      }),
    `(a) every tree-mutating git call carries the hook and fsmonitor guard (${r.gitArgvs.length} calls)`,
  );
  assert(
    r.gitArgvs.some((argv) => argv[0] === "show") === true,
    "(a) the unguarded shape really is exercised — a blob read ran without the guard, so the exemption above is not vacuous",
  );
}

// ------------------------- (h) the frozen map at HEAD matches after the commit
{
  const built = challengeFixture(2021);
  const r = await runChallenge({
    issue: 2021,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  const wt = r.worktree;
  const at = (ref: string, rel: string): string => blobSha(wt, ref, rel);
  assert(r.outcome?.kind === "new-tests", `(h) new-tests, got ${r.outcome?.kind}`);
  assert(
    at("HEAD", FROZEN) === built.frozen[FROZEN],
    "(h) the pre-existing frozen test still hashes to its record at the NEW head",
  );
  assert(
    at("HEAD", EDGE) === r.outcome?.frozen?.[EDGE],
    "(h) the new frozen test at HEAD hashes to what the step recorded — a fact about the commit",
  );
  assert(
    at("HEAD^", FROZEN) === built.frozen[FROZEN],
    "(h) the pre-existing frozen test matched its record at the head the step found too — the check ran against a contract that was already sound",
  );
}

// ----------------------------- (i) a frozen record that does not match at HEAD
{
  const built = challengeFixture(209);
  // Somebody edited the contract after the run froze it. The step must refuse
  // before paying an adversary to attack an implementation nobody verified.
  put(built.worktree, FROZEN, "#!/bin/sh\nexit 0\n");
  git(built.worktree, "add", "-A");
  git(built.worktree, "commit", "-q", "--amend", "-m", "build: attempt 1 for #209");
  const r = await runChallenge({
    issue: 209,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw !== undefined, "(i) a tampered contract throws");
  assert(isInfra(r.threw), `(i) the throw is infrastructure (got ${r.threw?.constructor.name})`);
  assert(
    (r.threw?.message ?? "").includes("frozen tests do not match the record"),
    `(i) the throw names the frozen mismatch (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(i) the adversary was never dispatched (got ${r.dispatched})`);
  // The fixture's own `--amend` is the only thing that moved HEAD; the step
  // committed nothing. Comparing against the amended head rather than `buildSha`
  // is what makes this assert about the STEP and not about the fixture's setup.
  const headNow = git(built.worktree, "rev-parse", "HEAD");
  assert(
    subjectsAbove(built.worktree, headNow).length === 0,
    "(i) the step committed nothing on top of the tree it refused",
  );
  assert(
    git(built.worktree, "status", "--porcelain", "-uall") === "",
    "(i) and the tampered file the step refused to build against is left exactly as found, unstaged",
  );
}

// ------------------------------------------------ (j) the prompt's load-bearing lines
{
  const r = await runChallenge({
    issue: 210,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  const prompt = r.prompts[0] ?? "";
  assert(r.outcome?.kind === "new-tests", `(j) new-tests, got ${r.outcome?.kind}`);
  assert(prompt.includes(FROZEN), "(j) the prompt NAMES the existing frozen test");
  assert(prompt.includes("ADDITIONAL edge-case tests"), "(j) the prompt asks for additional tests");
  assert(
    prompt.includes("MUST FAIL against the code as it stands"),
    "(j) the prompt requires a test that fails against the current head",
  );
  assert(prompt.includes("AC1"), "(j) the prompt ties each new test to a criterion id");
  assert(
    prompt.includes("Never submit a path from the frozen list"),
    "(j) the prompt forbids submitting a frozen path",
  );
  assert(
    prompt.includes(RUNNER),
    `(j) the runner template is in the prompt (looked for ${RUNNER})`,
  );
  assert(
    prompt.includes("The retry helper gives up on the first transient failure."),
    "(j) the prompt carries the spec's problem verbatim",
  );
  assert(
    r.specs[0]?.role === "developer" && r.specs[0]?.cwd === r.worktree,
    `(j) dispatched as developer in the worktree (got ${r.specs[0]?.role} @ ${r.specs[0]?.cwd})`,
  );
}

// -------------------------------- (k) no runner configured is infrastructure
{
  const r = await runChallenge({
    issue: 211,
    noRunner: true,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(
    isInfra(r.threw) && (r.threw?.message ?? "").includes("no test runner configured"),
    `(k) a missing runner THROWS naming the setting — a round without one could only ever report \`none\`, which would certify nothing (got ${r.threw?.message ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(r.dispatched === 0, `(k) the adversary was never dispatched (got ${r.dispatched})`);
}

// ------------------------------------- (l) the worktree must exist and be ours
{
  const built = challengeFixture(212);
  git(built.repoRoot, "worktree", "remove", "--force", built.worktree);
  const r = await runChallenge({ issue: 212, built });
  assert(r.threw !== undefined, "(l) a missing worktree is infrastructure, not a verdict");
  assert(
    (r.threw?.message ?? "").includes("does not exist"),
    `(l) the throw names the missing worktree (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, "(l) the adversary was never dispatched");
}

// ------------------------------ (m) phase1Handlers wires the real challenge step
//
// The not-built stub THROWS "… is not built yet"; the real step refuses a
// missing worktree by naming it, so the two cannot be confused.
{
  const built = challengeFixture(213);
  git(built.repoRoot, "worktree", "remove", "--force", built.worktree);
  const handler = phase1Handlers(built.repoRoot, 213).challenge;
  const settled = handler
    ? await handler(built.ctx).then(
        (o) => o,
        (err: unknown) => err,
      )
    : "no challenge handler";
  assert(
    settled instanceof Error && settled.message.includes("does not exist"),
    `(m) phase1Handlers.challenge is the real step (got ${settled instanceof Error ? settled.message : JSON.stringify(settled)})`,
  );
  assert(
    !(settled instanceof Error && /not built yet/.test(settled.message)),
    "(m) it is not the notBuilt stub answering for the challenge state",
  );
}

// ---------------------- (n) every other state's stub throws rather than answering
//
// A stub that returned an outcome kind the table does not list would end the run
// on `no transition for <state> + "…"`, blaming the machine for a stage nobody
// built. A throw is what the engine already turns into a handed-back run whose
// reason names the missing stage.
{
  const built = challengeFixture(214);
  const handlers = phase1Handlers(built.repoRoot, 214);
  const stubs = ["verify", "publish", "review", "ci", "land", "handback"] as const;
  const messages = await Promise.all(
    stubs.map((s) =>
      (handlers[s] as (c: never) => Promise<unknown>)(built.ctx as never).then(
        String,
        (e: unknown) => (e as Error).message,
      ),
    ),
  );
  assert(
    stubs.every((s, i) => messages[i] === `work-lean stage ${s} is not built yet`),
    `(n) each unbuilt stage's handler THROWS the reason, not an illegal outcome (got ${JSON.stringify(messages)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
