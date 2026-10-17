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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { inlineLensFixPrompt, runLensFix } from "../src/work-driver-lens-fix.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  assertLensFixPromptTestScope,
  assertLensFixResendPromptTestScope,
} from "./lib/developer-test-scope.ts";

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

// ───────────────────────────────────────────────────────────────────────────
// The RE-DISPATCH branch — the inline array `runLensFix` builds when the
// previous dispatch committed nothing. It is a SECOND prompt literal, so the
// first pass of #1156 covered `inlineLensFixPrompt` and left this one without
// the rule; and the re-dispatch is the THIRD gate-run on the same tree, which
// is the shape the rule bounds most. Driven through the real `runLensFix` with
// a captured dispatch, so the assertion is on what the driver really sends
// rather than on a copy of the literal this file could keep stale.
//
// The render is `await`ed INSIDE the helper's async watchdog guard, which is
// why that helper takes an async body: `runLensFix` awaits git, so a
// synchronous body would restore the env before the prompt was built and the
// prompt would render with whatever the ambient environment holds — the exact
// desync the pin exists to prevent.
// ───────────────────────────────────────────────────────────────────────────

const RESEND_WT = "/tmp/pi-rukas-lens-fix-resend/wt";
const RESEND_BRANCH = "feature/issue-1156-resend";

/**
 * Render the RE-DISPATCH prompt by driving `runLensFix` to the resend shape.
 *
 * The resend fires when this round already carries a `lens-fix-empty-resend`
 * event (which lifts `countLensFixEmptyResends` to >= 1) AND the tree reads
 * clean with nothing committed ahead of the branch — so the stub executor
 * answers `git status --porcelain` with nothing and `git rev-list --count`
 * with 0.
 *
 * `branchName` is left EMPTY deliberately. With a branch name the #981
 * reposition gate runs before the dispatch and gates it on the worktree being
 * at the branch tip — which would make this fixture depend on git refs that do
 * not exist, and a failed gate parks WITHOUT dispatching, so the prompt would
 * never be built. With none, `fixTree !== ctx.repoRoot` still holds, the gate
 * is skipped on its own branch-name condition, and the prompt is what is
 * exercised. The gate's own behaviour is test-work-driver-lens-fix-edge-cases.
 *
 * Nothing touches disk: the repo root is a scratch directory and
 * `PI_ENSEMBLE_RESUME=0` keeps `beginDispatch` from persisting state.
 */
async function renderResendPrompt(): Promise<string> {
  const prompts: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "pi-lens-fix-resend-"));
  const prevResume = process.env.PI_ENSEMBLE_RESUME;
  process.env.PI_ENSEMBLE_RESUME = "0";
  try {
    const base = initialState(1156, 1_000_000);
    const ctx = {
      host: {} as unknown as DriverContext["host"],
      repoRoot: dir,
      issue: 1156,
      verifyExecFn: async (cmd: string) =>
        cmd.includes("rev-list") ? { stdout: "0\n" } : { stdout: "" },
      dispatchFn: async (
        _host: unknown,
        spec: { role: string; prompt: string; cwd?: string },
      ): Promise<DispatchResult> => {
        prompts.push(spec.prompt);
        return {
          role: "developer",
          ok: true,
          text: "nothing-to-fix: already resolved in the committed diff",
          toolUses: [],
          ms: 20,
          exitCode: 0,
          transcriptPath: "/tmp/pi-lens-fix-resend-stub.json",
        };
      },
    } as unknown as DriverContext;
    const s = {
      ...base,
      pipelineState: {
        ...base.pipelineState,
        currentStep: "lens-fix" as const,
        worktrees: { default: RESEND_WT },
        branchName: "",
        reviewRound: 1,
      },
      eventLog: [
        {
          kind: "lens-issues-found" as const,
          at: 1_100_000,
          jobId: "j-lens-1",
          round: 1,
          findings: FINDINGS,
          verdict: "ISSUES_FOUND" as const,
        },
        // A resend already recorded THIS round is what lifts the count to >= 1
        // and routes to the RE-DISPATCH branch rather than the normal prompt.
        {
          kind: "lens-fix-empty-resend" as const,
          at: 1_150_000,
          jobId: "j-resend-1",
          round: 1,
          worktree: RESEND_WT,
          evidence: `git status --porcelain at ${RESEND_WT} was empty; no committed fix`,
        },
      ],
    };
    await runLensFix(ctx, s, 1_200_000);
    return prompts.find((p) => p.includes("RE-DISPATCH")) ?? "";
  } finally {
    if (prevResume === undefined) delete process.env.PI_ENSEMBLE_RESUME;
    else process.env.PI_ENSEMBLE_RESUME = prevResume;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Rendered lazily so the watchdog guard inside the helper pins the env the
// prompt is BUILT with, not only the env it is compared against.
assertLensFixResendPromptTestScope(assert, renderResendPrompt);

// Non-vacuity on the same branch: the resend really is its own literal, so the
// rule asserted above is not being satisfied by the ordinary prompt the earlier
// block already covers.
{
  const resend = await renderResendPrompt();
  assert(
    resend.includes("RE-DISPATCH") &&
      resend.includes(RESEND_WT) &&
      resend.includes(FINDINGS) &&
      !resend.includes("Address the six-pass review findings"),
    "non-vacuity: the re-dispatch prompt is its own literal (worktree + findings present, the ordinary prompt's opening line absent)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
