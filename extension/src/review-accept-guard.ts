/**
 * review-accept-guard — deny-by-default refusal of agent bash that could reach the
 * review findings store (#1105, #1125), and of agent edits of the findings file.
 *
 * Accepting a recorded finding suppresses it from every later round, so it stays a
 * human act: the operator runs `extension/scripts/review-accept.ts` in a terminal.
 * This hook refuses, in every mode and for every role, agent bash that could reach
 * that store, and agent edit / write / multiedit of the findings file, one of its
 * `.tmp` / `.corrupt` siblings, or the store module's own source.
 *
 * ADVISORY, not a security boundary: every rule is a string match on the command
 * text or the target path. The threat model is the honest-but-forgetful agent, and
 * the operator's terminal is the real boundary.
 *
 * ── THE ADJUDICATION RULE (#1125, operator decision 2026-10-16), in code ────────
 *
 *   (a) ORDERING. One EXACT allowlist of read-only command forms (the arms below) is
 *       authoritative. Every OTHER bash command that names the findings store — the
 *       data file, the store module, their stems, a `.tmp` / `.corrupt` sibling — is
 *       refused. So is any command containing a runtime or a forge CLI, and any
 *       command this module cannot parse: unbalanced quotes, or a heredoc body that
 *       never terminates.
 *   (b) POLARITY. Fail closed. Over-refusing a harmless read is an ACCEPTED COST —
 *       `--output`/`-o` on any file, `-c` at all, `bun test <non-test-path>`, a read
 *       tool naming the store, a word carrying `$`/backtick/backslash, a redirection.
 *       Each refusal names the flag or operand to drop, or the accept CLI to run instead.
 *   (c) EVOLUTION. A newly discovered bypass spelling is closed by REMOVING AN
 *       ALLOWANCE or ADDING A REFUSAL — never by adding a command scanner. This file
 *       has exactly one parser (`normalise`), one matcher (`namesProtected`) and one
 *       dispatch (`scanCommand`); the parsing helpers themselves live in
 *       review-accept-command.ts and this module composes them with the arms.
 *
 * ── THE DECISION, in order ──────────────────────────────────────────────────────
 *
 *   1. `normalise()` — ONE pass: lowercase, whitespace and newlines collapsed to a
 *      single space, balanced `'…'` / `"…"`, spans removed (their contents are prose,
 *      so a commit message may name the store), and each heredoc BODY replaced by the
 *      bare marker `<<` (the body is text this guard cannot read). An odd count of
 *      `'` or `"` is PARSE_FAIL and clause (a) refuses it.
 *   2. `namesProtected()` — TOKEN-wise match against the protected names, their stems
 *      and the `.tmp` / `.corrupt` siblings, asked of BOTH the raw command and the
 *      normalised one; a heredoc marker standing beside a runtime word also counts,
 *      because the guard cannot see what that heredoc feeds the interpreter.
 *   3. THE PRE-CHECKS — an unparseable command is refused here, and the write-flag /
 *      path-operand remedies are decided here. There is NO cheap exit in front of the
 *      allowlist: any command carrying a word that could name a program reaches the
 *      arms, which is every real command. Deny-by-default is not free, and this header
 *      no longer claims it is — the arms are a handful of array tests, and a correct
 *      refusal is worth more than the microseconds a fast path would have saved.
 *   4. THE ARMS — the raw command is split into segments on `|`, `;`, `&&`, `||`, `&`
 *      and newlines, and EVERY segment must clear the two segment-wide gates and match
 *      one arm exactly. The segment-wide gates refuse ANY word carrying shell
 *      expansion (`$`, backtick, backslash — the guard cannot read what the shell will
 *      substitute, so a protected name can be ASSEMBLED rather than spelled) or a
 *      redirection (`<` / `>` — bytes move to or from a path no arm ever saw).
 *        A1  git (--no-pager)? status|log|diff|show|blame — no -o, -c, --ext-diff,
 *            --output…, no `alias`, and no operand naming the store by position
 *        A2  gh pr view|diff|list|checks | gh repo view | gh issue view|list
 *        A3  glab mr view|diff. `gh api` is NOT an arm: it carries an arbitrary method
 *            and body, so no flag ban can make it a read.
 *        A4  (bun|bunx) test <flags-without-values | test paths>
 *        A5  bash …/verify-loop.sh <same argv, plus --digest>
 *        A6  the exact build forms: bun run build, bun run check, bunx tsc --noEmit
 *        A7  git commit -m "<prose>" — git at word 0, and one UNQUOTED -m whose
 *            QUOTED message is the only prose the arm excuses
 *        A8  a read tool (ls, cat, head, tail, wc, grep, rg, file, stat, which,
 *            basename, dirname, echo, printf, cd, pwd, true) at word 0, with no
 *            exec-capable flag (--pre, --pre-glob, --exec, -exec, --command) and
 *            naming nothing protected. `sed` and `awk` are NOT read tools: each can
 *            run a shell (`sed -n '1e id'`, `awk BEGIN{system("id")}`) and `sed` can
 *            write a file (`sed -n 'w /tmp/x'`), so no flag ban turns either one
 *            into a read.
 *      A segment matching no arm is refused.
 */

import { posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  RUNTIME,
  WRITE_FLAGS,
  armBuild,
  armCommit,
  armForgeRead,
  armGitRead,
  armRead,
  armTest,
  armVerifyLoop,
  hasFlag,
} from "./review-accept-arms.ts";
import {
  armsOf,
  baseName,
  isProtectedToken,
  namesProtected,
  normalise,
  shellWords,
  squeeze,
  tokensOf,
  unquote,
} from "./review-accept-command.ts";
import { trace, traceWarn } from "./trace.ts";
/** The forge CLIs, whose read arms are exact. */
const VCS = /^(?:git|gh|glab)$/;
/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";
/** Shell expansion characters. A word carrying one is text whose final form the guard
 * cannot read (`$(…)`, `${V}`, backticks, escapes), so no arm vouches for it: clause
 * (a) refuses what it cannot parse, and a protected name assembled by the shell is
 * exactly that. Asked of the RAW word, quotes included. */
const EXPANSION = /[$`\\]/;
/** Redirection characters: an arm word carrying one moves bytes to or from a path the
 * arms never saw. */
const REDIRECT = /[<>]/;

/** Does a word carry shell expansion or a redirection character? */
const unsafeChars = (word: string): boolean => EXPANSION.test(word) || REDIRECT.test(word);

/** Does one segment match one of the arms? Judged on the raw words, quotes kept. */
function segmentAdmitted(words: string[]): boolean {
  if (words.length === 0) return false;
  // Clause (a): a heredoc body the guard cannot read is not an argument. The marker is
  // tested FIRST, so no arm can vouch for a command whose body was removed.
  if (words.some((x) => x === "<<" || unquote(x) === "<<")) return false;
  // Two shapes no arm vouches for, in any position: shell expansion, whose result the
  // guard cannot read (`$V`, `$(…)`, backticks and escapes can ASSEMBLE a protected name
  // the text never spells), and a redirection, which moves bytes to or from a path no
  // arm ever saw. Both are asked of the RAW word, quotes included.
  if (words.some(unsafeChars)) return false;
  return [armGitRead, armForgeRead, armTest, armVerifyLoop, armBuild, armCommit, armRead].some(
    (arm) => arm(words),
  );
}

/** The refusal reasons (clause (b)): one base, plus the sentence naming the remedy. */
function refusalReason(
  opts: { vcsWrite?: boolean; dataOperand?: boolean; target?: string } = {},
): string {
  if (opts.target)
    return `The review findings file (${opts.target}) is written only by ${ACCEPT_CLI}. Agents may not edit it.`;
  const base = `Accepting a review finding is an operator act: agents may not reach the review findings store. Run ${ACCEPT_CLI} from a terminal for an acceptance. Allowed reads: git status/log/diff/show/blame, gh|glab pr|mr view|diff, gh repo view, gh issue view|list, bun|bunx test <test-path.ts>, bash smoke-tests/lib/verify-loop.sh <test-path.ts>, bun run build, bun run check, bunx tsc --noEmit, git commit -m "<message>", or a read tool (cat, grep, rg, ...) on a path that is not the findings store.`;
  // `false` means "this route is not a write-flag one" and must add nothing; only
  // `true` speaks of flags. `opts.vcsWrite` is a three-state value here — undefined
  // when the command names nothing protected — so a truthiness test read as a route.
  const vcs =
    opts.vcsWrite === true
      ? " Drop the write-capable flag (-o/--output/-c): e.g. `git --no-pager log` instead of `git -c core.pager=cat log`."
      : "";
  const data =
    opts.dataOperand === true
      ? " Drop the path operand naming the store: it is not an argument any command may take."
      : "";
  return base + vcs + data;
}

/**
 * THE DECISION — clause (a) in code: parse first (a failure refuses), then the
 * pre-checks, then the allowlist, and a segment with no matching arm refuses. Returns
 * the refusal reason, or undefined for "allowed": the DEFAULT is ALLOW, so a shape this
 * module simply does not think about passes — only the routes enumerated above block.
 */
/** Is any word a runtime or a forge CLI, quotes stepped over? */
const namesRunner = (text: string): boolean =>
  shellWords(text).some((w) => {
    const t = baseName(unquote(w));
    return RUNTIME.test(t) || VCS.test(t);
  });

/** Is any NON-QUOTED word the store? A quoted word is prose, not an argument. */
const opensProtected = (words: string[]): boolean =>
  words.some((w) => !/["']/.test(w) && isProtectedToken(unquote(w)));

/**
 * The segment the arms match: balanced quotes are STEPPED OVER, not deleted, so a
 * word keeps its quoting (which tells prose from an argument) while glued operators
 * (`x.ts;rm`) become ordinary characters the arms cannot mistake for a separator.
 */
function unquoteKeepQuotes(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    const c = segment[i] as string;
    if (c === "'" || c === '"') {
      const end = segment.indexOf(c, i + 1);
      const stop = end < 0 ? segment.length : end + 1;
      out += segment.slice(i, stop).replace(/\s/g, "_");
      // An unpaired quote leaves `stop` at `i`: the walk has to move forward anyway or
      // the scan spins until the process dies, and a scan that dies is not a guard.
      i = stop > i ? stop : i + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Any word that is a program name (`bun`, `git`, `bash`, …), quotes stepped over. */
function looksLikeProgram(text: string): boolean {
  return shellWords(text).some((w) => {
    const t = baseName(unquote(w));
    return /^[a-z][a-z0-9._-]*$/.test(t) && !/^[._-]/.test(t);
  });
}

function scanCommand(command: string): string | undefined {
  // The newline is kept here: it is a segment separator, and the SEGMENTS are taken from
  // this view. `flat` (the folded text) decides only the pre-checks and the remedy
  // sentences, where a newline is just whitespace. Keeping both views derived from one
  // text is what makes the newline case unforgeable.
  const kept = command.toLowerCase();
  const trimmed = squeeze(command);
  if (trimmed === "") return undefined;
  // ONE view drives the whole decision: the command with its newlines folded. A shell
  // treats a newline as a segment separator exactly as it treats `;`, and the previous
  // shape compared a raw text against a folded one, so the newline check could not be
  // trusted. Folding first makes the operator test below a plain substring scan.
  const flat = trimmed.toLowerCase();
  const norm = normalise(trimmed);
  if (norm === "PARSE_FAIL") return refusalReason({ dataOperand: true });
  const raw = kept;

  const protectedAnywhere = namesProtected(raw) || namesProtected(norm);
  const heredocRuntime = norm.includes("<<") && namesRunner(norm);
  // Any operator, redirection or newline opens a segment the shell will run, even inside
  // quotes, so the pre-checks defer to the arms whenever one appears.
  const reach = /[|;&<>]/.test(command) || command.includes(String.fromCharCode(10));
  // The runner test is asked of the NORMALISED text as well as the raw one: normalise
  // removes quoted spans, and a runner that SURVIVES quote removal is a word the shell
  // really executes. Asking only the raw text let `bash …` reach the arms by a path the
  // pre-checks never vetted.
  //
  // `looksLikeProgram(flat)` is the term that makes this pre-check unreachable for any
  // real command — a bare word is all it takes — and that is deliberate: every command
  // goes through the arms rather than being waved past them. The terms above it are not
  // dead, they are just no longer sufficient on their own.
  if (
    !protectedAnywhere &&
    !namesRunner(flat) &&
    !namesRunner(norm) &&
    !looksLikeProgram(flat) &&
    !reach &&
    !heredocRuntime
  )
    return undefined;

  // The write-flag remedy applies only when the command BOTH names the store and
  // carries one of the write-capable arguments; a runtime import of the store is
  // neither, and must not be told to drop a flag it never passed.
  const vcsWrite = namesProtected(norm)
    ? shellWords(raw).some((w) => VCS.test(baseName(unquote(w)))) &&
      hasFlag(shellWords(raw), ...WRITE_FLAGS)
    : false;
  const dataOperand =
    namesProtected(norm) && !vcsWrite
      ? armsOf(norm).some((s) => {
          const w = shellWords(s);
          // Two shapes name the store as data: a non-verb word (`cat <store>`,
          // `git add <store>`), or the VERB of a command that executes text it cannot
          // read — a heredoc marker (`cat << review-findings-store`). Either way the
          // remedy is to drop the path.
          return w.length > 1 && (opensProtected(w.slice(1)) || (w.length > 2 && w.includes("<<")));
        })
      : false;

  // The SEGMENTS come from the raw view, where a newline still separates: iterating
  // the folded view would judge one merged segment and never see the second line at all.
  const rawArms = armsOf(raw);
  for (const rawSegment of rawArms) {
    // The ARMS see the raw segment with its quotes intact: a quoted word is prose and
    // must not be mistaken for an argument, and `git commit -m "…"` needs to see that
    // its message was quoted at all. The normalised text is lowercase, so lowercasing
    // the raw segment keeps the two views comparable.
    const words = shellWords(unquoteKeepQuotes(rawSegment));
    if (!segmentAdmitted(words)) return refusalReason({ vcsWrite, dataOperand });
  }
  return undefined;
}

/** The refusal text when a bash command could reach the findings store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command);
}

/** Edit tools whose `path` argument is checked against the protected files. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);

/** The target path when an edit-style call would write a protected file, else undefined.
 *
 * Fail-closed like the bash branch: a throw here must not read as "nothing to block".
 * The `path` property is read exactly ONCE, inside its own try — a caller whose `path` is
 * a throwing getter (a Proxy, a lazy field) made the old shape re-read the same getter in
 * its catch, so the guard's own error escaped and the tool_call handler saw an exception
 * rather than a refusal. The value is normalised before its basename is taken, so a
 * trailing `/.` or a `../..` walk out of the store's directory cannot present the store
 * as some other file: every SEGMENT of the normalised path is asked.
 */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  let target: unknown;
  try {
    target = (input as { path?: unknown } | null)?.path;
  } catch (err) {
    traceWarn(
      `review-accept-guard: edit scan threw, refusing fail-open (${err instanceof Error ? err.message : String(err)})`,
    );
    // An unreadable `path` is a target the guard cannot rule out, so it is refused rather
    // than read as "nothing to block" — the string the caller would have handed back.
    return "<unreadable path>";
  }
  if (typeof target !== "string") return undefined;
  try {
    // The RAW path is asked SEGMENT-wise BEFORE normalisation: `.normalize` collapses
    // `<store>/../../src/x.ts` to `/repo/src/index.ts`, which reads as an ordinary file —
    // yet the bytes a writer following that path touches come from the store's directory, so
    // the walk itself is the refusal. Normalisation is asked too, for the trailing `/` and
    // `/.` spellings whose last segment is empty once the separators are gone.
    const walked = target.split(/[\\/]/).some((segment) => isProtectedToken(segment));
    if (walked || posix.normalize(target).split("/").some(isProtectedToken)) return target;
    return undefined;
  } catch (err) {
    traceWarn(
      `review-accept-guard: edit scan threw, refusing fail-open (${err instanceof Error ? err.message : String(err)})`,
    );
    return target;
  }
}

export function registerReviewAcceptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      // A scan that throws must not read as "nothing to block": a guard that fails
      // open on its own bug stops being a guard (clause (a) again).
      let reason: string | undefined;
      try {
        reason = scanCommand(command);
      } catch (err) {
        traceWarn(
          `review-accept-guard: scan threw, refusing fail-open (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        reason = refusalReason();
      }
      if (!reason) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return { block: true, reason };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return { block: true, reason: refusalReason({ target }) };
  });
}
