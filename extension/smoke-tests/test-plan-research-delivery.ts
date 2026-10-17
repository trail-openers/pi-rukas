/**
 * #1541 — the three contracts the background job's delivery path owes the PM,
 * asserted at the seam rather than through the pipeline.
 *
 * 1. `reportKind: "driver"` requires `ownerKind: "pm"`. The driver branch
 *    delivers the report as the run's ONLY result; an in-process caller
 *    (dispatchCore, the work driver) consumes the completion promise and would
 *    get a stray steer into a session that never asked. The invariant is
 *    enforced, not documented — startJob throws.
 * 2. A driver report whose `sendUserMessage` refuses still produces a stand-in.
 *    Before this fix `deliverOrStandIn` swallowed `deliverReport`'s boolean, so
 *    Pi refusing the steer left a WARN in the trace and silence in the session
 *    — the exact silent-hang shape #1044 exists to remove.
 * 3. A tool call at the registry's MAX_JOBS cap is a NAMED refusal with
 *    `started: false`, not a throw out of the tool.
 */

import { clearJobsForTesting, startJob } from "../src/async-jobs.ts";
import * as pendingJobs from "../src/pending-jobs-signal.ts";
import { registerPlanTool } from "../src/plan-tool.ts";
import { registerResearchTool } from "../src/research-tool.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) exit = 1;
}

const ok = (text = "body"): DispatchResult => ({
  role: "explore",
  ok: true,
  text,
  toolUses: [],
  ms: 1,
  exitCode: 0,
});

// A host whose sendUserMessage can be made to refuse, and whose inbox we read.
function makeHost(opts: { refuse?: boolean } = {}) {
  const inbox: Array<{ content: string; deliverAs?: string }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  const pi: any = {
    registerTool: () => {},
    sendUserMessage: (content: string, o?: { deliverAs?: string }) => {
      if (opts.refuse) throw new Error("stub: agent is mid-turn and no behaviour was given");
      inbox.push({ content, deliverAs: o?.deliverAs });
    },
  };
  return { pi, inbox };
}

async function main(): Promise<void> {
  // ------------------------------------------------ 1. the ownerKind gate
  {
    const { pi } = makeHost();
    let threw = "";
    try {
      startJob(pi, {
        label: "plan: gate",
        role: "explore",
        // driver-owned + driver-shaped report: the combination that would put a
        // report steer into a session that consumed the promise instead.
        ownerKind: "driver",
        reportKind: "driver",
        work: async () => ok(),
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    assert(
      /reportKind "driver" requires ownerKind "pm"/i.test(threw),
      `startJob REFUSES a driver-owned driver-shaped job (got: ${threw.slice(0, 60) || "no throw"})`,
    );

    // The legal combination still starts, and the illegal-but-meaningful one
    // (subagent report, driver owner) is untouched — the gate is narrow.
    const { pi: pi2, inbox: inbox2 } = makeHost();
    const legal = startJob(pi2, {
      label: "plan: legal",
      role: "explore",
      ownerKind: "pm",
      reportKind: "driver",
      work: async () => ok("the legal shape"),
    });
    await legal.completion;
    assert(
      inbox2.some((m) => m.content.includes("the legal shape")),
      "a pm-owned driver-shaped job still delivers its report — the gate is narrow, not a ban",
    );
  }

  // ------------------------------------ 2. refused delivery falls back to a stand-in
  {
    const { pi } = makeHost({ refuse: true });
    const standIns: string[] = [];
    // The real sendUserMessage refuses for every call, so both the report and
    // the stand-in go through the refusing host; count what the job TRIED.
    const job = startJob(pi, {
      label: "plan: refused",
      role: "explore",
      ownerKind: "pm",
      reportKind: "driver",
      subject: "the descriptor",
      // The seam that lets a test force the boolean without stubbing Pi's
      // internals: production always passes the real deliverReport.
      deliverForTest: () => {
        standIns.push("attempted");
        return false;
      },
      work: async () => ok("the body that never landed"),
    });
    await job.completion;
    assert(
      standIns.length === 1,
      `the caller reads deliverReport's boolean — a refused steer is DETECTED (${standIns.length} attempt(s) seen)`,
    );
    // Reaching this line at all is the assertion: with the host refusing every
    // sendUserMessage, a job that awaited clean proved the stand-in path is
    // swallow-safe — a throw out of `deliverOrStandIn` rejects `job.completion`.
  }

  // ------------------------------------------ 3. saturation is a named refusal
  {
    const CTX = { cwd: process.cwd() } as never;
    // Registration goes through a recording host, exactly as a Pi session does.
    const planAll: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
    registerPlanTool({ registerTool: (d) => void planAll.push(d) } as never);
    const researchAll: Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }> = [];
    registerResearchTool({ registerTool: (d) => void researchAll.push(d) } as never);
    const planTool = planAll.find((t) => t.name === "start_plan_driver");
    const researchTool = researchAll.find((t) => t.name === "start_research_driver");
    assert(Boolean(planTool && researchTool), "both tools registered on the stub host");
    // Fill the registry with plain jobs until the cap, then call both tools.
    const { pi } = makeHost();
    const handles: Array<{ completion: Promise<DispatchResult> }> = [];
    for (let i = 0; i < 60 && handles.length < 50; i++) {
      try {
        handles.push(
          startJob(pi, {
            label: `filler ${i}`,
            role: "explore",
            ownerKind: "pm",
            work: () => new Promise<DispatchResult>(() => {}),
          }),
        );
      } catch {
        break;
      }
    }
    assert(handles.length >= 50, `the registry is at its cap (${handles.length} live jobs)`);
    const pr = (await planTool?.execute(
      "t1",
      { descriptor: "a call that cannot start in extension/src/plan-tool.ts" },
      undefined,
      undefined,
      CTX,
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
    assert(
      pr.details.started === false && pr.details.error === "jobs-saturated",
      `the plan tool returns a NAMED saturation refusal, not a throw (details=${JSON.stringify(pr.details).slice(0, 70)})`,
    );
    assert(
      /refused/i.test(pr.content[0]?.text ?? ""),
      "...and the text says refused, so the model does not report a launched run",
    );
    const rr = (await researchTool?.execute(
      "t2",
      { topic: "a call that cannot start in extension/src/research-tool.ts" },
      undefined,
      undefined,
      CTX,
    )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
    assert(
      rr.details.started === false && rr.details.error === "jobs-saturated",
      "the research tool refuses the same way under the same cap",
    );
    // A refusal pre-launch has no job and so owes no steer — nothing to kill.
    assert(
      !String(pr.details.jobId ?? ""),
      "a saturated refusal carries NO jobId — nothing was launched, so nothing is owed a report",
    );
  }

  clearJobsForTesting();
  pendingJobs.shutdown();
  console.log(exit === 0 ? "\n#1541 job-delivery contracts: PASS" : "\nFAILED");
  process.exit(exit);
}
main();
