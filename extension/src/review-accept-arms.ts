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
  PROTECTED_STEMS,
  baseName,
  isProtectedToken,
  tokensOf,
  unquote,
} from "./review-accept-command.ts";
/** A JS runtime: its invocation executes a program, so it is never a read tool.
 * Exported because the guard's pre-checks ask the same question of the whole command. */
export const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
/** The write-capable arguments clause (b) refuses and names. Exported for the guard's
 * remedy sentence, which names the same flags. */
export const WRITE_FLAGS = ["-o", "--output", "-c", "--ext-diff"];
/** A runner that executes text rather than a file: no arm admits one. */
const EVAL_FLAGS = ["-e", "-p", "--print", "--eval", "-r", "--require", "--preload"];
/** git's repo-location selectors. Each one MOVES the repository the read runs against
 * (`.git` elsewhere, a work-tree elsewhere, a `PATH`-shadowed `git-shell` via
 * `--exec-path`), so the "plain git read" premise the git arms vouch for is about some
 * tree the arms never saw. Refused by whole word and `=`-attached, either spelling — the
 * segments reach the arms LOWERCASED, so `-C` arrives as `-c` and `--GIT-DIR=/x` as
 * `--git-dir=/x`. */
const REPO_LOCATION_FLAGS = ["-c", "--git-dir", "--work-tree", "--exec-path"];
/** The same selectors as a regex, for an arm that matches words it has ALREADY folded
 * (`armForgeRead` maps `unquote` over the segment before matching the subcommand, so
 * `hasFlag` would be looking at the quote characters rather than the flag). */
const REPO_LOCATION_FLAG = /^(-c|--git-dir|--work-tree|--exec-path)(?:=|\s|$)/;
/** Flags that hand the tool a PROGRAM to run on each input. `rg --pre=CMD` pipes every
 * matched file through CMD, GNU `find -exec` runs a command per hit, and a
 * `--command`/`--exec` spelling is a program argument on any tool that has one. Each is
 * refused by whole word and `=`-attached; the `sed`/`awk` that used to sit in READ_TOOLS
 * are gone entirely rather than flagged, since their EXECUTE verb (`-e id` for sed, the
 * `system()` builtin for awk) is a flag no list would name completely. */
const EXEC_FLAGS = ["--pre", "--pre-glob", "--exec", "-exec", "--command"];
/** The verbs arm A1 admits: reads that print to stdout and take no output argument. */
const GIT_READ_VERBS = ["status", "log", "diff", "show", "blame"];
/** Read tools arm A8 admits, each for arguments naming nothing protected. `bash` is
 * deliberately absent: it EXECUTES its operand, so it appears only in arm A5, which
 * judges every argument. A read arm that admitted `bash` would admit any script — and
 * `sed` and `awk` went the same way in the #1125 fix round, for the same reason: a tool
 * that can run a shell (`awk BEGIN{system("id")}`, GNU `sed -n '1e id'`) or write a file
 * (`sed -n 'w /tmp/x'`) is not a read, whatever its flags are checked for. */
export const READ_TOOLS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
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
  // The segments reach the arms LOWERCASED (`armsOf(raw)` where `raw` is the folded
  // command), so the two case-carrying spellings are matched case-insensitively — a
  // `/^-S/` test silently never fires on `-s<store>`, which is the form the scan sees.
  // The option values are asked BEFORE the path-limiting `--` branch: `-S`/`-G`/`--grep`
  // carry a NAME the tool matches, not a path, so `git log --oneline -- -G<store>` is a
  // search term and not a file. `-G` is the OTHER regex picker: `--pickaxe-regex` makes
  // `-S` one too, and `-G` matches the DIFF.
  if (/^-s/i.test(a) && isProtectedToken(baseName(a.slice(2)))) return true;
  if (/^-g/i.test(a) && isProtectedToken(baseName(a.slice(2)))) return true;
  if (/^--grep=/i.test(a) && isProtectedToken(baseName(a.slice(7)))) return true;
  if (dashdash >= 0 && index > dashdash) return isProtectedToken(a);
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
  // Asked of every word of the arm, INCLUDING the verb position: `git -C /repo/.git log`
  // puts the selector before the verb, where `rest` cannot see it.
  if (hasFlag(w, ...REPO_LOCATION_FLAGS)) return false;
  if (hasFlag(rest, ...WRITE_FLAGS) || tokensOf(rest.join(" ")).includes("alias")) return false;
  // EMPTY words are asked LAST, after the operand tests: an empty word separates nothing,
  // so a name the operand loop below already caught is reported for the NAME rather than
  // for the empty word. The shell glues `''` to its neighbour (`''f` is ONE word), so the
  // quote characters shift the `slice()` offsets and a protected name hides from every
  // test above — which is exactly why an empty word has no arm here. Asked of the WHOLE
  // arm (`w`, not `rest`): the empty word may sit before the verb, where `rest` cannot
  // reach it. A word is never empty by accident, so refusing one is clause (b)'s accepted
  // cost, not a lost read.
  if (w.some((x) => unquote(x).trim() === "")) return false;
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
  const folded = w.map(unquote);
  if (folded.some((a) => REPO_LOCATION_FLAG.test(a))) return false;
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
 * A7: `git commit -m "<prose>"`, judged on the words with their quotes intact, with
 * `git` and then `commit` at words 0 and 1 — a prefix word (`sudo git commit …`) puts a
 * program the arms never named in front of the commit. The message flag must be UNQUOTED
 * and the message itself QUOTED: `commit "-m" "m <store>"` excuses only the word after
 * the flag the arm actually spells, so a quoted `-m` is a pathspec and the prose excuse
 * never opens. A protected word standing outside the real message is a path operand.
 * No `-F/--file` may name a file, and neither may a template or a cleanup selector: each
 * one names a PATH the commit reads (`--template=<store>`, `-t <store>`), so the arm
 * refuses them outright rather than guess which of its arguments is a file.
 */
export function armCommit(w: string[]): boolean {
  if (unquote(w[0] ?? "") !== "git" || unquote(w[1] ?? "") !== "commit") return false;
  const words = w.map(unquote);
  const rest = w.slice(2);
  // `-t` is `--template` (a file whose contents become the message) and `--cleanup` names
  // a file too on some spellings; with or without `=value`, an operand of this shape is a
  // path the commit opens, which no arm vouches for.
  if (hasFlag(rest.map(unquote), "-f", "--file", "-F", "-t", "--template", "--cleanup"))
    return false;
  // The same ban every git read arm carries: `-c` sets a config (a hook or an alias the
  // commit then runs) and the repo-location flags move the repository being committed to.
  if (hasFlag(rest.map(unquote), ...WRITE_FLAGS, ...REPO_LOCATION_FLAGS)) return false;
  const message = rest.findIndex(
    (a, n) =>
      // The flag spelled WITHOUT quotes (a quoted `"-m"` is an operand, not the flag) and
      // the following word QUOTED (a bare word beside `-m` is an operand, not a message).
      (a === "-m" || a === "--message") &&
      !/["']/.test(rest[n] ?? "") &&
      /["']/.test(rest[n + 1] ?? ""),
  );
  if (message < 0) return false;
  // The quoted message is prose and stays admissible; every OTHER word the shell hands
  // to `commit` — a pathspec, or a flag spelled with an expansion — is asked of the
  // store, which is what the quote-erased normalised view cannot see.
  const excused = new Set([message, message + 1]);
  return !rest.some((a, n) => !excused.has(n) && isProtectedToken(a));
}

/**
 * A8: a read tool whose arguments name nothing protected, with no write flag and no
 * exec-capable flag. The tool is matched at word 0 — `sudo cat <store>` and
 * `time cat <store>` put a program the arms never named in front of the read, so the
 * arm refuses rather than guess what the prefix does.
 */
export function armRead(w: string[]): boolean {
  const head = w[0] ?? "";
  if (!READ_TOOLS.has(head)) return false;
  const args = w.slice(1);
  if (hasFlag(args.map(unquote), ...WRITE_FLAGS, ...EVAL_FLAGS, ...EXEC_FLAGS)) return false;
  // A store name standing inside a quoted argument is still a NAME the tool receives
  // (`grep pat "x<store>"` hides it in a pattern, `cat "<store>"` in a path), so a quoted
  // word is asked too — and the word is cut at its QUOTE CHARACTERS first, so a name the
  // quotes delimit reads as a word of its own. A name merely EMBEDDED in a longer word
  // (`echo "it's a normal message about <store>"`) is prose and stays admitted.
  return !args.some(isProtectedToken);
}
