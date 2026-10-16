import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import type { SearchResult } from "../src/vipune.ts";
import type { vipuneSearch } from "../src/vipune.ts";

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

// ---------------------------------------------------------------------------
// #1043 cache tests — the fixtures shared by test-plan-confirm-reviewed.ts and
// test-plan-investigation-cache.ts (formerly copied into both).
// ---------------------------------------------------------------------------

export const DESC = "add a start_plan_driver tool for the plan pipeline in extension";
export const REPO = process.cwd();
export const GAP_HIGH =
  "GAP: HIGH — the spec omits the rollback path — proposed resolution: add a rollback section\nVERDICT: READY";
export const GAP_CRITICAL =
  "GAP: CRITICAL the spec commits to both a retry cap of 3 and an infinite retry — proposed resolution: name which wins\nVERDICT: NEEDS_ITERATION";
export const DUP_NONE = "DUPLICATE_RISK: none — no overlapping open work";

/** Dispatches seen by the counting stub: explore (duplicate-risk + angles) and gate. */
export const log = { explore: 0, gate: 0 };

/**
 * Counting dispatch for the pipeline and cache tests. `gateReply` is one reply or
 * one per gate round (the last repeats); `dupReply` is the duplicate-risk verdict.
 */
export function installCountingDispatch(gateReply: string | string[], dupReply = DUP_NONE): void {
  const replies = Array.isArray(gateReply) ? gateReply : [gateReply];
  log.explore = 0;
  log.gate = 0;
  gatePrompts.length = 0;
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    const base = { ok: true, toolUses: [], ms: 1, exitCode: 0 };
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      const text = replies[Math.min(log.gate, replies.length - 1)] ?? "";
      log.gate++;
      return Promise.resolve({ ...base, role: spec.role, text });
    }
    log.explore++;
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({ ...base, role: "explore", text: dupReply });
    }
    return Promise.resolve({
      ...base,
      role: "explore",
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
    });
  }) as never);
}

/**
 * A dispatch stub whose angles emit `perKind` oversized items per kind — the
 * shape that overflows stage 0's render budget and fits stage 1's (the
 * compaction case, same fixture as test-plan-body-budget).
 */
export function installOverflowDispatch(itemText: string, perKind = 20): void {
  const kinds = [
    "acceptance-criterion",
    "test-surface-item",
    "edge-case",
    "reference",
    "out-of-scope",
  ];
  const toolUses = kinds.flatMap((kind) =>
    Array.from({ length: perKind }, (_, i) => ({
      name: "report_plan_item",
      arguments: { kind, text: `${kind}-${i}: ${itemText}`, angle: "x" },
    })),
  );
  setPlanDispatch(((_pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      return Promise.resolve({
        role: spec.role,
        ok: true,
        text: "VERDICT: READY",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: DUP_NONE,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      });
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "prose summary",
      toolUses,
      ms: 1,
      exitCode: 0,
    });
  }) as never);
}

export function pipeline(input: Partial<PlanDriverInput> = {}): Promise<PlanResult> {
  return runPlanPipeline({} as never, { descriptor: DESC, ...input }, REPO);
}

/** The per-test cache: its directory and the HEAD the git-state stub reports. */
export const cacheState = { dir: "", keySha: "a".repeat(40) };
const tmpCacheDirs: string[] = [];

/** A fresh cache directory and HEAD, with the git-state stub pointing at them. */
export async function newPlanCache(prefix = "plan-cache-"): Promise<void> {
  cacheState.dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpCacheDirs.push(cacheState.dir);
  cacheState.keySha = "a".repeat(40);
  setPlanGitStateFn(async () => ({ keySha: cacheState.keySha, cacheDir: cacheState.dir }));
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  // #1377: reset to the pre-#1377 stub shape so a test that does not pass
  // labels never sees a label read, and one that does must opt in explicitly.
  forgeStub.existing = null;
  forgeStub.truncated = false;
  forgeStub.labelListCalls = 0;
}

/** Reset the seams and remove every cache directory a test created. */
export async function teardownPlanCache(): Promise<void> {
  setPlanGitStateFn(null);
  setPlanDispatch(null);
  for (const d of tmpCacheDirs) await rm(d, { recursive: true, force: true });
}

/** The lineage entry files (`*.json`) in the current cache directory. */
export async function cacheFiles(): Promise<string[]> {
  try {
    return (await readdir(cacheState.dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

export type RawCacheEntry = {
  createdAt: number;
  barrier: Record<string, unknown>;
  reviewed?: Record<string, unknown>;
};

/** Rewrite the current cache's first entry through `fn` (simulates a stale or hand-edited file). */
export async function mutateEntry(fn: (e: RawCacheEntry) => void): Promise<void> {
  const [f] = await cacheFiles();
  const p = path.join(cacheState.dir, f ?? "");
  const e = JSON.parse(await readFile(p, "utf8")) as RawCacheEntry;
  fn(e);
  await writeFile(p, JSON.stringify(e));
}
