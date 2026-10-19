/**
 * work-develop-scope-fence-seam — the issue-fenced scope lift (#1405, epic #1642).
 *
 * A develop-gate fence hit is `issue-fenced` when the planner fenced a path out
 * (the workstream's `outOfScope`) and no sibling declared it. The planner
 * sometimes fences a file the issue's own Test surface names (#1187, #1378), so
 * the gate parks a cycle the issue asked for. Two things happen here:
 *
 *   - PRECHECK (acts): the normalised path is a standalone token in a bullet of
 *     the PRIMARY issue body's `## Test surface` section. The rule admits it and
 *     no model is asked. A protected path is never admitted.
 *   - MODEL (logged only): every other hit asks the `scope-fence` seam through
 *     `shadowDecide`. The answer is recorded and never acted on: a shadow call
 *     cannot change a verdict, whatever `PI_ENSEMBLE_DECISION_MODE_SCOPE_FENCE` says.
 *
 * The body is the explore-cached artifact (`pipelineState.issueBodyArtifact`),
 * written from `gh issue view` by the driver, never by a cycle agent. A missing
 * or empty artifact admits nothing and asks nothing: the fence stands.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DecideRequest } from "./decision-seam.ts";
import { shadowDecide } from "./decision-shadow.ts";
import { flattenIssueText } from "./text-flatten.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { sliceMarkdownSection } from "./work-driver-plan-parse.ts";
import type { WorkState } from "./workflow-state.ts";

/** The three issue-body sections a fence lift may be justified by. */
export interface IssueSections {
  testSurface: string;
  references: string;
  acceptanceCriteria: string;
}

export function issueSections(body: string): IssueSections {
  return {
    testSurface: sliceMarkdownSection(body, "Test surface") ?? "",
    references: sliceMarkdownSection(body, "References") ?? "",
    acceptanceCriteria: sliceMarkdownSection(body, "Acceptance criteria") ?? "",
  };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The flattened Test-surface bullet that names `file`, or undefined. The path is
 * a standalone token: `extension/x/test-a.ts` does not name `test-a.ts`, so the
 * characters around the match may not be path characters. A `./` spelling names
 * the same file and is stripped before the match.
 */
export function testSurfaceNames(testSurface: string, file: string): string | undefined {
  const token = new RegExp(`(?<![\\w./-])${escapeRegExp(file)}(?![\\w./-])`);
  for (const raw of testSurface.split("\n")) {
    if (!/^\s*[-*]\s/.test(raw)) continue;
    const line = flattenIssueText(raw).replace(/(^|[\s`(])\.\//g, "$1");
    if (token.test(line)) return line.replace(/^[-*]\s+/, "");
  }
  return undefined;
}

/** The seam's question and state for one fenced path. Evidence is the three sections only. */
export function scopeFenceRequest(sections: IssueSections, file: string): DecideRequest {
  return {
    question: `May this workstream change ${file}, given the issue body?`,
    state: {
      path: file,
      fence: "issue-fenced",
      testSurface: sections.testSurface,
      references: sections.references,
      acceptanceCriteria: sections.acceptanceCriteria,
    },
    rule: "false",
    evidence: {
      texts: [
        { name: "Test surface", text: flattenIssueText(sections.testSurface) },
        { name: "References", text: flattenIssueText(sections.references) },
        { name: "Acceptance criteria", text: flattenIssueText(sections.acceptanceCriteria) },
      ],
    },
  };
}

/** The cached body, or undefined when there is none, or it is empty. */
function readCachedBody(repoRoot: string, artifactPath: string | undefined): string | undefined {
  if (!artifactPath) return undefined;
  try {
    const body = readFileSync(path.resolve(repoRoot, artifactPath), "utf8");
    return body.trim() ? body : undefined;
  } catch {
    return undefined;
  }
}

/** One admitted lift: the pair, and the Test-surface line that justified it. */
export type FenceLift = { workstreamId: string; file: string; line: string };

/**
 * The develop gate's lift for an issue-fenced hit: `(workstreamId, file) → admitted`.
 * Each pair is judged on its own, so a second fenced file from the same workstream
 * still fails, and so does the same file on a sibling workstream. An admitted
 * precheck is pushed to `lifts` (the caller records it as a `fence-lifted` event).
 */
export function scopeFenceLift(
  ctx: CycleContext,
  state: WorkState,
  lifts?: FenceLift[],
): (workstreamId: string, file: string) => boolean {
  const repoRoot = ctx.repoRoot;
  const issues = state.issues ?? [state.issue];
  const body = readCachedBody(repoRoot, state.pipelineState.issueBodyArtifact);
  const asked = new Set<string>();
  return (workstreamId, file) => {
    // A protected path is never lifted, by the rule or the model.
    if (isProtectedPath(file)) return false;
    if (body === undefined) return false;
    const sections = issueSections(body);
    const named = testSurfaceNames(sections.testSurface, file);
    if (named !== undefined) {
      lifts?.push({ workstreamId, file, line: named });
      trace(`fence lifted by the issue's Test surface: ${workstreamId} may change ${file}`);
      return true;
    }
    const key = `${workstreamId}\0${file}`;
    if (!asked.has(key)) {
      asked.add(key);
      void shadowDecide("scope-fence", scopeFenceRequest(sections, file), {
        repoRoot,
        issues,
      }).then((d) => {
        if (!d?.model) return;
        // The record carries the verbatim check; the path condition is not in it,
        // so the trace states whether the quote names the path too.
        const namesPath = (d.model.quote ?? "").includes(file);
        trace(
          `scope-fence (shadow, not acted on): ${workstreamId} ${file} — model ${d.model.answer}; quote ${namesPath ? "names" : "does not name"} the path; evidence ${d.evidence?.passed ? "verified" : "not verified"}`,
        );
      });
    }
    return false;
  };
}
