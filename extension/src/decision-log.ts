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
 * `redactSecrets` (defined in secret-patterns.ts and re-exported here) replaces every
 * span matching vipune.ts's `SECRET_PATTERNS` — the same shape-with-context rules
 * `looksLikeSecret` refuses on — with a fixed marker, and the record carries the count.
 * The patterns are imported, not copied, so the two cannot drift.
 */

import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./secret-patterns.ts";
import { trace } from "./trace.ts";
import { ensureGitExclude } from "./work-driver-git-exclude.ts";

export { REDACTED, redactSecrets } from "./secret-patterns.ts";

/** Every string in a record — the state included — is bounded to this, after redaction. */
const LOG_STRING_CHARS = 4000;

/**
 * Redact the WHOLE text, then keep a window of it (`from` = which end). Clipping
 * first can cut a credential into a fragment no pattern recognises, so the
 * shadow seams' bounded inputs go through here rather than slicing raw text.
 */
export function redactClip(text: string, max: number, from: "start" | "end" = "start"): string {
  const { text: clean } = redactSecrets(text);
  return from === "end" ? clean.slice(-max) : clean.slice(0, max);
}

/**
 * Redact every string inside a JSON-shaped value, then bound it. The final
 * bound is applied after redaction, so it can never cut a secret into a
 * fragment the patterns no longer recognise; a generous pre-bound (well past
 * any token's length) keeps a whole-document state from being regex-scanned.
 */
function redactDeep(v: unknown, counter: { n: number }, bound?: number): unknown {
  if (typeof v === "string") {
    const r = redactSecrets(bound === undefined ? v : v.slice(0, bound + 2048));
    counter.n += r.count;
    return bound !== undefined && r.text.length > bound ? `${r.text.slice(0, bound)}…` : r.text;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, counter, bound));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, redactDeep(x, counter, bound)]),
    );
  }
  return v;
}

/**
 * Redact a JSON-shaped state, unbounded. decide() applies this before the
 * state reaches any backend, so a credential in the state never leaves the
 * host, and the log, the hash and the model all see the same text.
 */
export function redactState(state: unknown): { state: unknown; count: number } {
  const counter = { n: 0 };
  return { state: redactDeep(state, counter), count: counter.n };
}

const checkouts = new Map<string, string>();

/** The main checkout for a linked worktree; `root` itself otherwise. Memoised per root. */
function mainCheckout(root: string): string {
  const known = checkouts.get(root);
  if (known !== undefined) return known;
  const resolved = resolveMainCheckout(root);
  checkouts.set(root, resolved);
  return resolved;
}

function resolveMainCheckout(root: string): string {
  try {
    const dotGit = path.join(root, ".git");
    if (!statSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    const wt = m?.[1]
      ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(root, m[1]))
      : null;
    if (!wt?.[1])
      trace(`decision-log: ${root}/.git is not a linked worktree pointer; logging under it`);
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
  /** Spans already redacted upstream (decide() redacts the state before any backend). */
  priorRedactions = 0,
): Promise<string | undefined> {
  const counter = { n: priorRedactions };
  const redacted = redactDeep(record, counter, LOG_STRING_CHARS) as Record<string, unknown>;
  const line = `${JSON.stringify({ ...redacted, redactions: counter.n })}\n`;
  if (!where.repoRoot) {
    trace(`decision-log: no repo root, record not written — ${line.slice(0, 300)}`);
    return undefined;
  }
  const root = mainCheckout(where.repoRoot);
  const file = decisionLogPath(where.repoRoot, where.issues);
  try {
    // A symlinked `.pi/` component must not carry the record — or even the
    // directories — out of the repo: check the nearest existing ancestor
    // before creating anything, and the final directory after.
    const realRoot = await fs.realpath(root);
    const inside = async (p: string) => {
      const rel = path.relative(realRoot, await fs.realpath(p));
      return !(rel.startsWith("..") || path.isAbsolute(rel));
    };
    let ancestor = path.dirname(file);
    while (
      !(await fs.stat(ancestor).then(
        () => true,
        () => false,
      ))
    )
      ancestor = path.dirname(ancestor);
    if (!(await inside(ancestor))) throw new Error("log directory escapes the repo root");
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!(await inside(path.dirname(file)))) throw new Error("log directory escapes the repo root");
    const st = await fs.lstat(file).catch(() => undefined);
    if (st && !st.isFile()) throw new Error("log path is not a regular file");
    await fs.appendFile(file, line, { flag: "a" });
  } catch (err) {
    trace(`decision-log: append to ${file} failed: ${(err as Error).message}`);
    return undefined;
  }
  if (file === path.join(root, ".pi", "decisions.jsonl")) {
    // Outside a cycle the log is not under the driver's gitignored state dir.
    const isRepo = await fs.stat(path.join(root, ".git")).then(
      (s) => s.isDirectory(),
      () => false,
    );
    // ensureGitExclude is best-effort and traces its own failures; this is a backstop.
    if (isRepo) {
      await ensureGitExclude(root, [".pi/decisions.jsonl"]).catch((err: Error) =>
        trace(`decision-log: could not exclude .pi/decisions.jsonl: ${err.message}`),
      );
    }
  }
  return file;
}
