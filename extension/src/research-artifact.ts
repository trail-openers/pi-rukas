/**
 * research-artifact — the durable artifact + provenance sidecar of /research.
 *
 * The single biggest gap vs every surveyed harness (outputs/
 * research-driver-landscape.md §Executive summary 5.1): the old flow's only
 * durable output was one undated vipune line. The driver now writes a dated
 * markdown report plus a provenance sidecar under `<repo>/outputs/`
 * (operator decision 2026-09-09), following this repo's own
 * `<slug>.md` + `<slug>.provenance.md` convention.
 *
 * `outputs/` is ensured into `.git/info/exclude` (the per-clone mechanism
 * the scratch-hygiene convention uses for `tmp/` — AGENTS.md §7) so an
 * untracked artifact can never dirty a later /work cycle's clean-tree check.
 * The project's own .gitignore is NEVER edited — whether artifacts get
 * committed is the operator's call.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AngleRun, ResearchClaim, ResearchTier } from "./research-types.ts";
import { trace } from "./trace.ts";

/** Lowercase-kebab slug from a topic, bounded for a sane filename. */
export function slugify(topic: string): string {
  const s = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "research";
}

export interface ArtifactPaths {
  artifactPath: string;
  provenancePath: string;
}

/**
 * Resolve non-colliding paths: `outputs/research-<slug>.md` (+ sidecar);
 * an existing artifact gets a `-2`, `-3`… suffix — a new run is a new
 * document, never a silent overwrite of an earlier report.
 */
export async function resolveArtifactPaths(repoRoot: string, slug: string): Promise<ArtifactPaths> {
  const dir = path.join(repoRoot, "outputs");
  const exists = async (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    );
  let base = `research-${slug}`;
  for (let n = 2; await exists(path.join(dir, `${base}.md`)); n++) {
    base = `research-${slug}-${n}`;
  }
  return {
    artifactPath: path.join(dir, `${base}.md`),
    provenancePath: path.join(dir, `${base}.provenance.md`),
  };
}

/**
 * Ensure `outputs/` is in `.git/info/exclude`. No-op when `.git` is not a
 * plain directory (worktree/submodule `.git` files are skipped — those
 * clones resolve their own exclude file and this is a convenience, not a
 * gate) or on any I/O failure: the artifact write must never fail because
 * the exclude could not be written.
 */
export async function ensureOutputsExcluded(repoRoot: string): Promise<void> {
  try {
    const gitDir = path.join(repoRoot, ".git");
    const st = await fs.stat(gitDir).catch(() => undefined);
    if (!st?.isDirectory()) return;
    const infoDir = path.join(gitDir, "info");
    const excludeFile = path.join(infoDir, "exclude");
    await fs.mkdir(infoDir, { recursive: true });
    const current = await fs.readFile(excludeFile, "utf8").catch(() => "");
    if (current.split("\n").some((l) => l.trim() === "outputs/")) return;
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    await fs.appendFile(excludeFile, `${sep}outputs/\n`);
  } catch (err) {
    trace(`research-artifact: could not update .git/info/exclude: ${(err as Error).message}`);
  }
}

function verificationLabel(c: ResearchClaim): string {
  const v = c.verification;
  if (v.check === "url-liveness") return `url ${v.status}`;
  if (v.check === "code-grounding") return v.status;
  return "unchecked";
}

function claimRow(c: ResearchClaim): string {
  const date = c.sourceDate ? ` · ${c.sourceDate}` : "";
  return `- ${c.text}\n  - source: ${c.source}${date} · confidence: ${c.confidence} · staleness: ${c.staleness} · verification: ${verificationLabel(c)} · angle: ${c.angle}`;
}

export interface ArtifactArgs {
  topic: string;
  tier: ResearchTier;
  date: string;
  pinnedCommit: string;
  angles: AngleRun[];
  claims: ResearchClaim[];
  abstained: boolean;
  provenanceBasename: string;
}

/** Render the dated research artifact (markdown). */
export function renderArtifact(a: ArtifactArgs): string {
  const findings = a.claims.filter((c) => c.kind === "finding");
  const contradictions = a.claims.filter((c) => c.kind === "contradiction");
  const gaps = a.claims.filter((c) => c.kind === "gap");
  const signals = a.claims.filter((c) => c.kind === "signal");
  const section = (title: string, items: ResearchClaim[], empty: string) =>
    `## ${title}\n\n${items.length > 0 ? items.map(claimRow).join("\n") : `- ${empty}`}\n`;
  const abstention = a.abstained
    ? "\n> **No reliably verified findings.** Nothing below cleared deterministic verification — this artifact records what was checked so the next attempt starts further ahead, not to support conclusions.\n"
    : "";
  const summaries = a.angles
    .map((x) => `- **${x.name}** (${x.ok ? "ok" : "failed"}): ${x.summary || "(no summary)"}`)
    .join("\n");
  return `# Research: ${a.topic}

**Date:** ${a.date} · **Tier:** ${a.tier} · **Pinned commit:** ${a.pinnedCommit}
**Provenance:** ${a.provenanceBasename}
${abstention}
## Angle summaries

${summaries || "- (no angles ran)"}

${section("Findings", findings, "(none)")}
${signals.length > 0 ? section("Signals", signals, "(none)") : ""}${section("Contradictions", contradictions, "(none)")}
${section("Gaps / unanswered", gaps, "(none)")}
## Staleness note

Findings marked \`fast-moving\` should be re-verified before reuse in a later /plan or /work run — a single outdated passage measurably degrades downstream answers.
`.replace(/\n{3,}/g, "\n\n");
}

/** Render the provenance sidecar: every source, its check, its outcome. */
export function renderProvenance(a: ArtifactArgs): string {
  const rows = a.claims.map(
    (c) =>
      `- ${c.source} · kind: ${c.sourceKind} · ${verificationLabel(c)}${c.sourceDate ? ` · source date: ${c.sourceDate}` : ""} · cited by: ${c.text.slice(0, 80)}`,
  );
  return `# Provenance: ${a.topic}

**Date:** ${a.date} · **Tier:** ${a.tier} · **Pinned commit:** ${a.pinnedCommit}

Verification legend: \`url live/dead/unreachable\` = HTTP check at the date above (403/429 count as unreachable, not dead); \`grounded/ungrounded\` = path/symbol checked against the pinned commit's tree; \`unchecked\` = no deterministic check applies.

## Sources

${rows.join("\n") || "- (none)"}
`;
}

/** Write artifact + sidecar (creating outputs/), returning the paths. */
export async function writeArtifact(
  repoRoot: string,
  a: ArtifactArgs,
  paths: ArtifactPaths,
): Promise<ArtifactPaths> {
  await fs.mkdir(path.dirname(paths.artifactPath), { recursive: true });
  await ensureOutputsExcluded(repoRoot);
  await fs.writeFile(paths.artifactPath, renderArtifact(a), "utf8");
  await fs.writeFile(paths.provenancePath, renderProvenance(a), "utf8");
  return paths;
}
