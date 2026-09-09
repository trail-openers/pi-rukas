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
 * Derive the angle set. PM-supplied prompts win (framed, named custom-N);
 * otherwise: quick = 1 web angle; standard = web + docs, + codebase iff the
 * topic names code (codeIdentifiers non-empty).
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
