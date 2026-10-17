#!/usr/bin/env bun
/**
 * #1472 — the cycle's own ISSUE can be CLOSED under it.
 *
 * `endIfPrGone` watches the PR; nothing watched the issue. `runWorkDriverInner`'s
 * terminal refusal keys on the LOCAL state file, and the one cycle-entry forge
 * read (`checkAttentionLabel`) reads only `.labels`. So a person who closed the
 * issue mid-run did not stop the cycle: explore/plan/branch/develop/adversarial
 * and commit-pr are all ungated, and each pays for a fresh agent turn on work a
 * human just said they no longer want.
 *
 * This drives the gate with a fake Forge (the same `opts.forge` seam
 * `test-work-driver-attention-forge.ts` uses) and asserts the five behaviours
 * that make it correct rather than merely present:
 *
 *   1. CLOSED ends the cycle, naming WHICH issue and the step it stopped.
 *   2. Every group member is read — keying on the primary alone reproduces the
 *      miss `checkAttentionLabel` was originally written with.
 *   3. An unreadable state NEVER ends the cycle (fail open). A gate that fails
 *      closed turns a `gh` outage into mass cycle aborts, a worse bug than the
 *      one being fixed — and it says the check did not run.
 *   4. The retry budget is this gate's OWN: a cycle whose PR read was
 *      unreadable still gets its full issue-state backoff.
 *   5. The park is a handoff with `issue-closed:<step>`, no verifyEvidence, and
 *      the label recorded as SKIPPED (not failed).
 */

import type { Forge } from "../src/forge.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import {
  checkIssueStatesAtEntry,
  endIfIssueClosed,
  issueClosedPark,
} from "../src/work-driver-issue-closed.ts";
import { initialState } from "../src/workflow-state-update.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type IssueState = "OPEN" | "CLOSED";

/** Fake Forge whose issueView returns a programmable state per issue. */
function mkForge(states: Record<number, IssueState | Error>): { forge: Forge; calls: number[] } {
  const calls: number[] = [];
  const forge = {
    forge: "github",
    host: "github.com",
    owner: "acme",
    repo: "widget",
    cwd: "/repo",
    issueView: async (n: number) => {
      calls.push(n);
      const r = states[n];
      if (r instanceof Error) throw r;
      if (!r) throw new Error(`unexpected issue view ${n}`);
      return {
        number: n,
        title: `Issue ${n}`,
        body: "body",
        state: r,
        url: `https://github.com/acme/widget/issues/${n}`,
        author: undefined,
        labels: [],
        createdAt: "",
        updatedAt: "",
      };
    },
    prView: async () => {
      throw new Error("unused");
    },
    issueComment: async () => "",
    labelAdd: async () => undefined,
    labelRemove: async () => undefined,
    labelCreate: async () => undefined,
  } as unknown as Forge;
  return { forge, calls };
}

function mkCtx(issues: number[]): CycleContext {
  return {
    issue: issues[0],
    issues,
    repoRoot: "/repo",
    host: {} as DriverContext["host"],
    dispatchFn: async () => ({ transcriptPath: undefined }),
    emitSink: () => undefined,
  } as unknown as CycleContext;
}

function mkState(issue: number, issues: number[]): WorkState {
  return initialState(issue, issues, "main") as WorkState;
}

// ── 1. CLOSED ends the cycle and names the issue and the step ──────────────
{
  const { forge } = mkForge({ 10: "CLOSED" });
  const ctx = mkCtx([10]);
  const state = mkState(10, [10]);
  const gate = await endIfIssueClosed(ctx, state, "develop", { forge });
  assert(!!gate.ended, "a CLOSED issue ends the cycle at the step boundary");
  const caps = gate.ended?.eventLog.filter((e) => e.kind === "cap-hit") ?? [];
  assert(
    caps.length === 1 && caps[0].kind === "cap-hit" && caps[0].cap === "issue-closed:develop",
    "the park records cap `issue-closed:develop`",
  );
  assert(
    caps[0]?.kind === "cap-hit" && caps[0].nextStep === "handoff",
    "the park routes to handoff, so the operator gets a comment",
  );
  const notes = (gate.ended?.eventLog ?? []).filter((e) => e.kind === "plumb-report");
  const text = notes.map((e) => (e.kind === "plumb-report" ? e.body : "")).join("\n");
  assert(text.includes("#10"), "the park names WHICH issue was closed");
  assert(
    text.includes("was not run") && text.includes("no further child"),
    "the park states nothing was dispatched",
  );
}

// ── 2. every group member is read ──────────────────────────────────────────
{
  // The exact case checkAttentionLabel was originally written wrong on.
  const { forge, calls } = mkForge({ 10: "OPEN", 11: "CLOSED" });
  const gate = await endIfIssueClosed(mkCtx([10, 11]), mkState(10, [10, 11]), "explore", {
    forge,
  });
  assert(!!gate.ended, "a CLOSED non-primary member ends a grouped cycle");
  assert(calls.length === 2 && calls.includes(11), "every member of the group is read");
  const note = (gate.ended?.eventLog ?? []).find((e) => e.kind === "plumb-report");
  assert(
    note?.kind === "plumb-report" && note.body.includes("of 2"),
    "the handoff says the closed issue was one of a group",
  );
}
{
  const { forge, calls } = mkForge({ 10: "OPEN", 11: "OPEN" });
  const gate = await endIfIssueClosed(mkCtx([10, 11]), mkState(10, [10, 11]), "plan", { forge });
  assert(!gate.ended, "an all-OPEN group proceeds");
  assert(calls.length === 2, "both members were read, not just the primary");
}

// ── 2b. GROUP POLICY: any CLOSED member aborts the WHOLE group ───────────
// The ticket's HIGH gap left this undecided: drop the closed member and
// continue, or abort. Committed: abort. `droppedIssues` is explore's per-issue
// body verdict, not a closed-issue channel — reusing it would let #10's work
// land on one PR/review that also carries #11's already-paid-for work.
{
  const { forge } = mkForge({ 10: "OPEN", 11: "CLOSED", 12: "OPEN" });
  const gate = await endIfIssueClosed(
    mkCtx([10, 11, 12]),
    mkState(10, [10, 11, 12]),
    "develop",
    { forge },
  );
  assert(!!gate.ended, "a CLOSED member aborts the whole group, not just itself");
  const ps = gate.ended?.pipelineState;
  assert(
    ps?.droppedIssues === undefined,
    "the closed member is NOT recorded in droppedIssues (that is explore's verdict channel)",
  );
  assert(
    ps?.activeIssues === undefined || ps.activeIssues.length === 3,
    "activeIssues is not narrowed — the group is not silently continued without #11",
  );
}

// ── 3. fail OPEN: unreadable never ends a cycle ────────────────────────────
{
  const { forge } = mkForge({ 10: new Error("gh: could not reach api.github.com") });
  const ctx = mkCtx([10]);
  const gate = await endIfIssueClosed(ctx, mkState(10, [10]), "develop", { forge });
  assert(!gate.ended, "an UNREADABLE issue state never ends the cycle (fail open)");
  const notes = (gate.state.eventLog ?? []).filter((e) => e.kind === "plumb-report");
  assert(notes.length === 1, "the unreadable read is DISCLOSED, not silently approved");
  assert(
    notes[0]?.kind === "plumb-report" && notes[0].role === "issue-gate",
    "the note is attributed to the issue gate, so it is not read as a verify failure",
  );
}
{
  // A second gate in the same cycle must not re-pay the backoff or re-note.
  const { forge } = mkForge({ 10: new Error("gh down") });
  const ctx = mkCtx([10]);
  await endIfIssueClosed(ctx, mkState(10, [10]), "develop", { forge });
  const second = await endIfIssueClosed(ctx, mkState(10, [10]), "ci", { forge });
  assert(!second.ended, "a second unreadable gate still does not end the cycle");
  const t0 = Date.now();
  await endIfIssueClosed(ctx, mkState(10, [10]), "lens-review", { forge });
  assert(Date.now() - t0 < 400, "later gates skip the retry backoff (once per cycle)");
}

// ── 4. the retry budget is this gate's own ─────────────────────────────────
{
  // Two gates, one WeakSet each: a cycle whose PR read was unreadable must
  // still get its full issue-state backoff. Shared state here would silently
  // disable one gate's retries because of the other's failure.
  const { forge } = mkForge({ 10: new Error("gh down") });
  const ctx = mkCtx([10]);
  const t0 = Date.now();
  await endIfIssueClosed(ctx, mkState(10, [10]), "explore", { forge });
  const firstMs = Date.now() - t0;
  assert(firstMs >= 500, "the first unreadable read pays its own backoff (500ms+)");
  const { forge: f2 } = mkForge({ 10: "CLOSED" });
  const g2 = await endIfIssueClosed(ctx, mkState(10, [10]), "develop", { forge: f2 });
  assert(!!g2.ended, "a prior unreadable issue read does not blind the gate later");
}

// ── 5. the park's shape: handoff, no verifyEvidence, label SKIPPED ─────────
{
  const parked = issueClosedPark(mkState(10, [10]), 10, "develop", 1);
  const ps = parked.pipelineState;
  assert(
    ps.verifyEvidence === undefined,
    "the park writes NO verifyEvidence (VerifyEvidenceOrigin is about PRs)",
  );
  assert(ps.handoffLabelSkipped === true, "the park records the label as deliberately declined");
  assert(ps.currentStep === "handoff", "the park sits at handoff so the renderer runs");
  const cap = parked.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "issue-closed:develop",
    "the cap literal is recorded for /work-status and the queue",
  );
}

// ── 6. entry read answers BOTH questions in one view per issue ─────────────
{
  const { forge, calls } = mkForge({ 10: "OPEN", 11: "CLOSED" });
  const r = await checkIssueStatesAtEntry(mkCtx([10, 11]), { forge });
  assert(r.closed?.issue === 11, "entry detects the CLOSED member before any dispatch");
  assert(calls.length === 2, "entry makes one read per issue, not two per concern");
  assert(r.checked === true, "a fully readable group reports checked: true");
}
{
  const { forge } = mkForge({ 10: new Error("gh down") });
  const r = await checkIssueStatesAtEntry(mkCtx([10]), { forge });
  assert(!r.closed, "entry never refuses on an unreadable read");
  assert(r.checked === false, "and it discloses that the check did not run");
}

// ── 7. --restart is NOT an override for a CLOSED issue ─────────────────────
{
  // The label check short-circuits on restart (an operator "revised the issue");
  // a CLOSED issue must keep refusing, or `--restart` becomes a way to run work
  // a person explicitly closed.
  const { forge } = mkForge({ 10: "CLOSED" });
  const r = await checkIssueStatesAtEntry(mkCtx([10]), { forge, restart: true });
  assert(r.closed?.issue === 10, "--restart does not override a CLOSED issue");
}

console.log(exit === 0 ? "\nAll #1472 closed-issue gate checks passed." : "\nFAILED");
process.exit(exit);
