#!/usr/bin/env bun
/**
 * #362 — branch-step pre-flight for an already-open PR.
 *
 * Covers the matcher in isolation and the `runBranch` wiring via an injected
 * `verifyExecFn`, so nothing here touches the network or spawns a child.
 *
 * The regression being locked down: `/work N --restart` wipes the state file
 * but not GitHub, so the driver rebuilt issue #5 from scratch and opened PR
 * #359 while #358 was still open on a different branch. Because the branch
 * names differed, a branch-scoped lookup would not have caught it — the
 * matcher is keyed on the issue number.
 */

import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import { matchPrForIssue } from "../src/work-driver-pr-preflight.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- matcher

{
  const none = matchPrForIssue([], 5);
  assert(none === undefined, "matcher: empty PR list → no match");

  const byBody = matchPrForIssue(
    [{ number: 358, headRefName: "feature/whatever", body: "Automated.\n\nFixes #5" }],
    5,
  );
  assert(byBody?.number === 358 && byBody.matchedBy === "body", "matcher: body 'Fixes #5' matches");

  // The #358/#359 shape: the branch name does NOT contain the issue token the
  // second cycle would have used, so only the issue-keyed body check catches it.
  const byBranch = matchPrForIssue(
    [
      {
        number: 358,
        headRefName: "feature/issue-5-surface-thinking-only-output",
        body: "no keyword",
      },
    ],
    5,
  );
  assert(
    byBranch?.number === 358 && byBranch.matchedBy === "branch",
    "matcher: head branch 'issue-5-…' matches when the body has no keyword",
  );

  assert(
    matchPrForIssue([{ number: 9, headRefName: "feature/issue-55-x", body: "Fixes #55" }], 5) ===
      undefined,
    "matcher: issue #5 does NOT match #55 (no numeric-continuation false positive)",
  );
  assert(
    matchPrForIssue([{ number: 9, headRefName: "chore/unrelated", body: "Fixes #77" }], 5) ===
      undefined,
    "matcher: unrelated open PRs for other issues do not match",
  );
  assert(
    matchPrForIssue([{ number: 9, headRefName: "x", body: "Closes #5" }], 5)?.matchedBy === "body",
    "matcher: 'Closes' accepted alongside 'Fixes' (human-authored PRs)",
  );
  assert(
    matchPrForIssue([{ number: 9, headRefName: "feature/issues-85-111", body: "" }], 85)
      ?.matchedBy === "branch",
    "matcher: bundled 'issues-85-…' branch matches its first issue",
  );
  // Body match wins over branch match — it is the stronger signal.
  const both = matchPrForIssue(
    [
      { number: 1, headRefName: "feature/issue-5-old", body: "" },
      { number: 2, headRefName: "unrelated", body: "Fixes #5" },
    ],
    5,
  );
  assert(both?.number === 2, "matcher: body signal takes precedence over branch signal");
}

// ------------------------------------------------------- runBranch wiring

function ctxWith(prListJson: string | Error, dispatched: string[]): DriverContext {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: only the fields runBranch touches are needed
    pi: {} as any,
    repoRoot: "/tmp/does-not-exist",
    issue: 5,
    verifyExecFn: async (cmd: string) => {
      if (cmd.startsWith("gh pr list")) {
        if (prListJson instanceof Error) throw prListJson;
        return { stdout: prListJson };
      }
      return { stdout: "" };
    },
    dispatchFn: async () => {
      dispatched.push("dispatch");
      throw new Error("runBranch must not dispatch when the pre-flight halts");
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial context is sufficient for this path
  } as any;
}

{
  const dispatched: string[] = [];
  const ctx = ctxWith(
    JSON.stringify([{ number: 358, headRefName: "feature/x", body: "Fixes #5" }]),
    dispatched,
  );
  const out = await runBranch(ctx, initialState(5), 1000);
  const cap = out.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "existing-pr-detected" && cap.nextStep === "handoff",
    "runBranch: open PR for the issue → cap existing-pr-detected → handoff",
  );
  assert(dispatched.length === 0, "runBranch: halts BEFORE any dispatch (zero tokens spent)");
  assert(
    out.pipelineState.existingPr?.number === 358,
    "runBranch: records the PR number in pipelineState for the handoff body",
  );
}

/**
 * The contract for every "should proceed" case is precisely "no
 * existing-pr-detected cap was emitted". Asserting that directly beats
 * asserting on what the downstream dispatch happens to do, which is not this
 * module's business and would couple the test to runSingleDispatch internals.
 */
async function haltedByPreflight(prList: string | Error): Promise<boolean> {
  const out = await runBranch(ctxWith(prList, []), initialState(5), 1000).catch(() => undefined);
  if (!out) return false; // threw downstream ⇒ got past the pre-flight
  return out.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "existing-pr-detected");
}

// Exercise the helper in the positive direction too — a predicate only ever
// asserted false is indistinguishable from one hardwired to false.
assert(
  await haltedByPreflight(JSON.stringify([{ number: 358, headRefName: "f", body: "Fixes #5" }])),
  "haltedByPreflight: returns true for a genuine match (helper is not vacuously false)",
);

{
  const prev = process.env.PI_ENSEMBLE_PR_PREFLIGHT;
  process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";
  try {
    const halted = await haltedByPreflight(
      JSON.stringify([{ number: 358, headRefName: "f", body: "Fixes #5" }]),
    );
    assert(!halted, "runBranch: PI_ENSEMBLE_PR_PREFLIGHT=0 disables the check");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_PR_PREFLIGHT;
    else process.env.PI_ENSEMBLE_PR_PREFLIGHT = prev;
  }
}

assert(
  !(await haltedByPreflight(new Error("gh: could not connect"))),
  "runBranch: gh pr list failure fails OPEN — a lookup outage must not block work",
);
assert(
  !(await haltedByPreflight("this is not json")),
  "runBranch: unparseable gh output fails OPEN",
);
assert(
  !(await haltedByPreflight(
    JSON.stringify([{ number: 9, headRefName: "other", body: "Fixes #77" }]),
  )),
  "runBranch: unrelated open PRs do not halt the cycle",
);

// ------------------------------------------------- handoff rendering
// A cap whose handoff renderer throws is worse than no cap: the cycle halts
// and the operator gets nothing. #355 records that nothing else in the suite
// asserts on rendered handoff output, so cover both surfaces here.
{
  const halted = await runBranch(
    ctxWith(
      JSON.stringify([{ number: 358, headRefName: "feature/issue-5-old", body: "Fixes #5" }]),
      [],
    ),
    initialState(5),
    1000,
  );
  const md = renderHandoffMarkdown(halted);
  const chat = renderHandoffUserMessage(halted, "/tmp/repo", "/tmp/repo/tmp/issue-5");

  for (const [surface, text] of [
    ["markdown", md],
    ["chat", chat],
  ] as const) {
    assert(/#358/.test(text), `handoff ${surface}: names the existing PR number`);
    assert(
      /feature\/issue-5-old/.test(text),
      `handoff ${surface}: names the existing PR's head branch`,
    );
    assert(
      !/Discard the cycle and start over/.test(text),
      `handoff ${surface}: does NOT fall through to the generic discard-and-retry boilerplate`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
