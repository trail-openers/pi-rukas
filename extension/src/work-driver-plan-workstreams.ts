/**
 * work-driver-plan-workstreams — parseWorkstreams + maxWorkstreams.
 *
 * Extracted from work-driver-plan.ts for the AGENTS.md §12 500-line cap
 * (#849 moved parseWorkstreams into work-driver-plan-helpers.ts first; this
 * module is the permanent home).
 */

import { hostBudget } from "./host-resources.ts";
import { trace } from "./trace.ts";
import {
  countMarkdownSections,
  extractListField,
  sliceMarkdownSection,
} from "./work-driver-plan-parse.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { foldTwo } from "./workstream-fold.ts";

/**
 * Parse the explore-style reply for a fenced `## Workstreams` block.
 * Expected format (lenient — agents drift; only the keys matter):
 *
 *   ## Workstreams
 *
 *   ### task-a — short scope label
 *   - paths: src/foo.ts, src/bar.ts
 *   - out-of-scope: docs/, infrastructure
 *
 *   ### task-b — second scope label
 *   ...
 *
 * No `## Workstreams` heading present → returns `{}` (caller fills in
 * the synthetic `default` workstream). Designed to never throw: a
 * malformed reply collapses to single-workstream rather than aborting
 * the cycle.
 *
 * #679 case 2(a) — also parses the optional `- depends-on: <id>` and
 * `- integration-test: <path>` lines (tolerant of `depends_on:` / `Depends on:`
 * / `Depends-on:` variants and comma-separated multi-dep, via the same
 * `extractListField` + `splitOutsideParens` tolerance class as `paths:` /
 * `out-of-scope:`). Both are OPTIONAL: a plan that omits them parses
 * identically to the pre-#679 shape.
 *
 * #1322 — also parses the optional `- introduces: <symbols>` and
 * `- consumes: <symbols>` lines (the change's contract; see
 * work-driver-plan-contract.ts). Same tolerance, same optionality.
 *
 * #819 — the multi-block defect is NOT fixed by changing what this returns.
 * `sliceMarkdownSection` is byte-unchanged (its other callers — `## Spec`,
 * `## Worktrees`, `## Rationale` — are unaffected) and this parser still
 * returns the first block's map, so no caller's behaviour moves. What changed
 * is that the ambiguity is no longer SILENT: `parseWorkstreams` counts the
 * `## Workstreams` headings before slicing and traces when a reply carries
 * more than one. The rejection lives in `planSpecMismatchReason`
 * (work-driver-plan-spec-coverage.ts), which reads the reply's raw text for
 * the same count — it has to, because the parsed map cannot distinguish one
 * block from three.
 */
export function parseWorkstreams(text: string): Record<string, Workstream> {
  const out: Record<string, Workstream> = {};
  const blocks = countMarkdownSections(text, "Workstreams");
  if (blocks > 1) {
    // Loud on the driver's trace channel: the reply the cycle built from was
    // one arbitrary block of several, and the operator reading a handoff
    // later needs to be able to see that this happened.
    trace(
      `work-driver: plan reply carried ${blocks} '## Workstreams' sections — parsed the first (the plan-to-spec gate refuses this reply)`,
    );
  }
  const section = sliceMarkdownSection(text, "Workstreams");
  if (section === undefined) return out;
  // Each workstream begins with a ### subheading. Slice between consecutive
  // ### lines (or to end of section). Heading shape: `### <id> — <scope>` or
  // `### <id>` (scope optional; em/en/hyphen all accepted as the separator).
  // The id matches `[a-z0-9][a-z0-9_-]*` so hyphens inside an id like
  // `task-a` work; the separator is SPACE-DASH-SPACE so we don't ambiguate.
  const headingRe = /^###\s+([a-z0-9][a-z0-9_-]*)(?:\s+[—–-]\s+(.+?))?\s*$/gim;
  const headings: Array<{ index: number; length: number; id: string; scope: string }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = headingRe.exec(section))) {
    const id = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!id) continue;
    headings.push({
      index: m.index,
      length: m[0].length,
      id,
      scope: (m[2] ?? "").trim() || id,
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h) continue;
    const bodyStart = h.index + h.length;
    const bodyEnd = headings[i + 1]?.index ?? section.length;
    const body = section.slice(bodyStart, bodyEnd);
    // #679 case 2(a) — `depends-on` and `integration-test` are OPTIONAL lines.
    // Tolerant of `depends_on:` / `Depends on:` / `Depends-on:` variants and
    // comma-separated multi-dep (same `extractListField` + `splitOutsideParens`
    // tolerance class as `paths:` / `out-of-scope:`). Self-references and
    // dangling references are not dropped HERE — they surface as the
    // `invalid-dependency` / `circular-dependency` plan-quality reasons in
    // planQualityReason (the driver's one-shot corrective re-dispatch is the
    // existing pattern; the planner gets a steer naming the fix).
    const dependsOn = extractListField(body, "depends[- _]on");
    const integrationTest = extractListField(body, "integration[- _]test")[0];
    // #1322 — the change's contract: symbols created / used that do not exist
    // at base. Optional, same tolerance class; absent lines add no keys, so a
    // plan without them parses exactly as before.
    const introduces = extractListField(body, "introduces");
    const consumes = extractListField(body, "consumes");
    const entry = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(integrationTest ? { integrationTest } : {}),
      ...(introduces.length > 0 ? { introduces } : {}),
      ...(consumes.length > 0 ? { consumes } : {}),
    };
    // #290 — ceiling. Each workstream becomes a worktree AND a developer
    // child, so M is a direct multiplier on process count; parallel groups
    // multiply it again. The prompt now deliberately biases toward MORE
    // workstreams, which makes an unbounded M actively dangerous rather
    // than merely untidy. Excess FOLDS into the last kept workstream — the
    // shared fold (workstream-fold.ts): union of paths, outOfScope union
    // minus the merged paths, scope annotated — so the work is never
    // silently dropped, which is the failure mode a hard truncation would
    // introduce.
    if (Object.keys(out).length >= effectiveMaxWorkstreams()) {
      const lastId = Object.keys(out)[Object.keys(out).length - 1];
      if (!lastId) continue;
      const last = out[lastId];
      if (last) {
        const folded = foldTwo(last, entry);
        // The ceiling fold's annotation is `+folded:` (the coupling merge's
        // `+merged:` is the other site's wording).
        folded.scope = `${last.scope} (+folded: ${entry.id})`;
        out[lastId] = folded;
        trace(`work-driver: plan exceeded MAX_WORKSTREAMS — folded '${entry.id}' into '${lastId}'`);
      }
      continue;
    }
    out[h.id] = entry;
  }
  return out;
}

/** #290 — ceiling on workstreams per cycle. Override: PI_ENSEMBLE_MAX_WORKSTREAMS. */
export function maxWorkstreams(): number {
  const env = Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS);
  return Number.isFinite(env) && env >= 1 ? env : 6;
}

/**
 * #1325 — the ceiling a plan is actually folded to: `maxWorkstreams()` lowered
 * to the host's workstream slots. An explicit `PI_ENSEMBLE_MAX_WORKSTREAMS`
 * wins over the budget.
 */
export function effectiveMaxWorkstreams(): number {
  if (Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS) >= 1) return maxWorkstreams();
  return Math.min(maxWorkstreams(), hostBudget().workstreamSlots);
}
