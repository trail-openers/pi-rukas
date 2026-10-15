/**
 * memory-panel — the `/audit` memory section.
 *
 * `memory-stats.ts` shipped in v0.12.32 calibrated, documented and fully
 * tested, with **no caller**. This is its caller.
 *
 * `/audit` is where it belongs: the command already asks "does this repo hold
 * up against its own standards", and a memory store nobody reads is exactly
 * that kind of finding. The framing is deliberately actionable rather than a
 * number dump — a percentage means nothing to an auditor unless it comes with
 * what to do about it.
 *
 * Never fails the command. Every failure path in `readMemoryStats` already
 * returns `undefined`, and a missing project resolves to no panel at all, so
 * the outgoing message is byte-identical to the prompt body when there is
 * nothing to say.
 */

import { execp } from "./exec.ts";
import { type MemoryStats, readMemoryStats } from "./memory-stats.ts";

/**
 * Which project's memory to read.
 *
 * `VIPUNE_PROJECT` wins because an operator who set it meant it. Otherwise the
 * git remote, which is what the rest of the harness keys on.
 */
export async function resolveProject(repoRoot: string): Promise<string | undefined> {
  const explicit = process.env.VIPUNE_PROJECT?.trim();
  if (explicit) return explicit;
  try {
    const { stdout } = await execp("git config --get remote.origin.url", { cwd: repoRoot });
    const url = stdout.trim();
    if (!url) return undefined;
    // `git@github.com:owner/repo.git` and `https://…/owner/repo.git` both
    // reduce to `owner/repo`, which is how vipune keys a project.
    const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Turn stats into something an auditor can act on.
 *
 * Only says what is worth saying: a healthy store gets one line, not a report.
 */
export function renderMemoryPanel(s: MemoryStats): string {
  const lines = [`## Memory (${s.project})`, ""];
  lines.push(
    `${s.rows} memories, ${s.totalRetrievals} retrievals total (most-read row: ${s.maxRetrievals}).`,
  );

  const findings: string[] = [];
  if (s.rows === 0) {
    return [
      `## Memory (${s.project})`,
      "",
      "No memories recorded for this project. If sessions have been running with",
      "`PI_ENSEMBLE_AUTOSAVE=1`, that is itself a finding — nothing is being written.",
    ].join("\n");
  }

  const neverPct = Math.round((100 * s.neverRetrieved) / s.rows);
  if (neverPct >= 50) {
    findings.push(
      `- **${s.neverRetrieved} of ${s.rows} memories (${neverPct}%) have never been retrieved.** Either they are not being written in a form retrieval can find, or they are not worth keeping. Sample a few and check whether the content names the files and symbols a future query would use.`,
    );
  }
  if (s.totalRetrievals === 0 && s.rows > 0) {
    findings.push(
      "- **Nothing has ever been read back.** The store is write-only, which makes every memory " +
        "written so far pure cost. Check that the reading seam is actually wired.",
    );
  }
  if (s.medianChars > 0 && s.medianChars < 120) {
    findings.push(
      `- **Median memory is ${s.medianChars} characters.** Short entries tend to lack the file and symbol names that make them findable later.`,
    );
  }
  const archived = s.byStatus.archived ?? 0;
  if (archived > 0 && archived >= s.rows / 2) {
    findings.push(
      `- **${archived} of ${s.rows} rows are archived.** Worth confirming the live set is still representative.`,
    );
  }

  if (findings.length === 0) {
    lines.push(
      "",
      `Nothing anomalous: ${neverPct}% never retrieved, median ${s.medianChars} chars.`,
    );
  } else {
    lines.push("", ...findings);
  }
  lines.push(...renderCandidates(s));
  return lines.join("\n");
}

/**
 * Candidates awaiting an operator decision.
 *
 * The developer brief reads active rows only (#1103), so a candidate the
 * driver wrote influences nothing until someone promotes it — and this is
 * where that someone finds it. `vipune promote` takes no id and promotes on
 * retrieval count, which a `--no-touch` reader never raises, so the per-row
 * hint is a status update. Unpromoted candidates age out via `vipune prune`.
 */
function renderCandidates(s: MemoryStats): string[] {
  if (s.candidates.length === 0) return [];
  const total = s.byStatus.candidate ?? s.candidates.length;
  const out = [
    "",
    `### Candidates awaiting promotion (${total})`,
    "",
    "Invisible to developer briefs until an operator promotes them. Unpromoted candidates",
    "age out under `vipune prune`. To promote a row you have verified (operator only):",
    "`vipune update <id> --status active` — denied to every agent role.",
    "",
  ];
  // Ids and types only. Candidate content is LLM-derived from untrusted diffs;
  // printing it here would put attacker-shaped text into the PM's context.
  for (const c of s.candidates) out.push(`- \`${c.id}\` (${c.type})`);
  if (total > s.candidates.length) out.push(`- …and ${total - s.candidates.length} more`);
  return out;
}

/**
 * Build the panel for a repo, or nothing.
 *
 * Returns `undefined` rather than an error string on every failure path — a
 * memory panel is a bonus on `/audit`, never a reason for it not to run.
 */
export async function buildMemoryPanel(repoRoot: string): Promise<string | undefined> {
  const project = await resolveProject(repoRoot);
  if (!project) return undefined;
  const stats = await readMemoryStats(project);
  if (!stats) return undefined;
  return renderMemoryPanel(stats);
}
