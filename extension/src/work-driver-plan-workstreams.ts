/**
 * work-driver-plan-workstreams — parseWorkstreams + maxWorkstreams.
 *
 * Extracted from work-driver-plan.ts for the AGENTS.md §12 500-line cap
 * (#849 moved parseWorkstreams into work-driver-plan-helpers.ts first; this
 * module is the permanent home).
 */

import { trace } from "./trace.ts";
import { extractListField, sliceMarkdownSection } from "./work-driver-plan-parse.ts";

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
 */
export function parseWorkstreams(text: string): Record<
  string,
  {
    id: string;
    scope: string;
    paths: string[];
    outOfScope: string[];
    dependsOn?: string[];
    integrationTest?: string;
  }
> {
  const out: Record<
    string,
    {
      id: string;
      scope: string;
      paths: string[];
      outOfScope: string[];
      dependsOn?: string[];
      integrationTest?: string;
    }
  > = {};
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
    const entry = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(integrationTest ? { integrationTest } : {}),
    };
    // #290 — ceiling. Each workstream becomes a worktree AND a developer
    // child, so M is a direct multiplier on process count; parallel groups
    // multiply it again. The prompt now deliberately biases toward MORE
    // workstreams, which makes an unbounded M actively dangerous rather than
    // merely untidy. Excess FOLDS into the last kept workstream — union of
    // paths, scope annotated — so the work is never silently dropped, which
    // is the failure mode a hard truncation would introduce.
    if (Object.keys(out).length >= maxWorkstreams()) {
      const lastId = Object.keys(out)[Object.keys(out).length - 1];
      const last = lastId ? out[lastId] : undefined;
      if (last) {
        last.paths = [...new Set([...last.paths, ...entry.paths])];
        last.outOfScope = [...new Set([...last.outOfScope, ...entry.outOfScope])];
        last.scope = `${last.scope} (+folded: ${entry.id})`;
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
