/**
 * research-angles — tier→angle derivation and prompt framing for /research.
 *
 * Judgement stays with PM: it may pass its own angle prompts (they are
 * framed and dispatched verbatim); when it does not, the default set is
 * DERIVED DETERMINISTICALLY from the tier and the topic (the codebase angle
 * runs only when the topic names code — the same codeIdentifiersIn signal
 * the plan driver uses). Width is deliberately bounded: the retrieval
 * literature shows hard diminishing returns past a handful of curated
 * sources (outputs/research-driver-landscape.md §2), so the fix for quality
 * is verification and artifacts, never more fan-out.
 */
import { DESCRIPTOR_DATA_FRAMING } from "./plan-angles.ts";
import type { ResearchTier } from "./research-types.ts";

export interface ResearchAngle {
  name: string;
  prompt: string;
}

/** Max angles per run (PM-supplied lists are clipped, never rejected). */
export const MAX_RESEARCH_ANGLES = 4;

const REPORTER_PROMPT = [
  "## How to report — STRUCTURED, not prose",
  "For each claim you establish, call the `report_research_claim` tool ONCE (one call per claim, never batched; never as prose or JSON in your reply — only the tool calls count).",
  "Rules:",
  "- EVERY finding must name its source: a full URL, a repo path (`path#symbol` for code claims), or a versioned doc reference. An unsourced 'finding' is a `gap`.",
  "- Carry the source's DATE when you can determine it (sourceDate); never guess a date.",
  "- Mark staleness honestly: versions, benchmark numbers, maintainer/pricing facts and API surfaces are `fast-moving`; algorithms, published history and shipped decisions are `stable`.",
  "- When two sources disagree, report a `contradiction` naming both sides and both sources.",
  "- When you cannot answer something reliably, report a `gap` — an honest gap beats a confident fabrication.",
  "When you have finished all tool calls, write a SHORT prose summary (2-4 sentences) of what you established. The tool calls are the record; the prose is only a human-readable summary.",
].join("\n");

function frame(name: string, task: string): ResearchAngle {
  return {
    name,
    prompt: `RESEARCH (angle: ${name})\n\n${DESCRIPTOR_DATA_FRAMING}${task}\n\n${REPORTER_PROMPT}`,
  };
}

/**
 * The adoption tier's fixed trio — the "no product ships the full dated
 * adoption memo" whitespace (report §2): security/health signals,
 * alternatives, and this-repo integration fit.
 */
function adoptionAngles(topic: string): ResearchAngle[] {
  return [
    frame(
      "adoption-signals",
      `Collect the OSS-adoption signals for: "${topic}". Report each as kind "signal" with its source URL: OpenSSF Scorecard score (or its absence), Socket/Snyk-style supply-chain indicators, release cadence over the last 12 months (commits/releases, NOT star counts), latest release age vs a 4-day supply-chain embargo, license, maintainer count / bus factor, and any recent CVEs or yanked releases.`,
    ),
    frame(
      "adoption-alternatives",
      `Identify 2-4 credible alternatives to: "${topic}". For each, report findings covering: what it is, its one-line trade-off against the candidate, and the same headline health signal where quickly checkable. Include the do-nothing/build-in-house option when it is credible.`,
    ),
    frame(
      "adoption-fit",
      `Establish how "${topic}" would integrate with THIS repository: read the manifests (package.json / Cargo.toml / etc.), the existing dependency set and the code that would touch it (codebase_memory_search_code). Report findings for: where it would be used, what it would replace or overlap with, install/runtime constraints (supply-chain embargo compatibility, platform support), and code claims as \`path#symbol\` sources so the driver can pin them.`,
    ),
  ];
}

/**
 * Derive the angle set. PM-supplied prompts win (framed, named custom-N);
 * otherwise: quick = 1 web angle; standard AND deep = web + docs, +
 * codebase iff the topic names code (deep differs downstream — the
 * entailment pass — not in retrieval width, per the report: more fan-out
 * has measured diminishing returns, verification is where depth pays);
 * adoption = the fixed memo trio.
 */
export function anglesForTier(
  tier: ResearchTier,
  topic: string,
  codeIdentifiers: string[],
  custom?: string[],
): ResearchAngle[] {
  const supplied = (custom ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (supplied.length > 0) {
    return supplied
      .slice(0, MAX_RESEARCH_ANGLES)
      .map((p, i) => frame(`custom-${i + 1}`, `${p}\n\nTopic: "${topic}".`));
  }
  if (tier === "adoption") return adoptionAngles(topic);

  const web = frame(
    "web-current",
    `Establish the current state of this topic from the live web: "${topic}". Prefer primary sources (official docs, repos, release notes, papers) over aggregators; note publication dates; check whether anything cited has been superseded by a newer release or announcement.`,
  );
  if (tier === "quick") return [web];

  const docs = frame(
    "docs-depth",
    `Establish the technical depth of this topic from authoritative documentation and specifications: "${topic}". Use ctx7 for versioned library docs where a library is involved (pin the version you read). Capture the load-bearing mechanisms, limits and version gates — not marketing summaries.`,
  );
  const angles = [web, docs];
  if (codeIdentifiers.length > 0) {
    angles.push(
      frame(
        "codebase",
        `Establish how this topic relates to THIS repository's code: "${topic}". Use codebase_memory_search_code (and trace_path / get_architecture where relevant). Candidate identifiers: ${codeIdentifiers.join(", ")}. Every code claim must name the repo path (and \`path#symbol\` where a symbol is the subject) so the driver can verify it against the pinned commit.`,
      ),
    );
  }
  return angles;
}
