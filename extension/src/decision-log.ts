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
 *
 * Every pattern needs CONTEXT, not just its own characters: the URL rule needs
 * the `://` before it and the `@` after, the Bearer rule needs the literal
 * `Bearer ` in front. A bounded redaction therefore scans past the edge of the
 * window it keeps — `redactClip` backs off into the dropped side — otherwise a
 * credential that straddles the cut survives in the kept half while the scan
 * reports zero matches (#1393).
 */

import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SECRET_PATTERNS } from "./secret-patterns.ts";
import { trace } from "./trace.ts";
import { ensureGitExclude } from "./work-driver-git-exclude.ts";

export const REDACTED = "[REDACTED]";

/**
 * Every string in a record — the state included — is bounded to this, after
 * redaction. Exported so `boundedState` gives an undeclared field the same
 * bound the record applies, rather than scanning it unbounded (#1393).
 */
export const LOG_STRING_CHARS = 4000;

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
 * How far past the edge of the kept window the scan may reach into the side
 * being dropped, in two allowances that together bound one `redactBounded` call:
 *
 *   - `PRE_BOUND_SLACK` — how far the scan may extend past the window at all.
 *     It exists because a pattern's match can START before the window and END
 *     inside it, so the kept half carries a whole secret while the pattern needs
 *     the dropped half's `://` or `Bearer ` to match it; and because redaction
 *     replaces a span with a marker SHORTER than it, which slides the kept end
 *     toward the cut, so a secret sitting right at the boundary can be pushed
 *     into the kept half by its own redaction.
 *   - `CUT_TOKEN_BUDGET` — extra room for the token walk `widenPastCut` does
 *     once it has found whitespace (it keeps going for two more tokens, so a
 *     credential's key name or `Authorization:` prefix is included).
 *
 * Both are ceilings, never distances: `widenPastCut` stops at whitespace well
 * inside them, so a well-formed token is always covered whole while a
 * pathological 2 MB whitespace-free blob stays bounded by the sum.
 */
const PRE_BOUND_SLACK = 2048;
const CUT_TOKEN_BUDGET = 4096;

/** The one cap every `redactBounded` scan honours, past the window it keeps. */
const SCAN_CAP = PRE_BOUND_SLACK + CUT_TOKEN_BUDGET;

/**
 * Pull a scan cut outward to a token boundary, into the side being DROPPED.
 *
 * The cut must not land in the middle of a token, because that is exactly the
 * position that amputates a pattern's context: `https://user:pass@host` kept
 * from `user:` has no `://`, and `Bearer <token>` kept from `<token>` has no
 * `Bearer `. So from the window's own edge (`from`) walk outward to the nearest
 * whitespace — the boundary of the token the edge fell inside — and then TWO
 * more whitespace-separated tokens.
 *
 * The WHOLE walk, both legs together, is capped at `SCAN_CAP` from `from`:
 * clamping only the first leg would let a 2 MB whitespace-free run drag the scan
 * to offset 0 and make the bound decorative. Returns an offset on the dropped
 * side of `from`, no further from it than `SCAN_CAP` (#1393).
 */
function widenPastCut(text: string, from: number, side: "head" | "tail"): number {
  const isSpace = (i: number) => /\s/.test(text[i] ?? "");
  // `budget` is the walk's LENGTH limit, and `stop` the offset it may never
  // pass. The two are not the same: clamping the offset alone (an earlier cut
  // here did) turns the widening into a no-op on a short text, where the cap
  // would place the stop at 0 and every walk back to 0 is then legal.
  const budget = SCAN_CAP;
  if (side === "head") {
    const stop = Math.max(0, from - SCAN_CAP);
    let i = from;
    let walked = 0;
    while (i > stop && walked < budget && !isSpace(i)) {
      i--;
      walked++;
    }
    let tokens = 0;
    while (i > stop && walked < budget && tokens < 2) {
      if (isSpace(i - 1)) tokens++;
      i--;
      walked++;
    }
    return i;
  }
  const stop = Math.min(text.length, from + SCAN_CAP);
  let i = from;
  let walked = 0;
  while (i < stop && walked < budget && !isSpace(i - 1)) {
    i++;
    walked++;
  }
  let tokens = 0;
  while (i < stop && walked < budget && tokens < 2) {
    if (isSpace(i)) tokens++;
    i++;
    walked++;
  }
  return i;
}

/**
 * Redact a bounded window of `text`, keeping `max` characters from `from`.
 *
 * Both halves matter. Redact-**then**-clip is what stops a clip cutting a
 * credential into a fragment no pattern recognises. Scan-**then**-bound is what
 * stops a regex pass over a multi-megabyte document. And the scan reaches PAST
 * the cut (`widenPastCut`) rather than starting at it, because a pattern needs
 * context the kept window alone does not contain — pre-cutting at the boundary
 * used to hide a secret in the kept region entirely, so the "secret" reached the
 * model and the log unredacted while the scan reported zero matches (#1393).
 *
 * The scan window is the kept window widened outward by up to `SCAN_CAP` (the
 * `PRE_BOUND_SLACK` allowance plus the token walk's `CUT_TOKEN_BUDGET`), with its
 * edge pulled back to a token boundary so the scan never begins mid-token. The
 * window is then cut from `clean` — AFTER the replacement, which is the half that
 * matters — so the cut position is compensated for everything redaction removed
 * inside the window. That compensation is what makes the two orderings different:
 * clip-then-redact leaves a fragment, redact-then-clip-without-compensation drops
 * a secret the marker shrank past the cut, and both report zero redactions.
 *
 * Returns the count of the pass that actually produced the text, so a caller
 * can report redactions over what it shipped rather than over the whole input.
 */
export function redactBounded(
  text: string,
  max: number,
  from: "start" | "end" = "start",
): { text: string; count: number } {
  if (text.length <= max) return redactSecrets(text);
  if (from === "end") {
    const cut = text.length - max;
    const start = widenPastCut(text, cut, "head");
    const { text: clean, count } = redactSecrets(text.slice(start));
    // Exactly `max`, taken from the END of the already-redacted scan window.
    //
    // No compensation term is needed, and one would be wrong: the reason a
    // clip-after-redaction used to leak was that the SCAN was cut at the same
    // boundary as the KEEP, so the pattern's context was never seen. Widening
    // the scan is the fix; `clean`'s tail already contains every replacement
    // the window produced, and a `+ shrunk` term would push the result past
    // `max` — a bound that varies with how many secrets were in the text is not
    // a bound. `clean.length` only bites when the whole text is shorter than the
    // window, which the early return above already handled for the ordinary case.
    const keep = Math.min(max, clean.length);
    return { text: clean.slice(clean.length - keep), count };
  }
  const end = widenPastCut(text, max, "tail");
  const { text: clean, count } = redactSecrets(text.slice(0, end));
  // See the `end` branch: exactly `max` from the FRONT of the scan window.
  const keep = Math.min(max, clean.length);
  return { text: clean.slice(0, keep), count };
}

/** The clip a caller only wants the text for (`headless/failure.ts`). */
export function redactClip(text: string, max: number, from: "start" | "end" = "start"): string {
  return redactBounded(text, max, from).text;
}

/**
 * The seam-driven bound for one state field (#1393): redact the window the
 * field keeps — widened past the cut so every pattern's context is scanned —
 * and report the count of exactly that pass. Lives here, not at the call site,
 * so the redaction order, the count and the per-field bound cannot drift apart.
 */
export function boundField(
  text: string,
  bound: { max: number; from?: "start" | "end" },
): { text: string; count: number } {
  return redactBounded(text, bound.max, bound.from ?? "start");
}

/**
 * Redact every string inside a JSON-shaped value, then bound it. The final
 * bound is applied after redaction, so it can never cut a secret into a
 * fragment the patterns no longer recognise; the pre-bound keeps a
 * whole-document state from being regex-scanned end to end.
 *
 * The two callers are `appendDecisionRecord` below and `boundedState` in
 * decision-seam.ts, which must redact a state BEFORE it reaches
 * a backend — the record-level pass in `appendDecisionRecord` only ever guards
 * the log line, so an undeclared or nested string left unredacted here would
 * show the model a credential while the log looked clean (#1393).
 *
 * Exported only for `boundedState`, and only for the strings the seam did NOT
 * declare, which take the record-wide bound and nothing else: a declared field
 * goes through `boundField`, because the only window a caller may choose is the
 * registry's `FieldBound`, and a second module picking its own pre-bound is how
 * a pattern's context gets cut off at the clip (#1393).
 *
 * A cyclic state throws rather than recursing forever; both callers treat a
 * throw as "this state is not JSON" and take their non-serialisable path, which
 * is what the seam's own `serialise()` would have concluded anyway.
 */
export function redactDeep(v: unknown, counter: { n: number }, bound?: number): unknown {
  if (typeof v === "string") {
    const pre = bound === undefined ? v : v.slice(0, bound + PRE_BOUND_SLACK);
    const r = redactSecrets(pre);
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
 * The main checkout for a linked worktree; `root` itself otherwise. Memoised
 * per root.
 *
 * #1393 removed `redactState`, the unbounded wrapper over `redactDeep` that
 * stood here. `boundedState` (decision-seam.ts) is the one pre-budget redaction
 * now, and it is bounded: each field the seam declares is redacted over its
 * complete text and then clipped by the registry's `FieldBound`, and every other
 * string at the record-wide bound. An unbounded regex pass over a whole-document
 * state, run by up to 16 concurrent shadow callers, is what that seam replaced.
 */
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
