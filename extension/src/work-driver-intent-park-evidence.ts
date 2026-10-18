/**
 * work-driver-intent-park-evidence — the evidence line an `intent-park`
 * cap-hit carries (#1561).
 *
 * The park cap used to carry no `evidence`, so the headless result's
 * `failure.message` was the bare word `intent-park` and a host's record of
 * the refusal said nothing about why. The reason and the resolver's decisive
 * evidence (the PR it cites, with that PR's state, or the commit) now ride
 * on the cap's `evidence`, whose first line `failure.message` reports.
 *
 * A cited PR's state is READ from the forge, never taken from the resolver's
 * prose; a state that cannot be read is said to be unread. An OPEN PR behind
 * an `already-implemented` park is work awaiting review, not a done issue.
 */

import type { Forge } from "./forge.ts";
import { isMemoryClaim } from "./work-driver-intent-criticality.ts";
import type { NormalisedSpec, SpecEvidence } from "./work-driver-intent.ts";

/** The basis of the assumption `groundAlreadyImplemented` records when it refutes a park (#1351). */
export const GROUNDING_BASIS =
  "already-implemented means the mainline has the work; an open PR or an unmerged branch does not";

/** At most this many cited PRs are looked up. */
const MAX_PRS = 3;

export type CitedPrState = "OPEN" | "MERGED" | "CLOSED" | "unread";

/** The rows a park rests on: what confirms an implementation, what contradicts the issue. */
function decisiveRows(spec: NormalisedSpec): SpecEvidence[] {
  const want = spec.parkReason === "already-implemented" ? "confirmed" : "contradicted";
  return spec.evidence.filter((e) => e.verdict === want && !isMemoryClaim(e));
}

const rowText = (e: SpecEvidence) => `${e.claim}${e.source ? ` (${e.source})` : ""}`;

/** The text the resolver's decision rests on: its decisive rows and its rationale. */
function decisiveText(spec: NormalisedSpec): string {
  return [...decisiveRows(spec).map(rowText), spec.rationale].join("\n");
}

/** PR / MR numbers the text cites (`PR #12`, `pull request #12`, `MR !12`, `/pull/12`). */
export function citedPrs(text: string): number[] {
  const re =
    /\b(?:PR|MR|pull request|merge request)\s*[#!]?(\d+)\b|\/(?:pull|merge_requests)\/(\d+)\b/gi;
  const out = new Set<number>();
  for (const m of text.matchAll(re)) out.add(Number(m[1] ?? m[2]));
  return [...out].slice(0, MAX_PRS);
}

/** Commit SHAs the text cites: 7-40 hex characters with at least one digit and one letter. */
function citedCommits(text: string): string[] {
  const shas = (text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).filter(
    (s) => /\d/.test(s) && /[a-f]/.test(s),
  );
  return [...new Set(shas)].slice(0, 3);
}

/** The state of each PR the park rests on, read from the forge. Never throws. */
export async function readCitedPrStates(
  spec: NormalisedSpec,
  forge: Forge | undefined,
): Promise<Map<number, CitedPrState>> {
  const states = new Map<number, CitedPrState>();
  for (const n of citedPrs(decisiveText(spec))) {
    try {
      const pr = forge ? await forge.prView(n) : undefined;
      const st = pr?.state;
      states.set(n, st === "OPEN" || st === "MERGED" || st === "CLOSED" ? st : "unread");
    } catch {
      states.set(n, "unread");
    }
  }
  return states;
}

/** The OPEN PR an `already-implemented` park rests on: work awaiting review. */
export function awaitingReviewPr(
  spec: NormalisedSpec,
  states: ReadonlyMap<number, CitedPrState>,
): number | undefined {
  if (spec.parkReason !== "already-implemented") return undefined;
  for (const [n, st] of states) if (st === "OPEN") return n;
  return undefined;
}

/**
 * The cap's evidence: a first line naming the reason and the decisive
 * evidence (what `failure.message` reports), then the decisive rows and the
 * resolver's rationale.
 */
export function parkEvidence(
  spec: NormalisedSpec,
  issue: number,
  states: ReadonlyMap<number, CitedPrState>,
): string {
  const reason = spec.parkReason ?? "underspecified";
  const rows = decisiveRows(spec);
  const open = awaitingReviewPr(spec, states);
  let headline: string;
  if (open !== undefined) {
    headline = `the work for #${issue} is in open PR #${open}, awaiting review (not merged) — review or merge PR #${open}, and close #${issue} once it lands`;
  } else {
    const refs = [
      ...[...states].map(([n, st]) => `PR #${n} (${st === "unread" ? "state not read" : st})`),
      ...citedCommits(decisiveText(spec)).map((sha) => `commit ${sha}`),
    ];
    // #1351 — a refuted already-implemented park leads with the refutation, not the resolver's claim.
    const refuted = spec.assumptions.find((a) => a.basis === GROUNDING_BASIS)?.text;
    const first = refuted ?? (rows[0] ? rowText(rows[0]) : spec.rationale.split("\n")[0]?.trim());
    headline = [refs.join(", "), first].filter((p) => p).join(" — ") || "no evidence recorded";
  }
  const lines = [`intent-park (${reason}): ${headline}`];
  if (rows.length > 0) lines.push("Decisive evidence:", ...rows.map((e) => `- ${rowText(e)}`));
  if (spec.rationale) lines.push(`Resolver's rationale: ${spec.rationale}`);
  return lines.join("\n");
}
