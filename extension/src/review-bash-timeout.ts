/**
 * review-bash-timeout — the in-child `tool_call` hook that bounds one bash call
 * for a REVIEWER child (#2140) and, since #2377, for a DEVELOPER child too.
 *
 * A child that never returns from one bash call never returns from its turn
 * either: no steer can land and the whole-child (or, for a lean seat, the
 * step) bound ends the dispatch with no verdict. Measured on lean `specify`:
 * one developer bash call that never returned sat 41 min until the 35-min step
 * bound killed the step. This hook does not kill anything — it lowers
 * `event.input.timeout` to the bound and Pi's own bash tool enforces it,
 * answering the child with the usual "Command timed out after N seconds" error
 * result. The child keeps its turn, the steer arrives, the dispatch still
 * reaches an answer. Because that error text is the operator's evidence the
 * bound fired, there is no killCause, no parent timer and no process kill.
 *
 * TWO ROLES, ONE HANDLER, TWO KNOBS. The role is asked inside the body — the
 * same seam `developer-push-guard.ts` reads it, so the parent session
 * (`PI_ENSEMBLE_ROLE` unset) stays untouched — and each role reads only its
 * own knob: `PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS` (600000) for the reviewer
 * roles, `PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS` (1500000) for the
 * developer. Neither knob can bound the other role's calls, and `ops`,
 * `explore`, the PM session and every other role get no bound at all. A call
 * that genuinely needs longer is the child's to split or background with its
 * own `timeout`; the hook does not raise a ceiling on the operator's behalf.
 *
 * Nested calls — a `bash` a codemode script made, carrying `parentToolCallId` —
 * reach these same handlers, so they are bounded too; the codemode call itself
 * is not a bash call and is left alone.
 *
 * Every seam is read per call, so one environment decides for every process:
 * the harness-set role, the caps master switch that makes every other bound
 * inert, and the knob itself — a whole number of milliseconds whose rounded
 * seconds still fit Pi's bash ceiling (`Number()` alone took `1e308`, a
 * fraction, hex and a digit separator, and a value just under the ms ceiling
 * rounds past it). An invalid non-empty value means NO bound and warns, like
 * the sibling review
 * knobs; empty or unset means the default. The developer reader has one
 * difference, and it is deliberate: `"0"` is NO bound with NO warning, because
 * `0` is how every other knob in this project spells "off" — a warning there
 * would fire on the documented way to turn the arm off.
 * The hook never throws: it registers through `failClosedPi`, whose wrapper
 * turns a thrown handler into a `{ block: true }` refusal, so an operator knob
 * cannot refuse a child's bash call — a write that fails warns, as written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isDeveloperRole, isReviewerRole } from "./review-bounds.ts";
import { trace, traceWarn } from "./trace.ts";

/** Ten minutes: above a per-file test run, far below the 60-min tool-inactivity
 *  bound, inside the 30-min lens bound. */
const DEFAULT_REVIEW_BASH_TIMEOUT_MS = 600_000;

/** Twenty-five minutes: ABOVE the `timeout 1200` suite wrapper the developer
 *  prompt tells the child to type, so that wrapper stays the bound that bites
 *  for a suite shard and this one only catches a call that never returns at all
 *  — and still well inside the develop / lens-fix child bounds, so the call ends
 *  and the child keeps its turn rather than the bound ending the dispatch. */
const DEFAULT_DEVELOPER_BASH_TIMEOUT_MS = 1_500_000;

/** Pi's bash ceiling for `timeout` (its MAX_TIMEOUT_MS): past it the tool throws
 *  `Invalid timeout: maximum is …` instead of running anything, so a knob asking
 *  for it gets no bound. The knob is written as `Math.ceil(ms / 1000)` SECONDS
 *  and Pi re-expands that as `seconds * 1000`, so the ceiling must be judged on
 *  the written value: a whole number of ms can clear the ms ceiling while still
 *  passing the ms test, and the child would get Pi's error rather than a bound.
 *  A whole number of ms is required because `Number()` also takes a sign,
 *  fraction, exponent, hex and digit separators, none of which an operator types
 *  for a bound, and below a second there is no bound worth setting. The ceiling
 *  is stated in MS so the one range test reads in the knob's own unit; the return
 *  is in the SECONDS Pi's bash schema takes; undefined means no bound. */
const MAX_BASH_TIMEOUT_MS = 2_147_483_000;
const MIN_MILLISECONDS = 1000;
const PLAIN_MILLISECONDS = /^\d+$/;

/** The seconds Pi's bash schema takes, or undefined for no bound. `zeroMeansOff`
 *  is the difference between the two knobs: `0` is how every other knob in this
 *  project spells "off", so the developer reader takes it as one silently, while
 *  the reviewer reader keeps its documented promise that `0` is one of the
 *  garbage values that means no bound — as does any value whose rounded seconds
 *  would overshoot Pi's ceiling. */
function boundSeconds(
  text: string,
  name: string,
  defaultMs: number,
  zeroMeansOff: boolean,
): number | undefined {
  if (text === "") return Math.ceil(defaultMs / 1000);
  if (zeroMeansOff && text === "0") return undefined;
  // One range test, not two: a value that is not a whole ms count is NaN and NaN fails this.
  const ms = PLAIN_MILLISECONDS.test(text) ? Number(text) : Number.NaN;
  // The ceiling is judged on the SECONDS actually written, not the ms read: Pi
  // multiplies what it receives back by 1000 and throws past its own maximum.
  const seconds = Number.isNaN(ms) ? Number.NaN : Math.ceil(ms / 1000);
  // A whole ms count can still round UP past Pi's ceiling, so the test reads the
  // written seconds: 2147483001 is a whole count under the ms ceiling yet writes
  // 2147484s, which Pi multiplies back to a value it rejects.
  if (!(ms >= MIN_MILLISECONDS && seconds * 1000 <= MAX_BASH_TIMEOUT_MS)) {
    traceWarn(`${name}=${text.slice(0, 40)} is not a whole ms count in range`);
    return undefined;
  }
  return seconds;
}

export function reviewBashBoundSeconds(): number | undefined {
  return boundSeconds(
    process.env.PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS?.trim() ?? "",
    "PI_ENSEMBLE_REVIEW_BASH_TIMEOUT_MS",
    DEFAULT_REVIEW_BASH_TIMEOUT_MS,
    false,
  );
}

export function developerBashBoundSeconds(): number | undefined {
  return boundSeconds(
    process.env.PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS?.trim() ?? "",
    "PI_ENSEMBLE_DEVELOPER_BASH_TIMEOUT_MS",
    DEFAULT_DEVELOPER_BASH_TIMEOUT_MS,
    true,
  );
}

/**
 * Mutate a bounded role's bash call to run within its own bound; never block it.
 * One handler covers both roles and selects inside — two handlers would be two
 * places for the caps switch, the role read and the never-raise rule to drift.
 */
export function registerReviewBashTimeout(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash" || process.env.PI_ENSEMBLE_DISPATCH_CAPS === "0") return;
    const role = process.env.PI_ENSEMBLE_ROLE ?? "";
    // Read per call: the parent session resolves to an unset role and must stay
    // untouched, and neither role may fall through to the other's knob.
    const reviewer = isReviewerRole(role);
    if (!reviewer && !isDeveloperRole(role)) return;
    const bound = reviewer ? reviewBashBoundSeconds() : developerBashBoundSeconds();
    if (bound === undefined) return;
    const input = event.input as { timeout?: unknown } | undefined | null;
    if (typeof input !== "object" || input === null) return;
    // Only a finite positive timeout the model chose for itself survives (a
    // `timeout 120` it wrote); absent, 0, negative, NaN, a string or over the
    // ceiling is replaced, so an oversized one is clamped too.
    const chosen = input.timeout;
    if (typeof chosen !== "number" || !Number.isFinite(chosen) || !(chosen > 0) || chosen > bound) {
      try {
        input.timeout = bound;
      } catch (err) {
        // A frozen input must not throw: into the wrapper above that is a refusal.
        traceWarn(`review-bash-timeout: could not set the bound: ${String(err)}`);
        return;
      }
      trace(`review-bash-timeout: bounded a ${role || "child"} bash call to ${bound}s`);
    }
  });
}
