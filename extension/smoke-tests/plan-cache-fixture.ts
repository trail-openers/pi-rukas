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
