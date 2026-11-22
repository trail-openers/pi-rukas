/**
 * lean-tool — `start_lean_driver`, the agent-callable start of the lean /work engine.
 *
 * `/work-lean` and `pi-rukas-headless work-lean` are the operator's two ways in; an orchestrating
 * agent had only `start_work_driver`, which runs the other engine. This tool calls the SAME entry
 * point the slash command calls (`runWorkLean`) inside a background job, and the run's outcome
 * arrives as one `[ensemble:async]` steer — the contract `start_work_driver` and
 * `start_research_driver` keep.
 *
 * It adds no policy. The trust mode is the session's (`headless: !ctx.hasUI`, as
 * `start_work_driver` passes it), so a tool-launched run is gated exactly as `/work-lean` from the
 * same session. There is no merge parameter: `land` reads `.pi/work.json` `autoMerge` at the
 * run's base, and nothing an LLM writes reaches it. `specIntake` travels as a value into this
 * run's resolver and never touches `process.env`, which would arm every later run in the host.
 *
 * Three answers come back without a launch: a lock this tool's own run holds, a lock some other
 * run holds (the slash command, another session, another process), and a state file that already
 * records a finished run. The lock check is a courtesy read; `acquireLock` inside the engine stays
 * the authority, so a run that starts in between is refused there and reported as a crash.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setJobIssues } from "./async-jobs-registry.ts";
import { startJob } from "./async-jobs.ts";
import { runWorkLean } from "./lean/command.ts";
import { MINUTE_MS } from "./lean/deadline.ts";
import { engineFacts } from "./lean/engine-facts.ts";
import { lockHolder } from "./lean/lock.ts";
import { verifiedPosition } from "./lean/resume.ts";
import { SPEC_INTAKE_VALUES, type SpecIntake } from "./lean/spec-intake-switch.ts";
import { leanLockFile, leanStateFile, loadRun } from "./lean/state.ts";
import { oneLine } from "./lean/text-fence.ts";
import { trace } from "./trace.ts";
import { resolveRepoRoot } from "./work-entry.ts";

/** The run seam: `runWorkLean`'s signature, so a test drives the tool without spawning children. */
export type RunLean = typeof runWorkLean;

interface LeanToolParams {
  issue: number;
  specIntake?: SpecIntake;
  timeoutMinutes?: number;
}

const refused = (text: string, reason: string) => ({
  content: [{ type: "text" as const, text: `start_lean_driver refused: ${text}` }],
  details: { started: false, reason },
});

/** The argument rules of the headless verb, stated once for the tool's three inputs. */
function argumentProblem(p: LeanToolParams): string | undefined {
  if (!Number.isInteger(p.issue) || p.issue <= 0) return "issue must be a positive integer";
  if (p.specIntake !== undefined && !SPEC_INTAKE_VALUES.includes(p.specIntake))
    return `specIntake must be one of ${SPEC_INTAKE_VALUES.join(", ")}`;
  if (
    p.timeoutMinutes !== undefined &&
    (!Number.isFinite(p.timeoutMinutes) || p.timeoutMinutes <= 0)
  )
    return "timeoutMinutes needs minutes > 0";
  return undefined;
}

export function registerLeanTool(pi: ExtensionAPI, run: RunLean = runWorkLean): void {
  /** Issues whose run this tool started in this session and that have not settled yet → jobId. */
  const running = new Map<number, string>();
  pi.registerTool({
    name: "start_lean_driver",
    label: "Start /work-lean Run",
    description:
      "Start the lean /work engine for ONE issue — the same engine the /work-lean slash command runs (ready → specify → build → verify → review → publish → ci → land, driven by the issue's pi-spec v1 contract). Returns a launch notice at once; the run continues in the background and its outcome (landed, handed-back, not-ready, or crashed) arrives as one [ensemble:async] steer naming the issue. Do not poll .pi/lean-state/ and do not re-call to check progress. Refuses an issue whose lean run is already in progress. Merge authority is not a parameter: the land step reads .pi/work.json autoMerge at the run's base.",
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1, description: "The issue number. One issue per run." }),
      specIntake: Type.Optional(
        Type.Union([Type.Literal("require"), Type.Literal("derive")], {
          description:
            "require (the issue must carry a pi-spec v1 block) or derive (a ticket with no block gets one derived inside the run). For this run only; absent resolves from PI_ENSEMBLE_LEAN_SPEC_INTAKE, then .pi/work.json, then require.",
        }),
      ),
      timeoutMinutes: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          description:
            "Whole-run deadline in minutes, as the headless --timeout: no new step starts once it is inside the handoff allowance. A resumed run keeps the deadline it already recorded.",
        }),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      const p = raw as LeanToolParams;
      const problem = argumentProblem(p);
      if (problem !== undefined) return refused(problem, "bad-arguments");
      const { issue } = p;
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      const lock = leanLockFile(repoRoot, issue);
      const ours = running.get(issue);
      if (ours !== undefined)
        return refused(
          `#${issue} is already running — a run this tool started in this session (job ${ours}) holds ${lock}`,
          "in-progress",
        );
      const holder = lockHolder(repoRoot, issue);
      if (holder !== undefined)
        return refused(
          `#${issue} is already running — ${lock} is held by a run this tool did not start (the /work-lean command, another session or another process; owner ${holder})`,
          "in-progress",
        );
      // A finished run is answered from its record, judged as the engine judges it: the stamped
      // result is a cache, so it counts only when the step log replays to it. Anything else
      // (unreadable, inconsistent, unearned) is launched, and the engine's refusal is the steer.
      const file = leanStateFile(repoRoot, issue);
      let finished: { state: string; result: { code: number; reason: string } } | undefined;
      try {
        const run = loadRun(repoRoot, issue);
        const state = run?.result && verifiedPosition(file, run).state;
        if (run?.result && state && !engineFacts.stampedResultRefusal(file, state, run))
          finished = { state, result: run.result };
      } catch {
        finished = undefined;
      }
      if (finished !== undefined) {
        const text = `lean run #${issue} already finished: ${finished.state} (exit ${finished.result.code}) — ${oneLine(finished.result.reason, 300)}. Recorded in ${file}; nothing was started.`;
        return {
          content: [{ type: "text", text }],
          details: { started: false, reason: "finished" },
        };
      }
      const opts = {
        headless: !ctx.hasUI,
        ...(p.specIntake === undefined ? {} : { specIntake: p.specIntake }),
        ...(p.timeoutMinutes === undefined ? {} : { timeoutMs: p.timeoutMinutes * MINUTE_MS }),
      };
      const report = (ok: boolean, text: string, killed = false) => ({
        role: "lean-driver",
        ok: ok && !killed,
        text,
        toolUses: [],
        ms: 0,
        exitCode: killed ? 143 : ok ? 0 : 1,
        ...(killed ? { killCause: "abort" as const } : {}),
      });
      let jobId: string;
      try {
        jobId = startJob(pi, {
          label: "lean-driver",
          role: "lean-driver",
          subject: `#${issue}`,
          reportKind: "driver",
          reportWhere: `the lean state file ${leanStateFile(repoRoot, issue)}`,
          // The job's kill reaches the engine's step boundaries; the run still settles, so its
          // handed-back record is what the steer reports, and the job reads as killed unless the
          // run landed before the kill reached it.
          work: async (signal) => {
            try {
              const { summary, result } = await run(repoRoot, issue, { ...opts, signal });
              return report(
                true,
                `lean run #${issue}: ${result.state} — ${summary}`,
                signal.aborted && result.state !== "landed",
              );
            } catch (err) {
              const why = oneLine(err instanceof Error ? err.message : String(err), 300);
              return report(false, `lean run #${issue}: crashed — ${why}`);
            } finally {
              running.delete(issue);
            }
          },
        }).jobId;
      } catch (err) {
        return refused(err instanceof Error ? err.message : String(err), "jobs-saturated");
      }
      running.set(issue, jobId);
      setJobIssues(jobId, [issue]);
      trace(`start_lean_driver → job ${jobId} for #${issue}`);
      return {
        content: [
          {
            type: "text",
            text: `pi-rukas: lean run started for #${issue} (jobId: ${jobId}). Its outcome — landed, handed-back, not-ready, or crashed — arrives as one [ensemble:async] steer naming this job. Until then there is no outcome to quote; end your turn, and do not poll .pi/lean-state/ or re-call to check progress.`,
          },
        ],
        // #1295 — the async-result contract every report-delivering tool keeps.
        details: { started: true, async: true, jobId, issue },
      };
    },
  });
}
