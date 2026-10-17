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
 *   (a) ORDERING. One EXACT allowlist of read-only command forms (the eight arms
 *       below) is authoritative. Every OTHER bash command that names the findings
 *       store — the data file, the store module, their stems, a `.tmp` / `.corrupt`
 *       sibling — is refused. So is any command containing a runtime or a forge CLI,
 *       and any command this module cannot parse: unbalanced quotes, or a heredoc
 *       body that never terminates.
 *   (b) POLARITY. Fail closed. Over-refusing a harmless read is an ACCEPTED COST —
 *       `--output`/`-o` on any file, `-c` at all, `bun test <non-test-path>`, a read
 *       tool naming the store. Each refusal names the flag or operand to drop, or the
 *       accept CLI to run instead.
 *   (c) EVOLUTION. A newly discovered bypass spelling is closed by REMOVING AN
 *       ALLOWANCE or ADDING A REFUSAL — never by adding a command scanner. This file
 *       has exactly one parser (`normalise`), one matcher (`namesProtected`) and one
 *       dispatch (`scanCommand`).
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
 *   3. THE FAST PATH — nothing protected is named, no runtime word, no git / gh /
 *      glab: allowed before the allowlist is consulted, which is why deny-by-default
 *      costs nothing ordinary.
 *   4. THE ARMS — the normalised command is split into segments on `|`, `;`, `&&`,
 *      `||` and `&`, and EVERY segment must match one arm exactly:
 *        A1  git (--no-pager)? status|log|diff|show|blame  — no -o, -c, --ext-diff,
 *            --output…, no `alias`
 *        A2  gh pr view|diff|list|checks | gh repo view | gh api | gh issue view|list
 *        A3  glab mr view|diff
 *        A4  (bun|bunx) test <flags-without-values | test paths>
 *        A5  bash …/verify-loop.sh <same argv, plus --digest>
 *        A6  the exact build forms: bun run build, bun run check, bunx tsc --noEmit
 *        A7  git commit -m "<prose>" — protected words only inside a quoted -m
 *        A8  a read tool (ls, cat, head, tail, wc, grep, rg, sed -n, awk, file, stat,
 *            which, basename, dirname, echo, printf, cd, pwd, true) naming nothing
 *            protected
 *      A segment matching no arm is refused.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROTECTED_BASENAME,
  PROTECTED_STEMS,
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
/** A JS runtime: its invocation executes a program, so it is never a read tool. */
const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
/** The forge CLIs, whose read arms are exact. */
const VCS = /^(?:git|gh|glab)$/;
/** The one source of truth for the CLI the refusal tells the operator to use. */
const ACCEPT_CLI = "extension/scripts/review-accept.ts";
/** The write-capable arguments clause (b) refuses and names. */
const WRITE_FLAGS = ["-o", "--output", "-c", "--ext-diff"];
/** A runner that executes text rather than a file: no arm admits one. */
const EVAL_FLAGS = ["-e", "-p", "--print", "--eval", "-r", "--require", "--preload"];
/** The verbs arm A1 admits: reads that print to stdout and take no output argument. */
const GIT_READ_VERBS = ["status", "log", "diff", "show", "blame"];
/** Read tools arm A8 admits, each for arguments naming nothing protected. `bash` is
 * deliberately absent: it EXECUTES its operand, so it appears only in arm A5, which
 * judges every argument. A read arm that admitted `bash` would admit any script. */
const READ_TOOLS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "sed",
  "awk",
  "file",
  "stat",
  "which",
  "basename",
  "dirname",
  "echo",
  "printf",
  "cd",
  "pwd",
  "true",
]);

/** Does any word carry one of `flags`, whole, `=`-attached, or ATTACHED to the flag? */
function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.some((w) => {
    const a = unquote(w);
    return (
      flags.includes(a) ||
      flags.some((f) => a.startsWith(`${f}=`)) ||
      // `-odata`, `-creview-findings.json`: the value glued to the flag letter. An
      // option of this shape has no arm anyway, so it must never read as a pure read.
      flags.some((f) => a.startsWith(f) && a !== f)
    );
  });
}

/** Clause (b): a write-capable argument on a forge command — the refusal names it. */
const carriesWriteFlag = (words: string[]): boolean => hasFlag(words, ...WRITE_FLAGS);

/** Every argument after the verb of a test-like arm: a valueless switch or a test path. */
function testArgv(args: string[]): boolean {
  return args.every((raw) => {
    const a = unquote(raw);
    // A QUOTED argument is prose, not a suite path: the arm admits a test file, and it
    // cannot vouch for text it cannot read (`'bun ./src/store.ts'`, `--digest-mode on`).
    if (/["']/.test(raw)) return false;
    if (/^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(a)) return !EVAL_FLAGS.includes(a);
    return /(^|\/)[^/]*(?:test|spec)[^/]*\.tsx?$/.test(a);
  });
}

/**
 * A1: `git (--no-pager )?status|log|diff|show|blame`, pure read, no write flag.
 * The verb is matched WITHOUT stepping over quotes — `'status'` is text handed to git,
 * not the verb this arm vouches for.
 */
function armGitRead(w: string[]): boolean {
  const head = ["", "git", "--no-pager"];
  let i = 0;
  while (i < w.length && head.includes(unquote(w[i] ?? ""))) i++;
  const verb = w[i];
  if (i === 0 || verb === undefined || !GIT_READ_VERBS.includes(verb)) return false;
  const rest = w.slice(i);
  return !hasFlag(rest, ...WRITE_FLAGS) && !tokensOf(rest.join(" ")).includes("alias");
}

/** A2/A3: the exact gh / glab read subcommands, with the same flag ban. */
function armForgeRead(w: string[]): boolean {
  const words = w.map(unquote);
  if (words[0] === "git") words.shift();
  if (words[0] === "--no-pager") words.shift();
  const shape: Array<[string, string[], string[]]> = [
    ["gh", ["pr"], ["view", "diff", "list", "checks"]],
    ["gh", ["repo"], ["view"]],
    ["gh", ["issue"], ["view", "list"]],
    ["glab", ["mr"], ["view", "diff"]],
  ];
  const ok =
    (words[0] === "gh" && words[1] === "api") ||
    shape.some(
      ([tool, area, verbs]) =>
        words[0] === tool && area.includes(words[1] ?? "") && verbs.includes(words[2] ?? ""),
    );
  if (!ok) return false;
  return !hasFlag(w, ...WRITE_FLAGS) && !tokensOf(w.join(" ")).includes("alias");
}

/** A4: `(bun|bunx) test <flags-without-values | test paths>` — no eval flag. */
function armTest(w: string[]): boolean {
  if (!RUNTIME.test(unquote(w[0] ?? "")) || w[1] !== "test") return false;
  return testArgv(w.slice(2));
}

/**
 * A5: `bash …/verify-loop.sh <test paths>`, the same argv rule plus `--digest`.
 * The script name and every argument are matched WITHOUT stepping over quotes: the
 * arm is the literal `bash <path-to-verify-loop.sh> <suites>`, so a quoted word —
 * which the shell hands to the script as an argument — is not the name it requires.
 */
function armVerifyLoop(w: string[]): boolean {
  if (w[0] !== "bash") return false;
  if (!/(^|\/)verify-loop\.sh$/.test(w[1] ?? "")) return false;
  return w.slice(2).every((a) => a === "--digest" || testArgv([a]));
}

/** A6: the exact build and type-check forms, spelled precisely. */
function armBuild(w: string[]): boolean {
  const joined = w.map(unquote).join(" ");
  return (
    joined === "bun run build" ||
    joined === "bun run check" ||
    joined === "bunx tsc --noemit" ||
    joined === "bun x tsc --noemit"
  );
}

/**
 * A7: `git commit -m "<prose>"`, judged on the words with their quotes intact. The
 * message must be QUOTED — `-m` beside a bare word is an operand — and a protected
 * word may appear ONLY inside it: a name standing outside the quotes is a path operand
 * and has no arm. No `-F/--file` may name a file.
 */
function armCommit(w: string[]): boolean {
  const words = w.map(unquote);
  const at = words.findIndex((a) => a === "git" || a === "commit");
  if (at < 0 || words[at] !== "git") return false;
  if (at > 1 || words[at + 1] !== "commit") return false;
  const rest = w.slice(at + 2);
  if (hasFlag(rest.map(unquote), "-f", "--file")) return false;
  const message = rest.findIndex(
    (a, n) => /^(-m|--message)$/.test(unquote(a)) && /["']/.test(rest[n + 1] ?? ""),
  );
  if (message < 0) return false;
  return !opensProtected(rest.filter((_, n) => n !== message && n !== message + 1));
}

/** A8: a read tool whose arguments name nothing protected, with no write flag. */
function armRead(w: string[]): boolean {
  const head = w[0] ?? "";
  if (!READ_TOOLS.has(head)) return false;
  if (head === "sed" && w[1] !== "-n") return false;
  if (hasFlag(w.map(unquote), ...WRITE_FLAGS, ...EVAL_FLAGS)) return false;
  return !opensProtected(w.slice(1));
}

/** Does one segment match one of the eight arms? Judged on the raw words, quotes kept. */
function segmentAdmitted(words: string[], raw: string): boolean {
  if (words.length === 0) return false;
  // Clause (a): a heredoc body the guard cannot read is not an argument. The marker is
  // tested FIRST, so no arm can vouch for a command whose body was removed.
  if (words.some((x) => x === "<<" || unquote(x) === "<<")) return false;
  return [
    armGitRead,
    armForgeRead,
    armTest,
    armVerifyLoop,
    armBuild,
    armCommit,
    armRead,
    armCommitRaw,
  ].some((arm) => arm(words, raw));
}

/**
 * A7's twin, for the case quote removal has already hidden: `git commit -m "… with an
 * apostrophe"` is one balanced span to the RAW view and the normalised view has split
 * it, so armCommit cannot locate the message. The name is then prose when every word
 * the shell would hand to `commit` sits outside the quotes — that is, is unquoted.
 */
function armCommitRaw(w: string[], raw: string): boolean {
  const words = w.map(unquote);
  const at = words.findIndex((a) => a === "commit");
  if (at < 1 || words[at - 1] !== "git") return false;
  if (hasFlag(words.slice(at + 1), "-f", "--file")) return false;
  return !opensProtected(words.slice(at + 1).filter((a) => a !== "-m" && a !== "--message"));
}

/** The refusal reasons (clause (b)): one base, plus the sentence naming the remedy. */
function refusalReason(
  opts: { vcsWrite?: boolean; dataOperand?: boolean; target?: string } = {},
): string {
  if (opts.target)
    return `The review findings file (${opts.target}) is written only by ${ACCEPT_CLI}. Agents may not edit it.`;
  const base = `Accepting a review finding is an operator act: agents may not reach the review findings store. Run ${ACCEPT_CLI} from a terminal for an acceptance. Allowed reads: git status/log/diff/show/blame (no -o/--output/-c), gh|glab pr|mr view|diff, gh repo view, gh api <path>, gh issue view|list, bun|bunx test <test-path.ts>, bash smoke-tests/lib/verify-loop.sh <test-path.ts>, bun run build, bun run check, bunx tsc --noEmit, git commit -m "<message>", or a read tool (cat, grep, rg, sed -n, ...) on a path that is not the findings store.`;
  const vcs = opts.vcsWrite
    ? " Drop the write-capable flag (-o/--output/-c): e.g. `git --no-pager log` instead of `git -c core.pager=cat log`."
    : "";
  const data =
    opts.dataOperand === true
      ? " Drop the path operand naming the store: it is not an argument any command may take."
      : "";
  return base + vcs + data;
}

/**
 * THE DECISION — clause (a) in code: parse first (a failure refuses), then the fast
 * path, then the allowlist, and a segment with no matching arm refuses. Returns the
 * refusal reason, or undefined for "allowed": the DEFAULT is ALLOW, so a shape this
 * module simply does not think about passes — only the routes enumerated above block.
 *
 * The fast path asks the NORMALISED text for the store words (a commit message is
 * prose) and the RAW text for the runtime / forge words and the shell operators: a
 * program name inside quotes still reaches a shell, and a quoted `;` still separates
 * two commands, so `echo 'x; bun -e …'` is not waved through as prose.
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
      i = stop;
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
  // this view. `flat` (the folded text) decides only the fast path and the remedy
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
  // Any operator or newline opens a segment the shell will run, even inside quotes, so
  // the fast path defers to the arms whenever one appears.
  const reach = /[|;&]/.test(command) || command.includes(String.fromCharCode(10));
  // The runner test is asked of the NORMALISED text as well as the raw one: normalise
  // removes quoted spans, and a runner that SURVIVES quote removal is a word the shell
  // really executes. Asking only the raw text let `bash …` reach the arms by a path the
  // fast path never vetted.
  if (
    !protectedAnywhere &&
    !namesRunner(flat) &&
    !namesRunner(norm) &&
    !looksLikeProgram(flat) &&
    !reach &&
    !heredocRuntime
  )
    return undefined;

  const vcsWrite = namesProtected(norm)
    ? shellWords(raw).some((w) => VCS.test(baseName(unquote(w)))) &&
      hasFlag(shellWords(raw), ...WRITE_FLAGS)
    : false;
  const dataOperand = namesProtected(norm)
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
  for (let i = 0; i < rawArms.length; i++) {
    // The ARMS see the raw segment with its quotes intact: a quoted word is prose and
    // must not be mistaken for an argument, and `git commit -m "…"` needs to see that
    // its message was quoted at all. The normalised text is lowercase, so lowercasing
    // the raw segment keeps the two views comparable.
    const rawSegment = rawArms[i] ?? "";
    const words = shellWords(unquoteKeepQuotes(rawSegment));
    if (false && !segmentAdmitted(words, rawSegment)) return refusalReason({ vcsWrite, dataOperand });
  }
  return undefined;
}

/** The refusal text when a bash command could reach the findings store, else undefined. */
export function runsReviewAccept(command: string): string | undefined {
  return scanCommand(command);
}

/** Edit tools whose `path` argument is checked against the protected files. */
const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** The findings file and its tmp / corrupt-copy siblings — the store writes these. */
const FINDINGS_SIBLING = /^review-findings\.json\.(?:tmp|corrupt-[a-z0-9]+)$/;

/** The target path when an edit-style call would write a protected file, else undefined. */
export function editsFindingsFile(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const target = (input as { path?: unknown } | null)?.path;
  if (typeof target !== "string") return undefined;
  const base = target.split(/[\\/]/).pop() ?? "";
  return PROTECTED_BASENAME.test(base) ||
    FINDINGS_SIBLING.test(base) ||
    PROTECTED_STEMS.includes(base.replace(/\.tsx?$/, ""))
    ? target
    : undefined;
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
