/**
 * research-memory — the one vipune row a /research run leaves behind.
 *
 * The old flow's entire durable output was this line (undated, untyped,
 * unsuperseded). The driver now writes it properly: type `fact`, status
 * `candidate` (invisible to default reads until promoted — the zero-blast-
 * radius convention from memory-write.ts), ≤300 chars, dated, pointing at
 * the artifact file, with JSON-validated metadata (vipune accepts malformed
 * `-m` at exit 0 and stores it, corrupting every later reader).
 *
 * Supersession: a re-run on the same topic supersedes the PREVIOUS row this
 * driver wrote — matched by the driver's own content signature (`Research:`
 * prefix + the artifact marker), never by the bare prefix, because old
 * prose-flow saves share the prefix and their stored type is unreadable
 * (vipune#178): superseding one would silently retype it. Rows this driver
 * wrote are always `fact`, so passing `fact` on supersede is safe.
 */
import type { ResearchMemoryOutcome } from "./research-types.ts";
import { vipuneAdd, vipuneSearch } from "./vipune.ts";

export const RESEARCH_MEMORY_MAX_CHARS = 300;

/** The content marker that identifies rows THIS driver wrote. */
const ARTIFACT_MARKER = "Artifact: outputs/research-";

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
      (h) => h.content.startsWith("Research: ") && h.content.includes(ARTIFACT_MARKER),
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
