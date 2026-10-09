#!/usr/bin/env bun
/**
 * A fix must be written where the driver will look for it.
 *
 * `runSingleDispatch` built a spec of `{ role, prompt }` with no `cwd`, and
 * `spawn.ts` falls back to the Pi process's own directory — so the lens-fix
 * developer edited the repo ROOT while `integrateLensFix` staged from the
 * WORKTREE nobody had touched. `stagePorcelainPaths` returned 0, the loop
 * `continue`d, and the fix was silently dropped. The next lens round then
 * re-read an unchanged branch and re-flagged the same findings at escalating
 * severity until the round cap fired.
 *
 * Observed live on nessie #663. The pushed commit had deleted 1007 lines of
 * `src/config/mod.rs` — the whole config module root — so CI could not compile.
 * The lens-fix developer diagnosed it and restored the files correctly: 1174
 * lines, staged in the index. None of it was ever committed or pushed, because
 * the driver was staging somewhere else. The PR sat broken while the fix sat on
 * disk.
 *
 * Of `runSingleDispatch`'s consumers only lens-fix was wrong: `branch`, `ci`,
 * `merged`, `step-back` and `commit-pr` legitimately act at the integration
 * point.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const read = (f: string) =>
  readFileSync(path.join(SRC, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

// ------------------------------------------- the dispatch can carry a cwd

{
  const merged = read("work-driver-merged.ts");
  assert(
    /opts\?:\s*\{[^}]*cwd\?:\s*string/.test(merged),
    "canary: runSingleDispatch accepts a cwd — it had no way to express one",
  );
  assert(
    /\{\s*role,\s*prompt:\s*buildPrompt\(\)[^}]*cwd/.test(merged),
    "canary: ...and puts it on the DispatchSpec, so spawn.ts stops falling back to process.cwd()",
  );
}

// ------------------------------------------- lens-fix uses it

{
  const lens = read("work-driver-lens.ts");
  assert(
    /lens-fix[\s\S]{0,600}cwd:\s*lensWorktree\(/.test(lens),
    "canary: the lens-fix dispatch passes a cwd — its absence silently discarded every fix",
  );
  assert(/function lensWorktree\(/.test(lens), "the worktree is resolved by one named function");
  // The review and the fix must agree, or the fix lands against a tree the
  // findings do not describe.
  const uses = lens.match(/lensWorktree\(ctx, state\)/g) ?? [];
  assert(
    uses.length >= 2,
    `canary: the review and the fix resolve the same tree (${uses.length} call sites) — they disagreed, which is the whole defect`,
  );
  // Anchor the canary on the dispatch's "lens-fix" role string / jobId, not
  // on a comment (which can be reworded without changing behaviour).
  const dispatchCall = lens.match(
    /runSingleDispatch\([\s\S]*?"lens-fix"[\s\S]*?cwd:\s*lensWorktree\(ctx, state\)/,
  );
  assert(
    dispatchCall !== null,
    "canary: the lens-fix dispatch (anchored on the 'lens-fix' role string) passes a cwd",
  );
}

// ------------------------- the steps that belong at the integration point

{
  // Only lens-fix was wrong. If a future edit adds a cwd to `merged` or `ci`,
  // that is a behaviour change worth noticing rather than a fix.
  const merged = read("work-driver-merged.ts");
  const commit = read("work-driver-commit.ts");
  for (const [name, src, label] of [
    ["merged", merged, "ops:merge"],
    ["commit-pr", commit, "ops:commit-pr"],
  ] as const) {
    const call = src.slice(src.indexOf(`"${label}"`) - 400, src.indexOf(`"${label}"`) + 400);
    assert(
      !/cwd:/.test(call),
      `${name} still dispatches at the integration point, with no cwd — it is correct there`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
