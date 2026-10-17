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
 * window it keeps — `redactBounded` widens its scan with `widenPastCut`, which
 * backs off into the dropped side to the start of the token the cut fell inside —
 * otherwise a credential that straddles the cut survives in the kept half while
 * the scan reports zero matches (#1393). `redactClip` is only the text-only
 * wrapper over `redactBounded`; the widening lives in the latter.
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
 * The token boundary `widenPastCut` walks to, hoisted out of the loop (#1393 round 5,
 * item 6). A literal `RegExp` in the body is re-created on every character of a walk
 * that can run `SCAN_CAP` deep, and the walk is on the hot path of every bounded pass.
 * `\s` carries no `g` flag, so a single shared instance cannot leak `lastIndex`.
 */
const WHITESPACE = /\s/;

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
 *
 * When the walk finds no whitespace inside `SCAN_CAP` it stops AT the cap rather
 * than sweeping to offset 0 for the answer — the run is unbounded, so a scan over
 * it is, and a window that wide is what made the bound decorative.
 *
 * The offset it returns is a TOKEN START, not merely a token boundary, and that
 * distinction is load-bearing rather than tidy. No pattern is `^`-anchored — the
 * prefix rules dropped their leading `\b` deliberately (see secret-patterns.ts) —
 * so what makes a mid-token slice useless is not an anchor but the combination of a
 * GREEDY body and the token-end lookahead: a body swallows everything its class
 * allows and the lookahead then refuses a continuation, so a slice that opens one
 * character into a run has to match the pattern starting there, and for a prefix
 * rule the prefix is behind it — no match at all, and zero redactions reported over
 * a window full of keys. Walking to the whitespace and then stopping ON the
 * delimiter leaves the walk one short of the character that begins the token; the
 * `+1`/`-1` below is the step onto it. A window that begins mid-token is the shape
 * that hid the glued credential from the bounded scan (#1393).
 */
function widenPastCut(text: string, from: number, side: "head" | "tail"): number {
  const isSpace = (i: number) => WHITESPACE.test(text[i] ?? "");
  // One clamp, not two. The walk may never pass `stop`, and `stop` is already
  // `SCAN_CAP` away from `from`, so the offset IS the length bound: a separate
  // `walked < budget` counter walked in lockstep with it and could only ever
  // agree. Clamping the offset alone (an earlier cut here did) turns the
  // widening into a no-op on a short text, where the cap would place the stop at
  // 0 and every walk back to 0 is then legal — which is what `stop` is derived
  // from `from` for, rather than from the text's own ends.
  if (side === "head") {
    const stop = Math.max(0, from - SCAN_CAP);
    let i = from;
    while (i > stop && !isSpace(i)) i--;
    // Out of budget with no whitespace found: the run is unbounded, so stop.
    if (i === stop) return stop;
    // `i` sits ON the delimiter; step back onto the token's first character.
    i--;
    let tokens = 0;
    while (i > stop && tokens < 2) {
      if (isSpace(i - 1)) tokens++;
      i--;
    }
    // The last decrement crossed a token start, so land back on the delimiter
    // and hand the caller a slice that opens on a token.
    return tokens === 2 ? i + 1 : i;
  }
  const stop = Math.min(text.length, from + SCAN_CAP);
  let i = from;
  while (i < stop && !isSpace(i - 1)) i++;
  if (i === stop) return stop;
  // `i` sits just past the delimiter; step back onto the token's first character.
  let tokens = 0;
  while (i < stop && tokens < 2) {
    if (isSpace(i)) tokens++;
    i++;
  }
  return tokens === 2 ? i - 1 : i;
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
 * matters — so the kept text is exactly `max` of the already-redacted scan.
 *
 * Returns the count of the pass that actually produced the text, so a caller
 * can report redactions over what it shipped rather than over the whole input.
 */
export function redactBounded(
  text: string,
  max: number,
  from: "start" | "end" = "start",
): { text: string; count: number } {
  // A bound that is not a positive number cannot keep anything, and must not
  // report that it did. Without this guard `max: 0` fell through to
  // `widenPastCut(text, 0, "start")`, scanned the head of the text and shipped
  // `""` with a nonzero count — a record claiming redactions over a string it
  // never showed. `!(max > 0)` is the whole test: it takes 0, the negatives and
  // NaN, which `max <= 0` would let through.
  if (!(max > 0)) return { text: "", count: 0 };
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
 *
 * OBJECT KEYS ARE STRINGS TOO. The first arm covered values only, so
 * `{"tok:sk-ant-…": "v"}` shipped the key verbatim while the value looked clean —
 * a credential in the one place the counter never visited. A key now goes through
 * the SAME bounded pass as a value, and its redactions land in the same counter, so
 * the record's `redactions` describes the whole line rather than its values. A key is
 * not CLIPPED to `bound` the way a value is: it is a short identifier, and clipping it
 * would mangle field names the operator has to read in order to bound a span the JSON
 * parser would already have refused. The redaction is the claim, not the bound.
 */
export function redactDeep(v: unknown, counter: { n: number }, bound?: number): unknown {
  if (typeof v === "string") {
    if (bound === undefined) {
      const r = redactSecrets(v);
      counter.n += r.count;
      return r.text;
    }
    // The SAME widened scan `boundField` uses, not a `slice(bound + slack)` /
    // `slice(bound)` pair. The naive pair has no widening at the keep edge: it
    // cuts the scan at `bound + slack`, so a credential straddling `bound` is
    // amputated before the patterns ever see it, and the kept text ships the
    // fragment with a count of zero — the #1393 leak, relocated from the record's
    // top level into a nested string (`boundField` covers only the fields a seam
    // DECLARES; `redactDeep` is what an undeclared or nested string gets).
    const r = redactBounded(v, bound, "start");
    counter.n += r.count;
    // The ellipsis is for the human reading the log, so it stays — but the
    // ceiling is the bound, which an `…` on top of `slice(0, bound)` used to
    // exceed by one character. `bound > 0` is guaranteed by the early return in
    // `redactBounded` only for its own output, so the slice is written to stay
    // in range for `bound === 1` rather than assuming `slice(0, 0)`-style maths.
    const clipped = r.text.length > bound ? `${r.text.slice(0, Math.max(0, bound - 1))}…` : r.text;
    return clipped;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, counter, bound));
  if (v && typeof v === "object") {
    // A key is a string too, so it goes through the SAME pattern set as a value
    // (#1393): a credential hiding in a key was shipped whole by a value-only pass,
    // with the counter describing only half the record. It is redacted and COUNTED,
    // but not clipped to `bound` the way a value is — a key is a short identifier, and
    // clipping it would mangle field names into something the operator cannot read in
    // order to bound a span the JSON parser would already have refused.
    const redactKey = (k: string): string => {
      const r = bound === undefined ? redactSecrets(k) : redactBounded(k, bound, "start");
      counter.n += r.count;
      return r.text;
    };
    // KEYS ARE BUILT IN A LOOP, NOT VIA `Object.fromEntries` (#1393 round 5, item 1).
    // Redaction makes two distinct keys EQUAL — `{"sk-ant-AAAA…": 1, "sk-ant-BBBB…": 2}`
    // both become `[REDACTED]` — and `Object.fromEntries` collapses a duplicate key to
    // its last row, so the record shipped ONE entry while `counter.n` reported the two
    // redactions that produced it: a count describing rows the line no longer contains.
    // A key that LITERALLY reads `[REDACTED]` was overwritten the same way, by a redaction
    // that had nothing to do with it. Neither is a leak, and both are the log lying about
    // its own contents, which is the one thing a measurement log must not do. A colliding
    // key therefore takes a `~n` suffix (first collision `~1`, then `~2`, …), which keeps
    // every row and keeps the value paired with the key it came from. The suffix cannot
    // re-match: it is appended AFTER the redaction pass, never re-scanned, and `~` is in
    // no pattern's body class except the Bearer arm, whose `\s+` prefix a bare `~1` never
    // satisfies — and the counter is not touched by it, so the count still describes the
    // redactions, not the renaming.
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const rk = redactKey(k);
      const value = redactDeep(x, counter, bound);
      if (!(rk in out)) {
        out[rk] = value;
        continue;
      }
      let n = 1;
      while (`${rk}~${n}` in out) n++;
      out[`${rk}~${n}`] = value;
    }
    return out;
  }
  return v;
}

/**
 * The main checkout for a linked worktree; `root` itself otherwise. Memoised
 * per root.
 *
 * #1393 removed `redactState`, the unbounded wrapper over `redactDeep` that
 * stood here. `boundedState` (decision-seam.ts) is the one pre-budget redaction
 * now, and it is bounded: each field the seam declares goes through
 * `redactBounded` over the window its `FieldBound` keeps — scan widened past the
 * cut, then `max` kept — and every other string goes through the same widened
 * pass at the record-wide bound. An unbounded regex pass over a whole-document
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
