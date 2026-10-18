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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import {
  classifyContinueLookup,
  continueHeadProblem,
} from "../src/work-driver-continue-pr-lookup.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import {
  listOpenPrsForIssue,
  matchPrForIssue,
  type OpenPrLookup,
} from "../src/work-driver-pr-preflight.ts";
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
    host: {} as any,
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

// ------------------------------------------- #1468 continue-pr lookup

const prRow = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  headRefName: `feature/issue-5-x${n}`,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  isCrossRepository: false,
  headRepository: { name: "repo" },
  body: "Fixes #5",
  ...over,
});

function ghExec(out: string | Error, seen: string[][] = []): VerifyExecFn {
  return async (cmd, opts) => {
    seen.push([cmd, ...(opts?.argv ?? [])]);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
}

async function lookup(out: string | Error): Promise<OpenPrLookup> {
  return listOpenPrsForIssue(ghExec(out), "/tmp/does-not-exist", 5);
}

{
  const seen: string[][] = [];
  await listOpenPrsForIssue(ghExec("[]", seen), "/tmp/x", 5);
  assert(
    seen[0]?.join(" ") ===
      "gh pr list --state open --limit 500 --json number,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository,body",
    "continue lookup: gh runs in argv form with --limit 500 and the head/base/fork fields",
  );

  const one = await lookup(JSON.stringify([prRow(358), prRow(9, { headRefName: "x", body: "" })]));
  assert(
    one.kind === "ok" && one.prs.length === 1 && one.prs[0]?.matchedBy === "both",
    "continue lookup: body and branch match on the same number count as one PR (matchedBy both)",
  );
  const c1 = classifyContinueLookup(one, 5, "github");
  assert("pr" in c1 && c1.pr.number === 358, "continue classify: exactly one PR → ok");

  const two = await lookup(
    JSON.stringify([prRow(358, { body: "" }), prRow(360, { headRefName: "y" })]),
  );
  assert(
    two.kind === "ok" && two.prs.map((p) => p.matchedBy).join() === "branch,body",
    "continue lookup: a branch-only and a body-only match are both kept",
  );
  const c2 = classifyContinueLookup(two, 5, "github");
  assert(
    "cap" in c2 &&
      c2.cap === "continue-pr-ambiguous" &&
      /358/.test(c2.evidence) &&
      /360/.test(c2.evidence),
    "continue classify: two PR numbers → ambiguous, evidence lists both",
  );

  const zero = classifyContinueLookup(await lookup("[]"), 5, "github");
  assert(
    "cap" in zero && zero.cap === "continue-pr-not-found",
    "continue classify: 0 PRs → not-found",
  );

  const failed: Array<[string, string | Error, RegExp]> = [
    ["gh throw", new Error("gh: could not connect"), /could not connect/],
    ["bad JSON", "this is not json", /JSON/i],
    ["not an array", "{}", /array/i],
    ["500-row page", JSON.stringify(Array.from({ length: 500 }, (_, i) => prRow(1000 + i))), /500/],
  ];
  for (const [name, out, re] of failed) {
    const r = await lookup(out);
    const c = classifyContinueLookup(r, 5, "github");
    assert(
      r.kind === "unreadable" &&
        "cap" in c &&
        c.cap === "continue-pr-not-found" &&
        re.test(c.evidence),
      `continue lookup: ${name} → unreadable → not-found with the reason in evidence`,
    );
  }

  const gl = classifyContinueLookup(one, 5, "gitlab");
  assert(
    "cap" in gl && gl.cap === "continue-pr-not-found" && /gitlab/.test(gl.evidence),
    "continue classify: forge=gitlab → not-found naming the forge",
  );

  for (const [name, over] of [
    ["isCrossRepository true", { isCrossRepository: true }],
    ["isCrossRepository missing", { isCrossRepository: undefined }],
    ["headRepository null", { headRepository: null }],
  ] as const) {
    const c = classifyContinueLookup(await lookup(JSON.stringify([prRow(358, over)])), 5, "github");
    assert("cap" in c && c.cap === "continue-pr-fork", `continue classify: ${name} → fork`);
  }
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-head-"));
  const exec: VerifyExecFn = (cmd, opts) => execp(cmd, { ...opts, cwd: dir });
  const pr = (headRefName: string, baseRefName = "main") => ({
    ...prRow(358, { headRefName, baseRefName }),
    matchedBy: "body" as const,
  });
  assert(
    (await continueHeadProblem(exec, dir, pr("feature/issue-5-x"), "main")) === undefined,
    "continue head: a plain feature branch on main passes",
  );
  for (const [name, head, base] of [
    ["command substitution", "x$(touch pwned)", "main"],
    ["backtick", "x`touch pwned`", "main"],
    ["leading dash", "-x", "main"],
    ["git-invalid name", "feature/x.lock", "main"],
    ["head is the mainline", "main", "main"],
    ["base is not the mainline", "feature/issue-5-x", "release"],
  ] as const) {
    const problem = await continueHeadProblem(exec, dir, pr(head, base), "main");
    assert(typeof problem === "string" && problem.length > 0, `continue head: ${name} → unsafe`);
  }
  assert(
    !fs.existsSync(path.join(dir, "pwned")),
    "continue head: no untrusted name reached a shell",
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
