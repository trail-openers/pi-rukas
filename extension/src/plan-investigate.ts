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
import type { DispatchHost } from "./async-jobs-lifecycle.ts";
import type { dispatchCore } from "./dispatch.ts";
import { DESCRIPTOR_DATA_FRAMING, anglePromptsFor } from "./plan-angles.ts";
import type { AngleFindings, MechanicalInventory, PlanItemKind } from "./plan-draft.ts";
import { extractPlanItems, renderPriorContext } from "./plan-draft.ts";
import {
  type IssueState,
  type KnownIssue,
  downgradeSelfDuplicate,
  normaliseIssueState,
  priorContextExcludingSource,
  relatedExcludingSource,
} from "./plan-duplicate-self.ts";
import { traceDuplicateRisk } from "./plan-duplicate-trace.ts";
import { applyNeverClaimFilter } from "./plan-never-claim.ts";
import { forbiddenPhrasesBlock } from "./plan-prior-context.ts";
import type { PlanType } from "./plan-types.ts";
import { reporterPathFromArgs, statReporterPath } from "./reporter-preflight.ts";
import { trace, traceWarn } from "./trace.ts";

/** The dispatch seam (same shape as plan-driver's PlanDispatchFn). */
export type InvestigateDispatch = typeof dispatchCore;

/**
 * Per-dispatch bound for every plan child (the research driver aliases it
 * too). Without it a plan child runs under the global 2-hour spawn
 * backstop — a hung angle or gate reviewer stalls the whole ticket.
 *
 * 30 minutes (operator decision 2026-09-09, revising the initial 8): the
 * live vipune fixture run killed two heavy investigation angles at exactly
 * 8m00s under concurrent load, and killing a child loses its whole
 * context — the operator's historical floor for agent runs is 30 min. The
 * bound exists only to beat the 2-hour backstop, not to police normal
 * variance. One constant, no env knob. Timeout routing reuses paths that
 * already exist: angle → fail-closed (ok=false, disclosed in the result
 * and the drafted body), duplicate-risk → undefined risk + trace, gap
 * gate → gate-unavailable.
 */
export const PLAN_DISPATCH_TIMEOUT_MS = 30 * 60_000;

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
  /** The four levels the risk child's marker admits; the parser's own default is `medium`. */
  level: DuplicateRiskLevel;
  rationale: string;
  /**
   * #1856 — set only when a HIGH verdict was downgraded to medium because EVERY
   * issue it named was one the driver may suppress: the source issue this plan
   * is for, one of that issue's own split children, or a CLOSED issue the child
   * itself called prior art or a reversal target (plan-duplicate-self.ts). An
   * absent marker (`parseDuplicateRisk`'s medium default) is NEVER a downgrade.
   */
  downgradedFrom?: DuplicateRiskLevel;
  /** Why the downgrade was allowed, in the driver's words. Present with `downgradedFrom`. */
  downgradeReason?: string;
  /**
   * #1856 — every issue the filter suppressed, with the rule that removed it.
   * Absent when there was no source issue, so a run with no subject keeps the
   * exact verdict shape it had before.
   */
  excludedIssues?: ExcludedDuplicate[];
}

/** The risk levels the `DUPLICATE_RISK:` marker admits. */
export type DuplicateRiskLevel = "high" | "medium" | "low" | "none";

/** One issue the duplicate-risk candidate set lost, and the rule that removed it. */
export interface ExcludedDuplicate {
  number: number;
  /** The normalised state ({@link IssueState}), or `"unknown"` when nothing carried one. */
  state: IssueState;
  title: string;
  /** One of `EXCLUSION_REASONS` in plan-duplicate-self.ts. */
  reason: string;
}

export interface InvestigationResult {
  /** Undefined when the duplicate-risk dispatch failed (ok=false). */
  duplicateRisk?: DuplicateRisk;
  findings: AngleFindings[];
  /**
   * #677: disclosure lines from the NEVER CLAIM post-filter (one per
   * dropped angle, naming the matched phrase). Empty when nothing was
   * dropped — the driver renders this into the drafted body and the
   * result details, never silently.
   */
  neverClaimDisclosure: string[];
}

/**
 * The duplicate-risk prompt. The mechanical inventory is only a mechanical
 * scan: it cannot see semantic overlap a different title hides, so the risk
 * call goes to an explore. SECURITY (six-lens re-review, PR #640): the
 * descriptor is untrusted operator input — the same DESCRIPTOR_DATA_FRAMING
 * constant as the angle and gap-gate prompts, one copy.
 *
 * REVERSAL vocabulary (vipune fixture run, C6): a CLOSED issue whose work
 * LANDED is prior art or a reversal target, never duplicate work — the old
 * prompt hard-blocked a deliberate reversal of a completed decision with no
 * path to filing. And the operator's context is threaded in so an explicit
 * acknowledgment ("this deliberately reverses #103") deterministically
 * reaches the risk child — the no-knob override path.
 *
 * #1856: `sourceIssue` names the existing issue this plan is FOR. Its descriptor
 * is a near-copy of that issue's own title, so without this line the child's
 * most confident duplicate is the ticket under plan. Absent → the prompt is
 * byte-identical to what it was before.
 */
export function duplicateRiskPrompt(
  type: PlanType,
  descriptor: string,
  inv: MechanicalInventory,
  priorContext: { source: string; fact: string }[] = [],
  forbiddenPhrases?: string[],
  sourceIssue?: number,
): string {
  const forbidden = forbiddenPhrasesBlock(forbiddenPhrases ?? []);
  const prior =
    priorContext.length > 0
      ? ` PM has already established: ${renderPriorContext(priorContext)} — if this context explicitly acknowledges an issue as prior art or a deliberate reversal, that issue is RECONCILED and must not raise the risk above medium.`
      : "";
  const subject =
    sourceIssue === undefined
      ? ""
      : ` This check covers the plan of EXISTING issue #${sourceIssue} (or one of its own split children, written #${sourceIssue}-1, #${sourceIssue}-2 …): that issue and its split children are the SUBJECT of this plan, never its duplicate — do not report them as duplicates, and a verdict that names nothing else is low or none.`;
  return [
    `${DESCRIPTOR_DATA_FRAMING}DUPLICATE RISK CHECK for a proposed ${type} ticket: "${descriptor}".`,
    `Mechanical scan found: ${
      inv.related.map((r) => `#${r.number} (${r.state}) ${r.title}`).join("; ") ||
      "no related issues"
    }.${prior}${forbidden}${subject}`,
    "Assess whether filing this ticket would duplicate existing work — check open + recently closed issues (gh issue list --state all --search '<keyword>' --limit 10) and vipune.",
    "high means DUPLICATE: an OPEN issue (or closed-but-unlanded work) already covers this scope. A CLOSED issue whose work landed is prior art or a REVERSAL target, not a duplicate — report medium at most and NAME the issue so the spec can reference it.",
    "Return a short verdict: DUPLICATE_RISK: high|medium|low|none plus 2-3 sentences of rationale with issue numbers.",
  ].join(" ");
}

/**
 * Parse the duplicate-risk child's marker line (absent marker → medium).
 *
 * Two hardenings from the live vipune fixture run (verified 2026-09-09):
 * the reply often ECHOES the prompt's template ("DUPLICATE_RISK:
 * high|medium|low|none") before the real verdict, and a first-match parse
 * read the echoed "high" as a HIGH hard-stop. A verdict immediately
 * followed by `|` is the menu, not a verdict, and the LAST real marker
 * wins (the verdict line closes the reply). The rationale is taken from
 * AROUND the matched marker rather than a blind head-slice, so the
 * operator sees the reasoning, not the child's task restatement.
 */
export function parseDuplicateRisk(text: string): DuplicateRisk {
  const re = /DUPLICATE_RISK\s*[:—-]\s*(high|medium|low|none)\b(?!\s*\|)/gi;
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  if (!last) return { level: "medium", rationale: text.slice(0, 400) };
  return {
    // The alternation admits exactly the four levels, so the captured group is
    // already a `DuplicateRiskLevel` once lower-cased; the cast records that the
    // regex and the union are one list, not two.
    level: (last[1] ?? "medium").toLowerCase() as DuplicateRiskLevel,
    rationale: text.slice(last.index, last.index + 400),
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
  pi: DispatchHost,
  args: {
    type: PlanType;
    descriptor: string;
    repoRoot: string;
    inv: MechanicalInventory;
    priorContext: { source: string; fact: string }[];
    codeIdentifiers: string[];
    pinnedSubIssues?: number;
    /** #677: the operator's verbatim forbidden phrases (NEVER CLAIM block). */
    forbiddenPhrases?: string[];
    /**
     * #1856: the existing issue this plan is FOR. Its rows leave the candidate
     * set the risk child sees, and a HIGH that names only it (or its split
     * children, or closed prior art) is downgraded. Absent → the pre-#1856
     * prompt and verdict, byte for byte.
     */
    sourceIssue?: number;
    /**
     * #893 — injectable stat of the plan-reporter extension path. A rejecting
     * stat makes the phase fail before ANY dispatch (duplicate-risk included)
     * with the named "reporter extension missing" error. Production passes
     * none (the real fs.stat is used); tests pass a stub.
     */
    statFn?: (p: string) => Promise<unknown>;
    /**
     * #1541 review (MEDIUM) — the async job's signal, threaded to every child
     * of the barrier so `dispatch_kill` stops live children instead of only
     * refusing the next phase. Absent → the pre-#1541 shape (tests, and any
     * caller with no job to abort).
     */
    signal?: AbortSignal;
  },
): Promise<InvestigationResult> {
  const { type, descriptor, repoRoot, inv, priorContext, codeIdentifiers } = args;
  // #893 — pre-spawn stat of the plan-reporter extension. The Phase-2 angle
  // children carry PLAN_EXTRA_ARGS; the duplicate-risk child carries only
  // --no-skills (no reporter). The check is keyed off the actual reporter
  // path, so marker-line children are unaffected. Failing here is cheaper
  // than spending a dispatch on a child that can never report.
  const reporterPath = reporterPathFromArgs(PLAN_EXTRA_ARGS);
  if (reporterPath) {
    try {
      await statReporterPath(reporterPath, args.statFn);
    } catch (err) {
      // #893 — a missing reporter path is a STRUCTURED all-angles-failed
      // result, not an uncaught throw: every angle is marked failed with
      // the named error (so the driver's existing all-angles-failed halt
      // carries it in failedAngles), and nothing is dispatched — the
      // duplicate-risk child included, since it shares the fan-out's fate
      // here (no reporter = a broken install, and no partial plan is filed
      // in that state).
      const msg = (err as Error).message;
      trace(`plan-investigate: reporter preflight failed — no dispatch (${msg})`);
      const failed = anglePromptsFor(
        type,
        descriptor,
        priorContext,
        codeIdentifiers,
        args.pinnedSubIssues,
        args.forbiddenPhrases,
      ).map((a) => ({
        name: a.name,
        ok: false,
        text: "",
        toolUses: [] as PlanItemKind[],
        failure: msg,
      }));
      return { findings: failed, neverClaimDisclosure: [] };
    }
  }
  const angles = anglePromptsFor(
    type,
    descriptor,
    priorContext,
    codeIdentifiers,
    args.pinnedSubIssues,
    args.forbiddenPhrases,
  );

  // #1856: the risk child's candidate set. The SUBJECT of the plan is never its
  // duplicate, so the source issue (and its split children) leave both the
  // scanned rows and the "PM has already established" rows. Only this child's
  // view changes — the gap gate and the drafted body still see the full
  // inventory, which is where naming the planned issue is useful rather than
  // misleading.
  const sourceIssue = args.sourceIssue;
  const riskInv =
    sourceIssue === undefined ? inv : { ...inv, related: relatedExcludingSource(inv, sourceIssue) };
  const riskPrior = priorContextExcludingSource(priorContext, sourceIssue);
  // What the inventory can tell the post-filter about each named issue (its
  // state decides the CLOSED-prior-art rule). Built from the FULL inventory: a
  // closed prior-art issue is not the subject and stays knowable. The state is
  // NORMALISED HERE and nowhere else: `mapGhIssue` upper-cases and `mapGlIssue`
  // maps `opened`/`closed`, and a cached entry carries whatever bytes a
  // hand-edited file held — so this is the one site that decides what a state
  // IS, and every rule downstream compares exact values instead of re-casing.
  const known = new Map<number, KnownIssue>();
  for (const r of inv.related) {
    known.set(r.number, { state: normaliseIssueState(r.state), title: r.title });
  }

  const duplicatePromise = dispatch(
    pi,
    {
      role: "explore",
      prompt: duplicateRiskPrompt(
        type,
        descriptor,
        riskInv,
        riskPrior,
        args.forbiddenPhrases,
        sourceIssue,
      ),
      cwd: repoRoot,
    },
    {
      label: "plan-duplicate-risk",
      timeoutMs: PLAN_DISPATCH_TIMEOUT_MS,
      ...(args.signal ? { signal: args.signal } : {}),
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
          ...(args.signal ? { signal: args.signal } : {}),
          extraArgs: PLAN_EXTRA_ARGS,
        },
      ).then((r) => {
        const toolUses = r.toolUses; // #633: DispatchResult declares toolUses: unknown[] (non-optional)
        // #893 — raw count of report_plan_item toolUses (schema-valid or not),
        // distinct from the post-extraction count. Zero raw calls means the
        // child never called the reporter at all (possibly never loaded);
        // >0 with zero valid items means the calls were schema-invalid.
        const rawCalls = toolUses.filter((tu) => {
          if (!tu || typeof tu !== "object") return false;
          return (tu as { name?: string }).name === "report_plan_item";
        }).length;
        // Structured-first (D8, fail-closed): an angle is "ok" only when the
        // dispatch succeeded AND it produced at least one structured item.
        const ok = r.ok && !r.errorStop && toolUses.length > 0;
        // Disclosure (vipune fixture run, C3/C5): a failed angle used to
        // vanish silently from the drafted body and the result. The failure
        // reason travels on the finding so both render sites can show the
        // hole (a timed-out child exits 143 under the timeout above).
        const failure = ok
          ? undefined
          : !r.ok
            ? `dispatch failed or timed out (exit ${r.exitCode ?? "?"}${r.exitCode === 143 ? " — killed at the dispatch bound" : ""})`
            : r.errorStop
              ? "provider error mid-stream"
              : rawCalls === 0
                ? "0 report_plan_item calls — reporter may not have loaded (check pi version / --extension)"
                : "returned no structured items (prose only)";
        return {
          name: a.name,
          ok,
          text: r.text,
          toolUses: extractPlanItems(toolUses, a.name),
          failure,
        };
      }),
    ),
  );

  const [dup, rawFindings] = await Promise.all([duplicatePromise, anglesPromise]);

  // #677 — the deterministic NEVER CLAIM post-filter, applied AFTER the
  // barrier and BEFORE the driver's all-angles-failed guard (a dropped
  // item that emptied an angle is the same as a failed angle for that
  // guard's purposes, and the disclosure is the operator's only record
  // of why). Verbatim-only, disclosed, never silent.
  const filtered = applyNeverClaimFilter(rawFindings, args.forbiddenPhrases ?? []);
  if (filtered.droppedCount > 0) {
    trace(
      `plan-investigate: NEVER CLAIM filter dropped ${filtered.droppedCount} item(s) across ${filtered.findings.length} angle(s)`,
    );
  }

  let duplicateRisk: DuplicateRisk | undefined;
  // Structured-first, as for the angles (#893): a reply that failed or errored
  // mid-stream is NOT a verdict, so no value is produced for the driver's halt
  // rule to read — the same gate the angles get.
  //
  // #1856 review round 2 adds `killCause === undefined` to that gate. A child
  // killed at a bound (timeout, inactivity, loop detector) can exit reporting
  // `ok` with a half-written reply, and `parseDuplicateRisk` defaults an absent
  // marker to `medium` — so a killed child used to read as a clean
  // "no duplicate risk" and the plan filed. A kill is not a verdict, and here it
  // also disqualifies the post-filter: a HIGH the child was killed while writing
  // keeps its halt rather than being talked out of one by an incomplete rationale.
  if (dup.ok && !dup.errorStop && dup.killCause === undefined) {
    // #1856 lens round 1 (H1) — the post-filter reads the child's FULL reply via
    // `fullText`, not the 400-char display slice `parseDuplicateRisk` keeps: an
    // OPEN duplicate named past that cut would otherwise be invisible to the
    // fail-closed rules, and a HIGH that halts on main would be downgraded here
    // only because the evidence fell off the end of a window.
    const parsed = parseDuplicateRisk(dup.text);
    duplicateRisk = downgradeSelfDuplicate(parsed, {
      fullText: dup.text,
      ...(sourceIssue === undefined ? {} : { sourceIssue }),
      known,
    });
    traceDuplicateRisk(duplicateRisk, {
      kept: duplicateRisk === parsed,
      ...(sourceIssue === undefined ? {} : { sourceIssue }),
      fullText: dup.text,
    });
  } else {
    // A non-fatal kill (the child ended as DONE at its bound) still leaves no
    // verdict here, and `traceWarn` rather than `trace` is the point: this run
    // proceeds with NO duplicate check, which is the one condition under which a
    // duplicate reaches an issue, so it is not an ordinary informational line.
    traceWarn(
      `plan-driver: duplicate-risk dispatch produced no verdict (ok=${dup.ok}, errorStop=${dup.errorStop ? dup.errorStop.reason : "none"}, killCause=${dup.killCause ?? "none"}) — proceeding without a risk verdict`,
    );
  }
  return {
    duplicateRisk,
    findings: filtered.findings,
    neverClaimDisclosure: filtered.disclosure,
  };
}
