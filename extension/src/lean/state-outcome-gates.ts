/**
 * lean/state-outcome-gates — the three durable fields that make a run's gate events
 * publishable, and the rules that keep them honest.
 *
 * The compound fields of the outcome record whose values are not plain scalars — the per-round
 * review counts, each fix wave's head, and a red gate's tier/criterion attribution.
 * `state-outcome-record.ts` re-exports the types so every importer keeps spelling them from one
 * place.
 *
 * Why these are RECORD data and not reads of prose. `pi-rukas-result.json` is the host
 * contract; `.pi/lean-state/<issue>.json` is the driver's private persistence. A field
 * a host codes against has to be written by the handler that observed it, judged by
 * the loader that reads it back, and rebuilt on that load — the same rule every other
 * evidence-bearing field follows. A projection that parsed prose for these answers
 * would put a host's branch on a sentence.
 *
 * The bounds are the load-bearing part, not decoration: each value is handler- or
 * child-authored text that survives a resume, and a run that wrote a million-entry map
 * today would be a run whose state file the loader spends its memory on tomorrow. So
 * every map is entry-capped and every string length-bounded at BOTH the writer and the
 * validator, and the writer clips rather than throwing — a gate must not lose its
 * verdict over the length of a name it was quoting.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { GATE_SEVERITIES, type GateSeverity } from "./gate-severities.ts";
import type { ReviewBoundRecord } from "./review-bound.ts";
import { isCount } from "./state-dispatches.ts";
import { PREEXISTING_NAMES_CAP } from "./state-outcome-maps.ts";

/** How many review rounds one step's record may name. */
export const ROUNDS_MAX = 8;
/** How many fix waves one step's record may name. */
export const WAVES_MAX = 4;
/** How many tiers one red gate may attribute. A step has one fast and one full tier. */
export const RED_TIERS_MAX = 4;
/** How many criterion ids one red gate may attribute. */
export const RED_CRITERIA_MAX = 64;
/** How long one criterion id may be on the record — the id rule's own bound, so the
 * writer clips at the length the validator refuses past rather than at a second literal. */
export const RED_CRITERIA_MAX_CHARS = 16;
/** How long one tier name may be on the record. */
export const RED_TIER_MAX_CHARS = 64;

/** The four published severities, in their published order. The only keys a round may
 * carry, and the only keys a host can be told to expect. */
export const ROUND_SEVERITIES = GATE_SEVERITIES;
export type ReviewRoundCounts = Record<GateSeverity, number>;

/** One fix wave the step ran, with the full head it pushed. */
export interface ReviewWaveHead {
  /** Which pass of the one wave raised the findings this fixer answered. */
  wave: "full" | "fix";
  /** The full 40-hex head the wave integrated — not the 12 the reason line prints. */
  head: string;
}

/** What a `review` step records about the rounds it judged and the wave it bought. */
export interface ReviewRecord {
  /** One entry per round, in the order the step judged them. */
  rounds: ReviewRoundCounts[];
  /** The waves that pushed, with the head each one left on the branch. */
  waves: ReviewWaveHead[];
  /** The step's own clock, when it stopped one mid-wave — verbatim from the record. */
  reviewBound?: ReviewBoundRecord;
  /** Edited test files whose failing base version the reviewer accepted — see `review-test-accept.ts`. */
  accepted?: TestEditAcceptance[];
}

/** How long the reviewer's one-line reason may be on the record. */
export const ACCEPT_REASON_MAX_CHARS = 200;

/** One edited pre-existing test file the reviewer accepted, bound to the head it read. */
export interface TestEditAcceptance {
  /** The repo-relative path, as the roster's `baseVersionRed` names it. */
  path: string;
  /** The reviewer's one-line reason. */
  reason: string;
  /** The full head the accepting pass reviewed; land honours it only on that head. */
  head: string;
}

/** Why this is not one acceptance this run may record, or `undefined` — asked by the writer and the loader. */
export function acceptanceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome review.accepted entry must be an object";
  const a = value as Record<string, unknown>;
  if (!isName(a.path, 300) || /\p{Cc}/u.test(a.path))
    return "outcome review.accepted path must be a one-line path of at most 300 chars";
  if (
    !isName(a.reason, ACCEPT_REASON_MAX_CHARS) ||
    /\p{Cc}/u.test(a.reason) ||
    a.reason.trim() === ""
  )
    return `outcome review.accepted reason must be one line of at most ${String(ACCEPT_REASON_MAX_CHARS)} chars`;
  if (typeof a.head !== "string" || !isFullCommitSha(a.head))
    return "outcome review.accepted head must be a 40-hex commit sha";
  return undefined;
}

/** What a red `verify`/`ci` step records about the gate that failed. */
export interface RedRecord {
  /** The tier name(s) that failed — `fast`, `full`, or the frozen contract's clause. */
  tiers: string[];
  /** The criterion ids the failing checks answer for, as the gate read them. */
  criteria: string[];
}

/** A short name a host can print, from whoever authored it. */
function isName(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && value.length <= max;
}

/** Why this ONE entry is not a round tally this run may print, or `undefined` when it
 * is. The whole-record validator asks it of every entry, and so does any reader that
 * holds a `rounds` array and cannot call the record validator — presence of an array is
 * not presence of a judged round, and a second ad-hoc shape test beside this one is how
 * the two drift apart. */
export function reviewRoundProblem(round: unknown): string | undefined {
  if (typeof round !== "object" || round === null || Array.isArray(round))
    return "outcome review.rounds entry must be an object";
  const keys = Object.keys(round);
  if (keys.some((k) => !(ROUND_SEVERITIES as readonly string[]).includes(k)))
    return `outcome review.rounds names a severity outside ${ROUND_SEVERITIES.join("/")}`;
  if (keys.length !== ROUND_SEVERITIES.length)
    return `outcome review.rounds entry must name exactly ${ROUND_SEVERITIES.join("/")}`;
  const counts = round as Record<string, unknown>;
  if (!ROUND_SEVERITIES.every((s) => isCount(counts[s])))
    return "outcome review.rounds counts must be non-negative integers";
  return undefined;
}

/** Why this is not a round tally this run may print, or `undefined` when it is. */
export function reviewRecordProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome review must be an object";
  const rec = value as { rounds?: unknown; waves?: unknown };
  if (!Array.isArray(rec.rounds)) return "outcome review.rounds must be an array";
  if (rec.rounds.length > ROUNDS_MAX)
    return `outcome review.rounds holds more than ${String(ROUNDS_MAX)} rounds`;
  for (const round of rec.rounds) {
    const problem = reviewRoundProblem(round);
    if (problem !== undefined) return problem;
  }
  if (!Array.isArray(rec.waves)) return "outcome review.waves must be an array";
  if (rec.waves.length > WAVES_MAX)
    return `outcome review.waves holds more than ${String(WAVES_MAX)} waves`;
  for (const w of rec.waves) {
    if (typeof w !== "object" || w === null || Array.isArray(w))
      return "outcome review.waves entry must be an object";
    const wave = w as { wave?: unknown; head?: unknown };
    if (wave.wave !== "full" && wave.wave !== "fix")
      return 'outcome review.waves wave must be "full" or "fix"';
    if (typeof wave.head !== "string" || !isFullCommitSha(wave.head))
      return "outcome review.waves head must be a 40-hex commit sha";
  }
  const accepted = (value as { accepted?: unknown }).accepted;
  if (accepted === undefined) return undefined;
  // One accepted entry per `baseVersionRed` path at most, so the roster's cap is this list's.
  if (!Array.isArray(accepted) || accepted.length > PREEXISTING_NAMES_CAP)
    return `outcome review.accepted must be an array of at most ${String(PREEXISTING_NAMES_CAP)} entries`;
  for (const a of accepted) {
    const problem = acceptanceProblem(a);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The round tally / wave list, rebuilt from the entries this module actually checked. */
export function buildReviewRecord(value: unknown): ReviewRecord {
  const rec = value as {
    rounds: unknown[];
    waves: { wave: "full" | "fix"; head: string }[];
    accepted?: TestEditAcceptance[];
  };
  return {
    rounds: rec.rounds.map(
      (r) =>
        Object.fromEntries(
          ROUND_SEVERITIES.map((s) => [s, (r as Record<string, number>)[s]]),
        ) as ReviewRoundCounts,
    ),
    waves: rec.waves.map((w) => ({ wave: w.wave, head: w.head })),
    ...(rec.accepted === undefined
      ? {}
      : { accepted: rec.accepted.map(({ path, reason, head }) => ({ path, reason, head })) }),
  };
}

/**
 * Fold the rows one round judged into the published tally.
 *
 * The writer's own clip: a row whose severity the layer did not publish counts at its
 * own severity rather than vanishing — the four keys are the shape a host reads, and a
 * row nobody counted is a finding a host would never hear about.
 */
export function roundCounts(rows: readonly { severity: string }[]): ReviewRoundCounts {
  const counts = Object.fromEntries(ROUND_SEVERITIES.map((s) => [s, 0])) as ReviewRoundCounts;
  for (const row of rows)
    if ((ROUND_SEVERITIES as readonly string[]).includes(row.severity))
      counts[row.severity as GateSeverity] += 1;
  return counts;
}

/** Why this is not a red gate's attribution this run may print, or `undefined`. */
export function redRecordProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "outcome red must be an object";
  const rec = value as { tiers?: unknown; criteria?: unknown };
  if (!Array.isArray(rec.tiers)) return "outcome red.tiers must be an array";
  if (rec.tiers.length > RED_TIERS_MAX)
    return `outcome red.tiers holds more than ${String(RED_TIERS_MAX)} tiers`;
  if (!rec.tiers.every((t) => isName(t, RED_TIER_MAX_CHARS)))
    return `outcome red.tiers entries must be names of at most ${String(RED_TIER_MAX_CHARS)} chars`;
  if (!Array.isArray(rec.criteria)) return "outcome red.criteria must be an array";
  if (rec.criteria.length > RED_CRITERIA_MAX)
    return `outcome red.criteria holds more than ${String(RED_CRITERIA_MAX)} criteria`;
  if (!rec.criteria.every((c) => isName(c, RED_CRITERIA_MAX_CHARS) && /^AC\d+$/.test(c)))
    return "outcome red.criteria entries must be AC<n> criterion ids";
  return undefined;
}

/** The red attribution, rebuilt from the entries this module actually checked. */
export function buildRedRecord(value: unknown): RedRecord {
  const rec = value as { tiers: string[]; criteria: string[] };
  return { tiers: [...rec.tiers], criteria: [...rec.criteria] };
}

/** The writer's clip: keep the front, which is where the name is, and never throw. */
export function clipNames(values: readonly string[], max: number, chars: number): string[] {
  return values
    .filter((v) => typeof v === "string" && v !== "")
    .slice(0, max)
    .map((v) => v.slice(0, chars));
}
