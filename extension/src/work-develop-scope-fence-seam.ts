/**
 * work-develop-scope-fence-seam — the issue-fenced scope lift (#1405, epic #1642).
 *
 * A develop-gate fence hit is `issue-fenced` when the planner fenced a path out
 * (the workstream's `outOfScope`) and no sibling declared it. The planner
 * sometimes fences a file the issue's own Test surface names (#1187, #1378), so
 * the gate parks a cycle the issue asked for. Two things happen here:
 *
 *   - PRECHECK (acts): the path is a TEST file (`isTestPath`, the convention the
 *     fence's #672 test-file exception uses) and a standalone token in a bullet of
 *     the PRIMARY issue body's `## Test surface` section. The rule admits it and
 *     no model is asked. A protected path is never admitted. Both measured parks
 *     (#1187, #1378) were test files. A Test-surface bullet that only names a SOURCE
 *     file to verify it ("covered by the existing tests") is not a request to change
 *     it, and no word list can tell the two apart, so source files are never lifted
 *     by the rule; the shadow seam logs whether a model could.
 *   - MODEL (logged only): every other hit asks the `scope-fence` seam through
 *     `shadowDecide`. The answer is recorded and never acted on: a shadow call
 *     cannot change a verdict, whatever `PI_ENSEMBLE_DECISION_MODE_SCOPE_FENCE` says.
 *
 * The body is the explore-cached artifact (`pipelineState.issueBodyArtifact`),
 * written from `gh issue view` by the driver, never by a cycle agent. A missing
 * or empty artifact admits nothing and asks nothing: the fence stands.
 *
 * Lifting a test file is safe to do on the issue's word: the planner's fence is a
 * scope boundary, not a security boundary, and the issue body is the scope
 * authority the operator chose to run /work on. Protected paths stay unliftable,
 * and lens and adversarial review still run on the change.
 *
 * A grouped cycle is never lifted: the cached body is the primary issue's only,
 * so a lift could not be attributed to a workstream's own issue.
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
import { isTestPath } from "./work-driver-plan-paths.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

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
 * A bullet that forbids, or only asks to verify, the path it names. The test
 * surface describes what to verify, so a path in such a bullet is not a request
 * to change it (heuristic; the rule admits only bullets that read as a change).
 */
const NON_CHANGE =
  /\b(must not|must still|should not|shall not|do not|don't|does not|not change|no change|unchanged|remain|still pass|must pass|existing behaviou?r)\b/i;

/**
 * The flattened Test-surface bullet that names `file`, or undefined. The path is
 * a standalone token: `extension/x/test-a.ts` does not name `test-a.ts`, so the
 * characters around the match may not be path characters. A `./` spelling names
 * the same file and is stripped before the match. A bullet matching NON_CHANGE
 * is skipped: naming a file to pin it is not asking for a change to it.
 */
export function testSurfaceNames(testSurface: string, file: string): string | undefined {
  // An empty pattern matches every line, so an empty or blank path names nothing.
  if (file.trim() === "") return undefined;
  const token = new RegExp(`(?<![\\w./-])${escapeRegExp(file)}(?![\\w./-])`);
  for (const raw of testSurface.split("\n")) {
    if (!/^\s*[-*]\s/.test(raw)) continue;
    const line = flattenIssueText(raw).replace(/(^|[\s`(])\.\//g, "$1");
    if (token.test(line) && !NON_CHANGE.test(line)) return line.replace(/^[-*]\s+/, "");
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
        {
          name: "Acceptance criteria",
          text: flattenIssueText(sections.acceptanceCriteria),
        },
      ],
    },
  };
}

/**
 * The cached body, or undefined when there is none, or it is empty. The artifact
 * must lie inside `<repoRoot>/.pi/work-state/` (where `writeDispatchArtifact`
 * writes it); anything else is refused, because the body is the lift's authority.
 */
function readCachedBody(repoRoot: string, artifactPath: string | undefined): string | undefined {
  if (!artifactPath) return undefined;
  const stateDir = workStateDir(repoRoot);
  const file = path.resolve(repoRoot, artifactPath);
  const rel = path.relative(stateDir, file);
  if (rel === "" || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)) {
    trace(`scope-fence: issue body artifact ${file} is outside ${stateDir}; refused`);
    return undefined;
  }
  try {
    const body = readFileSync(file, "utf8");
    return body.trim() ? body : undefined;
  } catch (err) {
    // A missing artifact is the normal "explore never ran" case and stays silent.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    trace(`scope-fence: could not read issue body ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/** One admitted lift: the pair, and the Test-surface line that justified it. */
export type FenceLift = { workstreamId: string; file: string; line: string };

/**
 * At most this many model asks per develop gate, the same cap the open-point
 * gate uses: a fence with many hits must not become a model call per path.
 */
const MAX_SHADOW_ASKS = 5;

/**
 * The develop gate's lift for an issue-fenced hit: `(workstreamId, file) → admitted`.
 * Each pair is judged on its own, so a second fenced file from the same workstream
 * still fails. The caller admits only a file that exactly one workstream changed,
 * so the same file fenced on a sibling workstream still fails. An admitted
 * precheck is pushed to `lifts` (the caller records it as a `fence-lifted` event).
 * A grouped cycle and a cycle with no usable body lift nothing and ask nothing.
 */
export function scopeFenceLift(
  ctx: CycleContext,
  state: WorkState,
  lifts?: FenceLift[],
): (workstreamId: string, file: string) => boolean {
  const repoRoot = ctx.repoRoot;
  const issues = state.issues ?? [state.issue];
  const grouped = issues.length !== 1;
  const body = grouped
    ? undefined
    : readCachedBody(repoRoot, state.pipelineState.issueBodyArtifact);
  const sections = body === undefined ? undefined : issueSections(body);
  const asked = new Set<string>();
  let asks = 0;
  let capTraced = false;
  let skipTraced = false;
  return (workstreamId, file) => {
    // A protected path is never lifted, by the rule or the model.
    if (isProtectedPath(file)) return false;
    if (sections === undefined) {
      if (!skipTraced) {
        skipTraced = true;
        trace(
          grouped
            ? `scope-fence: grouped cycle (${issues.length} issues); the Test-surface precheck is skipped, the fence stands`
            : "scope-fence: no usable issue body; the Test-surface precheck is skipped, the fence stands",
        );
      }
      return false;
    }
    // Only a test file is liftable by the rule (see the module doc).
    const named = isTestPath(file) ? testSurfaceNames(sections.testSurface, file) : undefined;
    if (named !== undefined) {
      lifts?.push({ workstreamId, file, line: named });
      trace(`fence lifted by the issue's Test surface: ${workstreamId} may change ${file}`);
      return true;
    }
    const key = `${workstreamId}\0${file}`;
    if (asked.has(key)) return false;
    if (asks >= MAX_SHADOW_ASKS) {
      if (!capTraced) {
        capTraced = true;
        trace(
          `scope-fence: ${MAX_SHADOW_ASKS} shadow asks reached for this develop gate; further fenced paths are not asked`,
        );
      }
      return false;
    }
    asked.add(key);
    asks++;
    void shadowDecide("scope-fence", scopeFenceRequest(sections, file), {
      repoRoot,
      issues,
    })
      .then((d) => {
        // One trace line per asked hit: the answer, or the abstain when none came back.
        // The record carries the verbatim check; the path condition is not in it,
        // so the trace states whether the quote names the path too.
        const verdict = d?.model
          ? `model ${d.model.answer}; quote ${(d.model.quote ?? "").includes(file) ? "names" : "does not name"} the path; evidence ${d.evidence?.passed ? "verified" : "not verified"}`
          : "model abstained";
        trace(`scope-fence (shadow, not acted on): ${workstreamId} ${file} — ${verdict}`);
      })
      .catch((err: unknown) => {
        trace(
          `scope-fence (shadow, not acted on) failed for ${workstreamId} ${file}: ${String(err)}`,
        );
      });
    return false;
  };
}
