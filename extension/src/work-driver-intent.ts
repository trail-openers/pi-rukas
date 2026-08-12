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
  /**
   * Whether `parkReason` was read from the reply or synthesised by the parser.
   * #404 — `underspecified` is both the null value and a real diagnosis, and
   * `reconcileVerdict` may override the diagnosis. Only a value the resolver
   * actually stated may license that.
   */
  parkReasonSource?: "parsed" | "default";
  /**
   * Whether the `park` verdict was stated by the resolver or synthesised
   * because no `INTENT-VERDICT` token parsed. #337's fix depends on knowing
   * the difference: a park nobody declared may be refuted by a complete spec;
   * a park the resolver actually declared may not.
   */
  verdictSource?: "parsed" | "default";
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
 * Read a `TOKEN: value` marker in the shapes resolvers actually emit.
 *
 * The prompt asks for an inline `PARK-REASON: <value>`, but a real resolver
 * wrote it as a markdown heading with the value on the next line:
 *
 *     ### PARK-REASON
 *     already-implemented
 *
 * The old colon-anchored regex silently missed that, and the synthesised
 * default then flowed into a decision (#404). Both forms are accepted; bold
 * and heading markers are tolerated, as they are on every sibling parser.
 */
function readToken(text: string, token: string, value: RegExp): string | undefined {
  const v = value.source;
  const inline = text.match(new RegExp(`${token}:\\s*\\**\\s*${v}\\b`, "i"));
  if (inline?.[1]) return inline[1].toLowerCase();
  // Heading form: the token on its own line, the value on the next.
  const heading = text.match(
    new RegExp(`^#{1,6}\\s*\\**\\s*${token}\\s*\\**\\s*$\\n+\\s*\\**\\s*${v}\\b`, "im"),
  );
  return heading?.[1]?.toLowerCase();
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

  const rawVerdict = readToken(text, "INTENT-VERDICT", /(proceed-with-assumptions|proceed|park)/);
  // No parseable verdict → park. This inverts the pre-#378 default, where a
  // missing token meant NEEDS_WORK and silence became permission to build.
  const verdict: IntentVerdict =
    rawVerdict === "proceed" || rawVerdict === "proceed-with-assumptions"
      ? (rawVerdict as IntentVerdict)
      : "park";

  const rawReason = readToken(text, "PARK-REASON", /([a-z-]+)/);
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
    // A park with no stated reason is still a park, and `underspecified` is
    // still the honest label for the operator. But #404: the driver must
    // remember that it INVENTED this value, because `reconcileVerdict` treats
    // `underspecified` as the one reason a complete spec may override — and a
    // value nobody said must never license building something.
    ...(verdict === "park"
      ? {
          parkReason: parkReason ?? "underspecified",
          parkReasonSource: parkReason ? ("parsed" as const) : ("default" as const),
          verdictSource: rawVerdict ? ("parsed" as const) : ("default" as const),
        }
      : {}),
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

/**
 * `- <claim> — <source> — confirmed|contradicted|unverifiable`
 *
 * The verdict token tolerates the shapes an LLM actually emits, not just the
 * one the template shows. #397: a real resolver reply wrote `— **confirmed**`
 * on all seven of its evidence rows, and the strict `last === "confirmed"`
 * test downgraded every one to `unverifiable` — so the driver held seven
 * executed-evidence confirmations and recorded them as "could not tell".
 * The sibling verdict parsers already tolerate bold (`\**` in the
 * INTENT-VERDICT and PARK-REASON regexes above); this was the one place the
 * tolerance was omitted.
 *
 * Anchored at `^` deliberately: an unanchored `/confirmed/` would accept
 * prose like "I could not confirm this" as a confirmation.
 */
function parseEvidence(section: string | undefined): SpecEvidence[] {
  return bullets(section).map((line) => {
    const parts = line.split(/\s+—\s+|\s+--\s+/);
    const last = (parts[parts.length - 1] ?? "").trim().toLowerCase();
    // Trailing parentheticals are common too: `**confirmed** (distinct identity…)`.
    const tok = last.match(/^\**\s*(confirmed|contradicted)\b/)?.[1];
    const verdict: SpecEvidence["verdict"] =
      tok === "confirmed" || tok === "contradicted" ? tok : "unverifiable";
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
/**
 * An open question that reads as an explicit "nothing blocking" is not one.
 *
 * Resolvers write `- **None blocking** — mechanism is confirmed with executed
 * evidence` rather than emitting an empty section. Counting that as a blocking
 * question is how a fully-resolved spec looks unresolved.
 */
function blockingQuestions(qs: string[]): string[] {
  return qs.filter((q) => !/^[\s*_`]*(none|n\/a)\b/i.test(q));
}

/**
 * Does this spec, on its own terms, determine what to build?
 *
 * The `confirmed` conjunct is what keeps #378's "silence is not permission"
 * true. A resolver that filled in the template without checking anything
 * against the code has no confirmed evidence row, fails this predicate, and
 * still parks. It also couples this to `parseEvidence` by design: without the
 * bold tolerance there, a real reply scores zero confirmed rows and this
 * correctly returns false.
 */
/**
 * Is there something to build, and something to judge it by?
 *
 * Deliberately a LOWER bar than `specIsComplete`. That predicate exists to
 * refute a park — to overturn an "underspecified" verdict — and demands a
 * confirmed evidence row, which is the right price for overturning a decision
 * and the wrong price for making one. A straightforward issue with no contested
 * claims has no evidence to confirm, and parking it would be a regression.
 *
 * This one asks only what `proceed` has to MEAN: an intent, at least one
 * deliverable, and no blocking question whose answer would change what gets
 * built. Without deliverables `work-driver-plan.ts` silently falls back to
 * `countEnumeratedFindings`, and #290's decomposition arithmetic degrades on
 * exactly that input.
 *
 * Acceptance criteria are deliberately NOT required. Demanding them looked
 * right and was wrong: `proceed-with-assumptions` exists precisely for a spec
 * with a defensible gap, and two existing tests document cycles that proceed
 * without criteria. Parking those would have been a regression dressed as a
 * guardrail — the bar has to be the thing whose absence actually breaks
 * something downstream, not everything one might wish for.
 */
export function specIsActionable(spec: NormalisedSpec): boolean {
  return (
    spec.intent.trim().length > 0 &&
    spec.deliverables.some((d) => d.description.trim().length > 0) &&
    blockingQuestions(spec.openQuestions).length === 0
  );
}

export function specIsComplete(spec: NormalisedSpec): boolean {
  return (
    spec.intent.trim().length > 0 &&
    spec.deliverables.length > 0 &&
    spec.acceptanceCriteria.length > 0 &&
    spec.evidence.some((e) => e.verdict === "confirmed") &&
    !spec.evidence.some((e) => e.verdict === "contradicted") &&
    blockingQuestions(spec.openQuestions).length === 0
  );
}

/**
 * What the driver appends when it overrides an `underspecified` park.
 *
 * The resolver never said proceed — the driver inferred it — so the override
 * must be visible where review happens, not only in `trace`. This rides the
 * existing `renderAssumptions` call in the PR body.
 */
const OVERRIDE_ASSUMPTION = {
  text: "The explore step's verdict read `underspecified`, but its own spec named an intent, deliverables, acceptance criteria and confirmed evidence with no blocking open questions. The driver proceeded on the spec rather than the label.",
  basis: "a complete spec refutes `underspecified` on its face",
};

export function reconcileVerdict(spec: NormalisedSpec): NormalisedSpec {
  if (spec.verdict === "park") {
    // #397 — `underspecified` is the ONE park reason a complete spec refutes
    // on its face, and it is also the value the parser synthesises when the
    // resolver omits its verdict token entirely. A cycle on #337 produced two
    // deliverables, three acceptance criteria and seven confirmed evidence
    // rows, then told the operator the issue "does not say enough to build
    // from". The other four reasons are all compatible with a complete spec —
    // already-implemented, too-large, premise-unsound and contradicted-by-code
    // must still park, so the override stays deliberately narrow.
    //
    // #404 — narrower still: the reason must have been STATED, not synthesised.
    // `underspecified` is also what the parser invents when the token does not
    // parse, and a resolver really did emit `### PARK-REASON` / heading-form
    // `already-implemented`. Overriding an invented value let the driver build
    // work the resolver had said was already done, and attach the assumption
    // below as a confident justification for doing it.
    //
    // The override therefore needs BOTH provenances, not just one:
    //
    //   INTENT-VERDICT | PARK-REASON      | override a complete spec?
    //   absent         | absent           | YES — the resolver said nothing (#337)
    //   `park`         | `underspecified` | YES — it contradicts itself; the spec wins (#397)
    //   `park`         | unparseable      | NO  — it DID say park (#404)
    //   any            | any other reason | NO  — never in scope
    const refutable =
      spec.parkReason === "underspecified" &&
      (spec.verdictSource === "default" || spec.parkReasonSource === "parsed");
    if (refutable && specIsComplete(spec)) {
      trace("work-driver: intent — 'underspecified' park refuted by a complete spec, proceeding");
      const { parkReason: _dropped, parkReasonSource: _src, verdictSource: _vsrc, ...rest } = spec;
      return {
        ...rest,
        verdict: "proceed-with-assumptions",
        assumptions: [...spec.assumptions, OVERRIDE_ASSUMPTION],
      };
    }
    return spec;
  }
  if (spec.evidence.some((e) => e.verdict === "contradicted")) {
    trace("work-driver: intent — evidence contradicts a proceed verdict, parking");
    return { ...spec, verdict: "park", parkReason: "contradicted-by-code" };
  }
  // The symmetric question, which nothing used to ask: a `proceed` has to be a
  // decision ABOUT something. An empty spec that says proceed is exactly the
  // "underspecified" case the park path already handles well — it just arrived
  // wearing the other verdict.
  if (!specIsActionable(spec)) {
    trace(
      "work-driver: intent — 'proceed' with no deliverables or criteria, parking as underspecified",
    );
    return { ...spec, verdict: "park", parkReason: "underspecified" };
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
