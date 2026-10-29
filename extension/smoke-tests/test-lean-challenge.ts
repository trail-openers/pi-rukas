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
 *   (f) the child commits on its own -> exactly ONE driver commit, holding only the red test
 *   (g) ten green submissions    -> `none`, and the per-file note list is CAPPED
 *   (h) the frozen map at HEAD matches after the challenge commit
 *   (i) a frozen record that does not match at HEAD -> THROW before the dispatch
 *   (j) the prompt names the frozen tests, asks for new ones, ties them to criteria
 *   (k) no runner configured -> THROW (a round that could only say `none` judged nothing)
 *   (l) the worktree is not ours -> THROW before the dispatch
 *   (o)-(q) the preconditions that must hold BEFORE a child is paid, and the
 *       literal-pathspec shape of the test commit, are in
 *       `test-lean-challenge-gates.ts`, which shares this fixture
 *   (m) phase1Handlers wires the real challenge step
 *   (n) every other state's stub throws rather than answering
 *
 * The VERDICT rules — when this step may say `new-tests`, when it must say
 * `none`, and the shapes it must answer with a THROW — are in
 * `test-lean-challenge-coverage.ts`, which shares this fixture. Every throw
 * case in both files asserts the error CLASS with `instanceof`, not only its
 * message and not its `name`: `none` and a throw are the two answers this step
 * gives and the machine routes them to opposite places, so a message match
 * alone would pass if the throw were the wrong kind — or if a future refactor
 * returned `none` with a scary string.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { ChallengeInfraError } from "../src/lean/challenge.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import {
  ROOTS,
  RUNNER,
  SpecifyInfraError,
  blobSha,
  challengeFixture,
  childCommitOf,
  commitPaths,
  git,
  greenEdge,
  put,
  redEdge,
  runChallenge,
  sha,
  status,
  subjectsAbove,
  submit,
} from "./lib/lean-challenge-fixture.ts";

/**
 * Is this throw the infrastructure family? Both steps name their own subclass
 * and the machine routes this step's two answers — `none` and a throw — to
 * opposite places, so the CLASS is the assertion: `instanceof` only, never a
 * `name` sniff that a re-export or a rename would silently unmatch.
 */
function isInfra(err: Error | undefined): boolean {
  return err instanceof SpecifyInfraError || err instanceof ChallengeInfraError;
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

// ---------------------- (f) the child commits on its own: still ONE driver commit
//
// The adversary is a developer with a shell, and a developer commits. The step
// resets the tree to `headBefore` before it rewrites anything, so the child's
// commit must not survive as a second commit above that head and its message
// must not become the record either: exactly one commit, the step's own subject,
// holding ONLY the new red test, with the frozen map still intact at HEAD.
{
  const built = challengeFixture(202);
  const r = await runChallenge({
    issue: 202,
    built,
    child: (wt) => {
      put(wt, EDGE, redEdge(EDGE));
      // The child stages everything and commits, the way one left to its own
      // devices does — including the frozen file sitting in its tree.
      childCommitOf(wt, "test: adversarial round 1");
    },
    toolUses: [submit("AC1", [EDGE])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(f) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "new-tests", `(f) new-tests, got ${r.outcome?.kind}`);
  assert(
    subjectsAbove(wt, r.headBefore).join() === "test: challenge tests for #202",
    `(f) EXACTLY ONE commit above the head the step found, and it is the step's own — the child's is gone (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD^") === r.headBefore,
    "(f) that single commit sits directly on the head the step found",
  );
  assert(
    commitPaths(wt).join() === EDGE,
    `(f) the commit holds the new red test and nothing else (got ${commitPaths(wt).join(", ")})`,
  );
  assert(status(wt) === "", `(f) the worktree is clean after the commit (got ${status(wt)})`);
}

// --------------------------- (g) ten green submissions: the note list is capped
//
// The reason an outcome carries is what an operator reads in a handback, so a
// round that dropped forty files must not print forty lines of it. Ten files
// all PASS the runner here, so all ten are refused with a per-file note. Two
// malformed `submit_tests` calls sit beside them so the reason also carries its
// malformed count — and nothing is red, so the round's verdict is `none` and
// its reason shows the cap and counts the rest rather than quoting them.
{
  const TEN = Array.from({ length: 10 }, (_unused, i) => `tests/AC1-green-${i + 1}.test.sh`);
  // The ten green submissions arrive as TWO rows of the same criterion, because
  // the boundary caps ONE row at `MAX_TEST_FILES_PER_ROW` names — a twenty-name
  // row is refused outright, and then neither note family below is ever built.
  // A child declares what it wrote per call, so two calls of ten names each are
  // what a real over-submission looks like, and both families reach the cap.
  const rowsFor = (rels: string[]): unknown[] => {
    const rows: unknown[] = [];
    for (let i = 0; i < rels.length; i += 5) rows.push(submit("AC1", rels.slice(i, i + 5)));
    return rows;
  };
  // Ten REFUSED rows (a path that is not a file in the tree) sit beside them:
  // the per-file evidence list and the refused-row list are two separate note
  // families and BOTH are capped, so each contributes its own `(+2 more)` once
  // the cap of eight clips it.
  const TEN_ABSENT = Array.from(
    { length: 10 },
    (_unused, i) => `tests/AC1-absent-${i + 1}.test.sh`,
  );
  const r = await runChallenge({
    issue: 203,
    child: (wt) => {
      for (const rel of TEN) put(wt, rel, greenEdge(rel));
    },
    toolUses: rowsFor(TEN.concat(TEN_ABSENT)),
  });
  const reason = r.outcome?.reason ?? "";
  assert(r.threw === undefined, `(g) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "none",
    `(g) nothing was red, so the verdict is \`none\` (got ${r.outcome?.kind})`,
  );
  assert(
    reason.includes("2 malformed submit_tests call(s)") === false,
    "(g) no malformed count here — the two lists are the capped ones, so the reason cannot hide a third clause",
  );
  assert(
    reason.includes("dropped 10") && reason.includes("(+2 more)"),
    `(g) the per-file note list is capped at eight and the other two counted, not quoted (got ${reason})`,
  );
  assert(
    reason.split("(+2 more)").length - 1 === 2 &&
      reason.includes("dropped 10:") &&
      reason.includes("dropped 10 (+2 more) —"),
    `(g) BOTH note families are capped — the per-file evidence list and the refused-row list each count their own two beyond the cap (got ${reason})`,
  );
  assert(
    reason.length < 4000,
    `(g) the reason stays bounded for a handback (${reason.length} chars)`,
  );
  assert(
    TEN.every((rel) => !existsSync(path.join(r.worktree, rel))),
    "(g) every refused green file is deleted from the tree",
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
// reason names the missing stage. `verify`, `handback` and `publish` are not in
// the list: each is a real step now, and `test-lean-verify-wiring.ts` /
// `test-lean-publish.ts` assert each is the step rather than the stub.
{
  const built = challengeFixture(214);
  const handlers = phase1Handlers(built.repoRoot, 214);
  const stubs = ["review", "ci", "land"] as const;
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
