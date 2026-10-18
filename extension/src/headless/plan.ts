/**
 * headless/plan — `pi-rukas-headless plan` (headless S6, #1021): one run of
 * the compiled /plan pipeline (runPlanPipeline) on the headless DriverHost.
 *
 *   plan <descriptor> (--dry-run | --file) [--type <t>] [--context <text>]
 *        [--reviewed-digest <d>] [--json]
 *   plan <descriptor> --start … | plan --resume <session> (--answer <file> | --retry | --confirm)
 *
 * The second form is a planning session held over several runs, one turn per
 * run (#1471): its flags and exit codes are in plan-turn.ts.
 *
 * `--dry-run` returns the drafted spec without filing; `--file` files it and
 * the result carries `url`. A `--file` run that echoes a dry run's
 * `reviewedDigest` files that reviewed spec verbatim (plan-confirm.ts).
 *
 * Exit codes:
 *   0   dry run with a fileable spec, or filed
 *  10   duplicate-risk, or a `--file` run that filed nothing without a failure
 *       (the reviewed spec changed: show the new one and ask again)
 *  11   needs-clarification (the JSON carries `questions`)
 *  40   bad arguments, or any other filing failure (`failure.reason` / `detail`)
 */

import { runPlanPipeline } from "../plan-driver.ts";
import { precheckDescriptor } from "../plan-precheck.ts";
import { PLAN_TYPES, type PlanResult, type PlanType, classifyPlanType } from "../plan-types.ts";
import { EXIT } from "./exit-code.ts";
import { isSessionId } from "./plan-session.ts";
import { type TurnArgs, readAnswer, runPlanTurn } from "./plan-turn.ts";
import {
  type ParsedFlags,
  type VerbContext,
  type VerbOutcome,
  badArguments,
  parseFlags,
} from "./verb.ts";

export const PLAN_FLAGS = [
  "--dry-run",
  "--file",
  "--type",
  "--context",
  "--reviewed-digest",
  "--json",
  "--start",
  "--resume",
  "--answer",
  "--retry",
  "--confirm",
] as const;

/** The flags that select a planning session (#1471) instead of a one-shot run. */
const TURN_FLAGS = ["--start", "--resume", "--answer", "--retry", "--confirm"] as const;

interface PlanArgs {
  descriptor: string;
  dryRun: boolean;
  type?: PlanType;
  context?: string;
  reviewedDigest?: string;
}

type TurnArgv =
  | Exclude<TurnArgs, { kind: "answer" }>
  | { kind: "answer"; id: string; answerFile: string };

export function parsePlanArgs(
  argv: readonly string[],
): PlanArgs | { turn: TurnArgv } | { error: string } {
  const p = parseFlags(argv, {
    bool: ["--dry-run", "--file", "--json", "--start", "--retry", "--confirm"],
    value: ["--type", "--context", "--reviewed-digest", "--resume", "--answer"],
  });
  if ("error" in p) return p;
  if (TURN_FLAGS.some((f) => p.bool.has(f) || p.value.has(f))) return parseTurnArgs(p);
  if (p.positional.length !== 1) return { error: "plan needs exactly one descriptor argument" };
  const descriptor = (p.positional[0] as string).trim();
  if (descriptor === "") return { error: "plan needs a non-empty descriptor" };
  const dryRun = p.bool.has("--dry-run");
  if (dryRun === p.bool.has("--file"))
    return { error: "plan needs exactly one of --dry-run or --file" };
  const type = p.value.get("--type");
  if (type !== undefined && !(PLAN_TYPES as readonly string[]).includes(type)) {
    return { error: `unknown plan type "${type}" (one of ${PLAN_TYPES.join(", ")})` };
  }
  return {
    descriptor,
    dryRun,
    type: type as PlanType | undefined,
    context: p.value.get("--context"),
    reviewedDigest: p.value.get("--reviewed-digest"),
  };
}

function parseTurnArgs(p: ParsedFlags): { turn: TurnArgv } | { error: string } {
  if (p.bool.has("--dry-run") || p.bool.has("--file") || p.value.has("--reviewed-digest")) {
    return { error: "--dry-run, --file and --reviewed-digest are not used in a planning session" };
  }
  const type = p.value.get("--type");
  if (type !== undefined && !(PLAN_TYPES as readonly string[]).includes(type)) {
    return { error: `unknown plan type "${type}" (one of ${PLAN_TYPES.join(", ")})` };
  }
  const id = p.value.get("--resume");
  const answerFile = p.value.get("--answer");
  if (p.bool.has("--start")) {
    if (
      id !== undefined ||
      answerFile !== undefined ||
      p.bool.has("--retry") ||
      p.bool.has("--confirm")
    ) {
      return {
        error: "--start begins a session: it takes no --resume, --answer, --retry or --confirm",
      };
    }
    if (p.positional.length !== 1)
      return { error: "plan --start needs exactly one descriptor argument" };
    const descriptor = (p.positional[0] as string).trim();
    if (descriptor === "") return { error: "plan needs a non-empty descriptor" };
    return {
      turn: {
        kind: "start",
        descriptor,
        type: type as PlanType | undefined,
        context: p.value.get("--context"),
      },
    };
  }
  if (id === undefined) return { error: "--answer, --retry and --confirm need --resume <session>" };
  if (!isSessionId(id)) return { error: `"${id}" is not a session id` };
  if (p.positional.length > 0 || type !== undefined || p.value.has("--context")) {
    return { error: "--resume takes no descriptor, --type or --context: the session has them" };
  }
  const actions = [answerFile !== undefined, p.bool.has("--retry"), p.bool.has("--confirm")];
  if (actions.filter(Boolean).length !== 1) {
    return { error: "--resume needs exactly one of --answer <file>, --retry or --confirm" };
  }
  if (answerFile !== undefined) return { turn: { kind: "answer", id, answerFile } };
  return { turn: { kind: p.bool.has("--retry") ? "retry" : "confirm", id } };
}

/** The exit code and status a plan result maps to. */
export function planExit(r: PlanResult, dryRun: boolean): { exitCode: number; status: string } {
  const reason = r.filingFailure?.reason;
  if (reason === "needs-clarification") return { exitCode: EXIT.clarification, status: reason };
  if (reason === "duplicate-risk") return { exitCode: EXIT.handoff, status: reason };
  if (reason !== undefined) return { exitCode: EXIT.refused, status: "failed" };
  if (dryRun) return { exitCode: EXIT.merged, status: "dry-run" };
  if (r.filed) return { exitCode: EXIT.merged, status: "filed" };
  return { exitCode: EXIT.handoff, status: "not-filed" };
}

export async function runPlanVerb(argv: readonly string[], ctx: VerbContext): Promise<VerbOutcome> {
  const args = parsePlanArgs(argv);
  if ("error" in args) return badArguments(args.error);
  if ("turn" in args) {
    const t = args.turn;
    if (t.kind !== "answer") return runPlanTurn(t, ctx);
    const answer = await readAnswer(t.answerFile);
    if (answer.text === undefined) return badArguments(answer.error ?? "no answer");
    return runPlanTurn({ kind: "answer", id: t.id, answer: answer.text }, ctx);
  }
  ctx.host.sendUserMessage(`plan: ${args.dryRun ? "dry run" : "file"} — ${args.descriptor}`, {
    deliverAs: "steer",
  });
  const result = await runPlanPipeline(ctx.host, args, ctx.repoRoot);
  const { exitCode, status } = planExit(result, args.dryRun);
  ctx.host.sendUserMessage(`plan: ${status} (exit ${exitCode})`, { deliverAs: "steer" });
  // The precheck is pure: re-running it recovers the questions the halt's spec text lists.
  const questions =
    status === "needs-clarification"
      ? precheckQuestions(args.descriptor, args.type, args.context)
      : undefined;
  return {
    exitCode,
    doc: {
      subcommand: "plan",
      exitCode,
      status,
      mode: args.dryRun ? "dry-run" : "file",
      ...result,
      ...(result.issueUrl ? { url: result.issueUrl } : {}),
      ...(result.filingFailure ? { failure: result.filingFailure } : {}),
      ...(questions ? { questions } : {}),
    },
  };
}

function precheckQuestions(descriptor: string, type?: PlanType, context?: string): string[] {
  const pre = precheckDescriptor(classifyPlanType(descriptor, type), descriptor, context);
  return pre.ok ? [] : pre.questions;
}
