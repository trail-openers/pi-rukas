/**
 * probe-cause — turns a failed executor rejection into one bounded, inert
 * sentence, for the fail-closed gates that embed it in a `reason`.
 *
 * Split out of `mainline.ts` (which grew past the file-size cap the first time
 * the probe's failure text got this much scrutiny). `mainline.ts` remains the
 * neutral leaf its callers import; this is the sanitiser it delegates to, and
 * its own only imports are `./exec.ts` for the executor shape and
 * `./secret-patterns.ts` for the shared pattern set — no driver, no review
 * layer, no `node:fs` / `node:child_process`.
 *
 * #1444 rounds 3 and 4 are the reason this is a module of its own with these
 * exact rules. The failure text is a `gh`/`git` complaint that travels into
 * merge-guard refusals, handoff comments and PR bodies, so it must be:
 *
 *   1. **Classified from the fields exec stamps**, never from prose. Round 3
 *      matched the message first, so a real `execp("sleep 30", { timeout: 200 })`
 *      — which node reports as `Command failed: sleep 30` with `code: null` —
 *      was classified from the digits of its own command echo as **"exit code
 *      30"**, and the operator chasing a stalled connection was told the tool
 *      exited non-zero. A timeout, a missing `gh` and a non-zero exit must stay
 *      distinguishable; that is the whole reason the causes exist.
 *   2. **Redacted before it is bounded, and again after.** A clip can cut a
 *      credential into a fragment no pattern recognises, and can land mid-way
 *      through the `[REDACTED]` marker just written — a `[REDACT` reads as
 *      content, not as a redaction that happened.
 *   3. **Inert as markdown and as a marker.** Backticks, `<!--`, `-->`,
 *      `VERDICT:`-shaped tokens all get neutralised, locally rather than
 *      through `comment-evidence.ts`: that module's shared rule serves diff
 *      evidence inside a `<<<` / `>>>` DATA block and must keep single
 *      backticks, whereas this text lands in markdown where one backtick
 *      closes an inline code span. Sharing one rule between the two audiences
 *      is what made every evidence caller strip lone backticks (#1444 r3).
 */

import type { ExecOpts } from "./exec.ts";
import { REDACTED, redactSecrets } from "./secret-patterns.ts";

/**
 * An executor rejection, read structurally. `promisify(exec)` / `execFile`
 * stamp these; a hand-rolled fake or a wrapper executor may carry none of them,
 * which is why every arm below has a message fallback.
 */
export type ProbeRejection = {
  message?: unknown;
  stderr?: unknown;
  killed?: unknown;
  signal?: unknown;
  code?: unknown;
};

/**
 * The executor shape the probes accept.
 *
 * Declared structurally rather than imported from `work-driver-git.ts`: a
 * type-only import of `VerifyExecFn` would satisfy the grep gate in
 * `test-review-ledger-path-imports.ts` only because TypeScript erases it, which
 * is exactly the false pass that gate exists to refuse. Its result is
 * `{ stdout, stderr? }` — the weakest contract that satisfies every existing
 * executor in the repo (`VerifyExecFn`, the driver `ExecFn` and `execp` are all
 * assignable to it; `execp`'s required `stderr` is a subtype of the optional
 * one).
 */
export type MainlineExecFn = (
  cmd: string,
  opts?: ExecOpts,
) => Promise<{ stdout: string; stderr?: string }>;

/** Upper bound on the sanitised cause. `detectMainline` embeds two of these. */
const MAX_CAUSE_CHARS = 160;

/** How short the stderr tail is clipped to, after redaction. */
const MAX_TAIL_CHARS = 120;

/**
 * node's exec preamble, which echoes the command itself.
 *
 * `g` because the tail can be built from the MESSAGE when no stderr was
 * captured, and a message carries the echo plus the tool's own text — every
 * occurrence of the preamble is node's, not the tool's, so all of them go.
 */
const COMMAND_FAILED_LINE = /^Command failed:[^\n]*\n?/gim;

/** The join between stderr lines — also the seam a wrapped token can straddle. */
const TAIL_JOIN = " | ";

/**
 * The token shapes named in #1387 round 3, added to the shared set in
 * `secret-patterns.ts` rather than replacing it: `secret-patterns` requires
 * long bodies (`gh[pousr]_…{16,}`) and this text comes from a `gh` error that
 * may quote a short or truncated value. Over-redaction here costs a reader a
 * little context; under-redaction publishes a credential.
 *
 * Every one is case-INsensitive. A `gh` error quotes whatever the server or
 * config spelled — `GHP_…`, `TOKEN = …`, `BEARER …` — and a case-sensitive rule
 * passes the credential through untouched while looking like it covered it.
 *
 * NO leading `\b` on the prefix rule (#1444 round 4). `\b` before `ghp_` only
 * fires where the character before it is a non-word character, so a token the
 * tool printed glued to a word — `…zzzzghp_<40 chars>` or `1234ghp_<40>` — was
 * passed through whole, prefix and body, by the one rule meant to catch it. The
 * prefix itself (`ghp_`, `github_pat_`, `glpat-`…) is specific enough to stand
 * alone; what needed a guard was the word `token`, not a prefix no English word
 * ends in.
 *
 * NOTE on the `\b` before `token` in rule 2: `\btoken\b` still matches the
 * `token` inside `github_pat_…`, so a bare `token[=:]…` rule would shred an
 * already-safe redaction marker. The negative lookahead requires the word to
 * stand alone.
 */
const EXTRA_SECRET_PATTERNS: readonly RegExp[] = [
  /(?:gh[pousr]_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)[A-Za-z0-9_./+=-]{4,}/gi,
  /\b(?!pat_)token\b\s*[:=]\s*["']?[A-Za-z0-9._\-/+:]{4,}/gi,
  /\bx-access-token:\s*\S+/gi,
  /\bBearer\s+\S+/gi,
];

/** `[REDACTED]` followed by whitespace and one more word — a broken token's tail. */
const SURVIVOR_AFTER_MARKER = /(\[REDACTED\])\s+\S+/g;
/** `[REDACTED]` separated from a further run by the line join — the same fault. */
const SURVIVOR_AFTER_JOIN = /(\[REDACTED\])\s*\|\s*\S+/g;

/** The shape of a node errno name: `E` then uppercase letters, `_` and digits. */
const ERRNO_NAME = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * The cause of a failed probe, in the words of whatever failed — sanitised.
 *
 * `promisify(exec)` puts the shell's own complaint on the error. Four steps, in
 * this order: drop node's `Command failed: <cmd>` echo; classify from the
 * fields (see the module header for why the order is the finding); redact
 * token-shaped spans on the whitespace-normalised text and then again after the
 * bound; neutralise markdown and marker characters.
 */
export function causeOf(err: unknown): string {
  const e = (err ?? {}) as ProbeRejection;
  const message =
    typeof e.message === "string" && e.message
      ? e.message
      : err instanceof Error
        ? ""
        : String(err);
  const rawStderr = typeof e.stderr === "string" ? e.stderr : "";
  // The tail is built from stderr when the executor captured anything,
  // otherwise from the message. node's exec errors repeat the whole command in
  // the preamble of BOTH, so when `stderr` is absent the message is the only
  // source — and it reaches `stderrTail` with that echo removed, which is what
  // the `g`-flagged `COMMAND_FAILED_LINE` does. When stderr IS present the
  // classification still reads the unstripped message; the tail never sees it.
  const tailSource = rawStderr.trim() ? rawStderr : message;
  const classification = classificationOf(e, message);
  const tail = stderrTail(tailSource);
  const cause = tail.length > 0 ? `${classification}: ${tail}` : classification;
  return boundThenRedact(neutraliseCauseText(cause), MAX_CAUSE_CHARS);
}

/**
 * What kind of failure this is, from the fields exec stamps — not from prose.
 *
 * Each arm is a different fault an operator acts on differently: a timeout is a
 * stalled connection, ENOENT is a missing `gh`, an exit code is the tool's own
 * complaint. They must never collapse into one sentence, and no arm may read
 * the digits out of an echoed command to guess at one.
 */
function classificationOf(e: ProbeRejection, message: string): string {
  // FIRST, and before anything that looks at the message: the fields exec
  // stamps. `execp("sleep 30", { timeout: 200 })` rejects with `code: null`,
  // `killed: true`, `signal: "SIGTERM"` and the message `Command failed:
  // sleep 30` — the only digits anywhere in it are the timeout the caller
  // itself passed. A message-first matcher read them as the exit status.
  if (e.killed === true) {
    // node's exec timeout and `execGroup`'s group kill both land here; the
    // message says which, and only the message can — `code` is null for both.
    return /\btimed out\b/i.test(message)
      ? "timed out"
      : typeof e.signal === "string" && e.signal
        ? `killed by ${e.signal}`
        : "killed";
  }
  // No fields AT ALL — a rejection nobody stamped (a hand-rolled fake, a
  // wrapper that dropped them). Then node's OWN preamble is the only evidence
  // of a kill worth naming: `Command failed:` and `Command timed out:` are
  // strings node writes, so unlike the `command not found` fallback below
  // there is no tool output that can forge one. The test is inside this arm
  // and not above the `code` arms: with `code: null` a real timeout must not
  // fall through to a bare "failed", and a rejection that DID carry `code: 3`
  // is an exit, whatever its preamble looks like.
  if (
    e.killed === undefined &&
    e.signal === undefined &&
    e.code === undefined &&
    /^Command (?:failed|timed out):/i.test(message)
  ) {
    return "timed out";
  }
  // ENOENT is checked BEFORE the numeric-code arm: node's exec errors carry the
  // shell's exit status on `code` (127 for a missing binary) and the syscall
  // errno on `err.code` — whichever spelling arrives, "not found" is the fact
  // an operator acts on, not "exit code 127".
  if (e.code === "ENOENT") return "not found (ENOENT)";
  // A numeric `code` is a fact about the process, so it outranks any prose.
  // The old code consulted the command echo first and this arm afterwards,
  // which is how a timeout became "exit code 30".
  if (typeof e.code === "number") return `exit code ${e.code}`;
  // The remaining message fallbacks, reached only when no field carried
  // anything. The tail reproduces this same text, so both tests are anchored
  // (word boundary before, end of string after) rather than bare substring
  // matches: an unanchored /ENOENT/ would let a message that merely QUOTES the
  // word — `gh: "ENOENT" is not a real error` — classify as a missing binary,
  // crossing from "what the tool said" to "what we concluded". A shell's or
  // node's own report ends with the phrase.
  //
  // There is deliberately NO `Command failed: … <digits>` regex in this
  // function. The digits on that line are the command the caller passed, not an
  // exit status, and every case that once needed it is covered by a field: a
  // real non-zero exit carries a numeric `code`, and a real timeout carries
  // `killed` + `signal`. Accepting `code === undefined` for the echo instead
  // would classify `execp("git log 127")` — failing for another reason
  // altogether — as "exit code 127", which is the misattribution this is about.
  if (/\bENOENT\b\s*$/i.test(message.trim())) return "not found (ENOENT)";
  // A shell that cannot find its binary prints this and exits 127; when the
  // field survived, the numeric arm above already fired, so this catches the
  // wrapper that lost it. "not found" is the sentence the operator acts on.
  if (/\bcommand not found\b\s*$/i.test(message.trim())) return "not found";
  // An errno name (`'ENOENT'`, `'EACCES'`) with no numeric code. Accepted only
  // in the shape node actually emits — an uppercase errno token — so a wrapper
  // that put prose on `code` cannot make the cause claim to be one.
  if (typeof e.code === "string" && ERRNO_NAME.test(e.code)) return e.code;
  return "failed";
}

/**
 * The short stderr tail: node's command echo dropped, one line, redacted,
 * then clipped, then redacted again (see `boundThenRedact`).
 */
function stderrTail(raw: string): string {
  const stripped = raw.replace(COMMAND_FAILED_LINE, "").trim();
  if (!stripped) return "";
  // The lines that carry the fault, not the banner that announced it. `gh` and
  // `glab` print a usage/help block ahead of the line that actually says what
  // broke (`Error: Bad credentials …`), so a head clip would report the usage
  // banner as the whole cause and push the credential-bearing error line past
  // the cap — redacted but never shown, so nobody could audit it. Prefer,
  // highest signal first: an `error:`/`fatal:` line, then the last non-empty
  // line; and keep every line when the error is short enough that dropping one
  // would drop a word of it.
  const lines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // `stripped` is non-empty, so `lines` has at least one entry; the `??` is for
  // the no-`error:` case, not for an empty array.
  const last = lines[lines.length - 1] as string;
  const pick = [...lines].reverse().find((l) => /^(?:error|fatal)\b/i.test(l)) ?? last;
  const joined = lines.length <= 1 ? last : lines.length <= 3 ? lines.join(TAIL_JOIN) : pick;
  // Redact, then bind, then redact the bound result. The ` | ` join can land
  // INSIDE a token the tool wrapped across lines, so a single pass redacts the
  // half before the separator and leaves the rest as loose characters no
  // pattern recognises — hence the convergence loop in `redactTokenShapes`.
  return boundThenRedact(redactTokenShapes(joined), MAX_TAIL_CHARS);
}

/**
 * Redact every known and #1387-specific secret span.
 *
 * The whitespace normalisation is load-bearing, not cosmetic: every pattern
 * above requires a contiguous body, and a `gh` error that quoted a value with
 * embedded whitespace (`token=abc def…`) would otherwise slip past whole.
 *
 * Two rules go beyond matching a shape, both because a credential that is
 * *partly* redacted is still a credential:
 *
 *   - after any span the patterns matched, the next whitespace-delimited run
 *     goes too. Every body class above stops at whitespace, so a token printed
 *     with a space or a newline inside it leaves its tail standing — and the
 *     tail of a token is precisely what must not reach a PR body. It fires only
 *     where a marker already sits, so the tool's ordinary prose survives.
 *   - the ` | ` join between stderr lines can land *inside* one wrapped token
 *     (`ghp_aaa | bbb`), leaving `bbb` after the marker where no pattern can
 *     see it. Joined lines are separated by exactly this string, so a ` | `
 *     that follows a marker is the seam of a broken token, not prose.
 *
 * Applied REPEATEDLY until a pass changes nothing, so a rule that exposes a
 * shape another rule then matches converges; the cap is a formality.
 */
function redactTokenShapes(s: string): string {
  let out = s.replace(/\s+/g, " ");
  for (let pass = 0; pass < 6; pass++) {
    const before = out;
    out = redactSecrets(out).text;
    for (const re of EXTRA_SECRET_PATTERNS) out = out.replace(re, REDACTED);
    out = out.replace(SURVIVOR_AFTER_MARKER, "$1");
    out = out.replace(SURVIVOR_AFTER_JOIN, "$1");
    if (out === before) break;
  }
  return out;
}

/**
 * Bound `text` to `max` code points, then redact again.
 *
 * Redacting first is the right order for a whole string — but the bound can cut
 * a span it did not redact in half (a token whose body begins exactly at the
 * cap), and it can land mid-way through the marker just written, leaving
 * `[REDACT` on the page: a reader then cannot tell whether something was
 * redacted there, and a fragment of a credential that only the marker made
 * inert rides along. Redacting the clipped result catches both — the fragment
 * is now bounded text with its own recognisable shape — and cutting at a marker
 * boundary keeps the marker itself whole.
 */
function boundThenRedact(text: string, max: number): string {
  const chars = Array.from(redactSecrets(text).text);
  if (chars.length <= max) return chars.join("");
  let cut = chars.slice(0, max).join("");
  // Do not end inside a redaction marker: a partial `[REDACT…` is worse than
  // the character it costs, because it reads as content rather than as a
  // redaction that happened.
  const open = cut.lastIndexOf(REDACTED);
  if (open > max - REDACTED.length && !cut.endsWith(REDACTED)) {
    cut = cut.slice(0, Math.max(0, open));
  }
  // Second redaction pass on the clipped text, with the #1387 shapes included.
  let out = redactSecrets(cut).text;
  for (const re of EXTRA_SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Fence and marker neutralisation for failure text only — NOT the shared
 * `neutraliseEvidence` in `comment-evidence.ts`.
 *
 * That function serves diff evidence quoted inside a `<<<` / `>>>` DATA block,
 * where a lone backtick is inert and the text must arrive as written. This text
 * is different on both counts: it is a `gh`/`git` complaint interpolated into
 * markdown (a handoff bullet, a PR body), where one backtick closes an inline
 * code span and puts the remainder under markdown interpretation. Folding this
 * rule into the shared one is what made every evidence caller strip lone
 * backticks (#1444 round 3), so each audience owns its own.
 *
 * Triple runs become `'''` and `<<<` / `>>>` are bracketed exactly as the
 * shared rule does — those two shapes are the same hazard for both readers.
 *
 * The marker arm is a LOCAL pattern rather than the shared `MARKER_RE`, which is
 * private to `comment-evidence.ts` and tuned for every token in
 * `MARKER_CONTRACTS`. A probe's stderr names no contract, so the one family this
 * branch's readers actually parse is enough.
 *
 * The token is broken rather than bracketed — the shape round 3 got wrong.
 * `readMarker` matches `VERDICT\s*:?\s*\**\s*:?\s*<value>` with no lookbehind
 * and no word boundary, so round 3's `‹VERDICT:› APPROVED` STILL PARSED: the
 * bracket sits outside the token, and the colon between the word and the
 * closing bracket satisfies the optional `:`. A `gh` message printing
 * `VERDICT: APPROVED` therefore forged the review's own verdict while the
 * neutraliser reported itself clean. Deleting the separator is not enough
 * either — the bare word still matches, because every separator in that pattern
 * is optional. So the token is folded into the redaction marker: `[REDACTED]`
 * is the shape this module uses for "something was here and is deliberately
 * gone", a parser anchors on nothing in it, and unlike a zero-width space it
 * survives every flatten in the pipeline (both `comment-evidence.ts` and
 * `text-flatten.ts` strip Cf characters, so an invisible seam would silently
 * undo itself one hop away). Applied after the backticks are stripped, so a
 * tool that wrote `` `VERDICT:` `` — a real spelling in a `gh` message — is
 * still caught.
 */
function neutraliseCauseText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/`{3,}/g, "'''")
    .replace(/`/g, "")
    .replace(/<!--/g, "‹--")
    .replace(/-->/g, "--›")
    .replace(/<{3,}/g, "‹‹‹")
    .replace(/>{3,}/g, "›››")
    .replace(/\b(?:INTENT[-_])?VERDICT\b[^\s]*/gi, () => REDACTED);
}
