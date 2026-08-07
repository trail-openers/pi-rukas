/**
 * work-driver-intent — turn ANY issue body into a normalised spec, then decide.
 *
 * `/work` used to assume an issue tells it what to build. Real backlogs do not
 * honour that: issues are hand-written, terse, imported from another project,
 * or simply wrong. Measured externally, 38.3% of real GitHub issues are
 * underspecified (SWE-bench Verified, 93 annotators over 1,699 samples), and
 * 41.77% of multi-agent failures are specification and system design (MAST) —
 * the largest single category.
 *
 * Two structural problems this replaces:
 *
 *   1. A missing verdict meant "build it" (`work-driver-plan.ts` defaulted an
 *      absent token to NEEDS_WORK). Silence was treated as permission.
 *   2. Nothing asked whether the issue was TRUE — whether the named symbols
 *      exist, whether the described behaviour matches the code, whether the
 *      work is already done. A confidently-wrong bug report got built.
 *
 * The resolver runs inside the `explore` role, which `role-tools.ts` already
 * gates with `--exclude-tools write,edit,multiedit` (#238). That is not
 * incidental: "Ask or Assume?" (69.4% on an underspecified SWE-bench variant)
 * finds that an agent holding edit tools rationalises ambiguity away, because
 * building is cheaper than asking. The resolver structurally cannot build.
 *
 * Grouping markers, where present, are consumed as high-confidence hints. They
 * are never required — that is the whole point.
 */

import { trace } from "./trace.ts";
import { sliceMarkdownSection } from "./work-driver-plan.ts";

/** Why a cycle refused to write code. Machine-readable so the queue can act. */
export type ParkReason =
  | "underspecified"
  | "contradicted-by-code"
  | "already-implemented"
  | "too-large"
  | "premise-unsound";

export type IntentVerdict = "proceed" | "proceed-with-assumptions" | "park";

export interface SpecDeliverable {
  id: string;
  description: string;
  paths: string[];
}

export interface SpecAssumption {
  text: string;
  basis: string;
}

/** A claim the resolver checked against the code or the world. */
export interface SpecEvidence {
  claim: string;
  source: string;
  verdict: "confirmed" | "contradicted" | "unverifiable";
}

export interface NormalisedSpec {
  intent: string;
  deliverables: SpecDeliverable[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  assumptions: SpecAssumption[];
  openQuestions: string[];
  evidence: SpecEvidence[];
  verdict: IntentVerdict;
  parkReason?: ParkReason;
  /** The resolver's own words on why — surfaced verbatim in the handoff. */
  rationale: string;
}

/** #378 escape hatch: PI_ENSEMBLE_INTENT=0 restores the single-token verdict router. */
export function intentResolutionEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_INTENT;
  return v !== "0" && v !== "false";
}

const PARK_REASONS: ParkReason[] = [
  "underspecified",
  "contradicted-by-code",
  "already-implemented",
  "too-large",
  "premise-unsound",
];

/**
 * Slice a `### <name>` subsection out of the `## Spec` block.
 *
 * `sliceMarkdownSection` matches exactly `##`, so it cannot reach these. It is
 * left alone rather than generalised: `parseWorkstreams` depends on its
 * current terminator behaviour, and widening a shared helper to serve one new
 * caller is how subtle parsing regressions get introduced.
 */
function sliceSubsection(text: string, name: string): string | undefined {
  const m = text.match(new RegExp(`^###\\s+${name}\\s*$`, "im"));
  if (!m || m.index === undefined) return undefined;
  const after = text.slice(m.index + m[0].length);
  // Terminate at the next heading of any level.
  const next = after.match(/^#{2,3}\s/m);
  return next?.index !== undefined ? after.slice(0, next.index) : after;
}

/** Bullet lines of a markdown section, with the leading marker stripped. */
function bullets(section: string | undefined): string[] {
  if (!section) return [];
  return section
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Parse the resolver's reply into a normalised spec.
 *
 * Deliberately lenient in the same way `parseWorkstreams` is: agents drift, and
 * a malformed reply must degrade to a park rather than abort the cycle. Every
 * field has a defined empty value, and an unreadable verdict parks.
 */
export function parseNormalisedSpec(text: string): NormalisedSpec | undefined {
  const section = sliceMarkdownSection(text, "Spec");
  if (section === undefined) return undefined;

  const verdictMatch = text.match(
    /INTENT-VERDICT:\s*\**\s*(proceed-with-assumptions|proceed|park)\b/i,
  );
  const rawVerdict = verdictMatch?.[1]?.toLowerCase();
  // No parseable verdict → park. This inverts the pre-#378 default, where a
  // missing token meant NEEDS_WORK and silence became permission to build.
  const verdict: IntentVerdict =
    rawVerdict === "proceed" || rawVerdict === "proceed-with-assumptions"
      ? (rawVerdict as IntentVerdict)
      : "park";

  const reasonMatch = text.match(/PARK-REASON:\s*\**\s*([a-z-]+)\b/i);
  const rawReason = reasonMatch?.[1]?.toLowerCase();
  const parkReason = PARK_REASONS.find((r) => r === rawReason);

  const intent = (sliceSubsection(section, "Intent") ?? "").trim().split("\n")[0] ?? "";
  const rationale = (sliceMarkdownSection(text, "Rationale") ?? "").trim().slice(0, 1200);

  return {
    intent,
    deliverables: parseDeliverables(sliceSubsection(section, "Deliverables")),
    acceptanceCriteria: bullets(sliceSubsection(section, "Acceptance criteria")),
    outOfScope: bullets(sliceSubsection(section, "Out of scope")),
    assumptions: bullets(sliceSubsection(section, "Assumptions")).map((line) => {
      const [text_, basis] = line.split(/\s+—\s+|\s+--\s+/, 2);
      return { text: (text_ ?? line).trim(), basis: (basis ?? "").trim() };
    }),
    openQuestions: bullets(sliceSubsection(section, "Open questions")),
    evidence: parseEvidence(sliceSubsection(section, "Evidence")),
    verdict,
    // A park with no stated reason is still a park; `underspecified` is the
    // honest default, since an unreadable reply is itself underspecified.
    ...(verdict === "park" ? { parkReason: parkReason ?? "underspecified" } : {}),
    rationale,
  };
}

/**
 * `- <id>: <description> [paths: a.ts, b/c.ts]`
 *
 * Paths are optional — a terse hand-written issue will not name files, and
 * demanding them would re-introduce the format dependency this module removes.
 */
function parseDeliverables(section: string | undefined): SpecDeliverable[] {
  return bullets(section).map((line, i) => {
    const pathsMatch = line.match(/\[paths:\s*([^\]]*)\]/i);
    const paths = (pathsMatch?.[1] ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const withoutPaths = line.replace(/\[paths:[^\]]*\]/i, "").trim();
    const idMatch = withoutPaths.match(/^([a-z0-9][a-z0-9_-]*)\s*:\s*(.+)$/i);
    return {
      id: idMatch?.[1]?.toLowerCase() ?? `d${i + 1}`,
      description: (idMatch?.[2] ?? withoutPaths).trim(),
      paths,
    };
  });
}

/** `- <claim> — <source> — confirmed|contradicted|unverifiable` */
function parseEvidence(section: string | undefined): SpecEvidence[] {
  return bullets(section).map((line) => {
    const parts = line.split(/\s+—\s+|\s+--\s+/);
    const last = (parts[parts.length - 1] ?? "").trim().toLowerCase();
    const verdict: SpecEvidence["verdict"] =
      last === "confirmed" || last === "contradicted" ? last : "unverifiable";
    return {
      claim: (parts[0] ?? line).trim(),
      source: (parts.length > 2 ? parts[1] : "")?.trim() ?? "",
      verdict,
    };
  });
}

/**
 * Cross-check the resolver's own verdict against its evidence.
 *
 * The resolver is an LLM and can contradict itself — claim `proceed` while
 * recording that the issue's central claim is contradicted by the code. When
 * that happens the evidence wins: a contradiction is the highest-value signal
 * this step produces, and ignoring it is how a confidently-wrong bug report
 * gets built.
 */
export function reconcileVerdict(spec: NormalisedSpec): NormalisedSpec {
  if (spec.verdict === "park") return spec;
  if (spec.evidence.some((e) => e.verdict === "contradicted")) {
    trace("work-driver: intent — evidence contradicts a proceed verdict, parking");
    return { ...spec, verdict: "park", parkReason: "contradicted-by-code" };
  }
  // Claiming a plain `proceed` while recording assumptions understates what
  // review needs to see; promote so the assumptions reach the PR body.
  if (spec.verdict === "proceed" && spec.assumptions.length > 0) {
    return { ...spec, verdict: "proceed-with-assumptions" };
  }
  return spec;
}

/** Operator-facing sentence for a park. */
export function explainPark(reason: ParkReason, issue: number): string {
  switch (reason) {
    case "underspecified":
      return `#${issue} does not say enough to build from — the driver could not resolve a concrete intent, and writing code from a guess is how the wrong thing gets shipped confidently. Add acceptance criteria or a concrete description and re-run.`;
    case "contradicted-by-code":
      return `#${issue}'s central claim is contradicted by the code as it actually is. The issue may be stale, or describe a bug that was already fixed. Check the evidence below before re-running.`;
    case "already-implemented":
      return `#${issue} appears to be already implemented. Close it if you agree, or say what is still missing and re-run.`;
    case "too-large":
      return `#${issue} is too large to execute as one cycle. Split it into separate issues; each should be a diff a reviewer can hold in their head.`;
    case "premise-unsound":
      return `#${issue} rests on a premise the driver could not substantiate — typically an API or behaviour that does not exist as described. Confirm the premise and re-run.`;
  }
}

/** The human action for a park, for the queue summary. */
export function parkAction(reason: ParkReason, issue: number): string {
  switch (reason) {
    case "underspecified":
      return `add acceptance criteria or a concrete description to #${issue}`;
    case "contradicted-by-code":
      return `check #${issue} against the current code — it may be stale or already fixed`;
    case "already-implemented":
      return `confirm and close #${issue}`;
    case "too-large":
      return `split #${issue} into separate issues`;
    case "premise-unsound":
      return `confirm the premise of #${issue} — the driver could not substantiate it`;
  }
}

/**
 * The assumptions block for the PR body.
 *
 * `proceed-with-assumptions` is only honest if the assumptions are visible
 * where review happens. Buried in a state file they may as well not exist.
 */
export function renderAssumptions(spec: NormalisedSpec): string {
  if (spec.assumptions.length === 0) return "";
  return [
    "",
    "## Assumptions made while resolving this issue",
    "",
    "The issue did not fully specify the following. Each was resolved with a defensible default rather than blocking — check them:",
    "",
    ...spec.assumptions.map((a) => `- **${a.text}**${a.basis ? ` — ${a.basis}` : ""}`),
  ].join("\n");
}
