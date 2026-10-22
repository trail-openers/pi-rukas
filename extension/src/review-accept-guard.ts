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
 *       authoritative FOR THE COMMANDS IT GOVERNS: the ones that name the findings
 *       store — the data file, the store module, their stems, a `.tmp` / `.corrupt`
 *       sibling. A command that names none of those is an ordinary agent command and
 *       the allowlist does not speak to it: `mkdir -p tmp/x`, `git add -A`, `git push`,
 *       `npm install`, `cargo test`, `python3 -c …` and `sed -n`/`awk`/`gh api` on a
 *       NON-protected path all pass, and the guard does not consult the arms at all.
 *       Every command that DOES name the store is refused unless it matches an arm
 *       exactly. A command this module cannot parse — unbalanced quotes, a heredoc body
 *       that never terminates — is NOT refused for being unparseable: it faces the SAME
 *       scope predicate a readable command faces, evaluated on the text that did reach
 *       us. In scope it is refused (an unreadable command is exactly where a name hides);
 *       out of scope it is an ordinary agent command, stray quote and all (#1665, #1738).
 *   (b) POLARITY. Fail closed. Over-refusing a harmless read is an ACCEPTED COST —
 *       `--output`/`-o` on any file, `-c` at all, `bun test <non-test-path>`, a read
 *       tool naming the store, a word carrying `$`/backtick/backslash, a redirection.
 *       Each refusal names the flag or operand to drop, or the accept CLI to run instead.
 *   (c) EVOLUTION. A newly discovered bypass spelling is closed by REMOVING AN
 *       ALLOWANCE or ADDING A REFUSAL — never by adding a command scanner. This file
 *       has exactly one parser (`normalise`), one matcher (`namesStore`) and one
 *       dispatch (`scanCommand`); the parsing helpers live in review-accept-command.ts,
 *       the arms and the "which program runs this command" predicates live in
 *       review-accept-arms.ts, the git VERB position in review-accept-verb.ts, the six
 *       scope tests of clause (a) live in review-accept-scope.ts, and this module composes
 *       them.
 *
 * ── THE DECISION, in order ──────────────────────────────────────────────────────
 *
 *   1. `normalise()` — ONE pass: lowercase, whitespace and newlines collapsed to a
 *      single space, balanced `'…'` / `"…"`, spans removed (their contents are prose,
 *      so a commit message may name the store), and each heredoc BODY replaced by the
 *      bare marker `<<` (the body is text this guard cannot read). An odd count of `'`
 *      or `"` — or a heredoc whose delimiter never returns — is a parse FAILURE whose
 *      cause `normalise()` itself reports: the scope
 *      predicate then runs on the squeezed raw text, and only a command it brings INTO
 *      scope is refused.
 *   2. `namesStore()` — TOKEN-wise match against the protected names, their stems and
 *      the `.tmp` / `.corrupt` siblings, asked of the RAW text, the NORMALISED text and
 *      the raw text with every quote, brace and comma removed (so `rev{iew-findings}.json`
 *      and `'rev''iew-findings.json'` both count). A heredoc body is part of the raw
 *      text, so it is asked too. NOTHING ELSE RUNS IF THIS IS FALSE: a command that
 *      names no protected token is allowed here, before the segment gates and before the
 *      arms, because clause (a) scopes the allowlist to commands that name the store.
 *   3. THE PRE-CHECKS — a command in scope then faces the runner / heredoc / operator
 *      pre-checks and the write-flag / path-operand remedies are decided here. There is
 *      no cheap exit in front of the allowlist for a store-naming command: deny-by-
 *      default is not free, and the arms are a handful of array tests.
 *   4. THE ARMS — the raw command is split into segments on `|`, `;`, `&&`, `||`, `&`
 *      and newlines, and EVERY segment must clear the two segment-wide gates and match
 *      one arm exactly. The segment-wide gates refuse ANY word carrying shell
 *      expansion (`$`, backtick, backslash — the guard cannot read what the shell will
 *      substitute, so a protected name can be ASSEMBLED rather than spelled) or a
 *      redirection (`<` / `>` — bytes move to or from a path no arm ever saw).
 *        A1  git (--no-pager)? status|log|diff|show|blame — no -o, -c, --ext-diff,
 *            no repo-location / config selector the target test cannot CLEAR (`-c
 *            key=value`, `--git-dir`, `--work-tree`, `--exec-path`, or a `-C` at the
 *            store's directory — but NOT `git -C <worktree>`, which is sanctioned,
 *            #1643), no `alias`, and no operand naming the store by position
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
  VCS,
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
  UNREADABLE,
  armsOf,
  baseName,
  closingQuote,
  isProtectedToken,
  namesProtected,
  normalise,
  shellWords,
  squeeze,
  unquote,
} from "./review-accept-command.ts";
import { type ScopeClause, inScope } from "./review-accept-scope.ts";
import { trace, traceWarn } from "./trace.ts";
/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";
/** Shell expansion characters are the shared `UNREADABLE` (see `unsafeChars` below). */
/** Redirection characters: an arm word carrying one moves bytes to or from a path the
 * arms never saw. */
const REDIRECT = /[<>]/;

/** Does a word carry shell expansion or a redirection character? The expansion test is
 * the shared `UNREADABLE` (a word whose final form the guard cannot read — `$(…)`,
 * `${V}`, backticks, escapes, `{a,b}` / `{1..9}` — so a protected name can be ASSEMBLED
 * rather than spelled, and clause (a) refuses what it cannot parse). It is the same
 * predicate the `-C <path>` target test asks, which is why it is imported rather than
 * re-spelled here. Asked of the RAW word, quotes included. */
const unsafeChars = (word: string): boolean => UNREADABLE.test(word) || REDIRECT.test(word);

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

/** The refusal reasons (clause (b)): one base, the clause that fired, and the sentence
 * naming the remedy. #1764 criterion 10: the accept-CLI sentence is the remedy for the
 * NAME test alone — a command refused by the selector, heredoc, unreadable-word or
 * write-flag test is not an acceptance attempt, and telling its author to go run the
 * accept script in a terminal explained nothing about why their `git -C` was refused. */
const BASE =
  "Accepting a review finding is an operator act: agents may not reach the review findings store.";
/** The forms the allowlist does admit — the same list the arms implement, in the order
 * the guard dispatches them. */
const ALLOWED_READS =
  ' Allowed reads: git status/log/diff/show/blame, gh|glab pr|mr view|diff, gh repo view, gh issue view|list, bun|bunx test <test-path.ts>, bash smoke-tests/lib/verify-loop.sh <test-path.ts>, bun run build, bun run check, bunx tsc --noEmit, git commit -m "<message>", or a read tool (cat, grep, rg, ...) on a path that is not the findings store.';
/** What each of the six scope tests refused, and what to do about it. `store-name` is the
 * ONLY one whose remedy is the accept CLI; the others name the flag or operand to drop. */
const CLAUSE_SENTENCE: Record<ScopeClause, string> = {
  "store-name": ` Run ${ACCEPT_CLI} from a terminal for an acceptance. Triggered by clause (1): the command names the review findings store.`,
  "attached-value":
    " Triggered by clause (2): a protected name is ATTACHED to an option value (`-G<name>`, `-S<name>`, `--grep=<name>`, `-o<name>`) — drop that flag or its value.",
  "repo-selector":
    " Triggered by clause (3): a git repo-location / config selector (`-C`, `--git-dir`, `--work-tree`, `--exec-path`, `-c k=v`) points inside `.git` or cannot be resolved — point `-C` at the worktree, not at the git directory.",
  "executing-operand":
    " Triggered by clause (4): a heredoc body or a stdin `-` is handed to a program that EXECUTES or WRITES it — name the file instead of piping unreadable text in.",
  "unreadable-word":
    " Triggered by clause (5): a word carries a shell expansion the guard cannot read, on a program that can read the store — pass the literal path rather than `$(…)`, `${V}` or a backtick.",
  "write-argument":
    " Triggered by clause (6): an argument that can WRITE a file (`-o`, `--output`, `-c`, `--ext-diff`, a spaced write flag) stands on a VCS or runtime command — drop the flag.",
};

function refusalReason(
  clause: ScopeClause = "store-name",
  opts: { vcsWrite?: boolean; dataOperand?: boolean; target?: string } = {},
): string {
  if (opts.target)
    return `The review findings file (${opts.target}) is written only by ${ACCEPT_CLI}. Agents may not edit it.`;
  const base = BASE + CLAUSE_SENTENCE[clause] + ALLOWED_READS;
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
 * THE DECISION — clause (a) in code: parse first (a failure is adjudicated by the same
 * scope predicate a readable command faces), then the pre-checks, then the allowlist, and
 * a segment with no matching arm refuses. Returns the refusal reason AND the scope clause
 * that fired (#1764 criterion 10: a refusal that cannot say which of the six tests spoke
 * cannot be triaged, and the accept-CLI remedy belongs to test (1) alone), or undefined
 * for "allowed": the DEFAULT is ALLOW, so a shape this module simply does not think about
 * passes — only the routes enumerated above block.
 */
export interface GuardVerdict {
  readonly reason: string;
  readonly clause: ScopeClause;
}

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
      const end = closingQuote(segment, i);
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

/**
 * Clause (a), part (vi) is implemented in `review-accept-command.ts` as
 * `namesAttachedValue`, which strips the option prefix (`-G`, `-S`, `--grep=`, `-o`,
 * `--output=`) before asking the name and matches case-insensitively — the guard asks it
 * of its lowercased view, so `git log -GReview-Findings-Store` counts too.
 */

/** A command in a trace line: folded, and short enough to keep a trace file readable. */
function traceCommand(command: string): string {
  const flat = squeeze(command);
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}…`;
}

function scanCommand(command: string): GuardVerdict | undefined {
  // The newline is kept here: it is a segment separator, and the SEGMENTS are taken from
  // this view. `flat` (the folded text) decides only the pre-checks and the remedy
  // sentences, where a newline is just whitespace. Keeping both views derived from one
  // text is what makes the newline case unforgeable.
  const kept = command.toLowerCase();
  const trimmed = squeeze(command);
  if (trimmed === "") return undefined;
  // normalise() is asked of the UNFOLDED command (#1665). A heredoc's delimiter is a
  // LINE, and the previously-folded view had no lines left to search, so EVERY heredoc
  // parsed as unreadable and every `cat > f <<EOF` was refused whatever it wrote. The
  // fold is not lost: normalise's own last step is `squeeze`, so every other view here is
  // the same folded text it always was.
  const parsed = normalise(command);
  const raw = kept;
  // The words as the shell hands them out (`--output=<path>` is ONE word here, which is
  // precisely what an arm's `-o <name>` pair test cannot see).
  const words = shellWords(raw);
  // On a parse failure the scope predicate still gets a lowercase, whitespace-folded text to
  // ask its questions of — the fold normalise() performs, spelled here for the one view it
  // could not produce — rather than a branch that asks only some of them.
  const norm = parsed.ok ? parsed.text : squeeze(kept);
  // An UNREADABLE command is the guard's business exactly when a READABLE one of the same
  // text would be (#1665, and #1738: this branch used to consult test (1) alone, so an
  // unparseable command that reached the store by any of the other five routes walked
  // free). A stray quote in a command nowhere near the findings store is an ordinary
  // agent command — the findings-store refusal is the ONLY message this guard has, and a
  // store sentence on `echo 'a` is what made five cycles unreadable to their own agents.
  // In scope it is refused: an odd quote or a heredoc whose body never terminates is
  // precisely how a name hides behind text the guard cannot read. An ALLOWED one is an
  // ordinary command with a stray quote in it, so it logs at trace level, not warn: a host
  // that types `echo 'a` a hundred times a day should not read a hundred warnings.
  if (!parsed.ok) {
    const blocked = inScope(raw, norm, words);
    const line = `review-accept-guard: unparseable command (${parsed.cause}) ${
      blocked ? "in scope, refusing" : "out of scope, allowing"
    }: ${traceCommand(command)}`;
    if (blocked) traceWarn(line);
    else trace(line);
    return blocked
      ? { reason: refusalReason(blocked, { dataOperand: true }), clause: blocked }
      : undefined;
  }
  // Does the folded command name a protected file? Both remedy computations below ask
  // the same question, so it is asked ONCE here and reused rather than re-derived.
  const namesTheStore = namesProtected(norm);
  const clause = inScope(raw, norm, words);
  if (!clause) return undefined;

  // From here the command is IN SCOPE, so everything the guard knows how to refuse
  // applies — the segment-wide gates (expansion, braces, a redirection) and the arms,
  // and a segment matching no arm is refused. There is no cheap exit in front of the
  // allowlist for a command in scope: deny-by-default is not free, and the arms are a
  // handful of array tests.

  // The write-flag remedy applies only when the command BOTH names the store and
  // carries one of the write-capable arguments; a runtime import of the store is
  // neither, and must not be told to drop a flag it never passed.
  const vcsWrite = namesTheStore
    ? shellWords(raw).some((w) => VCS.test(baseName(unquote(w)))) &&
      hasFlag(shellWords(raw), ...WRITE_FLAGS)
    : false;
  const dataOperand =
    namesTheStore && !vcsWrite
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
    if (!segmentAdmitted(words))
      return { reason: refusalReason(clause, { vcsWrite, dataOperand }), clause };
  }
  return undefined;
}

/** The refusal text when a bash command could reach the findings store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command)?.reason;
}

/**
 * The guard's full verdict: the refusal text AND which of the six scope tests produced it.
 * The hook consumes `runsReviewAccept`; the #1764 suites consume this, because "every
 * refusal names its clause" and "only a clause-(1) refusal names the accept CLI" are the
 * assertions that keep the remedy from silently vanishing from the other five routes.
 */
export function reviewAcceptVerdict(command: string): GuardVerdict | undefined {
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
  // A PRESENT key is asked for even when its value is `undefined` / `null` — reading
  // `input.path` can itself throw (a Proxy, a lazy field), and that is refused below.
  const obj = (input ?? {}) as Record<string, unknown>;
  if (!("path" in obj)) return undefined;
  let target: unknown;
  try {
    target = obj.path;
  } catch (err) {
    traceWarn(
      `review-accept-guard: edit scan threw, refusing fail-open (${err instanceof Error ? err.message : String(err)})`,
    );
    // An unreadable `path` is a target the guard cannot rule out, so it is refused rather
    // than read as "nothing to block" — the string the caller would have handed back.
    return "<unreadable path>";
  }
  // A `path` that is PRESENT but not a string (a number, an array, an object with a
  // `toString`) is a target the guard cannot rule out: the writer below would coerce it,
  // so it is refused rather than read as "nothing to block". Only an ABSENT path — no
  // property at all, or `undefined` / `null` — means there is nothing to block.
  if (typeof target !== "string")
    return target === undefined || target === null ? undefined : "<non-string path>";
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
      const raw = (event.input as { command?: unknown } | null)?.command;
      // A `command` that is PRESENT but not a string cannot be scanned, and a scan that
      // cannot run is not a pass: refused fail-closed, like every other unreadable input.
      if (raw !== undefined && raw !== null && typeof raw !== "string")
        return { block: true, reason: refusalReason("store-name") };
      const command = typeof raw === "string" ? raw : "";
      // A scan that throws must not read as "nothing to block": a guard that fails
      // open on its own bug stops being a guard (clause (a) again).
      let reason: string | undefined;
      try {
        reason = scanCommand(command)?.reason;
      } catch (err) {
        traceWarn(
          `review-accept-guard: scan threw, refusing fail-open (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
        reason = refusalReason("store-name");
      }
      if (!reason) return;
      trace("review-accept-guard: BLOCKED agent-run finding acceptance (mode-independent)");
      return { block: true, reason };
    }
    const target = editsFindingsFile(event.toolName, event.input);
    if (!target) return;
    trace(`review-accept-guard: BLOCKED ${event.toolName} of the review findings file`);
    return { block: true, reason: refusalReason("store-name", { target }) };
  });
}
