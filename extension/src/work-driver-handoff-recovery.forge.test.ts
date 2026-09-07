/**
 * #612 — forge-agnostic recovery command strings.
 *
 * The shared decision in work-driver-handoff-recovery.ts used to hard-code
 * `gh` in every recovery line, which is the wrong CLI for a repo that lives
 * on GitLab. This module is the render-level test: for every cap that
 * carries forge-specific commands, the GitHub output must stay byte-for-byte
 * what it is today (the zero-regression path), and the GitLab output must
 * carry the glab equivalent. It exercises `recoveryStepsForCap` directly so
 * both presenters (chat + markdown, which share the decision) are covered.
 */

import { recoveryStepsForCap, requalifyLine } from "../src/work-driver-handoff-recovery.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A minimal state: one cap-hit event drives the shared decision. */
function capState(cap: string, extra: { prNumber?: number; existingPr?: unknown } = {}): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "explore",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      ...extra,
    },
    eventLog: [{ kind: "cap-hit", at: 3, cap: cap as never, reviewRound: 0, nextStep: "handoff" }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; the shared decision reads a subset
  } as any;
}

const allLines = (forge: "github" | "gitlab" | "unknown") =>
  recoveryStepsForCap(capState("awaiting-human-merge", { prNumber: 42 }), forge).steps.flatMap(
    (s) => s.lines,
  );

// ---- awaiting-human-merge: checks + open-in-browser

{
  const gh = allLines("github");
  assert(
    gh.includes("gh pr checks 42") && gh.includes("gh pr view 42 --web"),
    "github (awaiting-human-merge): byte-identical `gh pr checks` / `pr view --web` lines",
  );
  const gl = allLines("gitlab");
  assert(
    gl.includes('glab api "/projects/:id/merge_requests/42/pipelines" --output json'),
    "gitlab (awaiting-human-merge): pipelines fetch for the CI status",
  );
  assert(
    gl.includes("glab mr view 42 --web"),
    "gitlab (awaiting-human-merge): `glab mr view --web`",
  );
  assert(
    !gl.some((l) => l.startsWith("gh ")),
    "gitlab (awaiting-human-merge): no `gh` line leaks through",
  );
  assert(
    JSON.stringify(allLines("unknown")) === JSON.stringify(allLines("github")),
    "unknown forge falls back to the GitHub strings (advisory text, fail-open)",
  );
}

// ---- existing-pr-detected: view / continue / abandon / proceed

{
  const s = capState("existing-pr-detected", {
    existingPr: { number: 7, headRefName: "feature/x", matchedBy: "branch" },
  });
  const gh = recoveryStepsForCap(s, "github").steps.flatMap((st) => st.lines);
  assert(
    gh.includes("gh pr view 7 --json state,mergeable,files"),
    "github (existing-pr-detected): byte-identical `gh pr view --json` line",
  );
  assert(
    gh.includes('gh pr close 7 --comment "Superseded; restarting via /work"'),
    "github (existing-pr-detected): byte-identical `gh pr close` line",
  );
  const gl = recoveryStepsForCap(s, "gitlab").steps.flatMap((st) => st.lines);
  assert(gl.includes("glab mr view 7 --output json"), "gitlab: `glab mr view --output json`");
  assert(gl.includes("glab mr cancel 7"), "gitlab: `glab mr cancel` (GitLab's close verb)");
  // The forge-agnostic lines must be shared, not duplicated per forge.
  assert(gl.includes("git fetch origin"), "gitlab: `git fetch origin` is forge-agnostic");
  assert(gl.includes("PI_ENSEMBLE_PR_PREFLIGHT=0 pi"), "gitlab: env-override line unchanged");
}

// ---- explore-already-complete: view / close / comment

{
  const s = capState("explore-already-complete");
  const gh = recoveryStepsForCap(s, "github").steps.flatMap((st) => st.lines);
  assert(
    gh.includes("gh issue view 337"),
    "github (explore-already-complete): byte-identical `gh issue view` line",
  );
  assert(
    gh.includes(`gh issue close 337 --comment "Verified complete by /work — see prior PR"`),
    "github (explore-already-complete): byte-identical `gh issue close` line",
  );
  const gl = recoveryStepsForCap(s, "gitlab").steps.flatMap((st) => st.lines);
  assert(gl.includes("glab issue view 337"), "gitlab: `glab issue view`");
  assert(
    gl.includes(
      'glab api -f "body=Verified complete by /work — see prior PR" POST /projects/:id/issues/337/notes',
    ),
    "gitlab: comment-then-close via the notes API (glab issue close has no --comment)",
  );
  assert(gl.includes("glab issue close 337"), "gitlab: `glab issue close`");
}

// ---- explore-needs-clarification: edit

{
  const gh = recoveryStepsForCap(capState("explore-needs-clarification"), "github").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gh.includes("gh issue edit 337"),
    "github (explore-needs-clarification): byte-identical `gh issue edit` line",
  );
  const gl = recoveryStepsForCap(capState("explore-needs-clarification"), "gitlab").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gl.includes('glab issue edit 337 --description "<revised body>"'),
    "gitlab: `glab issue edit --description` (glab's non-interactive edit needs a value)",
  );
}

// ---- explore-bodies-empty: auth/version diagnostics

{
  const gh = recoveryStepsForCap(capState("explore-bodies-empty"), "github").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gh.includes("gh auth status") &&
      gh.includes("gh --version") &&
      gh.includes("gh extension list") &&
      gh.includes("gh api repos/<owner>/<repo>/issues/337 --jq .body | head"),
    "github (explore-bodies-empty): byte-identical auth/diagnostics lines",
  );
  const gl = recoveryStepsForCap(capState("explore-bodies-empty"), "gitlab").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gl.includes("glab auth status") && gl.includes("glab version"),
    "gitlab: `glab auth status` / `glab version` (glab has no --version flag)",
  );
  assert(
    gl.includes(`glab api "/projects/:id/issues/337" --output json | head`),
    "gitlab: REST probe via glab api",
  );
}

// ---- step-back-revise-spec: the /plan fallback

{
  const gh = recoveryStepsForCap(capState("step-back-revise-spec"), "github").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gh.includes("/plan 337    # or: gh issue edit 337"),
    "github (step-back-revise-spec): byte-identical `/plan … # or: gh issue edit` line",
  );
  const gl = recoveryStepsForCap(capState("step-back-revise-spec"), "gitlab").steps.flatMap(
    (st) => st.lines,
  );
  assert(
    gl.includes('/plan 337    # or: glab issue edit 337 --description "<revised body>"'),
    "gitlab: the inline fallback names glab",
  );
}

// ---- requalifyLine: the gh→glab binary rewrite (chat surface)

assert(
  requalifyLine("gh pr checks 42", "/repo", "/repo/tmp") === "gh pr checks 42",
  "requalifyLine (github default): gh lines pass through untouched",
);
assert(
  requalifyLine("gh pr checks 42", "/repo", "/repo/tmp", "gitlab") === "glab pr checks 42",
  "requalifyLine (gitlab): the binary is renamed, the rest is untouched",
);
assert(
  requalifyLine("git status", "/repo", "/repo/tmp", "gitlab") === "git -C /repo status",
  "requalifyLine (gitlab): git requalification still applies alongside the rename",
);
assert(
  requalifyLine("# then restart Pi", "/repo", "/repo/tmp", "gitlab") === "# then restart Pi",
  "requalifyLine (gitlab): comments still pass through",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
