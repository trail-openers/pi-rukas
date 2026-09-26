/**
 * research-memory — the one vipune row a /research run leaves behind.
 *
 * The old flow's entire durable output was this line (undated, untyped,
 * unsuperseded). The driver now writes it properly: type `fact`, status
 * `candidate` (invisible to default reads until promoted — the zero-blast-
 * radius convention from memory-write.ts), dated, pointing at the artifact
 * file, with JSON-validated metadata (vipune accepts malformed
 * `-m` at exit 0 and stores it, corrupting every later reader).
 *
 * Supersession: a re-run on the same topic supersedes the PREVIOUS row this
 * driver wrote — matched by the driver's own content signature (`Research:`
 * prefix + the artifact marker), never by the bare prefix, because old
 * prose-flow saves share the prefix and their stored type is unreadable
 * (vipune#178): superseding one would silently retype it. Rows this driver
 * wrote are always `fact`, so passing `fact` on supersede is safe.
 *
 * Row size: the whole-row cap is the FINAL guard. #895 sized it for the
 * takeaway format: a 400-char takeaway + `Research: <topic> — ` +
 * `. Artifact: <path> (<date>)` must fit without truncating the takeaway in
 * normal cases — hence 700 (was 300, which made the 400-char takeaway
 * always truncate mid-sentence). The cap still wins over any longer
 * combination; tests pin the exact stored row including that boundary.
 */
import type { ResearchClaim, ResearchMemoryOutcome } from "./research-types.ts";
import { vipuneAdd, vipuneSearch } from "./vipune.ts";

/**
 * Hard cap on the WHOLE row (takeaway + topic + artifact pointer + date).
 * Sized above the normal 400-char takeaway row so the takeaway survives
 * intact in the common case (#895); it remains the final guard for the
 * tail of the distribution.
 */
export const RESEARCH_MEMORY_MAX_CHARS = 700;

/** The content marker that identifies rows THIS driver wrote. */
const ARTIFACT_MARKER = "Artifact: outputs/research-";

/**
 * The supersession signature (topic prefix + artifact marker): a re-run
 * finds prior rows by `Research: <topic>` and checks this marker before
 * superseding. Exported so tests pin it — the takeaway format must never
 * break it (the marker sits AFTER the takeaway, so it is structurally
 * safe, but that safety is what the tests assert, not an assumption).
 */
export const RESEARCH_ROW_PREFIX = "Research: ";

export function researchMemoryText(
  topic: string,
  takeaway: string,
  artifactRelPath: string,
  date: string,
): string {
  const full = `Research: ${topic} — ${takeaway}. Artifact: ${artifactRelPath} (${date})`;
  return full.length > RESEARCH_MEMORY_MAX_CHARS
    ? `${full.slice(0, RESEARCH_MEMORY_MAX_CHARS - 1)}…`
    : full;
}

/**
 * The takeaway the driver stores for a run (#895): a count line plus the
 * top findings — the previous format stored only the first verified
 * finding's first 120 characters (95%+ of a run's content discarded, and a
 * re-run superseded it with whatever verified first).
 *
 * `verified` is the post-entailment verified-finding set: on the deep tier
 * the entail pass has already demoted "none" verdicts out of it, so "N
 * verified" counts what the run actually stands behind.
 *
 * Shape: `<N> verified of <M> claims across <K> angles — top findings:
 * <first 3 verified findings, each truncated to 80 chars, joined by
 * " | ">` (exactly the count line — `0 verified of M claims across K angles` —
 * when N is 0), capped at 400 chars.
 */
export function researchTakeawayText(
  verified: readonly Pick<ResearchClaim, "text">[],
  totalClaims: number,
  angleCount: number,
): string {
  const n = verified.length;
  if (n === 0) return `0 verified of ${totalClaims} claims across ${angleCount} angles`;
  const tops = verified
    .slice(0, 3)
    .map((c) => (c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text))
    .join(" | ");
  let t = `${n} verified of ${totalClaims} claims across ${angleCount} angles — top findings: ${tops}`;
  if (t.length > 400) t = `${t.slice(0, 399)}…`;
  return t;
}

export interface ResearchMemoryMetadata extends Record<string, unknown> {
  src: "pi-rukas";
  kind: "research";
  topic: string;
  artifact: string;
  date: string;
}

/** JSON-validate the metadata BEFORE the binary is reached (memory-write.ts precedent). */
export function validResearchMetadata(m: unknown): m is ResearchMemoryMetadata {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  if (r.src !== "pi-rukas" || r.kind !== "research") return false;
  for (const k of ["topic", "artifact", "date"]) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) return false;
  }
  try {
    JSON.parse(JSON.stringify(m));
    return true;
  } catch {
    return false;
  }
}

export async function writeResearchMemory(args: {
  topic: string;
  takeaway: string;
  artifactRelPath: string;
  date: string;
  cwd: string;
}): Promise<ResearchMemoryOutcome> {
  const metadata: ResearchMemoryMetadata = {
    src: "pi-rukas",
    kind: "research",
    topic: args.topic,
    artifact: args.artifactRelPath,
    date: args.date,
  };
  if (!validResearchMetadata(metadata)) {
    return { outcome: "skipped", detail: "invalid metadata (never reaches the binary)" };
  }
  const text = researchMemoryText(args.topic, args.takeaway, args.artifactRelPath, args.date);

  // Supersession lookup: only rows carrying the driver's own signature.
  let supersedes: string | undefined;
  const prior = await vipuneSearch(`Research: ${args.topic}`, {
    cwd: args.cwd,
    limit: 5,
    includeCandidates: true,
  });
  if (prior.kind === "hits") {
    const own = prior.hits.find(
      (h) => h.content.startsWith(RESEARCH_ROW_PREFIX) && h.content.includes(ARTIFACT_MARKER),
    );
    supersedes = own?.id;
  }

  const res = await vipuneAdd(text, {
    cwd: args.cwd,
    memoryType: "fact",
    status: "candidate",
    supersedes,
    metadata,
  });
  switch (res.kind) {
    case "added":
      return { outcome: "written", id: res.id };
    case "superseded":
      return { outcome: "superseded", id: res.id };
    case "absent":
      return { outcome: "skipped", detail: "vipune not installed" };
    case "refused":
      return { outcome: "skipped", detail: `refused: ${res.reason}` };
    default:
      return { outcome: "error", detail: res.kind };
  }
}
