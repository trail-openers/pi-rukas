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
  UNREADABLE,
  baseName,
  isAcceptScriptToken,
  isProtectedToken,
  shellWords,
  tokensOf,
  unquote,
} from "./review-accept-command.ts";
/** A JS runtime: its invocation executes a program, so it is never a read tool.
 * Exported because the guard's pre-checks ask the same question of the whole command. */
export const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
/** The write-capable arguments clause (b) refuses and names. Exported for the guard's
 * remedy sentence, which names the same flags. */
export const WRITE_FLAGS: readonly string[] = ["-o", "--output", "-c", "--ext-diff"];
/** The write-capable arguments EXCEPT the git config selector `-c`, DERIVED from
 * `WRITE_FLAGS` so the two lists cannot drift when a fifth flag is added: `-c` is not a
 * write flag in the same sense as an output path — it sets a config, and the thing that
 * makes it a route to the store is the value it sets (`core.fsmonitor=…`,
 * `alias.x=!cat <store>`), which is exactly what `hasUnresolvedRepoSelector` reads.
 * Asking `OUTPUT_FLAGS` where a `-C <path>` may appear keeps the #1643 sanctioned form
 * from matching a write flag on a case-folded `-C`. */
export const OUTPUT_FLAGS: readonly string[] = WRITE_FLAGS.filter((flag) => flag !== "-c");
/** A runner that executes text rather than a file: no arm admits one. */
const EVAL_FLAGS = ["-e", "-p", "--print", "--eval", "-r", "--require", "--preload"];
/** The forge CLIs, whose read arms are exact. Exported because the guard's remedy sentence
 * asks whether the command runs one of them. */
export const VCS = /^(?:git|gh|glab)$/;

// ── WHO RUNS THE COMMAND ──────────────────────────────────────────────────────────
//
// The scope tests in `review-accept-guard.ts` ask these of the whole command before any
// arm is consulted: clause (a) leaves a program that cannot reach the store's bytes
// alone, so deciding WHICH program a command runs is the gate in front of the allowlist.
// They sit beside `RUNTIME` and `READ_TOOLS` — the sets they test against — so the two
// cannot drift.

/** Does the command run GIT? A repo-location selector only matters for git — the same
 * `-c` on `python3` is its inline-code flag and moves no repository. */
export function namesGit(text: string): boolean {
  return shellWords(text).some((w) => baseName(unquote(w)) === "git");
}
/** Does the command run git, a forge CLI, or a JS runtime? The write-flag scope test
 * asks this: `-o` / `--output` are flags those programs honour as routes to writing a
 * file, while a test runner's `--reporter junit` is nobody's write route. */
export function namesVcsOrRuntime(text: string): boolean {
  return shellWords(text).some((w) => {
    const t = baseName(unquote(w));
    return RUNTIME.test(t) || VCS.test(t);
  });
}
/** Is any word an INTERPRETER — a program that EXECUTES the text it is handed? This, not
 * `namesVcsOrRuntime`, is the trigger for an unreadable heredoc body or a `-` program on
 * stdin: `bun <<EOF` runs its body, while `git commit -F- <<EOF` only READS it as a commit
 * message (#1643: refusing the heredoc commit message forced multi-`-m` commits and lost
 * byte-identical message verification). A git verb that executes its operand is not a risk
 * this rule closes — `git apply <<EOF` reaches the store only by NAMING a file in the
 * patch, and the name test in the guard is what catches that. */
export function namesInterpreter(text: string): boolean {
  return shellWords(text).some((w) => RUNTIME.test(baseName(unquote(w))));
}
/** The git verbs that PUT BYTES ON DISK from an operand the guard cannot read: a patch
 * (`apply`), a mailbox (`am`), an index update, a rename / deletion, or a checkout, each of
 * which takes its instructions from stdin or a heredoc. Beside one of these a heredoc body
 * or a `-` program is text the guard cannot see AND a program that writes, so the command is
 * in scope whatever the body spells (`git apply <<EOF` reaches the store by NAMING a path
 * inside the patch). `commit` is deliberately absent — its heredoc is a MESSAGE, read as
 * text and written nowhere, which is why `git commit -F- <<EOF` stays allowed (#1643) — and
 * `hash-object` writes only with `-w`, so it is asked for that flag too. */
const GIT_WRITE_VERBS = ["apply", "am", "update-index", "mv", "rm", "checkout-index"];
export function namesGitWriteVerb(text: string): boolean {
  const words = shellWords(text).map((w) => baseName(unquote(w)));
  if (words.includes("hash-object")) return words.includes("-w");
  return words.some((w) => GIT_WRITE_VERBS.includes(w));
}
/** Does the command run one of the READ TOOLS the arms admit (`cat`, `grep`, `rg`,
 * `head`, `wc`, …)? Together with `namesVcsOrRuntime` this is the set of programs through
 * which a store name can reach the guarded bytes at all: the scope test asks the
 * unreadable-word question of them, and of nobody else — `awk 'BEGIN{system("id")}'` runs
 * no store-capable program the guard recognises, and clause (a) leaves it alone. */
export function namesReadTool(text: string): boolean {
  return shellWords(text).some((w) => READ_TOOLS.has(baseName(unquote(w))));
}
/** Does some word of the ORIGINAL command (quotes intact) read as `-`? A runtime with a
 * bare `-` takes its PROGRAM from stdin, and a program the guard cannot read is the
 * store's worst unreadable half — which is why `cat payload.js | bun -` is in scope
 * however ordinary each half looks on its own. Asked of the raw words so a quoted "-"
 * still counts: the shell hands that word to the runtime as `-` all the same. */
export function hasStdinDash(rawWords: string[]): boolean {
  return rawWords.some((w) => unquote(w) === "-");
}
/** git's repo-location / config selectors that are NEVER cleared by their target:
 * `--git-dir` and `--work-tree` move the object store or the work tree the read runs
 * against, and `--exec-path` can shadow `git-shell` with a program of the caller's
 * choosing. Refused by whole word and `=`-attached, either case. */
const NEVER_CLEARED_SELECTOR = /^--(?:git-dir|work-tree|exec-path)(?:=|$)/i;
/** The same selectors as a regex, for the FORGE read arm, which resolves nothing: `gh` and
 * `glab` have no `-C <path>` form to resolve, so a forge read carrying any of them is
 * refused outright (`armForgeRead` maps `unquote` over the segment before matching the
 * subcommand, so `hasFlag` would be looking at the quote characters rather than the
 * flag). */
const REPO_LOCATION_FLAG = /^(-c|--git-dir|--work-tree|--exec-path)(?:=|\s|$)/;
/** `-C <path>` / `-c key=value`, the two selectors whose MEANING is in their value. The
 * arms receive the segment LOWERCASED, so an uppercase `-C <path>` is the word `-c
 * <path>` here; a lowercase `-c` is therefore indistinguishable from it, and that is
 * sound: git accepts `-c` only as `-c key=value`, so a value carrying no `=` cannot be a
 * config assignment and can only be the path form (#1643). */
const VALUE_SELECTOR = /^-c(.*)$/i;
/** A value that is a config assignment rather than a path (`-c core.pager=cat`): the `=`
 * is what makes it a hook / pager / alias the program then RUNS, which no target test can
 * clear. */
const CONFIG_VALUE = /=/;
/** A `-C` / `--git-dir` target carrying one of these is a path the guard cannot name: the
 * shell expands it onto whatever it matches, so the resolved path is unknown and the pair
 * cannot be cleared. The bracket class is included with `*` and `?` because `[.g]*` is a
 * glob too. Asked separately from `UNREADABLE` because `{}` is not a glob in the shells
 * this guard cares about but IS a substitution the other test already refuses. */
const GLOBISH = /[*?[]/;
/** Does a `-C` target reach the findings store's repo location? The store's data file and
 * its siblings live IN the git common dir, so a target that IS or CONTAINS `.git`, or that
 * carries a protected / accept-script segment, is the store's location and stays refused.
 * An empty or expansion-bearing target is refused too — a path the guard cannot resolve is
 * a path it cannot clear. So is a glob, a `~` or a `..` segment: this selector is MATCHED,
 * not resolved (a symlink or a glob onto `.git` is not caught), so anything that makes the
 * text stand for a different path than the one being read keeps the selector refused. */
function targetReachesStore(target: string | undefined): boolean {
  if (target === undefined) return true;
  const value = unquote(target).replace(/^['"]+|['"]+$/g, "");
  if (value === "" || UNREADABLE.test(value) || GLOBISH.test(value) || value.includes("~"))
    return true;
  return value
    .split(/[\\/]/)
    .some(
      (segment) =>
        segment === ".git" ||
        segment === ".." ||
        isProtectedToken(segment) ||
        isAcceptScriptToken(segment),
    );
}

/**
 * The resolved-target test (#1643 Decision 1) for one git segment. Every repo-location /
 * config selector is read together with its value, and one that cannot be CLEARED both
 * makes the command the guard's business and keeps the git arms from admitting it:
 *
 *  - `--git-dir` / `--work-tree` / `--exec-path`, spaced or `=`-attached: never cleared;
 *  - `-c key=value` (or `-C` spelling a `key=value`): a config the program then runs — a
 *    pager, a hook path, an alias — so no target test clears it (clause (b)'s accepted
 *    cost, and the position the case tables already record);
 *  - `-C <path>` whose path IS or CONTAINS the git common dir (`.git`), names a protected
 *    file, walks (`..`), globs (`*?[`), roots at a home directory (`~`), or cannot be
 *    resolved at all (empty, or carrying an expansion): refused;
 *  - `git -C <worktree>` — the form AGENTS.md mandates — clears, and its VALUE is the
 *    only word the loop steps over: an ATTACHED selector (`-C/tmp/x`, `-C=/tmp/x`) carries
 *    its own value, so the following word is an ordinary argument and still gets asked.
 *    Stepping over it unexamined was the fail-open this closes (#1738 lens review:
 *    `git -C/tmp/x -c core.fsmonitor=/tmp/p log` never read its own `-c`).
 *
 * A selector at the END of the segment (no value at all) is unresolved: the value the
 * program would take is unknown.
 */
export function resolveRepoSelectors(words: string[]): boolean {
  let unresolved = false;
  for (let i = 0; i < words.length; i++) {
    const a = unquote(words[i] ?? "");
    if (NEVER_CLEARED_SELECTOR.test(a)) {
      unresolved = true;
      continue;
    }
    const value = VALUE_SELECTOR.exec(a);
    if (value !== null) {
      let target = value[1] ?? "";
      if (target.startsWith("=")) target = target.slice(1);
      // A selector that spelled NO value takes its target from the NEXT word, and that
      // word is then consumed. An attached one consumed nothing, so the next word stays
      // where the loop will reach it.
      const spaced = target === "";
      if (spaced) target = unquote(words[i + 1] ?? "");
      if (CONFIG_VALUE.test(target) || targetReachesStore(target)) unresolved = true;
      else if (spaced) i++;
    }
  }
  return unresolved;
}

/** Does the segment carry a repo-location / config selector that cannot be cleared? */
export function hasUnresolvedRepoSelector(words: string[]): boolean {
  return resolveRepoSelectors(words);
}
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
  // The repo-location / config selectors go through the resolved-target test (#1643):
  // `git -C <worktree> log` is the sanctioned worktree form and clears, a `-c key=value`
  // or a selector aimed at `.git` does not. The write flags keep the blanket ban.
  if (hasUnresolvedRepoSelector(w)) return false;
  if (hasFlag(rest, ...OUTPUT_FLAGS) || tokensOf(rest.join(" ")).includes("alias")) return false;
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
  // A forge read takes no repo-location selector at all — `gh` and `glab` have no `-C`
  // form to resolve — so the blanket ban stands here and only here.
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
  if (hasFlag(rest.map(unquote), ...OUTPUT_FLAGS) || hasUnresolvedRepoSelector(rest.map(unquote)))
    return false;
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
