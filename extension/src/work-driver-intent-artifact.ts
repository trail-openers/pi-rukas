/**
 * work-driver-intent-artifact — restore the intent verdict from the
 * persisted spec artifact when the prose reply does not say it.
 *
 * The DRIVER persists the resolved spec to `.pi/work-state/<issue>/spec.txt`
 * (the same channel the issue-body artifacts use) after reconciliation in
 * `runExplore` — the resolver's prose reply is the primary record, and the
 * file is the durable shadow of the decision. On a SUBSEQUENT cycle, when
 * the prose does not parse — or parses only to the parser's synthetic
 * default park — the artifact is the surviving record of a valid decision,
 * and discarding it parks solid issues that the resolver fully resolved
 * (#594). It is a recovery channel, not a new decision.
 *
 * Two invariants bound how far the artifact may go:
 *
 *   1. An EXPLICIT prose park always wins over an artifact `proceed`. The
 *      resolver chose to stop; the file it also wrote cannot talk it back
 *      into building. (The same shape as #404: a park nobody declared may
 *      be refuted, a park that was declared may not.)
 *   2. The artifact must validate EVERY element, not just the top-level
 *      shape. A cast of the form `value as unknown as NormalisedSpec`
 *      (PR #597's version) trusts the resolver's JSON structure, and a
 *      half-written or truncated artifact with null elements would flow
 *      into `specIsComplete` / `renderAssumptions` and crash the driver.
 *      `parseNormalisedSpecArtifact` returns `undefined` on any malformed
 *      element instead.
 *
 * The artifact-path helpers (`exploreSpecArtifactPath`, `readSpecArtifact`,
 * `deleteSpecArtifact`, `persistSpecArtifact`) and the merge decision
 * (`resolveIntentVerdict`) live here too, so `runExplore` stays a thin
 * "delete stale → parse prose → reconcile → read artifact → merge" and
 * the 500-line limit in `work-driver-explore.ts` holds without a refactor.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type {
  NormalisedSpec,
  ParkReason,
  SpecAssumption,
  SpecDeliverable,
  SpecEvidence,
} from "./work-driver-intent.ts";
import { dispatchArtifactPath, writeDispatchArtifact } from "./workflow-state.ts";

const PARK_REASONS: readonly ParkReason[] = [
  "underspecified",
  "contradicted-by-code",
  "already-implemented",
  "too-large",
  "premise-unsound",
];

/**
 * Parse the spec artifact (the JSON the resolver persisted to spec.txt)
 * back into a NormalisedSpec.
 *
 * Strict on element shapes: every array element is checked, and the first
 * malformed element (or a top-level shape miss) returns `undefined`. The
 * reader never throws — a half-written file from a killed dispatch is
 * expected, and the caller degrades to the prose-only path.
 */
export function parseNormalisedSpecArtifact(text: string): NormalisedSpec | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validateSpec(raw);
}

/**
 * The precedence rule for the intent verdict, as a pure function.
 *
 * The artifact wins ONLY when the prose yielded no parse at all, or when
 * the prose parsed to the parser's synthetic default park
 * (`verdictSource === "default"` — the resolver omitted its verdict token).
 * An explicit prose park (the resolver actually wrote `park`, even with
 * the default `underspecified` reason) is a decision and is never
 * overridden by a file the same resolver also wrote.
 *
 * A malformed or absent artifact degrades to the prose decision — the
 * artifact is a RECOVERY channel, not an additional decision, and a file
 * that fails strict validation cannot license anything.
 */
export function resolveIntentVerdict(
  prose: NormalisedSpec | undefined,
  artifact: NormalisedSpec | undefined,
): { spec: NormalisedSpec | undefined; source: "prose" | "artifact" } {
  // The prose wins UNLESS it is the parser's synthetic default park
  // (verdictSource === "default"). A default park is not a decision the
  // resolver made — it is what the parser synthesises when the verdict
  // token does not parse, and the artifact (the resolver's own persisted
  // record) is the surviving signal. An EXPLICIT prose park
  // (verdictSource === "parsed") is a decision and is never overridden.
  //
  // A `proceed` or `proceed-with-assumptions` from the prose always wins —
  // the resolver said go, and the file it also wrote cannot talk it back
  // into building (or into parking, for that matter).
  const proseIsDecision =
    prose !== undefined && !(prose.verdict === "park" && prose.verdictSource === "default");
  if (proseIsDecision) {
    return { spec: prose, source: "prose" };
  }
  // prose is undefined (no parse) or a parser-default park. The artifact
  // wins if it is present and valid.
  if (artifact) {
    trace("work-driver: intent — restoring verdict from the persisted spec artifact");
    return { spec: artifact, source: "artifact" };
  }
  // No prose decision AND no valid artifact. The prose (undefined or the
  // default park) stands; the no-signal cap-hit or the intent-park cap-hit
  // fires downstream.
  return { spec: prose, source: "prose" };
}

/** The artifact path for the explore step's spec. Shared with tests. */
export function exploreSpecArtifactPath(repoRoot: string, issue: number): string {
  return dispatchArtifactPath(repoRoot, issue, "spec");
}

/**
 * Delete a stale spec artifact left by a prior cycle.
 *
 * Best-effort: the file is a cache of a decision, and a failed delete
 * only costs the fresh-cycle hygiene — the write below overwrites it
 * anyway. Never throws; a missing file (the normal case on a fresh
 * cycle) is a success.
 */
export async function deleteSpecArtifact(repoRoot: string, issue: number): Promise<void> {
  try {
    await fs.rm(exploreSpecArtifactPath(repoRoot, issue), { force: true });
  } catch (err) {
    trace(`work-driver: could not delete stale spec artifact: ${(err as Error).message}`);
  }
}

/**
 * Read the spec artifact back from disk, parsing + validating strictly.
 *
 * Returns undefined on a missing file (normal) or any malformed content
 * (never throws into the driver). The path is resolved via
 * `dispatchArtifactPath` so the read and the write can never disagree
 * about where the file lives.
 */
export async function readSpecArtifact(
  repoRoot: string,
  issue: number,
): Promise<NormalisedSpec | undefined> {
  let text: string;
  try {
    text = await fs.readFile(exploreSpecArtifactPath(repoRoot, issue), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const file = exploreSpecArtifactPath(repoRoot, issue);
      trace(
        `work-driver: spec artifact ${file} is unreadable (${(err as Error).message}); treating as absent`,
      );
    }
    return undefined;
  }
  return parseNormalisedSpecArtifact(text);
}

/** Persist the spec artifact (best-effort; trace on failure). */
export async function persistSpecArtifact(
  repoRoot: string,
  issue: number,
  spec: NormalisedSpec,
): Promise<void> {
  try {
    await writeDispatchArtifact(repoRoot, issue, "spec", JSON.stringify(spec, null, 2));
  } catch (err) {
    trace(`work-driver: could not persist spec artifact: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Element-level validation.
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isDeliverableArray(v: unknown): v is SpecDeliverable[] {
  return (
    Array.isArray(v) &&
    v.every(
      (d) =>
        d !== null &&
        typeof d === "object" &&
        typeof (d as SpecDeliverable).id === "string" &&
        typeof (d as SpecDeliverable).description === "string" &&
        isStringArray((d as SpecDeliverable).paths),
    )
  );
}

function isAssumptionArray(v: unknown): v is SpecAssumption[] {
  return (
    Array.isArray(v) &&
    v.every(
      (a) =>
        a !== null &&
        typeof a === "object" &&
        typeof (a as SpecAssumption).text === "string" &&
        typeof (a as SpecAssumption).basis === "string",
    )
  );
}

const EVIDENCE_VERDICTS: readonly SpecEvidence["verdict"][] = [
  "confirmed",
  "contradicted",
  "unverifiable",
];

function isEvidenceArray(v: unknown): v is SpecEvidence[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as SpecEvidence).claim === "string" &&
        typeof (e as SpecEvidence).source === "string" &&
        typeof (e as SpecEvidence).verdict === "string" &&
        EVIDENCE_VERDICTS.includes((e as SpecEvidence).verdict),
    )
  );
}

/**
 * Validate a parsed JSON value against the NormalisedSpec shape.
 *
 * Strict on every array element (see module header for why a cast is not
 * enough). `undefined` on ANY malformed element or top-level miss. The
 * verdict must be one of the three values; `parkReason`, when present,
 * must be one of the five — a malformed reason returns undefined because
 * a half-correct artifact should not half-validate.
 */
function validateSpec(raw: unknown): NormalisedSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.intent !== "string") return undefined;
  if (!isDeliverableArray(v.deliverables)) return undefined;
  if (!isStringArray(v.acceptanceCriteria)) return undefined;
  if (!isStringArray(v.outOfScope)) return undefined;
  if (!isAssumptionArray(v.assumptions)) return undefined;
  if (!isStringArray(v.openQuestions)) return undefined;
  if (!isEvidenceArray(v.evidence)) return undefined;
  if (v.verdict !== "proceed" && v.verdict !== "proceed-with-assumptions" && v.verdict !== "park") {
    return undefined;
  }
  const out: NormalisedSpec = {
    intent: v.intent,
    deliverables: v.deliverables as SpecDeliverable[],
    acceptanceCriteria: v.acceptanceCriteria as string[],
    outOfScope: v.outOfScope as string[],
    assumptions: v.assumptions as SpecAssumption[],
    openQuestions: v.openQuestions as string[],
    evidence: v.evidence as SpecEvidence[],
    verdict: v.verdict,
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
  if (v.parkReason !== undefined) {
    const pr = v.parkReason;
    if (typeof pr !== "string" || !PARK_REASONS.includes(pr as ParkReason)) return undefined;
    out.parkReason = pr as ParkReason;
  }
  if (v.parkReasonSource !== undefined) {
    const r = readProvenance(v.parkReasonSource);
    if (r === undefined) return undefined;
    out.parkReasonSource = r;
  }
  if (v.verdictSource !== undefined) {
    const r = readProvenance(v.verdictSource);
    if (r === undefined) return undefined;
    out.verdictSource = r;
  }
  return out;
}

/** Read a `"parsed" | "default"` field, returning undefined on a bad value. */
function readProvenance(val: unknown): "parsed" | "default" | undefined {
  if (val !== "parsed" && val !== "default") return undefined;
  return val;
}

/** The artifact path, for tests that need the raw path without the read. */
export function specArtifactDir(repoRoot: string, issue: number): string {
  return path.dirname(exploreSpecArtifactPath(repoRoot, issue));
}
