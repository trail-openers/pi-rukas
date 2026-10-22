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
  armsOf,
  baseName,
  eraseBackslashes,
  isAcceptScriptToken,
  isProtectedToken,
  pipeTargets,
  shellWords,
  tokensOf,
  unquote,
} from "./review-accept-command.ts";
import { READ_TOOLS } from "./review-accept-readtools.ts";
import { REPO_LOCATION_FLAG, hasUnresolvedRepoSelector } from "./review-accept-selector.ts";
import { gitPreVerbCleared, gitVerbIndex, gitVerbOfSegment } from "./review-accept-verb.ts";
/** A JS runtime: its invocation executes a program, so it is never a read tool.
 * Exported because the guard's pre-checks ask the same question of the whole command. */
export const RUNTIME = /^(?:bun|bunx|node|npx|tsx|ts-node|deno)$/;
/** A SHELL: like a runtime it EXECUTES the text it is handed — a heredoc or a stdin pipe
 * into `sh` is a program the guard cannot read. It is a set SEPARATE from `RUNTIME`
 * because the arms treat the two differently: A4 admits `(bun|bunx) test <paths>` as a
 * read-only run, and no arm admits a shell at all, so widening clause (4) to shells must
 * not widen A4 with it (#1764 fix round, criterion 8's shell arm). `env sh` counts: the
 * test asks whether any WORD of a segment is a shell, which is how a prefix word fails to
 * hide one. */
export const SHELL = /^(?:sh|bash|dash|ksh|zsh)$/;
/** The shell builtins that EXECUTE their operand: `eval "$x"`, `source file`, and the
 * POSIX `.` — the same act under a punctuation spelling. `.` is asked only in PROGRAM
 * position, because as an argument it is the ordinary "here" (`bun test .`, `tofu fmt .`)
 * and asking it per word would put every heredoc command that also mentions `.` in scope. */
const EXEC_BUILTIN = /^(?:eval|source)$/;
/** The write-capable arguments clause (b) refuses and names. Exported for the guard's
 * remedy sentence, which names the same flags. */
export const WRITE_FLAGS: readonly string[] = ["-o", "--output", "-c", "--ext-diff"];
/** The write-capable arguments EXCEPT the git config selector `-c`, DERIVED from
 * `WRITE_FLAGS` so the two lists cannot drift when a fifth flag is added: `-c` is not a
 * write flag in the same sense as an output path — it sets a config, and the thing that
 * makes it a route to the store is the value it sets (`core.fsmonitor=…`,
 * `alias.x=!cat <store>`), which is exactly what `hasUnresolvedRepoSelector` reads.
 * Asking `OUTPUT_FLAGS` where a `-C <path>` may appear keeps the #1643 sanctioned form
 * from matching a write flag on a case-folded `-C`. This is also the list clause (b) of the
 * scope test asks through `hasFlag` — the same list the arms and the remedy sentence name,
 * which is why there is exactly one of them and no second spelling to keep in step. */
export const OUTPUT_FLAGS: readonly string[] = WRITE_FLAGS.filter((flag) => flag !== "-c");
/** A write-capable flag whose VALUE is glued to it with `=`: `--output=<name>`,
 * `--ext-diff=<name>`. One word, so an arm's `-o <name>` pair test cannot see it.
 *
 * What is deliberately NOT here is a value glued to a flag letter WITHOUT `=` — `-ofoo`,
 * `-cfoo`. In the programs that take these flags that is not an option at all (`git show
 * -odata` reads `data` as a path operand), and reading it as one made every short-flag
 * command that mentions the store a refusal for a flag it never passed: `git commit
 * -oreview-findings.json`, `bun test --reporter junit … <store>` (#1764 fix round,
 * criterion 6). */
const ATTACHED_WRITE_ARG = /(?:^|\s)(?:--output=\S|--ext-diff=\S|-o=\S|-c=\S)/;
/** Does this command carry an argument that is a route to WRITING a file? The spaced
 * spellings (`-o <name>`, `--output <name>`, `--ext-diff <name>`) and the `=`-attached
 * spellings, and nothing glued without `=`. Exported because clause (b) of the scope test
 * and arm A7 must ask the SAME question — two lists of write flags, one consulted by the
 * scope rule and one by the arm, is how a flag is refused by one and admitted by the other. */
export function hasWriteCapableArgument(words: string[]): boolean {
  const visible = words.map((w) => unquote(w)).join(" ");
  return ATTACHED_WRITE_ARG.test(` ${visible} `) || hasFlag(words, ...OUTPUT_FLAGS);
}
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
// They sit beside the program sets they test against — `RUNTIME` and `VCS` here, the
// read-tool kinds in `review-accept-readtools.ts` — so the two cannot drift.

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
/** Does the command run git or a forge CLI (and NOT merely a JS runtime)? This is the
 * gate in front of the write-capable-argument test (#1764 fix round, criterion 6): `-o` /
 * `--output` / `--ext-diff` are routes to WRITING a file for git, gh and glab, while a
 * test runner's own flags are nobody's write surface. Without this gate the clause refused
 * `bun test --reporter junit foo` and `bash smoke-tests/lib/verify-loop.sh --digest-mode on
 * foo` — a runner's flags, on a program that writes nothing — whenever the store appeared
 * anywhere in the same command, which is the second time this harness's own offline gate
 * was the thing the guard brickwalled. */
export function namesVcsOrForge(text: string): boolean {
  return shellWords(text).some((w) => VCS.test(baseName(unquote(w))));
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
/** Is any word a SHELL — a program that EXECUTES the text it is handed, the same risk a
 * runtime carries? This, not `namesInterpreter`, is why `cat <<EOF\n…\nEOF | sh` is in
 * scope: the body is unreadable AND a shell will run it. `env sh` is caught because the
 * test asks per WORD, not per segment head. `.` counts only as the segment's PROGRAM
 * (`. script`), never as its argument. */
export function namesShell(text: string): boolean {
  return armsOf(text).some((segment) => runsAShell(shellWords(segment)));
}
/** Does one of this command's PIPE TARGETS run a shell — i.e. is the text some other
 * segment printed going to be EXECUTED? `echo "cat $F" | sh` is a program the guard
 * cannot read arriving on a shell's stdin from the side that carries no heredoc marker,
 * so clause (4)'s `<<` / `-` test never sees it (#1764 fix round, criterion 8). */
export function namesPipedShell(text: string): boolean {
  return pipeTargets(text).some((segment) => runsAShell(shellWords(segment)));
}
/** Does this segment's word list run a shell? Any word may be `sh`/`bash`/… (a prefix
 * word does not hide it); `eval`, `source` and `.` count in program position only. */
function runsAShell(words: string[]): boolean {
  const names = words.map((w) => baseName(unquote(w)));
  return (
    names.some((w) => SHELL.test(w) || EXEC_BUILTIN.test(w)) ||
    (names.length > 0 && (names[0] ?? "") === ".")
  );
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
  // A word is git's verb only when a git runs it, so the whole test is gated on git.
  if (!namesGit(text)) return false;
  // Asked of the words as written AND of the backslash-erased view: the shell removes the
  // escape and the quotes before git reads the word, so `git "apply" <<EOF` and
  // `git ap\ply <<EOF` are both a patch handed to `apply` (#1738).
  return [text, eraseBackslashes(text)].some((view) =>
    // PER SEGMENT, and only where the unreadable operand stands in the SAME segment: a
    // heredoc body line that merely mentions `git rm` in prose is nobody's write route, and
    // the verb counts only beside the `<<` body or the stdin `-` the guard cannot read.
    armsOf(view).some((segment) => {
      const words = shellWords(segment);
      const verb = gitVerbOfSegment(words);
      if (verb === undefined) return false;
      if (!GIT_WRITE_VERBS.includes(verb) && verb !== "hash-object") return false;
      if (!segment.includes("<<") && !hasStdinDash(words)) return false;
      // A DISJUNCTION, never an early return: `hash-object` writes only what `-w` tells it
      // to, and a decoy beside a real write verb (`git hash-object --stdin && git apply
      // <<EOF`) must not answer for the whole command.
      return verb === "hash-object" ? words.some((w) => unquote(w) === "-w") : true;
    }),
  );
}
/** Does the command run one of the READ TOOLS the arms admit (`cat`, `grep`, `rg`,
 * `head`, `wc`, …)? Together with `namesVcsOrRuntime` this is the set of programs through
 * which a store name can reach the guarded bytes at all. Restored in #1764 round 4 as
 * the DEFAULT trigger of clause (5): base asked this COMMAND-wide, and the monotone
 * invariant makes the command-wide question the floor — the per-segment operand analysis
 * may only lift it when `review-accept-exempt.ts` proves it understands every segment. */
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
/** Flags that hand the tool a PROGRAM to run on each input. `rg --pre=CMD` pipes every
 * matched file through CMD, GNU `find -exec` runs a command per hit, and a
 * `--command`/`--exec` spelling is a program argument on any tool that has one. Each is
 * refused by whole word and `=`-attached; the `sed`/`awk` that used to sit in READ_TOOLS
 * are gone entirely rather than flagged, since their EXECUTE verb (`-e id` for sed, the
 * `system()` builtin for awk) is a flag no list would name completely. */
const EXEC_FLAGS = ["--pre", "--pre-glob", "--exec", "-exec", "--command"];
/** The verbs arm A1 admits: reads that print to stdout and take no output argument. */
const GIT_READ_VERBS = ["status", "log", "diff", "show", "blame"];

/** Does any word carry one of `flags`, whole, `=`-attached, or ATTACHED to the flag? Each
 * word is asked as written and with its backslashes gone — `git -\o out.txt` is `-o` by the
 * time the program reads the word (#1738). */
export function hasFlag(words: string[], ...flags: string[]): boolean {
  return words.some((w) => {
    const a = unquote(w);
    return [a, eraseBackslashes(a)].some(
      (x) =>
        flags.includes(x) ||
        flags.some((f) => x.startsWith(`${f}=`)) ||
        // `-odata`, `-creview-findings.json`: the value glued to the flag letter. An
        // option of this shape has no arm anyway, so it must never read as a pure read.
        flags.some((f) => x.startsWith(f) && x !== f),
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
 * A1: `git (--no-pager)?(repo selector)*status|log|diff|show|blame`, pure read, no write
 * flag. The verb is matched WITHOUT stepping over quotes — `'status'` is text handed to
 * git, not the verb this arm vouches for. It IS matched after stepping over the
 * repo-location / config selectors: `git -C <worktree> log` is the form AGENTS.md
 * mandates, and anchoring the verb on the word immediately after `git` refused every one
 * of them that came into scope for any other reason (219 fieldbox refusals, #1764). The step
 * is safe because `hasUnresolvedRepoSelector` below has already read each selector WITH
 * its value and refused the arm unless the target clears — so what is stepped over is a
 * selector this arm has vouched for, never an unexamined path. WHERE the verb sits is the
 * ONE reader's answer (`gitVerbIndex` in `review-accept-verb.ts`), and `gitPreVerbCleared`
 * is the audit that nothing unvouched was stepped over to reach it.
 */
export function armGitRead(w: string[]): boolean {
  // The head must be the LITERAL word `git`: `/usr/bin/git log` and `sudo git log` put a
  // program this arm never named in front of the read, exactly as the prefix-word refusals
  // in A7/A8 treat them. `gitVerbIndex` accepts a path-spelled head because clause (4)
  // must still recognise `/usr/bin/git apply <<EOF` as a write.
  if (unquote(w[0] ?? "") !== "git") return false;
  const i = gitVerbIndex(w);
  const verb = i < 0 ? undefined : w[i];
  if (i <= 0 || verb === undefined || !GIT_READ_VERBS.includes(verb)) return false;
  if (!gitPreVerbCleared(w, i)) return false;
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
