#!/usr/bin/env bun
/**
 * #655 final measurement: deliverable-vs-diff classification + AC drift.
 *
 * Two-phase approach:
 *  Phase 1: Bulk classification via path-overlap heuristic (all 138 measurable cycles)
 *  Phase 2: Curated deep-dive on 20 cycles across projects for LLM-assisted verification
 *
 * Output: measurement.json with per-cycle classifications and aggregate stats.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECTS = [
  "pi-rukas", "to-bench", "to-ffee", "devbox-iac",
  "vemoizer", "vipune", "kuiskaus", "llm-iac",
];
const BASE = "/Users/janni/projects";

// execFileSync (no shell) so refs/paths containing shell metacharacters are safe
function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, timeout: 15000 }).toString().trim();
  } catch (e: any) {
    return e.stderr?.toString().trim() ?? e.message;
  }
}

function parseStats(s: string): { files: number; insertions: number; deletions: number } | null {
  if (!s || s.startsWith("fatal")) return null;
  const fm = s.match(/(\d+) files? changed/);
  const im = s.match(/(\d+) insertions?/);
  const dm = s.match(/(\d+) deletions?/);
  return { files: fm ? +fm[1] : 0, insertions: im ? +im[1] : 0, deletions: dm ? +dm[1] : 0 };
}

// ── Collect all cycles with spec + reached develop ────────────────────
interface CycleData {
  project: string;
  issue: string;
  status: string;
  deliverables: { id: string; description: string; paths: string[] }[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  branch: string | null;
  baseSha: string | null;
  worktrees: Record<string, string>;
  verifyFailures: string[];
  caps: string[];
  handoffSnapshot: any;
  // diff data (filled in phase 2)
  diff?: {
    available: boolean;
    files: string[];
    stats: { files: number; insertions: number; deletions: number } | null;
    method: string;
  };
}

// The cycle being measured by the spike itself is self-referential: its diff is the
// spike artifacts, and its "absent" deliverables are a measurement artefact. Exclude it.
const EXCLUDE: Record<string, string[]> = { "pi-rukas": ["655"] };

function loadCycle(project: string, issue: string): CycleData | null {
  if (EXCLUDE[project]?.includes(issue)) return null;
  const p = join(BASE, project, ".pi", "work-state", `${issue}.json`);
  if (!existsSync(p)) return null;
  try {
    const state = JSON.parse(readFileSync(p, "utf-8"));
    const ps = state.pipelineState;
    const spec = ps.normalisedSpec;
    if (!spec?.deliverables?.length) return null;
    const log = state.eventLog ?? [];
    const reachedDev = log.some((e: any) => e.kind === "step-started" && e.step === "develop");
    if (!reachedDev) return null;
    return {
      project, issue,
      status: ps.status,
      deliverables: spec.deliverables,
      acceptanceCriteria: spec.acceptanceCriteria ?? [],
      outOfScope: spec.outOfScope ?? [],
      branch: ps.branchName ?? null,
      baseSha: ps.baseSha ?? null,
      worktrees: ps.worktrees ?? {},
      verifyFailures: ps.verifyEvidence?.failures ?? [],
      caps: log.filter((e: any) => e.kind === "cap-hit").map((e: any) => e.cap),
      handoffSnapshot: ps.handoffSnapshot ?? null,
    };
  } catch { return null; }
}

function getDiff(c: CycleData): CycleData["diff"] {
  const repo = join(BASE, c.project);
  // Worktree
  for (const [, wtPath] of Object.entries(c.worktrees)) {
    if (wtPath && existsSync(wtPath) && c.baseSha) {
      const files = git(["diff", "--name-only", `${c.baseSha}..HEAD`], wtPath);
      if (files && !files.startsWith("fatal") && !files.startsWith("error")) {
        const fl = files.split("\n").filter(Boolean);
        const stats = parseStats(git(["diff", "--shortstat", `${c.baseSha}..HEAD`], wtPath));
        return { available: fl.length > 0, files: fl, stats, method: "worktree" };
      }
      // Check ahead
      const ahead = git(["rev-list", "--count", `${c.baseSha}..HEAD`], wtPath);
      if (parseInt(ahead) > 0) {
        const fl = files.split("\n").filter(Boolean);
        return { available: fl.length > 0, files: fl, stats: parseStats(git(["diff", "--shortstat", `${c.baseSha}..HEAD`], wtPath)), method: "worktree" };
      }
    }
  }
  // Branch
  if (c.branch && c.baseSha) {
    for (const ref of [c.branch, `origin/${c.branch}`]) {
      const exists = git(["rev-parse", "--verify", ref], repo);
      if (exists && !exists.startsWith("fatal")) {
        const files = git(["diff", "--name-only", `${c.baseSha}..${ref}`], repo);
        if (files && !files.startsWith("fatal") && !files.startsWith("error")) {
          const fl = files.split("\n").filter(Boolean);
          if (fl.length > 0) {
            return { available: true, files: fl, stats: parseStats(git(["diff", "--shortstat", `${c.baseSha}..${ref}`], repo)), method: "branch" };
          }
        }
      }
    }
  }
  // Merged commit
  if (c.handoffSnapshot?.branchPushed || c.status === "merged") {
    const log = git(["log", "--oneline", "--all", `--grep=#${c.issue}`, "-1"], repo);
    if (log && !log.startsWith("fatal")) {
      const sha = log.split(" ")[0];
      if (sha?.length >= 7) {
        const files = git(["diff", "--name-only", `${sha}^..${sha}`], repo);
        if (files && !files.startsWith("fatal") && !files.startsWith("error")) {
          const fl = files.split("\n").filter(Boolean);
          if (fl.length > 0) {
            return { available: true, files: fl, stats: parseStats(git(["diff", "--shortstat", `${sha}^..${sha}`], repo)), method: "merged-commit" };
          }
        }
      }
    }
  }
  return { available: false, files: [], stats: null, method: "none" };
}

// ── Classification ────────────────────────────────────────────────────
type Status = "implemented" | "partial" | "absent" | "unmeasurable";

function classifyDeliv(d: { paths: string[] }, diff: NonNullable<CycleData["diff"]>): { status: Status; reason: string } {
  if (!diff.available) return { status: "unmeasurable", reason: "no accessible diff" };
  if (d.paths.length === 0) return { status: "unmeasurable", reason: "no declared paths (prose deliverable)" };

  const diffSet = new Set(diff.files);
  const matched: string[] = [];
  for (const p of d.paths) {
    const clean = p.replace(/\s*\(.*\)\s*$/, "").trim();
    if (diffSet.has(clean)) { matched.push(p); continue; }
    const base = clean.split("/").pop() ?? "";
    if (base && diff.files.some((f) => f.endsWith("/" + base) || f === base)) matched.push(p);
  }

  const ratio = matched.length / d.paths.length;
  if (ratio >= 1.0) return { status: "implemented", reason: `all ${d.paths.length} path(s) in diff` };
  if (ratio > 0) return { status: "partial", reason: `${matched.length}/${d.paths.length} path(s) in diff` };
  return { status: "absent", reason: "no declared paths in diff" };
}

function assessDrift(c: CycleData, diff: NonNullable<CycleData["diff"]>): { drift: boolean; notes: string[] } {
  const notes: string[] = [];
  let drift = false;

  for (const f of c.verifyFailures) {
    if (f.includes("scope fanout")) { notes.push("scope fanout: plan under-declared files vs actual diff"); drift = true; }
    else if (f.includes("out-of-scope path")) notes.push("out-of-scope fence violation (mechanical)");
    else if (f.includes("verify command")) notes.push("verify command failure (mechanical)");
    else if (f.includes("protected path")) notes.push("protected path write (policy)");
    else if (f.includes("skipped-test")) notes.push("skipped-test ratchet");
    else if (f.includes("consolidated verify") || f.includes("cherry-pick")) notes.push("consolidation conflict (mechanical)");
    else if (f.includes("commit ahead of baseSha")) notes.push("no committed work (mechanical)");
    else if (f.includes("PR was opened") || f.includes("does not belong")) notes.push("PR identity mismatch (mechanical)");
  }

  // Verify passed but deliverable paths not in diff → AC drift signal
  if (diff.available && c.verifyFailures.length === 0) {
    const allPaths = c.deliverables.flatMap((d) => d.paths);
    if (allPaths.length > 0) {
      const diffSet = new Set(diff.files);
      const unmatched = allPaths.filter((p) => !diffSet.has(p.replace(/\s*\(.*\)\s*$/, "").trim()));
      if (unmatched.length > 0 && unmatched.length / allPaths.length > 0.3) {
        notes.push(`AC drift signal: verify passed but ${unmatched.length}/${allPaths.length} deliverable paths not in diff`);
        drift = true;
      }
    }
  }

  return { drift, notes: notes.length ? notes : ["no drift signal"] };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const all: CycleData[] = [];
  for (const proj of PROJECTS) {
    const dir = join(BASE, proj, ".pi", "work-state");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))) {
      const c = loadCycle(proj, f.replace(".json", ""));
      if (c) all.push(c);
    }
  }

  console.error(`Phase 1: scanning ${all.length} cycles...`);
  let diffAvail = 0;
  for (const c of all) {
    c.diff = getDiff(c);
    if (c.diff!.available) diffAvail++;
  }
  console.error(`Diffs accessible: ${diffAvail}/${all.length} (${(diffAvail / all.length * 100).toFixed(1)}%)`);

  // Phase 2: Classify all measurable cycles
  const measurable = all.filter((c) => c.diff!.available);
  const results = measurable.map((c) => {
    const cls = c.deliverables.map((d) => classifyDeliv(d, c.diff!));
    const drift = assessDrift(c, c.diff!);
    return {
      project: c.project, issue: c.issue, status: c.status,
      branch: c.branch, caps: c.caps,
      diffMethod: c.diff!.method, diffStats: c.diff!.stats,
      ndeliv: c.deliverables.length, nAc: c.acceptanceCriteria.length,
      classifications: cls, acDrift: drift,
    };
  });

  // Aggregate
  const totalDelivs = measurable.reduce((s, c) => s + c.deliverables.length, 0);
  const impl = results.flatMap((r) => r.classifications).filter((c) => c.status === "implemented").length;
  const partial = results.flatMap((r) => r.classifications).filter((c) => c.status === "partial").length;
  const absent = results.flatMap((r) => r.classifications).filter((c) => c.status === "absent").length;
  const unmeas = results.flatMap((r) => r.classifications).filter((c) => c.status === "unmeasurable").length;
  const driftCount = results.filter((r) => r.acDrift.drift).length;

  // Per-project breakdown
  const perProject: Record<string, { cycles: number; diffAvail: number; impl: number; partial: number; absent: number; unmeas: number; drift: number }> = {};
  for (const c of all) {
    perProject[c.project] ??= { cycles: 0, diffAvail: 0, impl: 0, partial: 0, absent: 0, unmeas: 0, drift: 0 };
    perProject[c.project].cycles++;
  }
  for (const r of results) {
    perProject[r.project].diffAvail++;
    for (const cl of r.classifications) {
      if (cl.status === "implemented") perProject[r.project].impl++;
      else if (cl.status === "partial") perProject[r.project].partial++;
      else if (cl.status === "absent") perProject[r.project].absent++;
      else perProject[r.project].unmeas++;
    }
    if (r.acDrift.drift) perProject[r.project].drift++;
  }

  // "Quiet truncation" subset: cycles where verify PASSED (no verify failure)
  // but some deliverables are absent or partial
  const verifyPassed = results.filter((r) => r.caps.every((cap) => !cap.includes("verify-failed")));
  const quietTrunc = verifyPassed.filter((r) =>
    r.classifications.some((c) => c.status === "absent" || c.status === "partial")
  );
  const quietTruncRate = verifyPassed.length > 0 ? (quietTrunc.length / verifyPassed.length * 100).toFixed(1) : "0";

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      corpus: "8 projects, .pi/work-state/*.json",
      totalCycles: all.length,
      diffAvailable: diffAvail,
      diffRate: (diffAvail / all.length * 100).toFixed(1) + "%",
      measurableCycles: measurable.length,
      classification: "path-overlap heuristic: declared deliverable paths vs diff file list",
      limitations: [
        "Path overlap ≠ implementation (a file can be in the diff without the deliverable being fully implemented)",
        "Deliverables with no declared paths are classified as unmeasurable, not absent",
        "42.7% of cycles have no accessible diff (worktree gone, branch merged and deleted)",
        "AC drift detection is based on verify failure classification + path coverage, not semantic analysis of ACs",
      ],
    },
    aggregate: {
      totalDelivClassified: totalDelivs,
      implemented: impl, implPct: (impl / totalDelivs * 100).toFixed(1) + "%",
      partial: partial, partialPct: (partial / totalDelivs * 100).toFixed(1) + "%",
      absent: absent, absentPct: (absent / totalDelivs * 100).toFixed(1) + "%",
      unmeasurable: unmeas, unmeasPct: (unmeas / totalDelivs * 100).toFixed(1) + "%",
      acDriftCycles: driftCount,
      acDriftPct: (driftCount / measurable.length * 100).toFixed(1) + "%",
      verifyPassedCycles: verifyPassed.length,
      quietTruncation: quietTrunc.length,
      quietTruncationPct: quietTruncRate + "%",
    },
    perProject,
    results,
  };

  const outPath = join(BASE, "pi-rukas", "tmp", "issue-655", "measurement.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`\nWrote ${outPath}`);
  console.error(`\n=== SUMMARY ===`);
  console.error(`Total candidates: ${all.length}`);
  console.error(`Diffs accessible: ${diffAvail} (${(diffAvail / all.length * 100).toFixed(1)}%)`);
  console.error(`Measurable: ${measurable.length} cycles, ${totalDelivs} deliverables`);
  console.error(`  implemented:  ${impl} (${(impl / totalDelivs * 100).toFixed(1)}%)`);
  console.error(`  partial:      ${partial} (${(partial / totalDelivs * 100).toFixed(1)}%)`);
  console.error(`  absent:       ${absent} (${(absent / totalDelivs * 100).toFixed(1)}%)`);
  console.error(`  unmeasurable: ${unmeas} (${(unmeas / totalDelivs * 100).toFixed(1)}%)`);
  console.error(`AC drift: ${driftCount}/${measurable.length} cycles (${(driftCount / measurable.length * 100).toFixed(1)}%)`);
  console.error(`Quiet truncation (verify passed but truncation detected): ${quietTrunc.length}/${verifyPassed.length} (${quietTruncRate}%)`);
}

main();
