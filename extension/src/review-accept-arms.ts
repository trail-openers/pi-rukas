/**
 * review-accept-arms — the arms and the operand tests the deny-by-default accept guard
 * (`review-accept-guard.ts`) dispatches through (#1125). Split out so the guard keeps
 * one dispatch (`scanCommand`) while the command FORMS live here: each arm is a
 * predicate over the raw words of one shell segment, quotes kept, and each answers only
 * "does this segment match the form this arm spells". No arm decides a refusal, and no
 * arm adds a scanner — clause (c) of the adjudication rule permits exactly one of each,
 * both of which stay in the guard.
 *
 * The arms are exported for the guard's dispatch table only; nothing else composes them.
 */

import {
  baseName,
  isProtectedToken,
  tokensOf,
  unquote,
} from "./review-accept-command.ts";
/** A JS runtime: its invocation executes a program, so it is never a read tool. */
const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
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
export function hasFlag(words: string[], ...flags: string[]): boolean {
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
 * Does one operand of a git READ verb name the store? Each shape is ASKED, never
 * decided: a shape that does not apply must fall through to the plain basename test,
 * because returning early would hide a name the fast path otherwise catches. Refused by
 * POSITION, never by substring, so an ordinary path stays an ordinary path:
 *
 *  - after a path-limiting `--`, every word IS a path: one whose basename is the store
 *    (`git log -- review-findings.json`) has no arm;
 *  - a `-S<pattern>` / `--grep=<text>` value is a NAME rather than a directory, so a
 *    store stem on its last segment refuses the segment (`git log -S<store>`);
 *  - the path half of a `REV:<path>` argument comes out of the object database, so the
 *    same rule applies there (`git show HEAD:<store>`);
 *  - and whatever is left is asked as a name outright: a word that IS the store, quoted
 *    or not, has no arm (`git log review-findings.json`).
 *
 * A path operand BEFORE `--` that merely LIVES in the store's directory is not refused:
 * `git log --oneline -- extension/src/review-findings-store.ts` names the store module's
 * SOURCE, and reading that is the read the allowlist documents.
 */
function namesStoreOperand(a: string, index: number, all: string[]): boolean {
  // The path-limiting `--` is the WHOLE word: `--oneline` and `--no-pager` contain the
  // two characters and are not separators, so a substring test would send every later
  // operand down the path branch and blind the ones below.
  const dashdash = all.indexOf("--");
  if (dashdash >= 0 && index > dashdash) return isProtectedToken(a);
  // The segments reach the arms LOWERCASED (`armsOf(raw)` where `raw` is the folded
  // command), so the two case-carrying spellings are matched case-insensitively — a
  // `/^-S/` test silently never fires on `-s<store>`, which is the form the scan sees.
  if (/^-s/i.test(a) && isProtectedToken(baseName(a.slice(2)))) return true;
  if (/^--grep=/i.test(a) && isProtectedToken(baseName(a.slice(7)))) return true;
  const colon = a.indexOf(":");
  if (colon > 0 && isProtectedToken(baseName(a.slice(colon + 1)))) return true;
  return isProtectedToken(a);
}

/**
 * A1: `git (--no-pager )?status|log|diff|show|blame`, pure read, no write flag.
 * The verb is matched WITHOUT stepping over quotes — `'status'` is text handed to git,
 * not the verb this arm vouches for.
 */
export function armGitRead(w: string[]): boolean {
  const head = ["", "git", "--no-pager"];
  let i = 0;
  while (i < w.length && head.includes(unquote(w[i] ?? ""))) i++;
  const verb = w[i];
  if (i === 0 || verb === undefined || !GIT_READ_VERBS.includes(verb)) return false;
  const rest = w.slice(i);
  if (hasFlag(rest, ...WRITE_FLAGS) || tokensOf(rest.join(" ")).includes("alias")) return false;
  return !rest.map(unquote).some(namesStoreOperand);
}

/** A2/A3: the exact gh / glab read subcommands, with the same flag ban. */
export function armForgeRead(w: string[]): boolean {
  const words = w.map(unquote);
  if (words[0] === "git") words.shift();
  if (words[0] === "--no-pager") words.shift();
  const shape: Array<[string, string[], string[]]> = [
    ["gh", ["pr"], ["view", "diff", "list", "checks"]],
    ["gh", ["repo"], ["view"]],
    ["gh", ["issue"], ["view", "list"]],
    ["glab", ["mr"], ["view", "diff"]],
  ];
  // `gh api` is deliberately NOT an arm: it carries an arbitrary method (`-X DELETE`,
  // `--method=POST`) and an arbitrary body, so no flag ban turns it into a read.
  const ok = shape.some(
    ([tool, area, verbs]) =>
      words[0] === tool && area.includes(words[1] ?? "") && verbs.includes(words[2] ?? ""),
  );
  if (!ok) return false;
  return !hasFlag(w, ...WRITE_FLAGS) && !tokensOf(w.join(" ")).includes("alias");
}

/** A4: `(bun|bunx) test <flags-without-values | test paths>` — no eval flag. */
export function armTest(w: string[]): boolean {
  if (!RUNTIME.test(unquote(w[0] ?? "")) || w[1] !== "test") return false;
  return testArgv(w.slice(2));
}

/**
 * A5: `bash …/verify-loop.sh <test paths>`, the same argv rule plus `--digest`.
 * The script name and every argument are matched WITHOUT stepping over quotes: the
 * arm is the literal `bash <path-to-verify-loop.sh> <suites>`, so a quoted word —
 * which the shell hands to the script as an argument — is not the name it requires.
 */
export function armVerifyLoop(w: string[]): boolean {
  if (w[0] !== "bash") return false;
  if (!/(^|\/)verify-loop\.sh$/.test(w[1] ?? "")) return false;
  return w.slice(2).every((a) => a === "--digest" || testArgv([a]));
}

/** A6: the exact build and type-check forms, spelled precisely. */
export function armBuild(w: string[]): boolean {
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
export function armCommit(w: string[]): boolean {
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
  // The quoted message is prose and stays admissible; every OTHER word the shell hands
  // to `commit` — a pathspec, or a flag spelled with an expansion — is asked of the
  // store, which is what the quote-erased normalised view cannot see.
  const excused = new Set([message, message + 1]);
  return !rest.some((a, n) => !excused.has(n) && isProtectedToken(a));
}

/** A8: a read tool whose arguments name nothing protected, with no write flag. */
export function armRead(w: string[]): boolean {
  const head = w[0] ?? "";
  if (!READ_TOOLS.has(head)) return false;
  if (head === "sed" && w[1] !== "-n") return false;
  if (hasFlag(w.map(unquote), ...WRITE_FLAGS, ...EVAL_FLAGS)) return false;
  // Asked on the raw word, quotes INCLUDED: `cat "review-findings.json"` is refused like
  // the bare spelling, because the shell hands the name to `cat` either way.
  return !w.slice(1).some(isProtectedToken);
}
