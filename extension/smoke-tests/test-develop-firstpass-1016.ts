/**
 * #1016 — a workstream that fails its FIRST pass is reported to the caller even
 * when the retry recovers it: the topological step keeps its dependents skipped.
 * Split out of test-develop-greens-1016.ts to keep that file under the 500-line gate.
 */
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

// #1016 — a workstream that fails its FIRST pass is reported to the caller even
// when the retry recovers it: the topological step keeps its dependents skipped.
{
  const { runIndependentFanout } = await import("../src/work-develop-retry.ts");
  const firstPassFailed = new Set<string>();
  const tries: Record<string, number> = {};
  const out = await runIndependentFanout({
    independent: ["x", "y"],
    preserved: new Set(),
    skip: [],
    verdicts: [],
    multi: true,
    resetFor: async () => ({ attempt: 1 }),
    runAt: async (id) => {
      tries[id] = (tries[id] ?? 0) + 1;
      return { id, ok: id !== "x" || tries[id] > 1 };
    },
    firstPassFailed,
  });
  assert(
    [...firstPassFailed].join() === "x" && out.every((v) => v.ok),
    "#1016: x failed its first pass (reported) and recovered on retry (ok); y never failed",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
