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
import type { Forge } from "../src/forge.ts";

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
