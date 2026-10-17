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
import {
  edgeRunReaches,
  redactEdgeRun,
  redactUnscannedRuns,
  widenPastCut,
} from "./decision-redact-window.ts";
import { redactSecrets } from "./secret-patterns.ts";
import { trace } from "./trace.ts";
import { ensureGitExclude } from "./work-driver-git-exclude.ts";

export { REDACTED, redactSecrets } from "./secret-patterns.ts";

/**
 * Every string in a record — the state included — is bounded to this, after
 * redaction. Exported so `boundedState` gives an undeclared field the same
 * bound the record applies, rather than scanning it unbounded (#1393).
 */
export const LOG_STRING_CHARS = 4000;

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
 * How far back a `from: "end"` scan may reach to find a PEM header the clip dropped
 * (#1393 round 6). 8192-bit RSA bodies are about 6.5 KB in base64, so 16384 covers a
 * whole key of that size plus the header line, and a `-----BEGIN` further back than
 * that is not the header of a key whose tail this window holds.
 *
 * The problem is specific to the LEFT edge of the scan. A key whose body is longer than
 * the window is clipped so the window opens in the middle of the base64: the PEM arm
 * matches on its `-----BEGIN` header, which is now behind the cut, so nothing matched
 * and `redactBounded(text, 2000, "end")` reported `count: 0` while shipping the whole
 * body. `widenPastCut` cannot help — it walks to a whitespace-delimited token boundary
 * and caps at `SCAN_CAP`, and a base64 body is one unbroken token thousands of
 * characters long, so its walk stops at the cap still inside the body. Pulling the start
 * back to the nearest header is the only move that reaches the arm's anchor.
 *
 * Only the `"end"` direction gets it, because only there is the window's LEFT edge the
 * cut: for `from: "start"` the scan already begins at offset 0 and the header, if the
 * text has one, is in front of it.
 */
const PEM_HEADER_REACH = 16384;

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
    const head = widenPastCut(text, cut, "head", SCAN_CAP);
    let start = head.offset;
    // A key longer than the window opens the scan mid-body, where no pattern anchors
    // (see `PEM_HEADER_REACH`). Back up to the header the clip dropped rather than
    // scanning a body no arm can match.
    //
    // BOUNDED, and the bound is what makes the line cheap. `lastIndexOf` with a `fromIndex`
    // still scans leftward to offset 0 before it answers "nothing", so on a document far larger
    // than the reach — the multi-megabyte log this function exists to keep off a regex — the
    // search cost grew with the document while its verdict could only ever be about the last
    // 16 KB of it. The slice bounds the walk to the only region that can answer the question,
    // and offsets are carried back by adding `from`, which is 0 on a text shorter than the reach
    // (`Math.max` there, so the prefix is scanned whole and the answer is identical to the
    // unbounded search by construction rather than by argument). The `start - found <= reach`
    // test below then becomes redundant rather than changed: an offset the search could not have
    // returned is an offset it now does not visit.
    const from = Math.max(0, start - PEM_HEADER_REACH);
    const hit = text.slice(from, start).lastIndexOf("-----BEGIN", start - from);
    const found = hit < 0 ? -1 : from + hit;
    if (found >= 0 && start - found <= PEM_HEADER_REACH) start = found;
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
    const kept = clean.slice(clean.length - keep);
    // The text was CLIPPED (`text.length > max`), so this window is a slice of a scan that
    // may not have reached it — the net runs whether or not the walk gave up. See
    // `redactUnscannedRuns`: `gaveUp` reports that the WALK terminated, not that the SCAN
    // saw the kept window, and a few hundred characters of whitespace filler is enough to
    // make the walk succeed over a body no arm anchored on.
    //
    // The edge probe measures the run in the ORIGINAL `text`, not in `kept`: a fragment's
    // length lives on the far side of the CLIP, where `kept` cannot see it (see
    // `edgeRunReaches`). For `"end"` the clip is the window's LEFT edge, so the walk starts
    // at `cut`; the scan may have started further back still, and a token wholly inside the
    // scan window is no fragment.
    const edge = edgeRunReaches(text, cut, text.length, SCAN_CAP);
    const net = redactUnscannedRuns(kept);
    const swept = edge.head ? redactEdgeRun(net.text, "head", SCAN_CAP) : net;
    // Re-clip, and the reason it is here rather than nowhere is `redactEdgeRun`: it replaces
    // the edge token with `REDACTED`, which is TEN CHARACTERS, and a token shorter than ten
    // characters makes the window LONGER than it was. `kept` is exactly `max`, so one such
    // replacement is enough to break the bound the function's own name promises — measured on
    // `redactBounded("pre " + <104-char run> + " end", 5, "end")`, which returned 14 characters
    // for a bound of 5. The clip-after-redaction ordering is the whole point of this function
    // and the bound is the claim its callers (`boundField`, `redactClip`) pass on, so the sweep
    // that violates it is followed by the one line that restores it. Taken from the END for
    // `"end"` and the FRONT for `"start"`, mirroring how `kept` itself was cut.
    //
    // The re-clip can cut the marker it follows, which reads as a leak of `[REDACT` and is not
    // one: no credential byte is in it, and a window that dropped characters is exactly what
    // the bound asks for. The window is never left longer to avoid that — a `max` that a
    // redaction is allowed to exceed is not a bound.
    const out = swept.text.length > max ? swept.text.slice(swept.text.length - max) : swept.text;
    return { text: out, count: count + net.count + (swept === net ? 0 : swept.count) };
  }
  const tail = widenPastCut(text, max, "tail", SCAN_CAP);
  const { text: clean, count } = redactSecrets(text.slice(0, tail.offset));
  // See the `end` branch: exactly `max` from the FRONT of the scan window.
  const keep = Math.min(max, clean.length);
  const kept = clean.slice(0, keep);
  // Mirror image of `"end"`, and the same rule: clipped means judged by its own contents,
  // not by whether the walk happened to find whitespace. For `"start"` the clip is the
  // window's RIGHT edge, so the walk runs forward from `max`, in the text the keep dropped.
  const net = redactUnscannedRuns(kept);
  const edge = edgeRunReaches(text, 0, max, SCAN_CAP);
  const swept = edge.tail ? redactEdgeRun(net.text, "tail", SCAN_CAP) : net;
  // See the `"end"` branch: the edge sweep can GROW the window past `max`, so both branches
  // re-clip, each from its own side.
  const out = swept.text.length > max ? swept.text.slice(0, max) : swept.text;
  return { text: out, count: count + net.count + (swept === net ? 0 : swept.count) };
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

/** Memoised `mainCheckout` results, keyed by the root that was asked about. */
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
