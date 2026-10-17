#!/usr/bin/env bun
/**
 * #1134 round 3 — the commit-pr commit count fails closed.
 *
 * verifyStepOutcome(commit-pr) counts the PR's commits with `git rev-list
 * --count --right-only` over `origin/<base>...origin/<branch>`. Three outcomes
 * must each be a FAILURE, never a note or a pass:
 *   1. git rejects the count (the call throws)            → failure
 *   2. git replies with something that is not a count     → failure (NaN)
 *   3. the mainline cannot be resolved, so there is no base → failure
 * A healthy count stays silent, so the control proves the assertions can fail.
 */

import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify-pr17.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Exec = (cmd: string, opts?: { argv?: string[] }) => Promise<{ stdout: string }>;

/** A stub git: the mainline answers `mainline`, the count answers `count`. */
function gitStub(opts: {
  mainline?: string;
  count: () => Promise<{ stdout: string }>;
}): Exec {
  return async (cmd, o) => {
    if (cmd.startsWith("git symbolic-ref")) {
      if (opts.mainline === undefined) throw new Error("fatal: ref not found");
      return { stdout: `origin/${opts.mainline}\n` };
    }
    if (cmd.startsWith("gh repo view")) throw new Error("gh unavailable");
    // The pushed-ref precondition (#1134 follow-up): origin/<branch> resolves.
    if (cmd === "git" && o?.argv?.[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n` };
    if (cmd === "git" && o?.argv?.[0] === "rev-list") return opts.count();
    // Everything else (forge detection, PR lookups) is unanswered: the gate
    // reports that itself, and these assertions only look at the commit count.
    throw new Error(`unexpected exec: ${cmd}`);
  };
}

function ctxWith(exec: Exec): DriverContext {
  return {
    repoRoot: "/nonexistent-1134",
    issue: 1134,
    verifyExecFn: exec,
  } as unknown as DriverContext;
}

function stateOn(branch: string) {
  const s = initialState(1134, Date.now());
  return { ...s, pipelineState: { ...s.pipelineState, branchName: branch } };
}

const COMMIT_LINE = /could not count commits/;

// 1. A rejected count is a failure with the reason, not a note.
{
  const exec = gitStub({
    mainline: "main",
    count: async () => {
      throw new Error("fatal: bad revision 'origin/main...origin/feature/x'");
    },
  });
  const r = await verifyStepOutcome(ctxWith(exec), stateOn("feature/x"), "commit-pr");
  const f = r.failures.find((x) => COMMIT_LINE.test(x));
  assert(
    f?.includes("origin/main") && f.includes("bad revision"),
    `a rejected rev-list is a FAILURE naming the base and the git error (got: ${f ?? "none"})`,
  );
  assert(
    f?.includes("commit evidence is unverifiable") === true,
    "...and it says the commit evidence is unverifiable",
  );
  assert(!r.ok, "a rejected count makes the gate fail");
  assert(
    !r.notes.some((n) => n.includes("rev-list failed")),
    "...and the rejection is not recorded as a note",
  );
}

// 2. A reply that is not a count fails closed (the existing NaN branch).
{
  const exec = gitStub({
    mainline: "main",
    count: async () => ({ stdout: "fatal\n" }),
  });
  const r = await verifyStepOutcome(ctxWith(exec), stateOn("feature/x"), "commit-pr");
  assert(
    r.failures.some((x) => COMMIT_LINE.test(x) && x.includes("unverifiable")),
    "a non-numeric count is a failure (NaN is unknown, not zero or a pass)",
  );
}

// 3. An unresolved mainline fails closed, and the reason reaches the failure.
{
  const exec = gitStub({
    mainline: undefined,
    count: async () => ({ stdout: "1\n" }),
  });
  const r = await verifyStepOutcome(ctxWith(exec), stateOn("feature/x"), "commit-pr");
  assert(
    r.failures.some((x) => x.includes("mainline is unresolved") && x.includes("could not resolve")),
    "an unresolved mainline is a failure carrying detectMainline's reason",
  );
}

// 4. Control: a healthy count raises no commit-count failure.
{
  const exec = gitStub({
    mainline: "main",
    count: async () => ({ stdout: "2\n" }),
  });
  const r = await verifyStepOutcome(ctxWith(exec), stateOn("feature/x"), "commit-pr");
  assert(
    !r.failures.some((x) => COMMIT_LINE.test(x)),
    "control: a readable positive count raises no commit-count failure",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
