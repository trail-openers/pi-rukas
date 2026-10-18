/**
 * plan-tool — the compiled `start_plan_driver` tool.
 *
 * `/plan` used to be a 473-line prose body sent into PM's context, which PM
 * then executed by hand — with a self-judged "triviality test" and no gate
 * between that self-judgment and `gh issue create`. The fix follows the
 * `start_work_driver` precedent (work-tool.ts): a compiled driver PM calls
 * instead of a prose flow PM re-implements, plus the mode-independent
 * issue-creation guard (issue-creation-guard.ts) that makes the replacement
 * safe by closing every other door.
 *
 * The driver (plan-driver.ts) runs the five-phase pipeline:
 *
 *   Phase 0  Classify   regex on the descriptor (or the `type` param)
 *   Phase 1  Inventory  vipune + `gh issue list` run by the driver; one
 *                       explore dispatch for duplicate risk
 *   Phase 2  Investigate type-specialised explore angles in parallel
 *   Phase 3  Draft      the driver assembles the structured body
 *   Phase 4  Gap gate   one adversarial-developer dispatch; CRITICAL gets
 *                       one corrective pass (CRITICAL-only terminal rule,
 *                       #664 transposed — HIGH/MEDIUM/LOW never re-draft),
 *                       then the residual findings travel with the spec
 *   Phase 5  File       `gh issue create --body-file` via execp
 *
 * **dryRun is the confirmation seam.** `dryRun: true` returns
 * `{ spec, gaps, priorContext, filed: false }` without filing; PM shows the
 * spec + gap disposition to the operator; on confirmation the driver is
 * re-called with `dryRun` omitted and files. Non-resumable by design (a
 * 2-5 minute flow; re-running is cheaper than a state file).
 *
 * #1043: an identical confirm of a FILEABLE dry run files the reviewed spec
 * verbatim (plan-confirm.ts) with no investigation, drafting or gate.
 *
 * **The tool launches; it does not wait (#1044).** The pipeline runs in a
 * background job (`startJob`, `reportKind: "driver"`) and execute() returns a
 * launch notice with the `jobId` immediately — the same contract
 * `start_work_driver` has. A blocking plan run locked the operator out of the
 * PM for 5–45 minutes, which is what they actually complained about. The full
 * rendered result — the exact text this tool used to return, dry-run specs and
 * NOT-FILEABLE blocks included — arrives later as ONE `[ensemble:async]` steer,
 * whether or not the PM is still mid-turn (`deliverAs: "steer"` is inert when
 * idle). A throw inside the job is delivered as a fail report, never lost.
 *
 * The driver's own filing is a child-process exec — exempt from the
 * tool_call guard by construction, exactly like the work driver's
 * mechanized `gh pr create`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { noticeSubject } from "./async-jobs-report.ts";
import { startJob } from "./async-jobs.ts";
import { runPlanPipeline } from "./plan-driver.ts";
import {
  FORBIDDEN_LINE_CHARS,
  MAX_LABELS,
  MAX_MARKER_PAIRS,
  MAX_PROVENANCE_LINE,
  normalizeLabels,
  validateProvenance,
} from "./plan-provenance.ts";
import { DRY_RUN_HEAD, renderPlanResult } from "./plan-report.ts";
import type { PlanDriverInput, PlanResult } from "./plan-types.ts";
import { trace } from "./trace.ts";
import { piSessionHost } from "./work-driver-host.ts";
import { resolveRepoRoot } from "./work-entry.ts";

/**
 * #1044 — the tool's return is a LAUNCH notice, never the spec: a tool result
 * arrives in seconds, and the pipeline takes minutes. So the only thing this
 * text may assert is what every run does whatever it ends up doing. The
 * `dryRun` branch used to say "show this spec to the operator", which read as
 * an instruction to present text that does not exist yet; it now points at the
 * steer instead, and the wording of the dry-run head stays in one place with
 * the renderer (plan-report.ts / DRY_RUN_HEAD).
 */
export function launchNotice(o: {
  jobId: string;
  descriptor: string;
  dryRun: boolean;
  repoRoot: string;
}): string {
  // #1541 review (MEDIUM) — two corrections to what this may promise.
  // (a) Conditional outcome. The dry-run branch used to assert the report
  //     "opens with <DRY_RUN_HEAD> and carries the spec, the gap dispositions
  //     and the digest". A dry run whose gate capped unresolved-CRITICAL, whose
  //     draft failed validation, or whose gap gate was unavailable renders
  //     NOT FILEABLE / PLAN COMPLETED with no digest at all, so the notice was
  //     offering a digest that may not exist. Same for the filing branch.
  // (b) The confirm call is a SECOND launch, and the digest it must echo only
  //     ever comes from the first one's steer — a confirm issued before that
  //     steer arrived has no digest to pass, files nothing verbatim, and pays
  //     for a full pipeline. Say so where the operator reads it.
  const next = o.dryRun
    ? `When the report arrives it says ONE of two things: "${DRY_RUN_HEAD} <digest>" with the spec and the gap dispositions — if the gate passed; or a NOT FILEABLE / PLAN COMPLETED block naming the reason, with NO digest to echo. Show whichever arrived to the operator. Only after that steer has arrived can you re-call with dryRun omitted — and to file the reviewed spec verbatim you must echo the reviewedDigest that steer carried, because that steer is the only place the digest exists; a confirm without it runs the whole pipeline again.`
    : "When the report arrives it says whether the issue was filed and carries the issue URL — or it says the run FAILED / was CANCELLED and names the cause. Until it arrives you have neither verdict nor URL: quote neither.";
  return `pi-rukas: /plan driver started for "${noticeSubject(o.descriptor)}" (jobId: ${o.jobId}, dryRun: ${o.dryRun}, repo: ${o.repoRoot}). ${next} The run takes minutes; end your turn — the [ensemble:async] steer carrying the jobId is the result, not this notice. Do not poll, and do not re-call to check progress.`;
}

/**
 * The shape of a registered `start_plan_driver` tool def — shared with the
 * test harness (plan-test-stubs.ts: invokePlanTool) so the dry-run e2e
 * blocks can drive the tool without the full ExtensionAPI surface.
 */
export interface RegisteredPlanTool {
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown> };
  // The five execute() arguments are NAMED (not `...a: unknown[]`) so the
  // shared harness — plan-test-stubs.ts, driving every dry-run e2e block —
  // can pass the ExtensionContext positionally without the `as any` cast it
  // needed before. #1044 makes the fifth argument matter in a second way: the
  // tool now launches a background job, and a job's report reaches the
  // registered `pi`, not this object — so a test that wants to read its own
  // result registers a stub whose `sendUserMessage` records the delivery.
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;
}

export function registerPlanTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_plan_driver",
    label: "Start /plan Driver",
    description:
      "Launch the compiled /plan pipeline (classify → inventory → type-specialised investigation → draft → adversarial gap gate → file) in the BACKGROUND and file the resulting GitHub issue. This is the ONLY way to create a GitHub issue: direct `gh issue create` (and `gh api` POST to the issues collection) is structurally refused for every role in every mode — the refusal names this tool. RETURNS IMMEDIATELY with a jobId and a launch notice — it does NOT return the spec. The run takes minutes; end your turn and the full result arrives later as one `[ensemble:async]` steer message naming this job (also when you are idle). Never poll or re-call to find out whether it finished. Call with dryRun:true FIRST: the steer then carries { spec, gaps, priorContext, filed:false } without filing; show that spec + gap dispositions to the operator, and on their confirmation re-call with dryRun omitted — that re-call is another launch, and it benefits from the dry run's investigation cache. The result includes issueUrl on success. A dry run reports a reviewedDigest; re-calling with identical inputs (same descriptor, context, type and origin/<default> commit, within the expiry — 2 hours by default) and that digest files the reviewed spec VERBATIM, with no investigation, drafting or gap gate (the result says FILED FROM REVIEWED DRY RUN). Any other call — a changed input, a missing or wrong digest, an expired or non-fileable dry run — runs the full pipeline, which reuses the investigation and re-runs the gate; when that call carried a reviewedDigest and the pipeline drafts a different spec, nothing is filed and the result says THE REVIEWED SPEC CHANGED — show the new spec and ask again. Epic sub-issues at depth >= 3 get a minimal body with a depth-limit note. Gap gate: runs for bug/feature/epic; chore/spike get deterministic validation only. A too-thin descriptor (below the word floor, no code identifier, no context) returns needs-clarification questions without dispatching anything — answer them and re-call. Concurrent launches are allowed; each result names its own descriptor. Non-resumable: a failed run is re-run, not resumed.",
    parameters: Type.Object({
      descriptor: Type.String({
        description: "Ticket descriptor — one or two sentences describing the intended change.",
      }),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("bug"),
            Type.Literal("feature"),
            Type.Literal("epic"),
            Type.Literal("chore"),
            Type.Literal("spike"),
          ],
          {
            description:
              "Override the type classification (default: inferred from the descriptor).",
          },
        ),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Prior /research findings or session facts to treat as established (not re-investigated). Typed directive blocks are the trusted channel: a heading (ACCEPTANCE CRITERIA, PITFALLS/EDGE CASES, OUT OF SCOPE, TEST SURFACE, DECOMPOSITION/SUB-ISSUES, NEVER CLAIM/FORBIDDEN — plain, ##, ===, ** or *-wrapped, ':' optional) opens a block whose bulleted or contiguous lines become that section's items verbatim. A block ends at the next heading, an END fence ('TEST SURFACE END' or a bare END line; BEGIN fences are consumed, never items), or a blank line followed by a non-bullet line — trailing prose after a block stays plain context. NEVER CLAIM items are verbatim forbidden phrases: each structured investigation item whose normalized text contains one as an exact normalized substring is dropped before drafting (disclosed, never silent), the phrases are threaded into every investigation and gap-gate prompt, and the drafted body is asserted phrase-free outside the Prior context inventory section.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Return the structured spec + gap dispositions WITHOUT filing. Call first; on operator confirmation, re-call with dryRun omitted.",
        }),
      ),
      reviewedDigest: Type.Optional(
        Type.String({
          description:
            "The reviewedDigest a dry run reported. Echo it on the confirming call to file that exact reviewed spec verbatim; without it, or on a mismatch, the full pipeline runs. The digest also covers labels and provenance: a confirm that changes either is a digest mismatch and files nothing.",
        }),
      ),
      labels: Type.Optional(
        Type.Array(Type.String(), {
          description: `Labels to create the filed issue with, in the same single forge call — so they are on the issue from its first moment (a follow-up edit leaves a window where an auto-filed ticket reads as manual work to everything watching the tracker). At most ${MAX_LABELS}; each 1-50 chars matching ^[A-Za-z0-9][A-Za-z0-9:._ /-]*$ (spaces and ':' allowed, no comma). Invalid input is refused BEFORE any dispatch with an invalid-input error naming what is wrong. Every label must already exist on the target repo: a missing one halts filing with filingFailure.reason "label-missing" and NOTHING is filed — the driver never creates a label as a side effect of filing. When the repo's label list cannot be read in full (a CLI failure, or more labels than either CLI reads in one page) the halt reason is "label-list-unreadable" instead, and nothing is filed either — the driver never guesses that a label exists. The result gains issueNumber alongside issueUrl. Omit for today's behaviour exactly.`,
        }),
      ),
      provenance: Type.Optional(
        Type.Object(
          {
            line: Type.String({
              description: `One line of at most ${MAX_PROVENANCE_LINE} chars, rendered as the FIRST line of the issue body in italics followed by a blank line. Any '@', '<', '>', backtick, or control / line-terminator character (CR, LF, form feed, NEL, U+2028, U+2029) is REJECTED (not escaped, not stripped), so the line can never mention an account, inject markup, or open a heading of the body the driver did not write.`,
              // The schema MIRRORS `FORBIDDEN_LINE_CHARS` rather than relying on
              // it alone: the validators in plan-provenance.ts are the authority
              // (they produce the named `invalid-input` problems), and this is
              // the second net — a caller reading the tool schema sees the shape
              // it must send, and a caller that bypasses the validators (a future
              // in-process path) still cannot get a terminator into the first line.
              // A `\n` here is a heading-injection: `"ok\n## Open points"` files a
              // section the driver never wrote, under the heading the /work intent
              // gate reads for blocking gaps — and `\f`, U+0085, U+2028 and U+2029
              // do the same in any consumer that honours them as terminators, so
              // the negated class is the WHOLE control range plus the three
              // Unicode separators, not just CR/LF. It is the exported regex's
              // source, so the two cannot drift.
              pattern: `^[^${FORBIDDEN_LINE_CHARS.source.slice(1, -1)}]+$`,
              maxLength: MAX_PROVENANCE_LINE,
            }),
            marker: Type.Record(Type.String(), Type.String(), {
              description: `Structured pairs, rendered as the LAST line of the body as \`<!-- pi-rukas:provenance v1 k1=v1 k2=v2 ... -->\` in sorted key order. At most ${MAX_MARKER_PAIRS}; keys match ^[a-z][a-z0-9_-]{0,31}$, values match ^[A-Za-z0-9._,:/#@+=-]{1,200}$ (no spaces or newlines; '@' IS allowed in a value — the account prohibition is on \`line\` only). Written by code after drafting, never by an LLM stage, and reserved out of the body budget so compaction cannot trim it.`,
            }),
          },
          {
            description:
              "Mark a filed issue as machine-filed: an italic line atop the body and an HTML-comment marker at its foot. Both are appended by code after drafting.",
          },
        ),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      // Pi hands the tool a JSON value. Widening to `Record<string, unknown>`
      // says exactly that — "fields not yet examined" — and every field is then
      // narrowed by a validator before use: `descriptor`/`dryRun`/`reviewedDigest`
      // by the guards here, `labels` by `normalizeLabels` (which rejects a
      // non-array, a non-string member and a sparse array), `provenance` by
      // `validateProvenance` (which requires a plain object with own string
      // keys). An earlier shape-named cast here claimed a `labels: string[]`
      // that nothing had checked yet, which is how a malformed caller would
      // reach the create call with bytes this module never examined.
      const params = raw as Record<string, unknown>;
      const descriptor = params.descriptor;
      if (typeof descriptor !== "string" || descriptor.trim().length === 0) {
        return {
          content: [{ type: "text", text: "start_plan_driver requires a non-empty descriptor." }],
          details: { started: false },
        };
      }
      const dryRun = params.dryRun === true;
      // #1377: labels and provenance are validated here, BEFORE any dispatch.
      // A caller that mistypes a label name gets a named error for the cost of
      // one tool call, not a five-minute pipeline that then halts at the forge;
      // and nothing can reach the create call with bytes this module did not
      // check (a label with a comma would break glab's comma-separated list, a
      // '@' or a newline in the line would name an account or open a heading in
      // visible text).
      const labelCheck = normalizeLabels(params.labels ?? []);
      if (!labelCheck.ok) {
        return invalidInput("labels", labelCheck.problems);
      }
      const provenanceCheck =
        params.provenance === undefined
          ? { ok: true as const, provenance: undefined }
          : validateProvenance(params.provenance);
      if (!provenanceCheck.ok) {
        return invalidInput("provenance", provenanceCheck.problems);
      }
      const labels = labelCheck.labels;
      const provenance = provenanceCheck.provenance;
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      trace(
        `start_plan_driver → descriptor="${descriptor.slice(0, 60)}" type=${String(params.type ?? "inferred")} dryRun=${dryRun} labels=${labels.length} provenance=${provenance ? "yes" : "no"} repoRoot=${repoRoot}`,
      );
      // #1044 — launch, don't wait. The whole pipeline runs inside the job, so
      // a throw anywhere in it reaches the job's rejection path and is
      // delivered as a bounded fail report rather than disappearing with the
      // tool call. `skipDeck`: the pipeline's own investigation / gap-gate
      // children are the real deck rows, and a synthetic row for the parent
      // job would mask them (the same reasoning the work tool's job follows).
      //
      // The job delivers to `pi`, the ExtensionAPI the tool was registered on
      // — the same host `start_work_driver` hands its job (work-tool.ts), so
      // every report-delivering tool resolves against one session. `steer`
      // survives the mid-turn case: a tool call runs during a turn by
      // definition, and the flag queues the message and is inert when idle
      // (agent-message.ts). A test drives the same seam by making the pi stub
      // it registers with answer `sendUserMessage`.
      // The typed view of the call: the four fields the driver reads by name,
      // with the three the validators just narrowed substituted. The cast
      // carries no unchecked field into the driver — `type` is the only one left
      // as the caller wrote it, and the driver re-classifies an unrecognised
      // value.
      const driverInput: PlanDriverInput = {
        ...(params as Omit<PlanDriverInput, "labels" | "provenance" | "descriptor">),
        descriptor,
        labels,
        provenance,
      };
      // #1541 review (MEDIUM) — the job's OWN AbortSignal, not the tool's exec
      // signal. `killJob(jobId)` / `killAllJobs()` (dispatch_kill and
      // session_shutdown) abort that controller, and `runPlanPipeline` checks
      // the signal at its phase boundaries, so an operator can stop a run
      // instead of waiting out the 30-minute per-child bound. The tool's
      // `_signal` is deliberately NOT threaded: Pi drops it the moment
      // execute() returns, and the job outlives the call by minutes.
      const runPlanJob = async (signal: AbortSignal) => {
        const result = await runPlanPipeline(piSessionHost(pi), driverInput, repoRoot, { signal });
        return {
          role: "plan-driver",
          ok: !result.cancelled,
          // A cancelled run is STILL delivered as a report: a silent kill
          // leaves PM waiting for a steer that never arrives, which is the
          // same silent hang #1044 was filed to remove.
          text: renderPlanResult(result, dryRun),
          toolUses: [],
          ms: 0,
          exitCode: result.cancelled ? 143 : 0,
          ...(result.cancelled ? { killCause: "abort" as const } : {}),
          // #1541 review (HIGH) — if the steer never lands, the stand-in names
          // where the answer still lives: the filed issue. A plan that filed is
          // NOT a plan to re-run, so this has to be said by the run that knows.
          ...(result.issueUrl ? { reportWhere: `the filed issue ${result.issueUrl}` } : {}),
        };
      };
      let jobId: string;
      try {
        jobId = startJob(pi, {
          label: "plan-driver",
          role: "plan-driver",
          subject: descriptor,
          skipDeck: true,
          reportKind: "driver",
          work: (signal) => runPlanJob(signal),
        }).jobId;
      } catch (err) {
        // #1541 review (LOW) — startJob throws at its MAX_JOBS cap. Letting it
        // propagate surfaces async-jobs internals as a tool failure; the caller
        // gets a NAMED refusal with `started: false`, the same shape the
        // invalid-input refusal above uses.
        return jobSaturation(err);
      }
      return {
        content: [
          {
            type: "text",
            text: launchNotice({ jobId, descriptor, dryRun, repoRoot }),
          },
        ],
        // #1295 — the async-result contract every report-delivering tool keeps:
        // `async: true` plus the jobId the steer's header will name.
        // #1541 review — `descriptor` is clamped to the same 80 chars the notice
        // prints. It is an LLM-written string that lands in tool output and then
        // in the transcript verbatim; an unbounded one puts the caller's whole
        // prompt into the details block for no benefit, since the value is an
        // identifier for the operator to match a steer to a run, not a document.
        details: {
          started: true,
          async: true,
          jobId,
          dryRun,
          descriptor: noticeSubject(descriptor),
        },
      };
    },
  });
}

/**
 * #1377: the pre-dispatch rejection of malformed labels / provenance. A NAMED
 * error (`invalid-input`) with every problem listed, and `started: false` so a
 * caller can tell a refused call from a run that filed nothing.
 */
function invalidInput(field: string, problems: string[]) {
  const text = `start_plan_driver refused: invalid ${field}. ${problems.join("; ")}`;
  trace(`start_plan_driver: invalid ${field} — ${problems.join("; ")}`);
  return {
    content: [{ type: "text" as const, text }],
    details: { started: false, error: `invalid-input: ${field}`, problems },
  };
}

/**
 * #1541 review (LOW): the named refusal when `startJob` is at its MAX_JOBS
 * cap. The registry throws a raw Error (every other startJob caller relies on
 * that — `test-async-dispatch.ts` pins the message), so the tool path
 * translates it into the shape its callers already read: `started: false` plus
 * an `error` naming the cause.
 */
function jobSaturation(err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  trace(`start_plan_driver refused: ${detail}`);
  return {
    content: [{ type: "text" as const, text: `start_plan_driver refused: ${detail}` }],
    details: { started: false, error: "jobs-saturated" },
  };
}
