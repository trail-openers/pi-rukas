/**
 * lean/report-handlers — the two steps that REPORT how a run ended.
 *
 * Split from `command.ts` along the seam those steps already had: every other entry of the handler table
 * answers a state by DOING work and returning a verdict, while `handback` and `decline` decide who hears about
 * the verdict. They are the only two handlers that read the host channel, the only two that may claim
 * `posted`, and the only two whose text leaves the process.
 *
 * ONE seam stamps the pair `posted: false` / `channel: "host"` for both steps: the pair is one fact — "who owns
 * this report" and "nothing was sent" — and the projection reads it off the step's record.
 *
 * The channel is read AT REPORT TIME, inside each handler, not when the handlers are built: the reporting steps
 * are the LAST thing a run does, and a host can move `PI_ENSEMBLE_HANDOFF_CHANNEL` between the two.
 */
import { execp } from "../exec.ts";
import { handoffChannel } from "../work-driver-handoff-channel.ts";
import type { HandlerCtx, LeanHandlers } from "./engine.ts";
import { rewindToVerified } from "./handback-rewind.ts";
import type { Rewind } from "./handback-rewind.ts";
import { handbackOutcome } from "./handback.ts";
import { postHandback, postNotReady } from "./io.ts";
import { REPORT_FAILED_KIND } from "./machine.ts";
import type { Outcome, Step } from "./state.ts";
import { oneLine } from "./text-fence.ts";

/**
 * How much of one refused rule the host-channel `decline` body carries, and how much of the joined body the
 * whole record carries. Each rule passes the same `oneLine` every other piece of untrusted prose here goes
 * through, and the joined total is bounded separately: a per-rule clip does not bound a run that refused the
 * spec on a hundred rules.
 */
const DECLINE_RULE_MAX_CHARS = 200;
const DECLINE_BODY_MAX_CHARS = 1000;

/**
 * The newest DECIDED `ready` or `specify` step whose outcome carries `failedRules` — read from the step log,
 * the durable record, rather than from a closure only a live `ready` fills. `specify` is consulted because it
 * is the other state that can refuse a run, and `ready` is asked LAST so its rules shadow an earlier round's.
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
 * The rewind seam one run's handback is driven with: the real executor against the run's own clone, from the
 * repo root.
 */
function rewindFor(ctx: HandlerCtx): (verifiedHead: string) => Promise<Rewind> {
  return (verifiedHead: string) => rewindToVerified(execp, ctx, verifiedHead, { net: true });
}

/**
 * The two reporting handlers, wired to the outside world the command owns.
 */
export function reportHandlers(repoRoot: string, issue: number): LeanHandlers {
  const noPost = async (): Promise<void> => {
    /* the host delivers the body from the result */
  };
  return {
    handback: (ctx: HandlerCtx) =>
      handoffChannel() === "host"
        ? handbackOutcome(ctx, noPost, rewindFor(ctx)).then(stampHost)
        : handbackOutcome(ctx, postHandback, rewindFor(ctx)),
    decline: async (ctx: HandlerCtx) => {
      // From the log, not from a closure: see `failedRulesFromLog`.
      const rules = failedRulesFromLog(ctx.steps);
      if (handoffChannel() === "host") {
        // `done`, so the run still ends `not-ready` at exit 11. The rules ARE the report the host posts, and
        // the stamped pair is what the result's `handoff.body` is built from.
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
        // NOT `done`: the step log memoizes a completed step forever, so a swallowed throw here would read as
        // "the comment was posted" when it meant "the network dropped". `report-failed` records the attempt
        // honestly; the run still ends `not-ready` at exit 11 and it is NOT retried on resume.
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
