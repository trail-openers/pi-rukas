import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jobStatusSnapshot } from "../src/async-jobs.ts";
import type { Forge } from "../src/forge.ts";
import { setPlanVipuneSearch } from "../src/plan-draft.ts";
/**
 * plan-test-stubs — the shared /plan pipeline test-seam stubs.
 *
 * makeDispatchStub + installForgeStub were duplicated verbatim across the
 * gap-gate test files (test-plan-gap-gate-rounds.ts and
 * test-plan-gap-writeback.ts — the latter's header even says "copied
 * verbatim"). A single copy lives here; both tests import it. If the
 * dispatch/forge shapes evolve, update the stub ONCE.
 */
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { setPlanGitStateFn } from "../src/plan-investigation-cache.ts";
import type { RegisteredPlanTool } from "../src/plan-tool.ts";
import type { PlanDriverInput, PlanResult } from "../src/plan-types.ts";
import type { RegisteredResearchTool } from "../src/research-tool.ts";
import type { SearchResult } from "../src/vipune.ts";
import type { vipuneSearch } from "../src/vipune.ts";
import { parseReportDetails, reportBody } from "./plan-report-read.ts";

// Re-exported so a test that reads a delivered report imports one module for
// the harness and gets the reader with it (the two are always used together).
export { parseReportDetails, reportBody } from "./plan-report-read.ts";

// The #1043 cache fixtures moved to plan-cache-fixture.ts at the 500-line cap,
// but ~8 plan tests still name them on THIS module. Re-exported rather than
// rewriting every consumer — one seam, one place to look.
export * from "./plan-cache-fixture.ts";

/** The gate prompts captured by installForgeStub/makeDispatchStub callers. */
export const gatePrompts: string[] = [];

export interface ForgeStubState {
  created: { title: string; body: string; labels?: string[] }[];
  mode: "ok" | "throw" | "empty-url";
  error?: string;
  /**
   * #1377: the labels this repo "has". `null` means the stub does not implement
   * the read at all (the pre-#1377 shape every plan test stub had) — the driver
   * must treat that as "could not read", never as "these labels do not exist".
   */
  existing: string[] | null;
  /**
   * #1377: whether the read reports a page-full (possibly truncated) result.
   * A truncated read is the OTHER non-answer: the driver must halt with
   * "could not read the full label set", never answer "that label is missing".
   */
  truncated: boolean;
  /** #1377: how many times the label list was read (0 when no labels were asked for). */
  labelListCalls: number;
  /** #1377: how many times the forge was resolved in one filing (one, post-#1377). */
  resolveCalls: number;
}

export const forgeStub: ForgeStubState = {
  created: [],
  mode: "ok",
  existing: null,
  truncated: false,
  labelListCalls: 0,
  resolveCalls: 0,
};

/**
 * Install the filing stub. #1377: the create call records the labels it was
 * handed as its third argument (a stub that ignored them would pass a test for
 * a filing that silently dropped them), and `labelList` answers from
 * `forgeStub.existing` — `null` leaves the method off entirely, which is how a
 * read failure is exercised, and `truncated: true` answers with the
 * page-full-with-no-more-rows shape no CLI can distinguish from a longer list.
 */
export function installForgeStub(): void {
  forgeStub.labelListCalls = 0;
  forgeStub.resolveCalls = 0;
  const stub: Record<string, unknown> = {
    issueCreate: (title: string, body: string, opts?: { labels?: string[] }) => {
      forgeStub.created.push({ title, body, labels: opts?.labels });
      if (forgeStub.mode === "throw") {
        return Promise.reject(new Error(forgeStub.error ?? "gh: HTTP 403 (rate limit exceeded)"));
      }
      if (forgeStub.mode === "empty-url") {
        return Promise.resolve({ url: "" });
      }
      // Always the same URL: tests pin `issueUrl === .../issues/1` after a
      // single filing, and a per-call counter would break the second filing in
      // a file that files twice. The NUMBER is what #1377 reports separately,
      // and it comes from the forge's own parse of this URL.
      return Promise.resolve({
        url: "https://github.com/test/test/issues/1",
        number: 1,
      });
    },
  };
  if (forgeStub.existing !== null) {
    const existing = forgeStub.existing;
    const truncated = forgeStub.truncated;
    stub.labelList = () => {
      forgeStub.labelListCalls++;
      return Promise.resolve({ names: existing, truncated });
    };
  }
  // #1377: ONE resolve per filing — the gate and the create call are handed the
  // same object, so a second call is a second `detectForge` read (or, with a
  // stub, a second chance for the two halves to disagree).
  setPlanForge(() => {
    forgeStub.resolveCalls++;
    return Promise.resolve(stub as unknown as Forge);
  });
}

/**
 * Build a dispatch stub: gap-gate (adversarial-developer) replies are fed
 * from `gateReply` (a string or per-round array); the DUPLICATE RISK CHECK
 * explore returns a none verdict; every other explore (the Phase-2 angles)
 * returns one structured report_plan_item call.
 */
export function makeDispatchStub(gateReply: string | string[]) {
  const replies = Array.isArray(gateReply) ? gateReply : [gateReply];
  let gateIteration = 0;
  return ((pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      const text = replies[gateIteration] ?? replies[replies.length - 1] ?? "";
      gateIteration++;
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none — no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
      ms: 1,
      exitCode: 0,
    } as never);
  }) as never;
}

export { setPlanDispatch };

/**
 * Install an OFFLINE vipune-search stub so a test that drives the full
 * /plan pipeline (runPlanPipeline) never reaches the real vipune binary.
 *
 * The pipeline's Phase-1 inventory runs TWO concurrent vipune searches per
 * call (semantic + hybrid legs) through the injectable seam. A pipeline test
 * that runs the driver 3-4 times therefore issues 6-8 real vipune invocations
 * — each a ~5-7 s process spawn on a loaded dev host (the offline gate runs
 * them back-to-back) — while asserting nothing about memory content. That is
 * the dominant source of the local gate's 25-40 min runtime (vs ~7 min in CI,
 * where the binary is fast). Pointing the seam at an empty result keeps the
 * pipeline fully offline and its output byte-deterministic (the vipune rows
 * are the "droppable tail" of the inventory; no pipeline assertion reads
 * them). Pair with installForgeStub() so the related-issues leg is stubbed too,
 * and with installNoPlanCacheStub() so the per-clone investigation cache is off.
 */
export function installOfflineVipuneStub(): void {
  setPlanVipuneSearch(async () => ({ kind: "hits", hits: [] }));
}

/**
 * #1043: disable the per-clone investigation cache. Without this a dry run in one
 * test file leaves an entry in the REAL `.git/pi-plan-cache`, and a later confirm
 * in another file would file that spec verbatim and skip its gate. Every test
 * that calls runPlanPipeline / invokePlanTool installs it explicitly. A test that
 * exercises the cache calls newPlanCache() instead.
 */
export function installNoPlanCacheStub(): void {
  setPlanGitStateFn(async () => undefined);
}

/**
 * The vipune-search stub seam (#858): routes the plan inventory's semantic +
 * hybrid legs through the driver's `setPlanVipuneSearch` DI seam. The
 * stub receives the full (query, opts) pair so tests can distinguish the
 * hybrid leg (opts.hybrid) from the semantic leg, and returns the same
 * SearchResult shape the real seam does. Pass `null` to restore the real
 * vipuneSearch.
 */
export function setPlanVipuneStub(
  fn: ((q: string, o: { hybrid?: boolean }) => Promise<SearchResult>) | null,
): void {
  if (fn === null) {
    setPlanVipuneSearch(null);
    return;
  }
  // The partial signature is safe: the inventory calls vipuneSearch with
  // (terms, searchOpts) only — no other shape ever reaches this seam.
  setPlanVipuneSearch(((q: string, o: { cwd: string }) =>
    fn(q, { hybrid: o.hybrid })) as unknown as typeof vipuneSearch);
}

/**
 * The dry-run harness shared by the pipeline e2e tests (#858 blocks moved
 * from test-plan-tool.ts along the 500-line seam). `calls` records each
 * dispatch as `role:prompt-head` so phase-ordering assertions can check
 * what ran; `gatePrompts` (above) captures the gap-gate prompts.
 */
export const calls: string[] = [];

/**
 * The one host capability a launched job needs: receive its steer. Every
 * report-delivering tool hands its job to the `pi` it was REGISTERED on, so a
 * test's `fakePi` must answer `sendUserMessage` as well as `registerTool` —
 * build it with `{ registerTool, ...makeJobDeliverer() }`. A stub with only
 * `registerTool` gets the delivery WARN'd away by `deliverReport` and the
 * harness waits on a report that never arrives.
 */
export interface JobDeliverer {
  sendUserMessage(content: string, options?: { deliverAs?: string }): void;
}

/**
 * The steer inbox the launched jobs deliver to, shared by the harness below
 * and by test-plan-research-async.ts. `waitForJobReport` reads it; a test
 * drains it (or passes its own array to `makeJobDeliverer`) when it needs to
 * distinguish two runs' reports.
 */
export const jobSteerInbox: Array<{ content: string; deliverAs?: string }> = [];

/**
 * Jobs whose registry entry has disappeared. `jobs.delete()` runs at the TOP of
 * the settle path (`async-jobs.ts`), and delivery happens after it — so a tick
 * landing in that gap sees a settled job with no report yet. Absence is
 * therefore NOT proof of a broken delivery; what `waitForJobReport` fails fast
 * on is a registry that stayed empty for a full second after the job vanished,
 * which is the shape of a run that finished its dispatches and never produced a
 * report.
 */
function runningJobIds(): string[] {
  return jobStatusSnapshot().map((j) => j.jobId);
}

export function makeJobDeliverer(
  inbox: Array<{ content: string; deliverAs?: string }> = jobSteerInbox,
): JobDeliverer {
  return {
    sendUserMessage(content: string, options?: { deliverAs?: string }) {
      inbox.push({
        content: typeof content === "string" ? content : JSON.stringify(content),
        deliverAs: options?.deliverAs,
      });
    },
  };
}

/** Either compiled driver tool def — the harness drives both identically. */
export type RegisteredDriverTool = RegisteredPlanTool | RegisteredResearchTool;

/** The tool's launch return — the only thing `execute()` gives back since #1044. */
export interface PlanLaunchReturn {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

/**
 * Drive one `start_plan_driver` call to its END and hand back what the PM
 * actually sees: the launch return from `execute()` plus the steer the job
 * eventually delivers.
 *
 * Before #1044 this helper read `content[0].text` and every dry-run e2e block
 * asserted the spec there. That text is now a launch notice — the pipeline
 * runs in a background job and its rendered result is the steer body, so
 * `text` here IS that body (the job report with the `[ensemble:async]` header
 * stripped). A test that wants the launch notice reads `launch` instead.
 *
 * A call the tool REFUSES before it launches — an empty descriptor, an invalid
 * label or provenance (#1377), or the registry being at its MAX_JOBS cap
 * (#1541) — has no job and therefore no steer: the refusal is the tool's own
 * return, so it is what `text` carries. `started` distinguishes the two paths.
 */
export async function invokePlanToolFull(
  tools: RegisteredDriverTool[],
  params: Record<string, unknown>,
): Promise<{
  text: string;
  details: Record<string, unknown>;
  launch: PlanLaunchReturn;
  jobId: string;
  report: string;
}> {
  const t = tools.find((x) => x.name === "start_plan_driver" || x.name === "start_research_driver");
  if (!t) throw new Error("no compiled driver tool is registered");
  calls.length = 0;
  gatePrompts.length = 0;
  // Only this call's own deliveries are in scope: without draining, the next
  // invoke would read the PREVIOUS run's report (both carry a jobId, and the
  // assertion would pass on stale bytes).
  jobSteerInbox.length = 0;
  // #1044: the pipeline now runs inside a job, and the job's report reaches
  // the `pi` the tool was REGISTERED on. A harness whose fakePi implements
  // only `registerTool` would have that delivery WARN'd away by
  // deliverReport, so the harness hands the tool a context that also answers
  // sendUserMessage into the inbox `waitForJobReport` reads.
  const launch = (await t.execute("id", params, undefined, undefined, {
    cwd: process.cwd(),
    ...makeJobDeliverer(),
  })) as unknown as PlanLaunchReturn;
  const jobId = String(launch.details?.jobId ?? "");
  if (!jobId) {
    // Refused pre-launch: no job, no steer, the tool's own text is the result.
    return {
      text: launch.content?.[0]?.text ?? "",
      details: launch.details ?? {},
      launch,
      jobId: "",
      report: "",
    };
  }
  const report = await waitForJobReport(jobId, jobSteerInbox);
  return {
    text: reportBody(report),
    details: parseReportDetails(report, params),
    launch,
    jobId,
    report,
  };
}

/**
 * The compatibility shim the pre-#1044 blocks keep calling: same contract,
 * `{ text, details }` is now read out of the delivered steer.
 */
export async function invokePlanTool(
  tools: RegisteredPlanTool[],
  params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const { text, details } = await invokePlanToolFull(tools, params);
  return { text, details };
}

/**
 * Poll until the job's report has reached the stub inbox (600 × 10 ms — the
 * plan pipeline runs dozens of stubbed dispatches before it reports). A job
 * that settled WITHOUT delivering throws immediately: that is a broken
 * delivery, and a slow suite is a different problem from a silent one.
 */
export async function waitForJobReport(
  jobId: string,
  inbox: Array<{ content: string }> = jobSteerInbox,
): Promise<string> {
  for (let i = 0; i < 600; i++) {
    const hit = inbox.find((m) => m.content.includes(`(job ${jobId})`));
    if (hit) return hit.content;
    const running = runningJobIds();
    // Nothing in flight and nothing left to deliver it: the job is gone from
    // the registry, and a full second of an empty one is far more than the
    // synchronous delivery that follows the delete needs.
    if (running.length === 0 && i > 100) {
      throw new Error(`job ${jobId} settled without delivering a report`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no [ensemble:async] report delivered for job ${jobId}`);
}
