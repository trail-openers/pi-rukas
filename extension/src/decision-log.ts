/**
 * decision-log — one JSONL record per `decide()` call (#1308).
 *
 * The log exists so a seam's model answers can be measured against its rule
 * before anyone trusts them (S5), which means it must be complete: every call
 * writes exactly one record, including rule-only and killed-switch calls.
 *
 * ## Where
 *
 * Under the REPO ROOT, never inside a worktree (operator decision 8): inside
 * a /work cycle `.pi/work-state/<primary-issue>/decisions.jsonl`, where the
 * primary of a group is its lowest issue number; otherwise
 * `.pi/decisions.jsonl`. A root that is itself a linked worktree (its `.git`
 * is a `gitdir:` file) is mapped to the main checkout, so a teardown cannot
 * take the log with it.
 *
 * ## How
 *
 * One `O_APPEND` write per record, so concurrent cycles interleave whole
 * lines. A failed append is traced and swallowed — the log must never change
 * a decision.
 *
 * ## Redaction
 *
 * `redactSecrets` replaces every span matching vipune.ts's `SECRET_PATTERNS`
 * — the same shape-with-context rules `looksLikeSecret` refuses on — with a
 * fixed marker, and the record carries the count. The patterns are imported,
 * not copied, so the two cannot drift.
 */

import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { SECRET_PATTERNS } from "./vipune.ts";
import { ensureGitExclude } from "./work-driver-git-exclude.ts";

export const REDACTED = "[REDACTED]";

/** Every string in a record — the state included — is bounded to this, after redaction. */
const LOG_STRING_CHARS = 4000;

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(
  (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
);

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of GLOBAL_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}

/**
 * Redact every string inside a JSON-shaped value, then bound it. Redacting
 * first means a bound can never cut a secret into a fragment the patterns no
 * longer recognise.
 */
function redactDeep(v: unknown, counter: { n: number }): unknown {
  if (typeof v === "string") {
    const r = redactSecrets(v);
    counter.n += r.count;
    return r.text.length > LOG_STRING_CHARS ? `${r.text.slice(0, LOG_STRING_CHARS)}…` : r.text;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, counter));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, counter)]));
  }
  return v;
}

/** The main checkout for a linked worktree; `root` itself otherwise. */
function mainCheckout(root: string): string {
  try {
    const dotGit = path.join(root, ".git");
    if (!statSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    const wt = m?.[1]
      ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(root, m[1]))
      : null;
    return wt?.[1] ?? root;
  } catch {
    return root;
  }
}

export function decisionLogPath(repoRoot: string, issues?: readonly number[]): string {
  const root = mainCheckout(repoRoot);
  const valid = (issues ?? []).filter((n) => Number.isInteger(n) && n > 0);
  return valid.length > 0
    ? path.join(root, ".pi", "work-state", String(Math.min(...valid)), "decisions.jsonl")
    : path.join(root, ".pi", "decisions.jsonl");
}

/** Append one record. Never throws; returns the path written, or undefined. */
export async function appendDecisionRecord(
  where: { repoRoot?: string; issues?: readonly number[] },
  record: Record<string, unknown>,
): Promise<string | undefined> {
  const counter = { n: 0 };
  const redacted = redactDeep(record, counter) as Record<string, unknown>;
  const line = `${JSON.stringify({ ...redacted, redactions: counter.n })}\n`;
  if (!where.repoRoot) {
    trace(`decision-log: no repo root, record not written — ${line.slice(0, 300)}`);
    return undefined;
  }
  const file = decisionLogPath(where.repoRoot, where.issues);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, line, { flag: "a" });
    if (!where.issues?.length) {
      // Outside a cycle the log is not under the driver's gitignored state dir.
      const root = mainCheckout(where.repoRoot);
      const isRepo = await fs.stat(path.join(root, ".git")).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (isRepo) await ensureGitExclude(root, [".pi/decisions.jsonl"]);
    }
    return file;
  } catch (err) {
    trace(`decision-log: append to ${file} failed: ${(err as Error).message}`);
    return undefined;
  }
}
