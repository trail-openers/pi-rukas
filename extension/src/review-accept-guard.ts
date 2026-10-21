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
 *       exactly; so is any command this module cannot parse: unbalanced quotes, or a
 *       heredoc body that never terminates.
 *   (b) POLARITY. Fail closed. Over-refusing a harmless read is an ACCEPTED COST —
 *       `--output`/`-o` on any file, `-c` at all, `bun test <non-test-path>`, a read
 *       tool naming the store, a word carrying `$`/backtick/backslash, a redirection.
 *       Each refusal names the flag or operand to drop, or the accept CLI to run instead.
 *   (c) EVOLUTION. A newly discovered bypass spelling is closed by REMOVING AN
 *       ALLOWANCE or ADDING A REFUSAL — never by adding a command scanner. This file
 *       has exactly one parser (`normalise`), one matcher (`namesStore`) and one
 *       dispatch (`scanCommand`); the parsing helpers live in review-accept-command.ts,
 *       the arms and the "which program runs this command" predicates live in
 *       review-accept-arms.ts, and this module composes them.
 *
 * ── THE DECISION, in order ──────────────────────────────────────────────────────
 *
 *   1. `normalise()` — ONE pass: lowercase, whitespace and newlines collapsed to a
 *      single space, balanced `'…'` / `"…"`, spans removed (their contents are prose,
 *      so a commit message may name the store), and each heredoc BODY replaced by the
 *      bare marker `<<` (the body is text this guard cannot read). An odd count of
 *      `'` or `"` is PARSE_FAIL and clause (a) refuses it.
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
  OUTPUT_FLAGS,
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
  hasStdinDash,
  hasUnresolvedRepoSelector,
  namesGit,
  namesInterpreter,
  namesReadTool,
  namesVcsOrRuntime,
} from "./review-accept-arms.ts";
import {
  armsOf,
  baseName,
  eraseShellPunctuation,
  isAcceptScriptToken,
  isProtectedToken,
  namesAttachedValue,
  namesProtected,
  namesStore,
  normalise,
  shellVisible,
  shellWords,
  squeeze,
  unquote,
} from "./review-accept-command.ts";
import { trace, traceWarn } from "./trace.ts";
/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";
/** Shell expansion characters. A word carrying one is text whose final form the guard
 * cannot read (`$(…)`, `${V}`, backticks, escapes, and `{a,b}` / `{1..9}` brace
 * expansion), so no arm vouches for it: clause (a) refuses what it cannot parse, and a
 * protected name assembled by the shell is exactly that. Braces are expansion too —
 * `rev{iew-findings}.json` becomes a protected name the text never spells. Asked of the
 * RAW word, quotes included. */
const EXPANSION = /[$`\\{}]/;
/** A word carrying a substitution — `$` or a backtick. Braces are DELIBERATELY absent:
 * they are ordinary punctuation in prose and in `awk '{print 1}'`, and a store name
 * assembled from braces is caught by the brace-erased view of `namesStore`. A BACKSLASH
 * is absent for the same reason and by the same argument: `echo -e "a\nb"`, `printf
 * 'x\n'`, a `grep` BRE carrying `\|` and a `gh --jq` filter carrying `"\n"` are ordinary
 * agent text (#1665), and an ESCAPED spelling of the store's name is caught by the
 * backslash-erased view of `namesStore` instead — which is what an unreadable word could
 * otherwise hide. Asked of the RAW text, so the `$` inside a quoted message still counts. */
const EXPANSION_WORD = /[$`]/;
/** A git repo-location selector is NOT a scope trigger on sight (#1643): the case-folded
 * `-C` of `git -C <worktree> log` — the form AGENTS.md mandates for worktrees — is
 * indistinguishable from the config `-c`, and refusing every command carrying one bricked
 * the sanctioned worktree surface. What brings such a command into scope is a selector the
 * guard cannot CLEAR: one aimed at the git common dir (where the findings store lives),
 * one naming a protected file, a `key=value` config whose value the program runs, or one
 * whose value it cannot read. The arms ask the SAME predicate, so a command the selector
 * brought in is refused by the arms on that same selector. */
/** Redirection characters: an arm word carrying one moves bytes to or from a path the
 * arms never saw. */
const REDIRECT = /[<>]/;
/** The write-capable arguments clause (b) refuses and names (`-o`, `--output`, `-c`,
 * `--ext-diff`), in the ATTACHED spelling where the value is glued to the flag. The
 * spaced spelling is the arms' own `hasFlag` question; this one covers `-o<name>` /
 * `--output=<name>`, which is one word and invisible to an arm's `-o <name>` pair test.
 * `=`-attachment only: a value glued straight onto a flag letter (`-odata`) is not an
 * option in the tools that take these flags — `git show -odata` reads `data` as a path
 * operand — and reading it as a flag would brick `bun test --reporter junit …` (`-…er
 * junit`) and every short-flag command that mentions the store (`bun test … <store>`,
 * `bash verify-loop.sh … <store>`, `git commit -oreview-findings.json`). Clause (b)'s
 * "over-refuse a harmless read" is about a READ of the store, not about unrelated flags. */
const ATTACHED_WRITE = /(?:^|\s)(?:--output=\S|-o\S|--ext-diff=\S|-c\S)/;

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

/**
 * Clause (a), part (vi) is implemented in `review-accept-command.ts` as
 * `namesAttachedValue`, which strips the option prefix (`-G`, `-S`, `--grep=`, `-o`,
 * `--output=`) before asking the name and matches case-insensitively — the guard asks it
 * of its lowercased view, so `git log -GReview-Findings-Store` counts too.
 */

function scanCommand(command: string): string | undefined {
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
  const norm = normalise(command);
  const raw = kept;
  // An UNREADABLE command is the guard's business only when its text names the store
  // (#1665). A stray quote or an unterminated heredoc in a command that nowhere mentions
  // the findings store cannot reach the findings store, and the findings-store refusal is
  // the ONLY message this guard has — a store sentence on a command nowhere near the
  // store is what made five cycles unreadable to their own agents. The PARSE_FAIL is
  // still fatal for anything that DOES name the store: an odd quote or a heredoc whose
  // body never terminates is exactly how a name gets hidden behind text the guard cannot
  // read, and every odd-quote case in the case tables names the store.
  if (norm === "PARSE_FAIL")
    return namesStore(command, kept, isAcceptScriptToken)
      ? refusalReason({ dataOperand: true })
      : undefined;
  // The words as the shell hands them out (`--output=<path>` is ONE word here, which is
  // precisely what an arm's `-o <name>` pair test cannot see).
  const words = shellWords(raw);
  // Does the folded command name a protected file? Both remedy computations below ask
  // the same question, so it is asked ONCE here and reused rather than re-derived.
  const namesTheStore = namesProtected(norm);
  // THE SCOPE OF THE RULE (#1125). Clause (a) makes the allowlist authoritative for
  // commands THAT NAME THE STORE; it says nothing about the rest, and the arms refusing
  // them is the whole agent surface bricked (`mkdir -p tmp/x`, `git add -A`, `git push`,
  // `npm install`, `cargo test`, `python3 -c …` all spell no protected name). So the
  // name test runs FIRST and a command that names nothing protected is allowed before
  // the segment gates and before the arms — which is what the rule says and what the
  // must-stay-allowed list (`gh api`, `sed -n`, `awk` on non-protected paths) requires.
  // A PARSE_FAIL is still refused above: an unreadable command is refused whatever it
  // spells. The name test is asked of the raw text, the normalised text and the
  // quote/brace/comma-erased text, so an assembled or quoted-split name is in scope.
  // THE SCOPE OF CLAUSE (a) (#1125) — five tests decide whether the guard speaks to a
  // command at all. Anything else is an ORDINARY AGENT COMMAND and the allowlist does
  // not govern it: `mkdir -p tmp/x`, `git add -A`, `git push`, `npm install`,
  // `cargo test`, `python3 -c …`, `sed -n` / `awk` / `gh api` on a non-protected path
  // all pass, and neither the segment gates nor the arms are consulted. The arms
  // refusing those was the whole agent surface bricked.
  //
  //  (1) the name spelled as a word anywhere — raw, normalised, or with quotes / braces
  //      / commas erased, so `rev{iew-findings}.json` and `'rev''iew-findings.json'`
  //      count, and a heredoc body counts (the body is part of the raw text); the
  //      operator script's basename counts too, since running it is the act the whole
  //      guard exists to refuse;
  //  (2) the name ATTACHED to an option (`git log -G<name>`, `-S<name>`, `--grep=<name>`,
  //      `git show HEAD:x -o<name>`): the option prefix glues the name to the flag, so
  //      no tokeniser ever hands `isProtectedToken` the bare name and no arm's operand
  //      test sees the pair — asked of the raw text and of its lowercase view, since git
  //      reads such a value exactly as written;
  //  (3) a git repo-location / config selector the guard cannot CLEAR (#1643): `-C <path>`
  //      aimed at the git common dir or at a protected file, `--git-dir` / `--work-tree` /
  //      `--exec-path`, or a `-c key=value` whose value the program runs. `git -C <worktree>
  //      log` — AGENTS.md's sanctioned form — clears and brings nothing in. It is a GIT
  //      shape, so it asks only when git itself is the program — `python3 -c '…'` is
  //      Python's inline-code flag and nothing moves.
  //  (4) a heredoc marker beside a runtime word: the body is text the guard cannot read
  //      and the interpreter will execute it, so an unreadable body next to a runner is
  //      in scope whatever the body spells;
  //  (5) an UNREADABLE WORD carried by a command that can READ THE STORE — a runtime,
  //      git / a forge CLI, or one of the read tools the arms enumerate. A word with `$`
  //      or a backtick has no determinable final text, so on one of those programs the arms
  //      must get the chance to refuse it (`cat {payload.js} | bun -`). A BACKSLASH is not
  //      such a word (#1665): the shell removes it, and the backslash-erased view of
  //      `namesStore` catches an escaped spelling of the store's name. On a program that is
  //      none of those — `awk`, `echo` — a store name can never reach the guard's protected
  //      bytes, and clause (a) leaves the command alone: braces alone are ordinary
  //      punctuation (`echo {a,b}`, `awk '{print 1}'` pass), and a name assembled from them
  //      is caught by (1)'s erased view.
  //  (6) a WRITE-CAPABLE ARGUMENT on a VCS/forge command: `-o<name>` / `--output=<name>`
  //      / `--ext-diff=<name>` ATTACHED to the flag, and any SPACED flag the arms' own
  //      `hasFlag` recognises. Clause (b) refuses these whatever the target, because the
  //      flag is a route to WRITING the store (`git show HEAD:x --output=f`). Asked only
  //      of a command that runs git / gh / glab, so `bun test --reporter junit …` and
  //      `verify-loop.sh --digest-mode on …` — a test runner's flags, on a program that
  //      writes nothing — stay the ordinary agent commands they are. A value glued to a
  //      flag letter WITHOUT `=` is not a flag at all (`git show -odata` is the path
  //      `data`), which is what keeps `bun test … <store>` and `git commit -m x -o<name>`
  //      adjudicated by the arms rather than by a substring that matches any short flag.
  //
  // A PARSE_FAIL is refused above, before any of this: an unreadable command is refused
  // whatever it spells.
  const inScope =
    namesStore(raw, norm, isAcceptScriptToken) ||
    namesAttachedValue(norm) ||
    namesAttachedValue(raw) ||
    (namesGit(raw) && hasUnresolvedRepoSelector(words)) ||
    ((norm.includes("<<") || hasStdinDash(words)) && namesInterpreter(norm)) ||
    ((namesVcsOrRuntime(norm) || namesReadTool(norm)) && EXPANSION_WORD.test(raw)) ||
    (namesVcsOrRuntime(norm) &&
      (ATTACHED_WRITE.test(`${shellVisible(raw)} `) || hasFlag(words, ...OUTPUT_FLAGS)));
  // A PARSE_FAIL is refused above: an unreadable command is refused whatever it spells.
  if (!inScope) return undefined;

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
        return { block: true, reason: refusalReason() };
      const command = typeof raw === "string" ? raw : "";
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
