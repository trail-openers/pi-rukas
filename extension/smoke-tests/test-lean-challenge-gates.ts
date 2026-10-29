#!/usr/bin/env bun
/**
 * lean/challenge — the gates a round must clear BEFORE a child is paid, and the
 * pathspec shape of the commit it makes afterwards.
 *
 * `test-lean-challenge.ts` drives the verdicts; this file drives the three
 * preconditions that are pure infrastructure — a head that is not a commit id,
 * a spec that is no longer ready — and the one property of the commit that only
 * git can answer: that a test whose NAME is a glob pattern was committed as one
 * literal file. The split is by subject, not by size: every case here asks
 * "what stops the round", and every case there asks "what did the round find".
 *
 *   (o) HEAD is not a 40-hex commit id      -> THROW before the dispatch
 *   (p) the issue's spec fails `readiness`  -> THROW before the dispatch
 *   (q) a submission named like a glob      -> the commit holds exactly that file
 *
 * The throw cases assert the error CLASS with `instanceof`, not only the message:
 * `none` and a throw are the two answers this step gives and the machine routes
 * them to opposite places, so a message match alone would pass if the throw were
 * the wrong kind.
 */

import { ChallengeInfraError } from "../src/lean/challenge.ts";
import {
  ROOTS,
  SpecifyInfraError,
  commitPaths,
  git,
  greenEdge,
  put,
  redEdge,
  runChallenge,
  submit,
} from "./lib/lean-challenge-fixture.ts";

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

const EDGE = "tests/AC1-edge-second-failure.test.sh";

// ------------------------------------------ (o) HEAD must be a commit id, first
//
// `rev-parse HEAD` answers with whatever the ref resolves to. A value that is
// not a 40-hex id is reinterpreted as a REF by every later `diff <sha> <sha>`,
// `rev-parse <sha>^` and `show <sha>:<path>`, so a poisoned head would retarget
// the whole round at a different commit rather than fail. It is validated before
// it reaches any of them — so the adversary is never paid either.
{
  const r = await runChallenge({
    issue: 215,
    overrideHead: "main",
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(
    isInfra(r.threw),
    `(o) a head that is not a commit id THROWS an infra error, not a verdict (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(
    isInfra(r.threw) && (r.threw?.message ?? "").includes("HEAD is not a commit id"),
    `(o) the throw names HEAD and its value (got ${r.threw?.message})`,
  );
  assert(
    (r.threw?.message ?? "").includes("main"),
    `(o) the throw quotes the offending value (got ${r.threw?.message})`,
  );
  assert(
    r.threw instanceof ChallengeInfraError,
    `(o) the throw is the challenge family (got ${r.threw?.constructor.name})`,
  );
  assert(r.dispatched === 0, `(o) the adversary was never dispatched (got ${r.dispatched})`);
}

// ------------------------- (p) the spec is re-checked for readiness before paying
//
// The issue is editable while the run is going, so a spec that passed `ready`
// need not be ready now, and the round's claim is stated against these criteria.
// An invalid criterion id is a rule `readiness` reports, and `specify` already
// refuses on it — the step now answers the same way, before the dispatch.
{
  const broken = {
    problem: "The retry helper gives up on the first transient failure.",
    size: "S",
    criteria: [
      { id: "AC1", text: "retries a transient failure twice before failing", verify: "test" },
      { id: "BAD-ID", text: "documents the retry budget", verify: "manual" },
    ],
    scope: { paths: ["src/retry.ts"], out: ["docs/"] },
  };
  const body = `\`\`\`pi-spec v1\n${JSON.stringify(broken, null, 2)}\n\`\`\``;
  const r = await runChallenge({
    issue: 216,
    specBody: body,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(
    isInfra(r.threw),
    `(p) a spec failing the readiness rules THROWS rather than reporting a verdict about criteria it cannot read (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(
    (r.threw?.message ?? "").includes("BAD-ID"),
    `(p) the throw names the rule it refused on, criterion id included (got ${r.threw?.message})`,
  );
  assert(r.dispatched === 0, `(p) the adversary was never dispatched (got ${r.dispatched})`);
}

// ------------- (q) a test named like a glob commits as ONE LITERAL file, nothing else
//
// The adversary submits `tests/[a]x.test.sh` beside a tracked `tests/ax.test.sh`
// that the pattern matches. Without `--literal-pathspecs` the add and the commit
// both take the glob's match — the tracked file the step never captured — and the
// un-literal `diff --name-only` assertion then reports the pair as "exactly the
// paths we meant", because the same glob is on that call too. So this asserts
// against git's own answer for the commit: one path, the bracketed name.
{
  const LITERAL = "tests/[a]x.test.sh";
  const SIBLING = "tests/ax.test.sh";
  const r = await runChallenge({
    issue: 217,
    // The sibling is part of the contract at the head the round starts from, so
    // its absence from the commit is a fact about THIS commit, not about a file
    // that was never tracked.
    extraFrozen: { [SIBLING]: greenEdge(SIBLING) },
    child: (wt) => put(wt, LITERAL, redEdge(LITERAL), 0o755),
    toolUses: [submit("AC1", [LITERAL])],
  });
  assert(r.threw === undefined, `(q) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "new-tests", `(q) new-tests, got ${r.outcome?.kind}`);
  const committed = commitPaths(r.worktree);
  assert(
    JSON.stringify(committed) === JSON.stringify([LITERAL]),
    `(q) git says the commit holds exactly the literal file (got ${JSON.stringify(committed)})`,
  );
  assert(
    !committed.includes(SIBLING),
    `(q) the glob's other match — the tracked ${SIBLING} — is NOT in the commit`,
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD^") === r.headBefore,
    "(q) and it sits directly on the head the step found",
  );
  assert(
    r.gitArgvs.some((a) => a[0] === "--literal-pathspecs"),
    "(q) the pathspec-carrying git calls are the literal ones",
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
