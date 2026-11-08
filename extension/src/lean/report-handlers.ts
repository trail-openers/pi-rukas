/**
 * lean/report-handlers — the two steps that REPORT how a run ended (#1920 item 3).
 *
 * Split from `command.ts` along the seam those steps already had: every other
 * entry of the handler table answers a state by DOING work and returning a
 * verdict, while `handback` and `decline` decide who hears about the verdict.
 * They are the only two handlers that read the host channel, the only two that
 * may claim `posted`, and the only two whose text leaves the process — so the
 * whole "who owns the report" contract lives in one file a reader of
 * `headless/work-lean-handoff.ts` can open.
 *
 * ONE seam stamps the pair `posted: false` / `channel: "host"` for both steps,
 * rather than each claiming a channel for itself: the pair is one fact — "who
 * owns this report" and "nothing was sent" — and the projection reads it off the
 * step's record, so a projection that re-read the environment could not disagree
 * with what this run actually did.
 *
 * The channel is read AT REPORT TIME, inside each handler, not when the handlers
 * are built: the reporting steps are the LAST thing a run does, long after the
 * wiring was assembled, and a host can move `PI_ENSEMBLE_HANDOFF_CHANNEL` between
 * the two. A build-time read would report the channel as it stood at assembly.
 */

import { handoffChannel } from "../work-driver-handoff-channel.ts";
import type { HandlerCtx, LeanHandlers } from "./engine.ts";
import { handbackOutcome } from "./handback.ts";
import { postHandback, postNotReady } from "./io.ts";
import { REPORT_FAILED_KIND } from "./machine.ts";
import type { Outcome, Step } from "./state.ts";
import { oneLine } from "./text-fence.ts";

/**
 * How much of one refused rule the host-channel `decline` body carries, and how
 * much of the joined body the whole record carries.
 *
 * The rules are a child's text destined for the host's document, so each passes
 * the same `oneLine` every other piece of untrusted prose here goes through, and
 * the joined total is bounded separately: a per-rule clip does not bound a run
 * that refused the spec on a hundred rules.
 */
const DECLINE_RULE_MAX_CHARS = 200;
const DECLINE_BODY_MAX_CHARS = 1000;

/**
 * The newest DECIDED `ready` or `specify` step whose outcome carries
 * `failedRules` — read from the step log, which is the durable record, rather
 * than from a closure that only a live `ready` fills. A run that crashed
 * between `ready` and `decline` resumes with nothing in the closure, and a
 * comment that said "ready never ran" on an issue whose spec had been refused
 * for three named rules would be both wrong and unrecoverable: the step log
 * already records the outcome that decided the verdict, so the comment posts
 * exactly those rules whether this process ran `ready` or not.
 *
 * `specify` is consulted as well as `ready` because it is the other state that
 * can refuse a run (`no-red-test`), and `ready` is asked LAST so its rules
 * shadow an earlier round's — a run whose `ready` passed after an earlier
 * refusal is not a run that posts the old rules.
 */
function failedRulesFromLog(steps: Step[]): string[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (step.state !== "ready" && step.state !== "specify") continue;
    const rules = step.outcome.failedRules;
    if (Array.isArray(rules) && rules.length > 0) return rules;
  }
  return ["no failed rule was recorded on the step log"];
}

/** The one place a reporting step's channel and delivery claim are written. */
function stampHost(outcome: Outcome): Outcome {
  return { ...outcome, posted: false, channel: "host" };
}

/**
 * The two reporting handlers, wired to the outside world the command owns:
 * `repoRoot`/`issue` are what a post is addressed to.
 */
export function reportHandlers(repoRoot: string, issue: number): LeanHandlers {
  const noPost = async (): Promise<void> => {
    /* the host delivers the body from the result */
  };
  return {
    handback: (ctx: HandlerCtx) =>
      handoffChannel() === "host"
        ? handbackOutcome(ctx, noPost).then(stampHost)
        : handbackOutcome(ctx, postHandback),
    decline: async (ctx: HandlerCtx) => {
      // From the log, not from a closure: see `failedRulesFromLog`.
      const rules = failedRulesFromLog(ctx.steps);
      if (handoffChannel() === "host") {
        // `done`, so the run still ends `not-ready` at exit 11: the spec refused
        // it whatever channel the reason travels on. The rules ARE the report the
        // host posts (a delivery note is not the body), and the stamped pair is
        // what the result's `handoff.body` is built from.
        return stampHost({
          kind: "done",
          reason: oneLine(
            rules.map((rule) => oneLine(rule, DECLINE_RULE_MAX_CHARS)).join("; "),
            DECLINE_BODY_MAX_CHARS,
          ),
        });
      }
      try {
        await postNotReady(repoRoot, issue, rules);
        // The comment reached the forge — the typed claim `leanHandoff` reads.
        return { kind: "done", posted: true, channel: "forge" as const };
      } catch (err) {
        // NOT `done`: the step log memoizes a completed step forever, so a
        // swallowed throw here would read as "the comment was posted" when it
        // meant "the network dropped". `report-failed` is the kind that records
        // the attempt honestly: the run still ends `not-ready` at exit 11 — the
        // spec refused it whether or not the forge took the comment — and the
        // reason on the record says the comment never went out. It is NOT
        // retried on resume: the step log and the reason are the record.
        return {
          kind: REPORT_FAILED_KIND,
          posted: false,
          channel: "forge" as const,
          reason: `comment not posted: ${(err as Error).message}`,
        };
      }
    },
  };
}
