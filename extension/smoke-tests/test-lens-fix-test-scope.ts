#!/usr/bin/env bun
/**
 * #1156 — the LENS-FIX developer carries the same test-scope rule the develop
 * prompt carries.
 *
 * `inlineLensFixPrompt` is the prompt a developer gets when it is sent back to
 * address six-pass review findings in the same worktree. It is the same child,
 * the same tree, and the same local gates to re-run — and it carried none of
 * the rule. So the developer that WROTE the change was told to run only the
 * smoke tests for the files it touched, and the developer that FIXED it after
 * review ran the whole offline suite to re-check a two-line change. The cost
 * the develop prompt's rule exists to remove was paid on the second dispatch
 * instead of the first.
 *
 * Separate file from `test-develop-prompt-scope.ts` because that file plus the
 * shared lib carry the develop-prompt surface, and `work-driver-prompts-late.ts`
 * sits at the 500-line cap (AGENTS.md §12) — the assertions live in the shared
 * lib and this file is the lens-fix caller.
 */

import { inlineLensFixPrompt } from "../src/work-driver-lens-fix.ts";
import { assertLensFixPromptTestScope } from "./lib/developer-test-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FINDINGS =
  '[{"path":"extension/src/x.ts","line":1,"severity":"MEDIUM","title":"t","suggestion":"s"}]';

// Rendered lazily via the assertion helper so the watchdog guard pins the env
// the prompt is BUILT with, not only the env it is compared against — an
// ambient PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS would otherwise move the
// derived bound out from under the `timeout <n>` the prompt carries.
assertLensFixPromptTestScope(assert, () => inlineLensFixPrompt(FINDINGS, "/tmp/scratch"));

// Non-vacuity: the prompt is the real one, not an empty string that would make
// every `includes` above pass on a degenerate value.
{
  const prompt = inlineLensFixPrompt(FINDINGS, "/tmp/scratch");
  assert(
    prompt.includes("six-pass review findings") && prompt.includes("/tmp/scratch"),
    "non-vacuity: the lens-fix prompt is the real dispatch prompt (findings + scratch dir present)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
