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
import { setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import type { RegisteredPlanTool } from "../src/plan-tool.ts";
import type { SearchResult } from "../src/vipune.ts";
import { vipuneSearch } from "../src/vipune.ts";

/** The gate prompts captured by installForgeStub/makeDispatchStub callers. */
export const gatePrompts: string[] = [];

export interface ForgeStubState {
  created: { title: string; body: string }[];
  mode: "ok" | "throw" | "empty-url";
  error?: string;
}

export const forgeStub: ForgeStubState = { created: [], mode: "ok" };

export function installForgeStub(): void {
  const stub = {
    issueCreate: (title: string, body: string) => {
      forgeStub.created.push({ title, body });
      if (forgeStub.mode === "throw") {
        return Promise.reject(new Error(forgeStub.error ?? "gh: HTTP 403 (rate limit exceeded)"));
      }
      if (forgeStub.mode === "empty-url") {
        return Promise.resolve({ url: "" });
      }
      return Promise.resolve({ url: "https://github.com/test/test/issues/1" });
    },
  } as unknown as Forge;
  setPlanForge(() => Promise.resolve(stub));
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
  setPlanVipuneSearch(((q: string, o: { cwd: string }) => fn(q, { hybrid: o.hybrid })) as unknown as typeof vipuneSearch);
}

/**
 * The dry-run harness shared by the pipeline e2e tests (#858 blocks moved
 * from test-plan-tool.ts along the 500-line seam). `calls` records each
 * dispatch as `role:prompt-head` so phase-ordering assertions can check
 * what ran; `gatePrompts` (above) captures the gap-gate prompts.
 */
export const calls: string[] = [];

export async function invokePlanTool(
  tools: RegisteredPlanTool[],
  params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const t = tools.find((x) => x.name === "start_plan_driver");
  if (!t) throw new Error("start_plan_driver not registered");
  calls.length = 0;
  gatePrompts.length = 0;
  const out = (await t.execute("id", params, undefined, undefined, { cwd: process.cwd() })) as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
  return { text: out.content[0]?.text ?? "", details: out.details ?? {} };
}
