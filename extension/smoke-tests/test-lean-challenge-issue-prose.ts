#!/usr/bin/env bun
/**
 * #2171 — the issue's prose reaches the challenge adversary.
 *
 * `challenge` was the seat that never saw the issue at all: the step fetched the
 * body, parsed the pi-spec block out of it and dropped the text with it. A
 * constraint written as prose — "the check runs before the draw", a non-obvious
 * "never do X" — was therefore invisible to the oracle whose whole job is to
 * break the acceptance tests, so it could call a spec complete while the issue
 * contradicted it.
 *
 * Split out of test-lean-challenge.ts (that file is the round's git/worktree
 * behaviour and had outgrown the size gate); the fixture is shared, so the two
 * files run the same step.
 */
import { runChallenge } from "./lib/lean-challenge-fixture.ts";
import { put, redEdge, submit, TWO_AC_BODY } from "./lib/lean-challenge-fixture.ts";
import { sha } from "./lib/lean-build-fixture.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, specExit } from "./lib/plan-pi-spec-fixture.ts";

/** The edge-case test path the adversary writes, as the round's other cases name it. */
const EDGE = "tests/AC1-edge-second-failure.test.sh";

// The body carries prose on BOTH sides of the spec block, so a section that
// rendered only the block (or nothing) cannot pass, and one assertion covers
// both directions of the strip. The switch is pinned OFF-for-absent rather than
// trusted to the ambient environment: `leanIssueProseEnabled()` reads
// `process.env` at call time, so a driver or operator shell that exported
// `PI_ENSEMBLE_LEAN_ISSUE_PROSE=0` would otherwise make these ON-case
// assertions fail red on an unrelated change.
{
  const proseBody = `The retry helper must keep its exception message.

${TWO_AC_BODY}

The message stays exactly "quota exceeded", and the check runs before the draw.
`;
  await withEnv({ PI_ENSEMBLE_LEAN_ISSUE_PROSE: undefined }, async () => {
    const r = await runChallenge({
      issue: 2102,
      specBody: proseBody,
      child: (wt) => put(wt, EDGE, redEdge(EDGE)),
      toolUses: [submit("AC1", [EDGE])],
    });
    const prompt = r.prompts[0] ?? "";
    assert(r.outcome?.kind === "new-tests", `(j2) new-tests, got ${r.outcome?.kind}`);
    assert(r.fetched === 1, `(j2) the issue was read exactly once (got ${r.fetched})`);
    assert(
      prompt.includes("## The issue") &&
        prompt.includes('The message stays exactly "quota exceeded"') &&
        prompt.includes("The retry helper must keep its exception message."),
      "(j2) the prose above AND below the spec block reaches the adversary's brief",
    );
    assert(
      !prompt.includes("pi-spec v1") && !prompt.includes('"verify": "test"'),
      "(j2) the spec block itself is stripped — the criteria are printed above, not embedded twice",
    );
    assert(
      prompt.includes("```text") &&
        prompt.indexOf("## The issue") < prompt.indexOf("## The acceptance criteria"),
      "(j2) the section sits between the problem and the criteria, behind the fence",
    );
    assert(
      prompt.includes("The issue text below is the authority"),
      "(j2) the one-line instruction that makes the prose binding is present",
    );
  });
}

// Off is off: with the switch set to "0" the same body renders NO section, and
// everything else about the brief is unchanged — that is what makes a
// with-prose run comparable to a without-prose one. `withEnv` rather than a
// hand-rolled set/`delete`: an operator's own ambient `=0` has to survive the
// file, not be deleted by it.
await withEnv({ PI_ENSEMBLE_LEAN_ISSUE_PROSE: "0" }, async () => {
  const r = await runChallenge({
    issue: 2103,
    specBody: `The retry helper must keep its exception message.\n\n${TWO_AC_BODY}\n`,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  const prompt = r.prompts[0] ?? "";
  assert(
    !prompt.includes("## The issue") && !prompt.includes("quota exceeded"),
    "(j3) PI_ENSEMBLE_LEAN_ISSUE_PROSE=0 restores the pre-feature brief exactly",
  );
  assert(
    prompt.includes("## The acceptance criteria") && r.outcome?.kind === "new-tests",
    "(j3) and the rest of the brief still works — the criteria are still there, the round still ran",
  );
  assert(
    sha(prompt).length > 0 && (r.prompts.length ?? 0) === 1,
    "(j3) the adversary was dispatched once with the switch off, so both runs are single-prompt comparable",
  );
});

process.exit(specExit());
