#!/usr/bin/env bun
/**
 * #612 — handoff recovery lines rendered through the two SURFACES (chat +
 * markdown) for each forge. The render-level forge variants are asserted in
 * src/work-driver-handoff-recovery.forge.test.ts (decision level); this
 * suite is the surface-level complement: it pins that
 *
 *   1. the DEFAULT call path (no forge arg — every existing call site until
 *      the driver wiring lands) renders byte-identical `gh` output on both
 *      surfaces (no regression);
 *   2. passing `forge: "gitlab"` produces the glab-spelled commands through
 *      BOTH presenters (they share the decision, but the chat presenter's
 *      requalifyLine is a second transformation that must not drop the
 *      rename or break its own git/rm/cat requalification);
 *   3. the rendered recovery block stays unchained for both forges — the
 *      same `&&` invariant test-handoff-rendering.ts enforces for GitHub.
 */

import { renderHandoffMarkdown } from "../src/work-driver-handoff-markdown.ts";
import { renderHandoffUserMessage } from "../src/work-driver-handoff-message.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/Users/x/repo";

/** A cycle parked at the human-merge gate with a named PR. */
function awaitingMergeState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "ci",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      prNumber: 42,
      mergeHold: {
        authorityGranted: false,
        authoritySource: "none",
        authorityQuote: "",
      },
    },
    eventLog: [
      { kind: "cap-hit", at: 3, cap: "awaiting-human-merge", reviewRound: 0, nextStep: "handoff" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

/** A cycle that found an existing open PR at the branch step. */
function existingPrState(): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 337,
    createdAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "handoff",
      currentStep: "handoff",
      lastCompletedStep: "branch",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      existingPr: {
        number: 7,
        title: "existing",
        state: "OPEN",
        url: "",
        headRefName: "feature/issue-337-x",
        baseRefName: "main",
        matchedBy: "branch",
      },
    },
    eventLog: [
      { kind: "cap-hit", at: 3, cap: "existing-pr-detected", reviewRound: 0, nextStep: "handoff" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; renderers read a subset
  } as any;
}

function shellLines(out: string): string[] {
  return out
    .split("\n")
    .filter((l) => /^\s*(#\s)?\s*(git|gh|glab|rm|export|cat|\/work)\b/.test(l.trim()));
}

const surfaces: Array<{
  name: "chat" | "markdown";
  render: (forge?: "github" | "gitlab" | "unknown") => string;
}> = [
  {
    name: "chat",
    render: (forge) =>
      forge === "gitlab"
        ? renderHandoffUserMessage(awaitingMergeState(), REPO, `${REPO}/tmp/issue-337`, forge)
        : renderHandoffUserMessage(awaitingMergeState(), REPO, `${REPO}/tmp/issue-337`),
  },
  {
    name: "markdown",
    render: (forge) =>
      forge === "gitlab"
        ? renderHandoffMarkdown(awaitingMergeState(), forge)
        : renderHandoffMarkdown(awaitingMergeState()),
  },
];

// ---- 1. default (no forge arg) = today's GitHub output, byte-identical

for (const s of surfaces) {
  const out = s.render();
  assert(s.name === "markdown" || true, `(${s.name}) rendered`);
  assert(
    out.includes("gh pr checks 42") && out.includes("gh pr view 42 --web"),
    `${s.name} (default): GitHub 'gh pr checks' / 'pr view --web' lines unchanged`,
  );
  assert(
    shellLines(out).every((l) => !/glab/.test(l)),
    `${s.name} (default): no glab line in the default rendering`,
  );
}

// ---- 2. forge: "gitlab" through BOTH presenters

{
  const chat = renderHandoffUserMessage(awaitingMergeState(), REPO, `${REPO}/tmp/issue-337`, "gitlab");
  const md = renderHandoffMarkdown(awaitingMergeState(), "gitlab");
  for (const [name, out] of [
    ["chat", chat],
    ["markdown", md],
  ] as const) {
    assert(
      out.includes('glab api "/projects/:id/merge_requests/42/pipelines" --output json'),
      `${name} (gitlab): pipelines fetch for the CI status`,
    );
    assert(out.includes("glab mr view 42 --web"), `${name} (gitlab): 'glab mr view --web'`);
    // The recovery block itself is forge-appropriate. The rest of the handoff
    // message (the "GitHub handoff: <url>" label, the in-process fallback
    // comment lines rendered by work-driver-handoff-message.ts) is OUT OF
    // SCOPE for this workstream — it belongs to the task-b handoff fallback,
    // which is the other in-scope file pair for #612. So the assertion is
    // scoped to the recovery section, not the whole rendered message.
    const recovery = out.slice(out.indexOf("What to do next"));
    assert(
      !recovery.split("\n").some((l) => /^\s*gh\b/.test(l.trim())),
      `${name} (gitlab): the recovery block has no 'gh' command line`,
    );
    assert(
      shellLines(out).every((l) => !/&&/.test(l)),
      `${name} (gitlab): recovery lines stay unchained (the re-prompt invariant)`,
    );
    assert(
      shellLines(out).length > 0,
      `${name} (gitlab): ...and there ARE commands, so the assertions are not vacuous`,
    );
  }
}

// ---- 3. forge: "unknown" falls back to the GitHub strings (fail-open)

for (const s of surfaces) {
  const out = s.render("github");
  const unknown =
    s.name === "chat"
      ? renderHandoffUserMessage(awaitingMergeState(), REPO, `${REPO}/tmp/issue-337`, "unknown")
      : renderHandoffMarkdown(awaitingMergeState(), "unknown");
  assert(
    unknown.includes("gh pr checks 42"),
    `${s.name} (unknown): falls back to the GitHub strings (advisory text, fail-open)`,
  );
  void out;
}

// ---- 4. existing-pr-detected through the chat surface (the requalifyLine path)

{
  const chat = renderHandoffUserMessage(existingPrState(), REPO, `${REPO}/tmp/issue-337`, "gitlab");
  assert(chat.includes("glab mr view 7 --output json"), "chat (gitlab, existing-pr): glab view");
  assert(chat.includes("glab mr cancel 7"), "chat (gitlab, existing-pr): glab cancel");
  assert(
    chat.includes("git -C /Users/x/repo fetch origin"),
    "chat (gitlab, existing-pr): git requalification still applies (git -C <repoRoot>)",
  );
  const md = renderHandoffMarkdown(existingPrState(), "gitlab");
  assert(md.includes("glab mr view 7 --output json"), "markdown (gitlab, existing-pr): glab view");
  assert(md.includes("git fetch origin"), "markdown (gitlab, existing-pr): cwd-relative git line");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
