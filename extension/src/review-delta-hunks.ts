/**
 * review-delta-hunks — the automatic delta's reviewed patch (#1128).
 *
 * A follow-up lens round used to review `git diff <lastHead>..<head>`
 * (two-dot). After `git merge origin/main` into the branch that range
 * contains main's own hunks, so every merge round re-reviewed code the
 * branch never wrote. The reviewed patch is now:
 *
 *   the hunks of `git diff <base>...<head>` (the branch's own changes,
 *   three-dot — main-only hunks are absent by construction)
 *   MINUS every hunk identical in content to one already present in
 *   `git diff <merge-base(lastHead, base)>..<lastHead>` (what the previous
 *   round reviewed).
 *
 * Hunk identity is per file and by BODY only: the `@@ -a,b +c,d @@` numbers
 * are ignored, so a hunk shifted by an earlier merged hunk still matches,
 * and matching is multiset-aware, so a genuinely new hunk is never dropped
 * just because an identical one was reviewed once elsewhere.
 *
 * Every git call is execFile (no shell). Any failure in the three-dot path
 * returns `fallback` so the caller uses the pre-#1128 two-dot delta — an
 * over-inclusive review, never a silently dropped one.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execp } from "./lens-exec.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);
const DIFF_MAX_BUFFER = 1024 * 1024;

interface Hunk {
  /** The `@@` line and the body lines, as emitted. */
  lines: string[];
  /** Identity: the body only (the `@@` numbers are excluded). */
  body: string;
}

interface Section {
  /** The `diff --git` line — the per-file scope of hunk identity. */
  file: string;
  /** Every line of the file section before its first hunk. */
  header: string[];
  hunks: Hunk[];
}

function parseSections(diff: string): Section[] {
  const out: Section[] = [];
  if (!diff) return out;
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  let cur: Section | undefined;
  let hunk: Hunk | undefined;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      cur = { file: line, header: [line], hunks: [] };
      out.push(cur);
      hunk = undefined;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@ ")) {
      hunk = { lines: [line], body: "" };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      hunk.lines.push(line);
      hunk.body += `${line}\n`;
    } else {
      cur.header.push(line);
    }
  }
  return out;
}

/** The identity key of a file section that has no hunks (mode change, empty
 * new file, rename): its full header, so an identical header still matches. */
function headerKey(s: Section): string {
  return `${s.file}\u0000H\u0000${s.header.join("\n")}`;
}

function hunkKey(s: Section, h: Hunk): string {
  return `${s.file}\u0000${h.body}`;
}

/** Decrement-and-test: true when an unconsumed identical unit was seen. */
function take(seen: Map<string, number>, key: string): boolean {
  const n = seen.get(key) ?? 0;
  if (n === 0) return false;
  seen.set(key, n - 1);
  return true;
}

/**
 * The pure core (no git): `headDiff` minus every hunk identical to one in
 * `prevDiff`. Returns "" when nothing is left — the caller decides what an
 * empty delta means (the no-review outcome, never an approval).
 */
export function subtractReviewedHunks(headDiff: string, prevDiff: string): string {
  const seen = new Map<string, number>();
  const count = (key: string) => seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const s of parseSections(prevDiff)) {
    if (s.hunks.length === 0) count(headerKey(s));
    for (const h of s.hunks) count(hunkKey(s, h));
  }
  const out: string[] = [];
  for (const s of parseSections(headDiff)) {
    if (s.hunks.length === 0) {
      if (!take(seen, headerKey(s))) out.push(...s.header);
      continue;
    }
    const kept = s.hunks.filter((h) => !take(seen, hunkKey(s, h)));
    if (kept.length === 0) continue;
    out.push(...s.header);
    for (const h of kept) out.push(...h.lines);
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

export type AutoHunkDelta =
  | { kind: "diff"; diff: string }
  | { kind: "empty"; reason: string }
  | { kind: "problem"; problem: string }
  | { kind: "fallback"; reason: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
    maxBuffer: DIFF_MAX_BUFFER,
  });
  return stdout;
}

/**
 * The reviewed patch for an automatic delta with an explicit base. `since`
 * is the previous round's head (a validated full SHA, an ancestor of
 * `head`); `head` is a full SHA already resolved by the caller.
 */
export async function resolveAutoHunkDelta(opts: {
  since: string;
  head: string;
  base: string;
  cwd?: string;
}): Promise<AutoHunkDelta> {
  const c = opts.cwd ?? process.cwd();
  const baseSha = await resolveHeadSha(c, opts.base, execp);
  if (!baseSha) {
    return {
      kind: "problem",
      problem: `lens review: cannot compute delta: base ref "${opts.base}" is not a commit`,
    };
  }
  try {
    const mbPrev = (await git(c, ["merge-base", opts.since, baseSha])).trim().split("\n")[0];
    if (!mbPrev) return { kind: "fallback", reason: "no merge-base for the previous head" };
    const headDiff = await git(c, ["diff", `${baseSha}...${opts.head}`]);
    const prevDiff = await git(c, ["diff", `${mbPrev}..${opts.since}`]);
    const diff = subtractReviewedHunks(headDiff, prevDiff);
    if (!diff) {
      return {
        kind: "empty",
        reason: `no branch-own changes since ${opts.since.slice(0, 8)} (every hunk was reviewed in the previous round, or came from ${opts.base})`,
      };
    }
    return { kind: "diff", diff };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    trace(`lens-review: hunk delta unavailable (${msg.slice(0, 120)}) — two-dot delta`);
    return { kind: "fallback", reason: msg.slice(0, 200) };
  }
}
