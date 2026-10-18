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
 * 2c. A driver report whose FORMATTER throws still produces the same stand-in
 *    (#1541 review round 4, HIGH). The branch used to call `deliver(build())`
 *    itself, outside any try, so a throw from `formatDriverReport` escaped the
 *    whole job with no stand-in — the MEDIUM fix read the boolean and in doing
 *    so moved the build call further out of the guarded path.
 * 3. A tool call at the registry's MAX_JOBS cap is a NAMED refusal with
 *    `started: false`, not a throw out of the tool.
 */

import { clearJobsForTesting, driverReportStandIn, startJob } from "../src/async-jobs.ts";
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

  // ------------------------------ 2b. the driver stand-in says DELIVERY failed, not RUN failed
  // #1541 review (HIGH). The run COMPLETED here — `work` settled and its
  // rendered text was built. Only the hand-over failed. The generic job stand-in
  // says `FAILED` and "its result is lost; re-dispatch", and for a plan that is
  // actively harmful: an operator following it re-runs a pipeline that already
  // drafted — and on a filing run already FILED — its spec. So this asserts the
  // words, because the words are what the operator acts on.
  {
    const refused = driverReportStandIn(
      "job-77",
      "plan-driver",
      "add retry to dispatch",
      new Error("sendUserMessage refused the driver report"),
      "dispatch_status (this job's row), plus the run's own durable output (the research artifact under outputs/, or the filed issue URL)",
    );
    assert(
      /\[ensemble:async\]/.test(refused) && refused.includes("(job job-77)"),
      "the driver stand-in keeps the two invariants every async report has: the prefix and the jobId token",
    );
    assert(
      /\bplan-driver\b/.test(refused) && refused.includes("add retry to dispatch"),
      "it names the job AND its subject, so a concurrent pair of launches is distinguishable",
    );
    assert(
      /COMPLETED/i.test(refused) && !/\bFAILED\b/.test(refused),
      `it says the run COMPLETED and never says FAILED — the run succeeded (got: ${refused.slice(0, 90)})`,
    );
    assert(
      /could not be delivered/i.test(refused),
      "it names what actually broke: the delivery, not the run",
    );
    assert(
      refused.includes("dispatch_status") && refused.includes("artifact under outputs/"),
      "it names where to look — the caller's pointer travels into the stand-in verbatim",
    );
    assert(
      !/result is lost|re-dispatch the job/i.test(refused),
      "it does NOT tell the operator to re-dispatch — a completed plan that filed its spec must not be silently re-run",
    );
    assert(
      /dispatch_status/.test(refused) && /artifact|issue URL/i.test(refused),
      "it says WHERE to look — a caller-supplied durable location, never a bare 'it is gone'",
    );

    // And the branch is wired: a refused send on a driver job produces THIS
    // text in the session, not the generic FAILED stand-in. The host refuses
    // every send, so the stand-in is captured through a second host rather
    // than read back from the refusing one.
    const seen: string[] = [];
    const host = makeHost();
    host.pi.sendUserMessage = (content: string) => {
      seen.push(content);
    };
    const job = startJob(host.pi, {
      label: "plan: undelivered",
      role: "plan-driver",
      ownerKind: "pm",
      reportKind: "driver",
      subject: "add retry to dispatch",
      deliverForTest: () => false,
      // The run reports where IT wrote its result — the pipeline is the only
      // party that knows, and a stand-in inventing a path would be a second lie.
      work: async () => ({
        ...ok("the spec that never reached anyone"),
        reportWhere: "the filed issue https://example.test/issues/54321",
      }),
    });
    await job.completion;
    const standIn = seen.find((m) => /could not be delivered/i.test(m)) ?? "";
    assert(
      !!standIn,
      `a driver job whose send was refused lands a delivery-failure stand-in in the session (got ${seen.length} message(s))`,
    );
    assert(
      /COMPLETED/i.test(standIn) && !/\bFAILED\b/.test(standIn),
      `...and it reads as a delivery failure, not a failed run (got: ${standIn.slice(0, 100)})`,
    );
    assert(
      standIn.includes("add retry to dispatch"),
      "...and it names the run, so the operator can match it to the launch notice",
    );
    assert(
      standIn.includes("https://example.test/issues/54321"),
      "...and it names the durable location the run reported, so the operator reads it instead of re-running",
    );

    // The default when the run reported nothing: a pointer at dispatch_status,
    // never a path the run never wrote.
    const seen2: string[] = [];
    const host2 = makeHost();
    host2.pi.sendUserMessage = (content: string) => {
      seen2.push(content);
    };
    const job2 = startJob(host2.pi, {
      label: "plan: no location",
      role: "plan-driver",
      ownerKind: "pm",
      reportKind: "driver",
      subject: "a run that wrote nothing",
      deliverForTest: () => false,
      work: async () => ok("a dry run that filed nothing"),
    });
    await job2.completion;
    const standIn2 = seen2.find((m) => /could not be delivered/i.test(m)) ?? "";
    assert(
      /dispatch_status/i.test(standIn2) && !/\/nonexistent\//.test(standIn2),
      `with nothing reported by the run it falls back to dispatch_status and invents no path (got: ${standIn2.slice(-120)})`,
    );
  }

  // ----------------------------------- 2c. a THROW from the formatter still delivers a stand-in
  // #1541 review round 4 (HIGH). The OTHER half of the same contract, and the half
  // the MEDIUM fix removed: the branch read `deliverReport`'s boolean by calling
  // `deliver(build())` itself, so `build()` ran outside any try and a throw from the
  // formatter escaped the settle with the promised steer stranded and no stand-in at
  // all. Both failure modes now route through `deliverOrStandIn`, which catches the
  // build AND reads the boolean.
  //
  // The throw is reached for real, not stubbed: `formatDriverReport` dereferences
  // `text.trim()`, so a result carrying a `text` that is neither a string nor
  // nullish throws at render time — exactly what a work function returning a
  // malformed pipeline result produces.
  {
    const seen: string[] = [];
    const host = makeHost();
    host.pi.sendUserMessage = (content: string) => {
      seen.push(content);
    };
    let rejected = false;
    const job = startJob(host.pi, {
      label: "plan: formatter threw",
      role: "plan-driver",
      ownerKind: "pm",
      reportKind: "driver",
      subject: "a spec whose renderer blew up",
      work: async () => ({ ...ok(), text: 42 as unknown as string }),
    });
    await job.completion.catch(() => {
      rejected = true;
    });
    // The job still settled: an escaping throw would reject `completion`, handing
    // the caller an exception instead of the report it was promised.
    assert(!rejected, "a formatter throw does NOT reject the job — the settle survives it");
    const standIn = seen.find((m) => /could not be delivered/i.test(m)) ?? "";
    assert(
      !!standIn,
      `a driver job whose formatter THREW still lands a stand-in in the session (got ${seen.length} message(s): ${JSON.stringify(seen.map((s) => s.slice(0, 30)))})`,
    );
    assert(
      /\[ensemble:async\]/.test(standIn),
      `the stand-in carries the \`[ensemble:async]\` prefix a client correlates on (got: ${standIn.slice(0, 60)})`,
    );
    assert(
      /\(job [a-z0-9]+-[a-z0-9]+\)/.test(standIn),
      `the stand-in carries the \`(job <id>)\` token so the operator can match it to the launch notice (got: ${standIn.slice(0, 90)})`,
    );
    assert(
      /COMPLETED/i.test(standIn) && !/\bFAILED\b/.test(standIn),
      `it still says COMPLETED — the run settled, only the render failed (got: ${standIn.slice(0, 100)})`,
    );
    assert(
      /is not a function/.test(standIn),
      "it names the formatter's own error, so the operator can tell a render bug from a refused send",
    );
    assert(
      seen.length === 1,
      `exactly one message reached the host — no half-rendered report alongside the stand-in (got ${seen.length})`,
    );
  }

  // ------------------------------ 2d. the stand-in clamps and flattens what it interpolates
  // #1541 review round 4: the stand-in is a STEER — it lands in the PM's context and
  // then in the next model turn. `formatFailReport` already clamps its error
  // (`(err.message ?? "").slice(-200)`); this one interpolated `String(err)`
  // verbatim, so a formatter that threw on a report-sized string put that whole
  // string, newlines and all, back in front of the model that has to recover.
  {
    const hostile = new Error(`trim failed:\n${"x".repeat(400)}\n...and a trailing line`);
    const long = driverReportStandIn(
      "job-88",
      "plan-driver",
      "clamp me",
      hostile,
      "dispatch_status (this job's row)",
    );
    const afterColon = long.slice(long.indexOf("could not be delivered: ") + 24);
    const errTail = afterColon.slice(0, afterColon.indexOf(". The run is not lost"));
    assert(
      !errTail.includes("\n"),
      `newlines in the error are flattened so the stand-in stays one report, not a multi-paragraph dump (got ${errTail.split("\n").length} line(s))`,
    );
    assert(
      errTail.length <= 200,
      `the interpolated error is clamped to 200 chars the way formatFailReport clamps its tail (got ${errTail.length})`,
    );
    assert(
      long.includes("[ensemble:async]") && long.includes("(job job-88)") && /COMPLETED/i.test(long),
      "clamping does not cost the stand-in its own invariants — prefix, jobId token and COMPLETED all survive",
    );
    assert(
      long.includes("dispatch_status"),
      "and the caller's `where` pointer is NOT clamped — it is what the operator acts on",
    );
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
