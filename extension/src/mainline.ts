/**
 * mainline — which branch the mainline is, resolved from the clone.
 *
 * #1387: this pair used to live in `work-driver-git.ts`, so the review ledger
 * path (`review-ledger-path.ts` → `identityBase`) imported a driver module for
 * one git read. The ledger writer and the merge guard both compute a patch
 * identity against `<remote>/<mainline>`; making them reach the driver layer
 * to do it tied the review layer to the driver for something that is a plain
 * git lookup.
 *
 * Neutral leaf, the shape `exec.ts` and `git-range.ts` already follow: its
 * only import is `./exec.ts` for its option/result types, so any module —
 * driver or review — may depend on it without pulling the other side in. The
 * driver callers keep their imports unchanged via the re-exports in
 * `work-driver-git.ts`.
 *
 * The executor type is declared structurally here rather than imported from
 * `work-driver-git.ts`: a type-only import of `VerifyExecFn` would satisfy the
 * grep gate in `test-review-ledger-path-imports.ts` only because TypeScript
 * erases it, which is exactly the false pass that gate exists to refuse. Its
 * result is `{ stdout, stderr? }` — the weakest contract that satisfies every
 * existing executor in the repo (`VerifyExecFn`, the driver `ExecFn` and
 * `execp` are all assignable to it; `execp`'s required `stderr` is a subtype
 * of the optional one).
 *
 * Every probe is bounded by `MAINLINE_PROBE_TIMEOUT_MS` and every failure
 * names its cause, because this leaf sits on the fail-closed paths: the review
 * ledger (`identityBase`) and the merge guard compute a patch identity against
 * `<remote>/<mainline>` through here. An unbounded `gh repo view` on a stalled
 * connection settled never, and "never" is the one outcome a fail-closed gate
 * cannot report — no reason, no verdict, no merge.
 */

import { neutraliseFences } from "./comment-evidence.ts";
import type { ExecOpts } from "./exec.ts";
import { REDACTED, redactSecrets } from "./secret-patterns.ts";
import { redactThenBound } from "./text-flatten.ts";

/** The executor shape both `detectMainline` and `resolveMainline` accept. */
export type MainlineExecFn = (
  cmd: string,
  opts?: ExecOpts,
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Bound on each mainline probe.
 *
 * Both calls are read-only and finish in well under a second when the host is
 * healthy — `git symbolic-ref` reads a local ref, `gh repo view` is one API
 * round-trip. Thirty seconds is the point at which "slow" is plainly a stalled
 * connection or a hung credential prompt, and the caller wants its verdict
 * rather than a promise that never settles. Deliberately a constant rather
 * than an input: `test-headless-inputs.ts` refuses an env read the
 * `--capabilities` inventory does not list, and a knob for a timeout nobody
 * tunes is an input with no operator.
 */
export const MAINLINE_PROBE_TIMEOUT_MS = 30_000;

/**
 * A mainline resolution. `ok` is the discriminator: `resolveMainline` reads
 * the verdict off it alone, never off the presence of a `branch` key (#1153).
 */
export type MainlineResult = { ok: true; branch: string } | { ok: false; reason: string };

/**
 * Resolve the mainline branch name for the current repo (e.g. "main",
 * "master").
 *
 * Two-step resolution:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` — fast, no
 *      network, returns "origin/main" → stripped to "main" in JS.
 *   2. Fallback: the forge adapter's `repoSettings()` (the network call
 *      behind the old `gh repo view --json defaultBranchRef`), used when
 *      origin/HEAD is absent (some fetch configurations don't set it).
 *
 * Returns `{ ok: true, branch }` on success, `{ ok: false, reason }` on
 * failure. The caller (detectMainline) is designed for use both from
 * verifyStepOutcome (via injected ctx.verifyExecFn) and from
 * restoreCheckout (injected at call site).
 *
 * Each probe carries `MAINLINE_PROBE_TIMEOUT_MS`. Both failures are recorded
 * (the executor is a free variable, so a hang, a missing `gh` and a non-zero
 * exit are three different faults) and the failure reason names them, so a
 * timeout reads differently from "gh is not installed".
 *
 * NOTE on shell safety: `git symbolic-ref` takes a fixed ref with no
 * dynamic arguments. The executor takes a shell string; any future
 * caller that wants to pass dynamic branch/repo names must not interpolate
 * them raw — JSON.stringify for quoting or prefer execFile-style arrays.
 */
export async function detectMainline(
  repoRoot: string,
  execFn: MainlineExecFn,
): Promise<MainlineResult> {
  // Each probe's failure cause, in probe order. The failure reason names both
  // — an unreadable mainline is fail-closed downstream, so "it failed" is not
  // an answer an operator can act on.
  const causes: string[] = [];

  // 1. git symbolic-ref — no network, instant.
  try {
    const { stdout } = await execFn("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeout: MAINLINE_PROBE_TIMEOUT_MS,
    });
    const ref = stdout.trim();
    if (ref) {
      // Returns "origin/main" — strip the leading origin/.
      const branch = ref.startsWith("origin/") ? ref.slice(7) : ref;
      if (branch) return { ok: true, branch };
    }
    causes.push("git symbolic-ref: empty origin/HEAD");
  } catch (err) {
    // refs/remotes/origin/HEAD may be absent; fall through.
    causes.push(`git symbolic-ref: ${causeOf(err)}`);
  }

  // 2. Fallback: `gh repo view` — the raw-JSON call is kept rather than
  //    routed through the forge adapter on purpose: the tests inject a
  //    `git symbolic-ref`-answering fake that answers nothing else, and
  //    the forge's `repoSettings()` command shape is not what those fakes
  //    expect. The adapter is the S4 seam for PR operations; this
  //    mainline probe is a git-side call with a `gh` fallback.
  try {
    const { stdout } = await execFn(
      "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'",
      { cwd: repoRoot, maxBuffer: 64 * 1024, timeout: MAINLINE_PROBE_TIMEOUT_MS },
    );
    const branch = stdout.trim();
    if (branch) return { ok: true, branch };
    causes.push("gh repo view: empty defaultBranchRef");
  } catch (err) {
    // Both methods failed.
    causes.push(`gh repo view: ${causeOf(err)}`);
  }

  return {
    ok: false,
    reason: `could not resolve mainline branch: both git symbolic-ref and gh repo view failed (${causes.join("; ")})`,
  };
}

/**
 * The cause of a failed probe, in the words of whatever failed — sanitised.
 *
 * `promisify(exec)` puts the shell's own complaint on the error, and this text
 * is embedded in the failure `reason`, which travels into merge-guard refusals,
 * handoff comments and PR bodies. An adversarial reviewer saw a `gh` auth error
 * echo token-shaped text through this path, so the raw message is never copied.
 * Four steps, in this order:
 *
 *   1. **Drop the `Command failed: <cmd>` line.** node's own preamble, which
 *      echoes the command (and would echo any future argument someone
 *      interpolates into it). The probe that failed is already named by the
 *      caller's `git symbolic-ref:` / `gh repo view:` prefix.
 *   2. **Prefer a classification.** timed out / killed by a signal / exited N /
 *      not found (ENOENT or the shell's "command not found"), taken from the
 *      fields exec stamps (`killed`, `signal`, `code`, `err.code`) rather than
 *      from prose matching wherever a field exists. A timeout, a missing `gh`
 *      and a non-zero exit must stay distinguishable — that is the whole reason
 *      the causes exist.
 *   3. **Redact token-shaped substrings** before the tail is clipped, so a
 *      bound cannot cut a credential into a fragment no pattern recognises
 *      (`redactThenBound` applies the same order for the same reason).
 *   4. **Neutralise markdown and marker characters** — backticks, `<!--`,
 *      `-->`, `VERDICT:`-shaped tokens — via the one fence/marker rule in
 *      `comment-evidence.ts`, so failure text cannot close a code span or forge
 *      a verdict a later reader parses.
 */
function causeOf(err: unknown): string {
  const e = (err ?? {}) as {
    message?: unknown;
    stderr?: unknown;
    killed?: unknown;
    signal?: unknown;
    code?: unknown;
  };
  const message =
    typeof e.message === "string" && e.message
      ? e.message
      : err instanceof Error
        ? ""
        : String(err);
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const classification = classificationOf(e, message);
  // `stderr` first when the executor captured it — that is the tool's own
  // complaint. The message is the fallback, with node's command echo stripped
  // inside `stderrTail`.
  const tail = stderrTail(stderr.trim() ? stderr : message);
  const cause = tail.length > 0 ? `${classification}: ${tail}` : classification;
  return redactThenBound(neutraliseFences(cause), MAX_CAUSE_CHARS).text;
}

/** Upper bound on the sanitised cause. The reason embeds two of these. */
const MAX_CAUSE_CHARS = 160;

/** How short the stderr tail is clipped to, after redaction. */
const MAX_TAIL_CHARS = 120;

/** node's exec preamble, which echoes the command itself. */
const COMMAND_FAILED_LINE = /^Command failed:[^\n]*\n?/i;

/**
 * The token shapes named in #1387 round 3, added to the shared set in
 * `secret-patterns.ts` rather than replacing it: `secret-patterns` requires
 * long bodies (`gh[pousr]_…{16,}`) and this text comes from a `gh` error that
 * may quote a short or truncated value. Over-redaction here costs a reader a
 * little context; under-redaction publishes a credential.
 *
 * NOTE on the `\b` before `token`: `\btoken\b` still matches the `token` inside
 * `github_pat_…`, so a bare `token[=:]…` rule would shred an already-safe
 * redaction marker. The negative lookahead requires the word to stand alone.
 */
const EXTRA_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-)[A-Za-z0-9_./+=-]{4,}/g,
  /\b(?!pat_)token\b\s*[:=]\s*["']?[A-Za-z0-9._\-/+:]{4,}/gi,
  /\bx-access-token:\s*\S+/gi,
  /\bBearer\s+\S+/gi,
];

/** Redact every known and #1387-specific secret span. */
function redactTokenShapes(s: string): string {
  let out = redactSecrets(s).text;
  for (const re of EXTRA_SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * What kind of failure this is, from the fields exec stamps — not from prose.
 *
 * Each arm is a different fault an operator acts on differently: a timeout is a
 * stalled connection, ENOENT is a missing `gh`, an exit code is the tool's own
 * complaint. They must never collapse into one sentence.
 */
function classificationOf(
  e: { killed?: unknown; signal?: unknown; code?: unknown },
  message: string,
): string {
  // A bare rejection carries no `code`, so the shell's own exit status is
  // recovered from the message. `exec` prefixes `Command failed: ` and node
  // appends the exit code to that first line (with the captured stderr after
  // it), so the trailing number on that line IS the code — but only on the
  // command-echo line. Anchoring there (rather than anywhere in the message)
  // is what keeps a number at the end of the tool's own complaint (`…api rate
  // limit exceeded 503`) from being read as an exit status: without that
  // anchor a rate limit classifies as "exit code 503", which is the
  // misattribution the classification exists to avoid. `gh repo view 127` in
  // the echoed command is the accepted false positive — the tail still shows
  // what the tool said, and nobody passes a bare number as a probe argument.
  const commandEcho = message.match(/^Command failed:[^\n]*\s(\d{1,3})\s*$/im);
  if (commandEcho) return `exit code ${commandEcho[1]}`;
  if (/\btimed out\b/i.test(message)) return "timed out";
  if (e.killed === true) {
    return typeof e.signal === "string" && e.signal ? `killed by ${e.signal}` : "killed";
  }
  // ENOENT is checked BEFORE the numeric-code arm: node's exec errors carry the
  // shell's exit status on `code` (127 for a missing binary) and the syscall
  // errno on `err.code` — whichever spelling arrives, "not found" is the fact
  // an operator acts on, not "exit code 127".
  if (e.code === "ENOENT") return "not found (ENOENT)";
  // The message test is anchored (a word boundary before / end after), not a
  // bare substring: the tail below reproduces the error's own text, so an
  // unanchored /ENOENT/ would let a message that merely QUOTES the word —
  // `gh: "ENOENT" is not a real error` — classify as a missing binary and
  // cross the attribution line from "what the tool said" to "what we
  // concluded". A shell's or node's own report ends with the phrase; a
  // quotation of it in the middle of a sentence does not.
  //
  // Kept as a sibling to the `e.code` arm rather than folded into it: a test
  // fake (or a wrapper executor that loses the errno field) rejects with
  // `new Error("spawn gh ENOENT")` and no `code` at all, and the shell's
  // `/bin/sh: gh: command not found` carries neither field.
  if (/\bENOENT\b\s*$/i.test(message.trim())) return "not found (ENOENT)";
  // Checked before the numeric `code` arm on purpose: a shell that cannot find
  // its binary exits 127, so `exit code 127` and "not found" describe the same
  // event, and the sentence the operator acts on is the second one. The tool's
  // own words still ride along in the tail.
  if (/\bcommand not found\b\s*$/i.test(message.trim())) return "not found";
  if (typeof e.code === "number") return `exit code ${e.code}`;
  if (typeof e.code === "string" && e.code) return e.code;
  return "failed";
}

/**
 * The short stderr tail: node's command echo dropped, one line, redacted,
 * then clipped. Redaction precedes the clip for the reason `redactThenBound`
 * documents — a clip first can leave a fragment no pattern matches.
 */
function stderrTail(raw: string): string {
  const stripped = raw.replace(COMMAND_FAILED_LINE, "").trim();
  if (!stripped) return "";
  // Every non-empty line, joined — not just the first. `gh` and `glab` print a
  // usage/help block ahead of the line that actually says what broke
  // (`Error: Bad credentials …`), and a first-line-only tail would report the
  // usage banner as the cause while the credential-bearing error line — the
  // text this function exists to redact — sat below it, redacted but never
  // shown, so nobody could see that the interesting line was ever there.
  const joined = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" | ");
  return redactThenBound(redactTokenShapes(joined), MAX_TAIL_CHARS).text;
}

/**
 * #1134 follow-up — detectMainline as a total function for its callers.
 *
 * A caller that reads `.branch` off a value that is undefined, or off an
 * unexpected shape, gets a TypeError rather than a verdict, and a throw from
 * the detector escapes the gate that asked. Both become the same unresolved
 * result a failed detection produces, carrying the reason.
 */
export async function resolveMainline(
  repoRoot: string,
  execFn: MainlineExecFn,
  detect: typeof detectMainline = detectMainline,
): Promise<MainlineResult> {
  let m: unknown;
  try {
    m = await detect(repoRoot, execFn);
  } catch (err) {
    // Same sanitisation as a probe cause: a detector that throws hands its
    // exception text straight to the handoff and the PR body.
    return { ok: false, reason: `mainline detection threw: ${causeOf(err)}` };
  }
  // #1153 — read the discriminated result by its DISCRIMINANT. A `"branch" in m`
  // test passes for any object carrying a `branch` key, including a failure
  // record that happens to have one; `ok` is the only field whose presence is
  // load-bearing for the verdict.
  if (m && typeof m === "object") {
    const mo = m as { ok?: unknown; branch?: unknown; reason?: unknown };
    if (mo.ok === true && typeof mo.branch === "string" && mo.branch.length > 0) {
      return { ok: true, branch: mo.branch };
    }
    if (mo.ok === false && typeof mo.reason === "string" && mo.reason.length > 0) {
      return { ok: false, reason: mo.reason };
    }
  }
  return {
    ok: false,
    reason: "mainline detection returned an unexpected result",
  };
}
