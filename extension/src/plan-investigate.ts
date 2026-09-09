/**
 * plan-investigate — Phase 1b (duplicate risk) + Phase 2 (investigation
 * angles) of the compiled /plan pipeline, run as ONE parallel barrier.
 *
 * The duplicate-risk explore used to be a fully blocking serial dispatch
 * whose result the driver consumed only as a HIGH/not-HIGH boolean — a full
 * child process of wall clock added ahead of the angle fan-out for a check
 * that shares no data dependency with it. The structural cost audit
 * (outputs/spec-driven-plan-driver-gap.md §4) put the serial dispatch tax at
 * the centre of the operator's 20–30-minute-per-ticket report, so the two
 * phases now dispatch together and the HIGH-risk hard stop moves to AFTER
 * the barrier, before draft/gate/file. Semantics are unchanged — a HIGH
 * verdict still refuses to file — the only trade is that on HIGH the angle
 * tokens are already spent, and HIGH is the rare case.
 *
 * This module also owns the plan pipeline's dispatch bounds: every plan
 * child gets PLAN_DISPATCH_TIMEOUT_MS instead of riding the 2-hour spawn
 * backstop (a hung angle used to stall the whole ticket), plus `cwd` pinned
 * to the repo root (children used to inherit the parent process cwd — a
 * latent wrong-repo hazard for the gh/vipune searches they run).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { dispatchCore } from "./dispatch.ts";
import { DESCRIPTOR_DATA_FRAMING } from "./plan-angles.ts";
import type { AngleFindings, MechanicalInventory } from "./plan-draft.ts";
import { anglePromptsFor, extractPlanItems } from "./plan-draft.ts";
import type { PlanType } from "./plan-types.ts";
import { trace } from "./trace.ts";

/** The dispatch seam (same shape as plan-driver's PlanDispatchFn). */
export type InvestigateDispatch = typeof dispatchCore;

/**
 * Per-dispatch bound for every plan child. Without it a plan child runs
 * under the global 2-hour spawn backstop — a hung angle or gate reviewer
 * stalls the whole ticket. 8 minutes is generous for the largest observed
 * angle (a codebase investigation) while keeping the worst case bounded.
 * One constant, no env knob (operator decision 2026-09-09: fewer knobs,
 * better defaults). Timeout routing reuses paths that already exist:
 * angle → fail-closed (ok=false), duplicate-risk → undefined risk + trace,
 * gap gate → gate-unavailable.
 */
export const PLAN_DISPATCH_TIMEOUT_MS = 8 * 60_000;

/**
 * Companion-extension path for the Phase-2 children (report_plan_item).
 * Follows LENS_REPORTER_PATH / POLICY_REPORTER_PATH exactly.
 */
export const PLAN_REPORTER_PATH = `${__dirname}/plan-reporter.ts`;

/**
 * The extra args the Phase-2 investigation children run with: no skills
 * (the exploration tools are in the role prompt; skills would just add cost)
 * + the plan-reporter extension that registers report_plan_item.
 */
export const PLAN_EXTRA_ARGS: string[] = ["--no-skills", "--extension", PLAN_REPORTER_PATH];

/**
 * The extra args for the marker-line children (duplicate-risk, gap gate):
 * they return a single marker-line reply and emit no structured items, so
 * they get no reporter extension — but they DO get `--no-skills`, which the
 * old inline dispatches omitted, loading the full skill set into a child
 * whose whole output is one verdict line.
 */
export const PLAN_MARKER_CHILD_ARGS: string[] = ["--no-skills"];

export interface DuplicateRisk {
  level: string;
  rationale: string;
}

export interface InvestigationResult {
  /** Undefined when the duplicate-risk dispatch failed (ok=false). */
  duplicateRisk?: DuplicateRisk;
  findings: AngleFindings[];
}

/**
 * The duplicate-risk prompt. The mechanical inventory is only a mechanical
 * scan: it cannot see semantic overlap a different title hides, so the risk
 * call goes to an explore. SECURITY (six-lens re-review, PR #640): the
 * descriptor is untrusted operator input — the same DESCRIPTOR_DATA_FRAMING
 * constant as the angle and gap-gate prompts, one copy.
 */
export function duplicateRiskPrompt(
  type: PlanType,
  descriptor: string,
  inv: MechanicalInventory,
): string {
  return [
    `${DESCRIPTOR_DATA_FRAMING}DUPLICATE RISK CHECK for a proposed ${type} ticket: "${descriptor}".`,
    `Mechanical scan found: ${
      inv.related.map((r) => `#${r.number} (${r.state}) ${r.title}`).join("; ") ||
      "no related issues"
    }.`,
    "Assess whether filing this ticket would duplicate existing work — check open + recently closed issues (gh issue list --state all --search '<keyword>' --limit 10) and vipune.",
    "Return a short verdict: DUPLICATE_RISK: high|medium|low|none plus 2-3 sentences of rationale with issue numbers.",
  ].join(" ");
}

/** Parse the duplicate-risk child's marker line (absent marker → medium). */
export function parseDuplicateRisk(text: string): DuplicateRisk {
  const m = text.match(/DUPLICATE_RISK\s*[:—-]\s*(high|medium|low|none)/i);
  return {
    level: m ? (m[1] ?? "medium").toLowerCase() : "medium",
    rationale: text.slice(0, 400),
  };
}

/**
 * Phase 1b + Phase 2 as one barrier: the duplicate-risk child and every
 * angle child dispatch together; wall clock is the slowest of them, not
 * their sum. The caller applies the HIGH-risk hard stop and the
 * all-angles-failed guard on the returned result.
 */
export async function runInvestigation(
  dispatch: InvestigateDispatch,
  pi: ExtensionAPI,
  args: {
    type: PlanType;
    descriptor: string;
    repoRoot: string;
    inv: MechanicalInventory;
    priorContext: { source: string; fact: string }[];
    codeIdentifiers: string[];
  },
): Promise<InvestigationResult> {
  const { type, descriptor, repoRoot, inv, priorContext, codeIdentifiers } = args;
  const angles = anglePromptsFor(type, descriptor, priorContext, codeIdentifiers);

  const duplicatePromise = dispatch(
    pi,
    { role: "explore", prompt: duplicateRiskPrompt(type, descriptor, inv), cwd: repoRoot },
    {
      label: "plan-duplicate-risk",
      timeoutMs: PLAN_DISPATCH_TIMEOUT_MS,
      extraArgs: PLAN_MARKER_CHILD_ARGS,
    },
  );

  // Phase 2 — the children run with the plan-reporter extension (the
  // report_plan_item tool) so the driver reads structured items from
  // result.toolUses instead of line-splitting prose. The duplicate-risk
  // child and the gap-gate child do NOT get the reporter — they return a
  // single marker-line reply, not a list of items.
  const anglesPromise = Promise.all(
    angles.map((a) =>
      dispatch(
        pi,
        { role: "explore", prompt: a.prompt, cwd: repoRoot },
        {
          label: `plan-${a.name}`.slice(0, 24),
          timeoutMs: PLAN_DISPATCH_TIMEOUT_MS,
          extraArgs: PLAN_EXTRA_ARGS,
        },
      ).then((r) => {
        const toolUses = r.toolUses; // #633: DispatchResult declares toolUses: unknown[] (non-optional)
        // Structured-first (D8, fail-closed): an angle is "ok" only when the
        // dispatch succeeded AND it produced at least one structured item.
        const ok = r.ok && !r.errorStop && toolUses.length > 0;
        return {
          name: a.name,
          ok,
          text: r.text,
          toolUses: extractPlanItems(toolUses, a.name),
        };
      }),
    ),
  );

  const [dup, findings] = await Promise.all([duplicatePromise, anglesPromise]);

  let duplicateRisk: DuplicateRisk | undefined;
  if (dup.ok) {
    duplicateRisk = parseDuplicateRisk(dup.text);
    trace(`plan-driver: duplicateRisk=${duplicateRisk.level}`);
  } else {
    trace("plan-driver: duplicate-risk dispatch failed — proceeding without a risk verdict");
  }
  return { duplicateRisk, findings };
}
