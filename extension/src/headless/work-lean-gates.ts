/**
 * headless/work-lean-gates — the gate events a lean run put on its record, projected
 * onto the host's result document (`issues[].gates`).
 *
 * The host reads `pi-rukas-result.json`; `.pi/lean-state/<issue>.json` is the driver's
 * private persistence and carries no stability promise (docs/headless.md). A benchmark
 * or a dashboard that wanted to know WHICH files froze per criterion, what the
 * challenge answered, which tier went red at which criterion, what each review round
 * found, which head the fix wave pushed, and what the handback actually shipped had to
 * parse the private file for it — and then rebuild the answer from a `reason` sentence,
 * because the durable red carried no tier and the durable review carried no counts.
 * This module publishes the events on the record that promises them.
 *
 * Three rules, each of which the sibling test file exists to break:
 *
 *   - **read the record, never the prose.** Every value here comes from a typed
 *     `Outcome` field written by the step that observed it. A `reason` line is the
 *     operator's sentence and gets clipped, reworded and folded; a host that branched
 *     on one would branch on wording. Where the record holds no value the field is an
 *     explicit `null` — a host must tell "this run had no challenge" apart from "this
 *     build never looked", and an omitted key cannot make that distinction.
 *   - **re-check what you print.** The loader judges a state file, but the log this
 *     projection reads is a `Step[]` that a run which just finished never passed
 *     through the loader with. So heads go through `isFullCommitSha` and severities
 *     through the published list again, exactly as `prUrlOf` revalidates a URL.
 *   - **the heads cannot disagree with `prState`.** `handback.head` is the head the step
 *     says it shipped, and `handback.verified` is that head put back through the gate
 *     `prStateOf` asks — `gateClearedPublishedHead` — rather than the step's own
 *     `shippedVerified` printed on its word. So one run cannot tell the host `ready` in
 *     one field and certify an uncertified head in another: a claim the run's newest
 *     `verify` does not back is published `false`, and only a claim the record never
 *     made is `null`. A reader that wants the verdict reads `prState`; a reader that
 *     wants the evidence reads these.
 *
 * The object is additive and switch-owned: absent entirely when
 * `PI_ENSEMBLE_LEAN_RESULT_GATES=0`, and then the document is the one this build wrote
 * before the object existed — which is why the projection builds it separately and the
 * caller decides whether to attach it, rather than filling fields conditionally.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { GATE_SEVERITIES } from "../lean/gate-severities.ts";
import type { ReviewBoundRecord } from "../lean/review-bound.ts";
import type { ReviewRoundCounts } from "../lean/state-outcome-gates.ts";
import { type Outcome, type Step, newestDecided } from "../lean/state.ts";
import { gateClearedPublishedHead, publishedHeadOf } from "./work-lean-pr.ts";

/** How many entries of one list a host may be handed. The record caps its own writes;
 * this is the print cap, and the smaller of the two governs what a host parses.
 *
 * Exported because the cap is a published fact and not an implementation detail: a list cut
 * at it prints exactly `LIST_MAX` entries, and the only thing that tells a host this
 * happened is the sibling count this module writes beside it. The truncation cases read the
 * cap from here rather than restating it, so moving it moves the cases with it instead of
 * quietly turning them into assertions about a number nobody chose. */
export const LIST_MAX = 16;
/** How long one published string may be. Same bound the projection applies to the
 * handback reason elsewhere: redact first, then clip, so a cut cannot strand a token. */
const TEXT_MAX = 500;

/** A list and its pre-cut count, with the pair's null rule: no record, then `null` for
 * BOTH halves — never a `0` beside a null list, which would be a positive claim that the
 * run held an empty list, a different fact and the wrong one. */
interface Cap<T> {
  items: T[] | null;
  total: number | null;
}

/** A list clipped to the print cap beside its pre-cut count — the whole rule in one place,
 * so no capped field can ship a cut it does not declare. An empty list is the record's
 * null, as it was before the marker: a field that held nothing published nothing. */
function clipped<T>(items: T[] | null): Cap<T> {
  if (items === null || items.length === 0) return { items: null, total: null };
  return { items: items.slice(0, LIST_MAX), total: items.length };
}

/**
 * A gate's verdict and, for a red, the attribution its step recorded.
 *
 * `kind` carries three words and the third is not a judgement of the work: `green` and
 * `red` are the gate's verdicts, and `error` is the engine's record of a gate whose handler
 * threw (`lean/error-outcome.ts`) — the infrastructure died and nothing was judged. A host
 * that read an `error` as a red would blame the work for a harness failure and go re-check a
 * criterion nobody ran, so an error entry publishes null attributions: the gate never named
 * a tier, and an empty list would say it named none.
 */
export interface GatesRed {
  state: "verify" | "ci";
  /** `green`, `red`, or `error` — an infrastructure throw, which is not a verdict. */
  kind: string;
  tiers: string[] | null;
  /** The full `tiers` count before the print cut; `null` exactly when `tiers` is. A host
   * detects a cut with `tiersTotal > tiers.length`. */
  tiersTotal: number | null;
  criteria: string[] | null;
  /** The full `criteria` count before the print cut; `null` exactly when `criteria` is. */
  criteriaTotal: number | null;
}

/** The review step's account of what it judged, as published. */
export interface GatesReview {
  kind: string;
  /** What the review step judged, published only when the step recorded it (G2). */
  rounds: ReviewRoundCounts[] | null;
  waves: { wave: string; head: string }[] | null;
  /** The full `waves` count before the print cut; `null` exactly when `waves` is. */
  wavesTotal: number | null;
  /**
   * The step's own clock, published verbatim from the record beside these counts (G11).
   *
   * The top-level `issues[].reviewBound` keeps its own rule — ABSENT means fully
   * reviewed — and this is the one gate field that does not follow the null rule, because
   * here absence is the answer: `prState`/`reviewBound` are governed by the omission rule
   * and everything else in `gates` by the null rule, which is what docs/headless.md
   * states, and what this comment exists to stop a reader guessing.
   */
  reviewBound: GatesReviewBound | null;
}

/** The `review` step's clock as the host sees it: the record's three fields, plus the lane
 * list's pre-cut count beside the list itself.
 *
 * It is `ReviewBoundRecord` and one extra key rather than that type, because the record is
 * the driver's durable shape — a lane list a writer produces and a loader validates — and
 * the print count belongs to neither of those. Widening the record's own type would tell a
 * reader the durable field carries a number no writer ever writes.
 */
export type GatesReviewBound = ReviewBoundRecord & {
  /** The full `unreviewedLanes` count before the print cut; `null` exactly when it is. */
  unreviewedLanesTotal: number | null;
};

/** What the handback shipped, and whether its own gate saw it. */
export interface GatesHandback {
  reason: string | null;
  head: string | null;
  verified: boolean | null;
  unshipped: { head: string; reason: string | null } | null;
}

/** `issues[].gates`: the gate events of one lean run. */
export interface GatesResult {
  specify: { frozen: Record<string, string> | null; tests: Record<string, string[]> | null };
  challenge: { kind: string; limit?: string; value?: number; used?: number } | null;
  verify: GatesRed[];
  review: GatesReview | null;
  handback: GatesHandback;
}

/** The newest step of one state by LOG POSITION, decided or not.
 * `newestDecided` would skip a crash mid-step and let an older verdict speak for a
 * gate that died, which is the wrong question for "what did this gate answer". */
function newestStep(steps: Step[], state: Step["state"]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.state === state) return steps[i];
  }
  return undefined;
}

/** Every step of one state, in the order the run walked them. */
function stepsOf(steps: Step[], state: Step["state"]): Step[] {
  return steps.filter((s) => s.state === state);
}

/** A head the record may name: full, hex, and nothing else. */
function headOf(value: unknown): string | null {
  return typeof value === "string" && isFullCommitSha(value) ? value : null;
}

/** A short piece of prose the run wrote, published at the projection's bound. */
function textOf(value: unknown, redact: (s: string) => string): string | null {
  if (typeof value !== "string") return null;
  const text = redact(value).trim();
  if (text === "") return null;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
}

/**
 * The one-line account of a review that stopped at its own clock, for `issues[].reviewBound`.
 *
 * The sentence's shape is the one the host contract has always published (reason, wave, the
 * lanes named after `unreviewed:`); what this reader adds is the redaction. `reason` and the
 * lane names are CHILD-authored text — the stop's sentence quotes what the step's bound said,
 * the lanes come off a skill roster — so each is put through `textOf` SEPARATELY before the
 * join, exactly as the `gates` copy of the same fact does. Joining first and redacting one
 * long string would let a credential straddle the `; wave ` boundary this code inserts and
 * survive the pattern scan; one string per field, one scrub per string, is what makes the two
 * surfaces of this fact say the same thing.
 */
export function reviewBoundSentence(
  bound: ReviewBoundRecord,
  redact: (s: string) => string,
): string {
  const reason = textOf(bound.reason, redact) ?? "";
  const lanes = bound.unreviewedLanes
    .map((lane) => textOf(lane, redact) ?? "")
    .filter((lane) => lane !== "")
    .slice(0, LIST_MAX)
    .join(", ");
  return `${reason}; wave ${bound.wave}; unreviewed: ${lanes === "" ? "none named" : lanes}`;
}

/**
 * The frozen contract, from the same two fields every other reader of it uses.
 *
 * `specify` froze the files and named the criterion each one answers for; `challenge`
 * may have added more, and `frozenFromLog`'s union across those steps IS the run's
 * definition of the contract. A run refused before any test froze publishes two nulls:
 * `{}` would say "it froze nothing", and an omitted object would say nothing at all.
 */
function specifyGates(steps: Step[]): GatesResult["specify"] {
  const frozen: Record<string, string> = {};
  const tests: Record<string, string[]> = {};
  let sawAny = false;
  for (const step of steps) {
    const froze =
      (step.state === "specify" && step.outcome?.kind === "ok") ||
      (step.state === "challenge" && step.outcome?.kind === "new-tests");
    if (!froze) continue;
    for (const [path, sha] of Object.entries(step.outcome?.frozen ?? {})) {
      // A digest that is not a sha256 is not tamper evidence, and printing one as
      // though it were would tell a host a file is verified when nothing verified it.
      if (typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) {
        frozen[path] = sha;
        sawAny = true;
      }
    }
    for (const [id, files] of Object.entries(step.outcome?.tests ?? {})) {
      if (!Array.isArray(files)) continue;
      const kept = files.filter((f): f is string => typeof f === "string" && f !== "");
      if (kept.length === 0) continue;
      tests[id] = [...(tests[id] ?? []), ...kept];
      sawAny = true;
    }
  }
  return sawAny ? { frozen, tests } : { frozen: null, tests: null };
}

/**
 * The challenge step's verdict — one of the three the registry gives it, read by
 * POSITION, with the ceiling's trio on its own arm.
 *
 * `null` for a run that has no challenge step and for one whose newest attempt was cut
 * off before it answered: in both cases the run has no verdict to report, and inventing
 * `"none"` would tell a host the adversary looked and found nothing.
 */
function challengeGates(steps: Step[]): GatesResult["challenge"] {
  const step = newestStep(steps, "challenge");
  const kind = step?.outcome?.kind;
  if (kind !== "new-tests" && kind !== "none" && kind !== "budget") return null;
  if (kind !== "budget") return { kind };
  // The ceiling arm's typed trio — what it ran out of, the ceiling, the spend. Data
  // rather than prose precisely so "out of turns" reads apart from "out of minutes".
  const { limit, value, used } = step?.outcome ?? {};
  return {
    kind,
    ...(typeof limit === "string" ? { limit } : {}),
    ...(typeof value === "number" ? { value } : {}),
    ...(typeof used === "number" ? { used } : {}),
  };
}

/**
 * Every `verify` and `ci` verdict the run recorded, in the order it recorded them, each
 * red with the tier that failed and the criteria the failing checks answer for.
 *
 * Three kinds reach the host, and the third is not a judgement of the code: `green` and
 * `red` are the gate's verdicts, and `error` is what the engine records when a gate's
 * handler threw (`lean/error-outcome.ts`). An entry of that kind attributes nothing — the
 * gate named no tier because it never finished — and a host that read it as a red would go
 * and re-check a criterion nobody ran.
 *
 * A list rather than one field because a run genuinely carries more than one red — a
 * first red, a fix round, and a pipeline that then fails — and a host triaging the run
 * needs to see which gate ended it, not only the last one to speak.
 *
 * Every published string here goes through `textOf`, the tier names included. The loader
 * bounds a tier name's LENGTH but says nothing about its CONTENT, and the writer's tier
 * names come off reason lines this step composed — so the projection is the last place a
 * credential-shaped or oversized name can be stopped before a host parses it, exactly as
 * for the two `reviewBound` strings and the handback reason.
 *
 * The `Total` beside each list counts what survives THAT filter, before the cut: a tier name
 * the seam empties and a criterion id that is not `AC<n>` are in neither number, so
 * `Total > length` means one thing here — entries this document cut for LENGTH.
 */
function verifyGates(steps: Step[], redact: (s: string) => string): GatesRed[] {
  const out: GatesRed[] = [];
  for (const state of ["verify", "ci"] as const) {
    for (const step of stepsOf(steps, state)) {
      const kind = step.outcome?.kind;
      if (kind === undefined) continue;
      const red = step.outcome?.red;
      const tiers = clipped(
        Array.isArray(red?.tiers)
          ? red.tiers.map((t) => textOf(t, redact)).filter((t): t is string => t !== null)
          : null,
      );
      const criteria = clipped(
        Array.isArray(red?.criteria)
          ? red.criteria.filter((c): c is string => typeof c === "string" && /^AC\d+$/.test(c))
          : null,
      );
      out.push({
        state,
        kind,
        tiers: tiers.items,
        tiersTotal: tiers.total,
        criteria: criteria.items,
        criteriaTotal: criteria.total,
      });
    }
  }
  return out;
}

/**
 * What the review step judged: one tally per round keyed by exactly the four published
 * severities, each fix wave's FULL head, and the unreviewed lanes verbatim.
 *
 * The severity filter is the projection's last defence. The loader refuses a fifth key,
 * but a value that reaches this function without passing through the loader has been
 * judged by nobody, and a host that switches on four names silently misses a finding
 * carried under a fifth — so a round holding anything else publishes nothing rather
 * than publishing a partial truth. The WHOLE tally goes, not the bad round: a tally that
 * named three of a run's four rounds would read as a complete count, which is the same
 * failure the waves arm refuses by dropping every wave for one malformed head.
 */
function reviewGates(steps: Step[], redact: (s: string) => string): GatesResult["review"] {
  const step = newestStep(steps, "review");
  const oc = step?.outcome;
  if (oc === undefined) return null;
  const { kind } = oc;
  if (kind !== "done" && kind !== "fixed" && kind !== "error") return null;
  const roundsArr = Array.isArray(oc.review?.rounds) ? oc.review.rounds : null;
  // All rounds or none. A tally that named two of a run's three rounds is not a shorter
  // truth, it is a wrong one: a host that sums `rounds` divides the run's findings by the
  // rounds it was shown and concludes the missing round found nothing. The waves arm below
  // already refuses its whole field for one malformed head, and a round is the same kind of
  // claim — so one refused round refuses the tally, while the waves keep publishing because
  // they were judged on their own terms.
  const rounds =
    roundsArr === null ||
    roundsArr.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        Object.keys(r).length === GATE_SEVERITIES.length &&
        GATE_SEVERITIES.every((s) => Number.isSafeInteger(r[s]) && (r[s] as number) >= 0),
    )
      ? roundsArr
      : null;
  const wavesArr = Array.isArray(oc.review?.waves) ? oc.review.waves : null;
  const wavesKept =
    wavesArr === null
      ? null
      : // A wave is published only when BOTH halves of its identity are sound: which pass
        // it was, and the full head it pushed. A malformed head publishes no wave rather
        // than a partial one — a host that read `waves: []` and `rounds: [...]` could at
        // least ask which, where an entry naming a head it cannot check out is a wrong
        // answer wearing a right one's clothes.
        wavesArr.filter(
          (w) =>
            typeof w?.head === "string" &&
            isFullCommitSha(w.head) &&
            (w.wave === "full" || w.wave === "fix"),
        );
  if (wavesKept !== null && wavesArr !== null && wavesKept.length !== wavesArr.length) return null;
  const waves = clipped(wavesKept);
  // The step's own clock, published as the record holds it — the field's own shape rule
  // is the loader's (`reviewBoundProblem`), so the projection publishes the value rather
  // than re-inventing a second judgement of it. What the projection does add is the print
  // cap and the redaction, and only those: both strings are child-authored text (the stop's
  // sentence quotes what the step's own bound said, the lane names come from a skill roster)
  // and every other published string of this object goes through `redact` before the clip,
  // so a lane or a reason that quoted a credential would otherwise be the one gate field
  // that ships it.
  const bound = oc.reviewBound;
  // One pass over the lanes: both halves of the pair come off the same `Cap`, so the count
  // cannot disagree with the list it stands beside.
  const lanes = clipped(
    bound === undefined
      ? null
      : bound.unreviewedLanes
          .map((lane) => textOf(lane, redact) ?? "")
          .filter((lane) => lane !== ""),
  );
  return {
    kind,
    rounds: rounds === null || rounds.length === 0 ? null : rounds,
    waves: waves.items,
    wavesTotal: waves.total,
    reviewBound:
      bound === undefined
        ? null
        : {
            wave: bound.wave,
            reason: textOf(bound.reason, redact) ?? "",
            unreviewedLanes: lanes.items ?? [],
            unreviewedLanesTotal: lanes.total,
          },
  };
}

/**
 * What the handback shipped.
 *
 * `head` is the caller's own `prState` input, and `verified` is the step's claim about
 * that head tested against the same gate `prStateOf` stands on, so the two fields answer
 * the same question with the same evidence and cannot drift. `reason` is the step's own
 * line for why the run ended where it did; `handoff.body` is the full report, of which
 * this reason is the headline — a host that wants the whole thing reads `handoff`, a host
 * that wants to triage reads this.
 */
function handbackGates(steps: Step[], redact: (s: string) => string): GatesResult["handback"] {
  const oc: Outcome | undefined = newestDecided(steps, "handback")?.outcome;
  const unshippedHead = headOf(oc?.unshippedHead);
  const unshippedReason = textOf(oc?.unshippedReason, redact);
  // The handback's OWN record wins where it spoke. `shippedHead`/`shippedVerified` are
  // what this step wrote after its rewind settled — including the case the publish-side
  // reading cannot see, where the rewind moved origin back to the verified head, so what
  // shipped is no longer what `publish` recorded.
  const own = headOf(oc?.shippedHead);
  if (own !== null) {
    // The step's `shippedVerified` is what IT believed about its own rewind, and nothing
    // in the record binds a `true` to a green about the head it names — a log whose every
    // gate went red would otherwise publish `verified: true` beside `prState: "draft"`,
    // two fields telling two stories about one commit and the mergeable one the field a
    // host reads. So the positive claim goes back through the gate `prStateOf` asks; the
    // cautious arms pass through, because a `false` needs no corroborating and a claim the
    // record never made is the projection's null, not the gate's answer.
    const claimed = typeof oc?.shippedVerified === "boolean" ? oc.shippedVerified : null;
    return {
      reason: textOf(oc?.reason, redact),
      head: own,
      verified: claimed === true ? gateClearedPublishedHead(steps, own) : claimed,
      unshipped: unshippedHead === null ? null : { head: unshippedHead, reason: unshippedReason },
    };
  }
  // Where the step said nothing — a run that never reached handback, one whose rule never
  // fired, or one whose no-head recording switch is off — the PUBLISH-SIDE reading answers,
  // which is the same evidence `prState` stands on: the head the newest DECIDED `publish`
  // says it shipped, put back through the gate's own test. Both null when there is no PR to
  // read a head off. A host that read `prState: "ready"` beside `head: null` would be told
  // the run is mergeable and simultaneously that it shipped nothing, which is two surfaces
  // telling two stories about one commit — the failure this function's header exists to
  // prevent, and the reason the fallback is the publish-side head rather than silence.
  const published = publishedHeadOf(newestDecided(steps, "publish"));
  return {
    reason: textOf(oc?.reason, redact),
    head: published ?? null,
    verified: published === undefined ? null : gateClearedPublishedHead(steps, published),
    unshipped: unshippedHead === null ? null : { head: unshippedHead, reason: unshippedReason },
  };
}

/**
 * The whole object for one run.
 *
 * The head fields are read through `work-lean-pr`'s helpers rather than re-derived here,
 * so there is exactly ONE reader of "which head did this run ship, and did its gate clear
 * it" across this projection and `prState` — two derivations of one fact is how two fields
 * start telling two stories.
 */
export function leanGates(steps: Step[], redact: (s: string) => string): GatesResult {
  return {
    specify: specifyGates(steps),
    challenge: challengeGates(steps),
    verify: verifyGates(steps, redact),
    review: reviewGates(steps, redact),
    handback: handbackGates(steps, redact),
  };
}
