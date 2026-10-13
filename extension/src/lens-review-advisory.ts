/**
 * lens-review-advisory — carried findings outside the PR's diff are advisory (#1140).
 *
 * Findings memory (review-findings-store.ts) carries an open row into every
 * later round while its file and cited line exist. A row stored on a file the
 * PR never touches (#1133: a phantom two-dot diff) therefore blocked forever,
 * and a carried CRITICAL set `hasCritical`, so only an operator editing the
 * store could unblock the PR. Production review tools block only on code the
 * change touched; this module applies that rule to carried rows only:
 *
 *   - a carried row whose path is NOT in `git diff --name-only <base>...<head>`
 *     (base: the review's explicit `base`, else the mainline; head: the
 *     review's resolved head SHA) is ADVISORY — out of the verdict and
 *     `hasCritical`, listed under "Advisory (outside this PR's diff)";
 *   - a carried row on a changed file, or with no path, blocks as before;
 *   - when the file list cannot be read, every carried row blocks (today's
 *     behaviour) and the returned note says so.
 *
 * Fresh findings from the round never pass through here, and the store rows
 * are not modified.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { neutraliseEvidence } from "./comment-evidence.ts";
import type { Finding } from "./lens-review-types.ts";
import { resolveMainlineBase } from "./review-delta-hunks.ts";

const execFileP = promisify(execFile);

export const ADVISORY_HEADING = "Advisory (outside this PR's diff)";

const norm = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

/** The PR's changed files, or the reason they could not be read. */
async function changedFiles(
  cwd: string,
  base: string | undefined,
  head: string | undefined,
): Promise<{ ok: true; files: Set<string> } | { ok: false; reason: string }> {
  const b = base ?? (await resolveMainlineBase(cwd));
  if (!b) return { ok: false, reason: "no base ref resolves (no explicit base, no mainline)" };
  if (!head) return { ok: false, reason: "the reviewed head did not resolve to a commit" };
  if (b.startsWith("-")) return { ok: false, reason: `base ref "${b}" starts with '-'` };
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "diff", "--name-only", `${b}...${head}`],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    return { ok: true, files: new Set(stdout.split("\n").filter(Boolean).map(norm)) };
  } catch (err) {
    return {
      ok: false,
      reason: `git diff --name-only ${b}...${head} failed: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`,
    };
  }
}

export interface CarriedSplit {
  blocking: Finding[];
  /** Summary fields: `advisory` rows, and a `memoryNote` when the changed-file
   * list was unreadable (every carried row then blocks). Empty when nothing is
   * carried, so it never overwrites a findings-memory note. */
  fields: { advisory?: Finding[]; memoryNote?: string };
}

/**
 * Split the round's carried rows (`recordFindingRunOutcome`'s result; none
 * when it did not record) into blocking (inside the diff, or no path) and
 * advisory.
 */
export async function splitCarried(
  recorded: { ok: boolean; carried?: Finding[] } | undefined,
  cwd: string | undefined,
  base: string | undefined,
  head: string | undefined,
): Promise<CarriedSplit> {
  const carried = recorded?.ok ? (recorded.carried ?? []) : [];
  if (carried.length === 0) return { blocking: [], fields: {} };
  const list = await changedFiles(cwd ?? process.cwd(), base, head);
  if (!list.ok) {
    return {
      blocking: [...carried],
      fields: {
        memoryNote: `carried findings all treated as blocking: the PR's changed-file list could not be read (${list.reason})`,
      },
    };
  }
  const blocking: Finding[] = [];
  const advisory: Finding[] = [];
  for (const f of carried) {
    (!f.path || list.files.has(norm(f.path)) ? blocking : advisory).push(f);
  }
  return { blocking, fields: advisory.length > 0 ? { advisory } : {} };
}

/** The summary/disclosure section listing advisory rows (empty when none). */
export function advisorySection(advisory: readonly Finding[] | undefined): string[] {
  if (!advisory || advisory.length === 0) return [];
  return [
    "",
    `${ADVISORY_HEADING} (${advisory.length}) — carried from an earlier round on files this PR does not change; they do not block:`,
    ...advisory.map((f) =>
      neutraliseEvidence(
        `- advisory: [${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.title} (${f.lens})`,
      ),
    ),
  ];
}
