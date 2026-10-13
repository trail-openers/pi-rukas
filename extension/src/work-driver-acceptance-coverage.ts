/**
 * work-driver-acceptance-coverage — the whole-issue acceptance-coverage
 * gate, run ONCE on the consolidated diff after all workstreams (#1137).
 *
 * The per-workstream adversarial review judges each workstream against the
 * WHOLE issue's acceptance criteria, so a workstream that correctly owns
 * only part of the issue (docs, say) gets ISSUES_FOUND for criteria a
 * sibling delivers, its develop re-dispatch changes nothing, and the cycle
 * parks with "byte-identical — nothing was fixed". The fix has two legs
 * (#1137): the per-workstream prompt is scoped to its own paths/deliverables
 * (task-a), and the whole-issue criteria are checked exactly ONCE here, on
 * the consolidated diff — never per workstream. A criterion no workstream
 * delivers must still be flagged; scoping the per-workstream reviews must
 * not silently drop whole-issue coverage.
 *
 * The check is deterministic path presence — the same stance as the
 * converge gate (#741, work-driver-converge.ts) and the consolidation
 * coverage gate (work-driver-verify.ts): the consolidated diff (what
 * actually shipped, `origin/<mainline>...origin/<branch>` at repoRoot, the
 * same read `verifyConsolidation` uses) is compared against the union of
 * every workstream's declared paths, and each acceptance criterion is
 * classified delivered / undelivered / unmeasurable. Zero LLM calls.
 *
 * Degradation is explicit, never a silent drop (the edge case the ticket
 * names): no acceptance criteria (no normalised spec, or none recorded)
 * and an unreadable consolidated diff both SKIP the gate with a recorded
 * reason — "scope unknown" — rather than passing or failing on whole-issue
 * criteria the driver could not even read.
 *
 * Escape hatch: PI_ENSEMBLE_ACCEPTANCE_COVERAGE=0 disables the gate
 * (consistent with PI_ENSEMBLE_CONVERGE / PI_ENSEMBLE_VERIFY).
 */

import { execp } from "./lens-exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { detectMainline } from "./work-driver-git.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import { appendEvent } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

/** `PI_ENSEMBLE_ACCEPTANCE_COVERAGE=0` (or `false`) disables the gate. */
export function acceptanceCoverageEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_ACCEPTANCE_COVERAGE;
  return v !== "0" && v !== "false";
}

export type CriterionStatus = "delivered" | "undelivered" | "unmeasurable";

/**
 * One acceptance criterion after the consolidated-coverage check. `paths`
 * is the subset of the criterion's own text that parses as a repo path
 * (the deliverable paths in parentheses, per the issue template — no
 * heuristic over prose otherwise); empty for a prose-only criterion.
 * `owner` names the workstream whose declared paths the criterion touches —
 * the attribution the operator needs to know where the work was supposed
 * to land; `null` when no workstream claims it.
 */
export interface CoverageCriterionResult {
  text: string;
  status: CriterionStatus;
  /** Of the criterion's own parseable paths, which are in the consolidated diff. */
  present: string[];
  /** Of the criterion's own parseable paths, which are absent (undelivered only). */
  missing: string[];
  /** The workstream id owning this criterion, or null. */
  owner: string | null;
}

export interface CoverageVerdict {
  /** True when the gate did not apply (disabled, no criteria, unreadable diff). */
  skipped: boolean;
  /** The degradation reason when `skipped` is true ("scope unknown" shapes). */
  skipReason?: string;
  /** True when the consolidated diff read itself failed. */
  diffUnreadable: boolean;
  criteria: CoverageCriterionResult[];
  /** The blocking set — criteria the consolidated diff does not deliver. */
  undelivered: CoverageCriterionResult[];
  /** The consolidated file list (what shipped), for the handoff's present side. */
  filesPresent: string[];
}

/** A repo-path token: word characters, dots, dashes, `@`, slash-separated. */
const PATH_TOKEN = /^[\w.@-]+(\/[\w.@-]+)*$/;
/** A token with a file extension is a file path; a slash-only token is a directory. */
const FILE_SHAPED = /\.[A-Za-z0-9]+$/;

/**
 * Extract the deliverable paths a criterion names in parentheses,
 * normalised the same way the verify gate normalises planner prose
 * ("`src/a.ts (new)`" → "src/a.ts"). A parenthesis pair without a path is
 * prose and is ignored — the check stays deterministic and never guesses
 * over free text.
 *
 * A single parenthetical may name several paths ("(src/a.ts, src/b.ts)") —
 * it is split on commas, and each comma part on whitespace, so a path
 * written after prose ("(see docs/x.md)") is still found. Only a token of
 * clean path shape survives: "(read/write)" yields "read/write" here, which
 * `parseablePaths` then drops unless the diff actually has files under it.
 */
export function criterionPathsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const inner = (m[1] ?? "").replace(/\s*\([^()]*\)\s*$/, "");
    for (const part of inner.split(",")) {
      for (const tok of normaliseDeclaredPath(part).split(/\s+/)) {
        if (!PATH_TOKEN.test(tok)) continue;
        if (FILE_SHAPED.test(tok) || tok.includes("/")) seen.add(tok);
      }
    }
  }
  return [...seen];
}

/**
 * The criterion's paths that can bear on the consolidated diff. A file-shaped
 * token always counts; a slash-only token (a directory) counts only when some
 * file in the diff lives under it. So "(read/write)" in prose is not a path
 * unless the diff actually touches read/ — the prose stays unmeasurable.
 */
export function parseablePaths(text: string, diffFiles: ReadonlySet<string>): string[] {
  return criterionPathsOf(text).filter(
    (p) => FILE_SHAPED.test(p) || [...diffFiles].some((f) => f.startsWith(`${p}/`)),
  );
}

/**
 * A git ref we are willing to hand to the shell. Branch names come from the
 * driver slug or from `git rev-parse` on the ops fallback, so they are
 * validated rather than trusted: no shell metacharacters, no `..` (which
 * would turn the range into something else), no leading dash.
 */
function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes("..") && !ref.startsWith("-");
}

/**
 * The consolidated diff name-set: every file in
 * `origin/<mainline>...origin/<branch>` at repoRoot (the same read and the
 * same `--name-status -M` rename awareness as `verifyConsolidation` in
 * work-driver-verify.ts — rename targets cover the path, rename sources
 * do not). Reads the LOCAL ref of the pushed branch (`origin/<branch>`)
 * like `fetchIntegratedDiff`, with the local `branch` ref as fallback.
 * Returns `unreadable: true` (the gate skips) when neither read succeeds.
 */
export async function readConsolidatedDiffFiles(
  execFn: NonNullable<DriverContext["verifyExecFn"]>,
  repoRoot: string,
  branchName: string | undefined,
): Promise<{ files: Set<string>; unreadable: boolean }> {
  const files = new Set<string>();
  if (!branchName) return { files, unreadable: true };
  const mainline = await detectMainline(repoRoot, execFn);
  const base = mainline && "branch" in mainline ? `origin/${mainline.branch}` : "origin/main";
  const tryRef = async (ref: string): Promise<boolean> => {
    if (!isSafeRef(ref) || !isSafeRef(base)) {
      trace(`work-driver: acceptance coverage — refusing unsafe ref name in diff read: ${ref}`);
      return false;
    }
    try {
      // Three-dot: the merge base, so a base that advanced after the branch
      // was cut does not put main-only files into the delivered set (#1134).
      const { stdout } = await execFn(`git diff --name-status -M ${base}...${ref}`, {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024,
      });
      for (const line of stdout.split("\n")) {
        const fields = line.split("\t");
        const code = fields[0]?.trim() ?? "";
        if (!code) continue;
        const codeBase = code[0];
        if ((codeBase === "R" || codeBase === "C") && fields.length >= 3) {
          // The rename/copy TARGET is what landed; the source covered via prefix.
          const tgt = normaliseDeclaredPath(fields[2] ?? "");
          if (tgt) files.add(tgt);
          continue;
        }
        // A plain delete (D) lists the name but the content did not ship.
        if (codeBase === "D") continue;
        const p = normaliseDeclaredPath(fields[1] ?? "");
        if (p) files.add(p);
      }
      return true;
    } catch (err) {
      // #1137 — a failed ref read is a skip signal; name the ref and the
      // error so the operator can tell "not pushed yet" (the expected
      // fallback to the local ref) from "branch does not exist" (the gate
      // degrades to the "scope unknown" skip below).
      trace(
        `work-driver: acceptance coverage — diff read failed for ${ref}: ${(err as Error).message?.slice(0, 200) ?? String(err).slice(0, 200)}`,
      );
      return false;
    }
  };
  if (await tryRef(`origin/${branchName}`)) return { files, unreadable: false };
  // The push may not have landed yet (the ops-fallback path); the local
  // branch ref carries the same commits.
  if (await tryRef(branchName)) return { files, unreadable: false };
  return { files, unreadable: true };
}

/**
 * Which workstream owns a criterion: the first workstream (declaration
 * order) whose declared paths intersect the criterion's parseable paths.
 * `null` when the criterion names no path any workstream declared — the
 * owner is then "the consolidated diff", and the undelivered entry names
 * the criterion, not a workstream it was never assigned to.
 */
function criterionOwner(
  workstreams: Record<string, { paths: string[] }>,
  paths: readonly string[],
): string | null {
  if (paths.length === 0) return null;
  for (const [id, ws] of Object.entries(workstreams)) {
    const declared = (ws?.paths ?? []).map(normaliseDeclaredPath);
    if (paths.some((p) => declared.includes(p))) return id;
  }
  return null;
}

/**
 * The core classification. Pure over (criteria, diff-file-set) so the smoke
 * test exercises the exact production predicate with no git at all.
 *
 * A criterion is `unmeasurable` when its text names no parseable path
 * (prose criterion — no heuristic over free text, never a false
 * undelivered); `undelivered` when it names paths and NONE of them is in
 * the consolidated diff (partially-present criteria do not block — the
 * same over-declaration stance as the converge gate, which only parks on
 * fully-absent deliverables); `delivered` when every named path shipped.
 */
export function classifyCoverage(
  criteria: string[],
  workstreams: Record<string, { paths: string[] }>,
  diffFiles: Set<string>,
  opts?: {
    diffUnreadable?: boolean;
    skipReason?: string;
  },
): CoverageVerdict {
  if (opts?.skipReason !== undefined) {
    return {
      skipped: true,
      skipReason: opts.skipReason,
      diffUnreadable: opts.diffUnreadable ?? false,
      criteria: [],
      undelivered: [],
      filesPresent: [],
    };
  }
  const results: CoverageCriterionResult[] = criteria.map((text) => {
    const paths = parseablePaths(text, diffFiles);
    if (paths.length === 0) {
      return {
        text,
        status: "unmeasurable",
        present: [],
        missing: [],
        owner: null,
      };
    }
    const present = paths.filter(
      (p) => diffFiles.has(p) || [...diffFiles].some((f) => f.startsWith(`${p}/`)),
    );
    const missing = paths.filter((p) => !present.includes(p));
    const owner = criterionOwner(workstreams, paths);
    if (missing.length === 0) {
      return { text, status: "delivered", present, missing, owner };
    }
    if (present.length === 0) {
      return { text, status: "undelivered", present, missing, owner };
    }
    // Partial: some of the criterion's paths shipped, some did not. Not a
    // block (the converge gate parks only on fully-absent deliverables) —
    // the delivered side is what shipped; the rest is an over-declaration
    // or a sibling's slice, which per-workstream review owns.
    return { text, status: "delivered", present, missing, owner };
  });
  const undelivered = results.filter((r) => r.status === "undelivered");
  return {
    skipped: false,
    diffUnreadable: opts?.diffUnreadable ?? false,
    criteria: results,
    undelivered,
    filesPresent: [...diffFiles],
  };
}

/**
 * The whole-issue acceptance-coverage gate. Runs once, on the consolidated
 * diff, after all workstreams (the commit-pr post-dispatch gate sequence in
 * work-driver-commit-pr-events.ts — both the mechanized and the ops-fallback
 * paths flow through it, so the check is independent of which path opened
 * the PR).
 *
 * Returns `null` when the gate does not apply — disabled, or no normalised
 * spec / no recorded acceptance criteria. An unreadable consolidated diff
 * returns a skipped verdict with the reason (a git failure is not evidence
 * a criterion is undelivered; the reason reads NOT CHECKED on the handoff).
 * Otherwise returns the verdict; the caller records undelivered criteria
 * as a warning (never a cap) via `recordAcceptanceCoverage`.
 */
export async function runAcceptanceCoverageGate(
  ctx: CycleContext,
  state: WorkState,
): Promise<CoverageVerdict | null> {
  if (!acceptanceCoverageEnabled()) return null;
  const spec = state.pipelineState.normalisedSpec;
  if (!spec || spec.acceptanceCriteria.length === 0) {
    trace(
      "work-driver: acceptance coverage — no recorded acceptance criteria; gate skipped (scope unknown)",
    );
    return null;
  }
  const execFn = ctx.verifyExecFn ?? execp;
  const { files, unreadable } = await readConsolidatedDiffFiles(
    execFn,
    ctx.repoRoot,
    state.pipelineState.branchName,
  );
  if (unreadable) {
    const skipReason = "consolidated diff unreadable";
    trace(`work-driver: acceptance coverage — ${skipReason}; NOT CHECKED`);
    return {
      skipped: true,
      skipReason,
      diffUnreadable: true,
      criteria: [],
      undelivered: [],
      filesPresent: [],
    };
  }
  const verdict = classifyCoverage(
    spec.acceptanceCriteria,
    state.pipelineState.workstreams ?? {},
    files,
  );
  if (verdict.undelivered.length > 0) {
    trace(
      `work-driver: acceptance coverage — undelivered criterion(s): ${verdict.undelivered.map((u) => u.text.slice(0, 120)).join(" | ")}`,
    );
  }
  return verdict;
}

/**
 * Record a coverage verdict as a WARNING, never a cap: undelivered criteria
 * (with owner attribution) and a NOT CHECKED skip are plumb notes on the
 * handoff, and the cycle continues. A criterion no workstream delivered is
 * disclosed to the operator, not used to park work that is otherwise fine.
 */
export function recordAcceptanceCoverage(state: WorkState, verdict: CoverageVerdict): WorkState {
  let body: string;
  if (verdict.skipped) {
    body = `acceptance coverage NOT CHECKED: ${verdict.skipReason ?? "unknown reason"}`;
  } else if (verdict.undelivered.length > 0) {
    const items = verdict.undelivered
      .map((u) => {
        const owner = u.owner
          ? ` (owned by workstream ${u.owner})`
          : " (no workstream declared it)";
        return `${u.text} — missing path(s): ${u.missing.join(", ")}${owner}`;
      })
      .join(" | ");
    body = `Acceptance coverage: not delivered: ${items}`;
  } else {
    return state;
  }
  trace(`work-driver: ${body}`);
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        { step: "commit-pr", role: "driver", body, at: Date.now() },
      ],
    },
  };
}
