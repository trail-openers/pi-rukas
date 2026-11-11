/**
 * public-hygiene-scan — what a bash command would PUBLISH, extracted from the
 * command string (#1788).
 *
 * `public-denylist.ts` answers "is this text dirty"; this module answers
 * "which text is this command about to put in front of the world". The split
 * is the one the guard needs: the matcher is pure and reusable from the forge
 * seam, and the extraction is the part that has to know gh's and git's flag
 * grammar.
 *
 * ## Surfaces (issue decision 4)
 *
 * - `gh issue create|edit|comment`, `gh pr create|edit|comment|review`,
 *   `gh release create|edit`: `--title/-t`, `--body/-b`, `--body-file/-F`,
 *   `--notes/--notes-file`.
 * - `gh api` writing (`-X POST|PATCH|PUT`, or POST implied by `-f`/`-F`) to an
 *   `/issues`, `/pulls`, `/releases` or `/comments` path: `-f/-F/--field/
 *   --raw-field` values, with `@file` and `--input` files read.
 * - `git commit -m/--message/-F/--file`.
 * - `git push` to a remote whose host is github.com: the outgoing commits'
 *   messages and ADDED diff lines, against the PRIVATE denylist only.
 *
 * ## What the scan actually follows
 *
 * A publish is found whenever the command's OWN words name it, after the runner
 * prefixes are stripped: `simpleCommands` splits the line, `unwrap`
 * (bash-destructive-write.ts) removes the process wrappers and their option
 * operands (`sudo`, `env`, `timeout`, `nohup`, `watch`, `xargs`, `exec`, `nice`,
 * `command`) and `NAME=value` assignments, and `commandPrefixLength` removes the
 * `oo` runner prefix that `unwrap` does not know. A `sudo`/`env`/`timeout` prefix
 * therefore no longer skips the scan — nor the fail-closed body-file and
 * substitution refusals, which are part of the same scan. A `bash -c`/`sh -lc`/
 * `eval` body is followed and scanned as its own command line, and `env -S STRING`
 * is re-split the same way.
 *
 * What it does NOT follow: a publish whose words the strip rule does not produce
 * as a command — an interpreter run (`python3 -c "gh pr comment …"`), a wrapper
 * table does not list, or a program that composes the publish itself. Those are
 * not silently allowed: when the RAW text still matches a publish shape
 * (`public-hygiene-publish-shapes.ts`) and the scan recorded no surface, the
 * guard refuses the command for being a publish it could not see.
 *
 * `pushesRemote` (git-push-command.ts)
 * recognises the push verb, including one hidden in a shell body.
 * `parseRemoteUrl` (forge-detect.ts) decides whether a remote host is
 * github.com. `simpleCommands` strips the quotes the same way bash does, so an
 * argument containing a space, a pipe or a `>` arrives here intact.
 *
 * ## A text the guard cannot read is refused, never assumed clean
 *
 * Every way a publish can be unreadable — an out-of-root body file, an
 * oversized one, a file that vanished, a push range git would not resolve, a
 * git call that timed out or overflowed — lands on a `problems` entry, and
 * `public-hygiene-guard.ts` refuses on it. "Could not tell" is not "clean":
 * the whole value of the guard is that it runs on every publish, and a check
 * that silently skipped the unreadable ones would report itself working while
 * doing nothing.
 *
 * ## Where a body file may live
 *
 * Realpath must sit inside the tool call's cwd tree, the OS temp dir, or the git
 * top-level of that directory (the repository, whose `tmp/issue-<N>/` scratch the
 * /work driver and its agents write PR and handoff bodies into), and be at most
 * 1 MiB. All three bounds exist because the path is agent-named input. The temp
 * dir is admissible because that is where the forge adapter legitimately writes a
 * body (`forge.ts`'s `withBodyFile` → `mkdtempSync`), and the repository because
 * the scratch convention (`tmp/issue-<N>/`) puts the driver's own body files there —
 * a rule that admitted only the temp dir refused a normal handoff comment. A path
 * outside every root is refused on its PATH alone and never opened. The roots are
 * owned by `public-hygiene-cwd.ts` (`admissibleRoots`), which is also what decides
 * which directory a chained command's push runs in.
 */

import path from "node:path";
import { simpleCommands } from "./bash-destructive-write.ts";
import { pushesRemote } from "./git-push-command.ts";
import { commandCarriesPushVerb } from "./git-push-words.ts";
import { PUSH_VERB } from "./public-hygiene-verbs.ts";
export { PUSH_VERB } from "./public-hygiene-verbs.ts";
import { publishArgv, publishCommandLines } from "./public-hygiene-command.ts";
import { codeOf } from "./public-hygiene-files.ts";
import { isAssignment } from "./public-hygiene-operands.ts";
import { commandPrefixLength } from "./public-hygiene-prefix.ts";
import { containsShellExpansion, shellExpansionProblem } from "./public-hygiene-substitution.ts";
import { isGitProgramWord } from "./public-hygiene-target.ts";
import type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";
import { unreadableOperands } from "./public-hygiene-unreadable.ts";
import { scanGhApi, scanGhPublish, scanGitCommit } from "./public-hygiene-verbs.ts";

export type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";
export { MAX_BODY_FILE_BYTES, OUTSIDE_ROOTS, readPublishFile } from "./public-hygiene-files.ts";

/** Bound on each git call the push scan makes (PM decision). */
export const PUSH_SCAN_TIMEOUT_MS = 10_000;

/** Bound on the git output the push scan reads (PM decision). */
export const PUSH_SCAN_MAX_BUFFER = 5 * 1024 * 1024;

/** The `problems` reason for a text the shell assembles. Names no content. */
const SHELL_BUILT_REASON =
  "is built by the shell, so its text cannot be read from the command; pass the text with --body-file (or, for gh api, -F field=@file)";

/**
 * The reason for the fail-closed invariant: this command was recognised as a
 * publish, yet the scan read no text and hit no problem, so whatever the forge
 * is about to receive is text this guard never saw.
 */
const UNREADABLE_PUBLISH_REASON =
  "could not be read (this command was recognised as a publish, but no title, body, comment, field or commit message was reachable to check); pass the text with --body-file (or, for gh api, -F field=@file)";

/**
 * Does this argv carry a publish verb whose text flags matter? The scan's own
 * noun/verb tables already decide which `gh` commands publish; this is the
 * narrower question the unreadable-operand pass asks, and it admits `gh api`
 * and `git commit` alongside the create/edit/comment/review verbs.
 */
export function publishesText(argv: readonly string[]): boolean {
  // Wrapper-stripped first: the noun table that decides this question is the
  // same one the verb readers use, and a `sudo` prefix must not answer "no".
  const body = publishArgv(argv);
  const prog = body.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (prog === undefined) return false;
  const base = prog.replace(/^.*\//, "");
  if (base === "gh") {
    return (
      body.includes("issue") ||
      body.includes("pr") ||
      body.includes("release") ||
      body.includes("api")
    );
  }
  if (base === "git") return body.includes("commit");
  return false;
}

/**
 * Every publish surface in a bash command. Wrappers and `bash -c` bodies are
 * followed, so a publish hidden one layer down is still a publish.
 *
 * `scanPush` is passed when the caller wants the push range scanned; it is
 * async and the caller decides whether to pay for it (only a command that
 * actually contains a push verb does).
 */
export function scanPublishSurfaces(command: string, cwd: string): PublishScan {
  const scan: PublishScan = { publishes: false, texts: [], problems: [] };
  // Asked ONCE of the raw command, not per simple command: `simpleCommands` ends
  // a command at `$(` and throws the rest of the operand away, so an argv cut
  // that way can be missing the very flag that names the publish.
  const substitutes = containsShellExpansion(command);
  const words = publishCommandLines(command);
  for (const argv of words) {
    if (argv.length === 0) continue;
    scanGhPublish(argv, cwd, scan);
    scanGhApi(argv, cwd, scan);
    scanGitCommit(argv, cwd, scan);
    // A publish-text flag whose value the shell builds (`--body "$(cat x)"`,
    // `--body $BODY`, a backtick, a process substitution) is a surface this
    // module cannot read, and the rule for one of those has never changed: it is
    // a refusal, never a pass. Asked of every command's argv rather than only
    // the ones already known to publish, because the flag itself is what names
    // the publish here — `--body "$(…)"` on a `gh` command the noun table does
    // not classify would otherwise publish an unchecked body.
    if (publishesText(argv)) {
      // `raw` is asked because the word splitter ENDS a command at `$(` and at a
      // backtick: for `--body $(cat f)` the operand half is gone from `argv`, so
      // the per-word test sees a flag with nothing after it and reports nothing
      // to refuse.
      for (const operand of unreadableOperands(argv, substitutes ? command : undefined)) {
        scan.problems.push({
          location: operand.location,
          reason: SHELL_BUILT_REASON,
        });
      }
    }
    // `bash -c 'gh pr comment …'`: the body word IS a command line, so it is
    // scanned as one. `simpleCommands` already split it out of the outer layer,
    // and a publish reached through a shell is the same publish (the memory
    // write guard refuses the identical shape).
    const nested = shellBody(argv);
    if (nested !== undefined) {
      for (const inner of publishCommandLines(nested)) {
        scanGhPublish(inner, cwd, scan);
        scanGhApi(inner, cwd, scan);
        scanGitCommit(inner, cwd, scan);
        if (publishesText(inner)) {
          for (const operand of unreadableOperands(inner, substitutes ? nested : undefined)) {
            scan.problems.push({ location: operand.location, reason: SHELL_BUILT_REASON });
          }
        }
      }
    }
  }
  // The word splitter cannot see a substitution that sits AFTER a space inside a
  // quoted operand (`--body "PREFIX $(cat f) tail"` arrives as `--body PREFIX`),
  // so the raw command is walked once with quoting and substitution depth
  // tracked, and any segment that both publishes inline text and substitutes is
  // refused on the same "could not read the text" rule as the glued form.
  // Nested `bash -c` bodies are covered by the same call: the outer scan already
  // sees the whole raw text, and a publish one layer down is the same publish.
  // QUOTE-FREE RULE (#1788). A command that BOTH publishes and contains a shell
  // expansion is refused outright, whoever the expansion belongs to: modelling
  // which quotes a `$(…)` sat behind is the defect class this module's first
  // shape could not get right (see `public-hygiene-substitution.ts`), so the rule
  // looks at no quotes at all. The location is `scan.publishes`'s own label — set
  // by each verb reader BEFORE it reads an operand — because a word list cut at a
  // `$(` can leave no text to name, and a command that publishes nothing has no
  // surface and stays allowed (`echo $(date)`).
  const surface = scan.publishes
    ? (scan.texts[0]?.location ?? scan.problems[0]?.location ?? scan.publishKind)
    : undefined;
  const expansion = substitutes
    ? shellExpansionProblem(command, surface, SHELL_BUILT_REASON)
    : undefined;
  if (expansion !== undefined) {
    scan.problems.push(expansion);
  }
  // THE FAIL-CLOSED INVARIANT (#1792 follow-up, item 2). A command the scan
  // RECOGNISED as a publish and whose text flags it owns produced NEITHER a text
  // NOR a problem is a publish whose text nobody looked at — the same refusal the
  // raw-shape backstop exists for, which the backstop itself cannot make (it is
  // gated on `!scan.publishes`). Recognition without evidence is a refusal.
  //
  // What does NOT fire: a publish that names no text surface at all. `git commit`
  // with no `-m`/`-F` (and `git commit --amend --no-edit`) take the message from
  // the editor or the amended commit, so the guard never had a surface and the
  // command is ordinary. Each verb reader sets `textSurfaceNamed` when it sees a
  // flag that carries text or names a file; only then is an empty result a
  // refusal. What DOES fire is a text flag present and nothing read — a flag name
  // the tables do not know, or a word split gone wrong.
  if (
    scan.publishes &&
    scan.textSurfaceNamed === true &&
    scan.texts.length === 0 &&
    scan.problems.length === 0
  ) {
    scan.problems.push({
      location: scan.publishKind ?? "publish",
      reason: UNREADABLE_PUBLISH_REASON,
    });
  }
  return scan;
}

/**
 * The script a `bash -c`/`sh -lc`/`eval` word list hands to a shell, if any.
 *
 * NOT `executedBodies` from `git-push-command.ts`, which looks superficially
 * like the same helper and is not: that one answers "does any shell body of the
 * WHOLE command contain the push verb?" and therefore (a) takes the raw command
 * string and re-tokenises it on whitespace, (b) attaches EVERY quoted run of the
 * command to ANY segment that runs a shell, and (c) has no `eval` case. This one
 * answers "which script does THIS argv hand to a shell?" per simple command, so
 * it must return the one body at the `-c` position of this word list (and the
 * tail of an `eval`) for the nested scan to attribute a publish to the right
 * layer. Sharing the helper would either widen the push matcher's over-approximation
 * into the publish scan or lose `eval` and the per-argv precision the scan needs.
 */
function shellBody(argv: string[]): string | undefined {
  const head = argv.find((w) => !isAssignment(w) && !w.startsWith("-"));
  const base = head === undefined ? undefined : path.basename(head);
  if (base === "eval") return argv.slice(1).join(" ");
  if (base === undefined || !SHELLS.has(base)) return undefined;
  const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  return c >= 0 ? argv[c + 1] : undefined;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * The programs outside `WRAPPERS` whose operands the SHELL WILL EXECUTE or
 * compile, rather than treat as data: `eval` runs its operands, `script -c` runs
 * its `-c` payload, and `make` compiles `VAR=value` overrides (the recipe later
 * expands them). None is in `WRAPPERS`, so the segmenter leaves the payload as
 * ONE opaque word and no git argv is ever produced for the word reader; and none
 * is a shell runner, so `executedBodies` never opens the quote either. The
 * payload is the only place the push is written.
 *
 * Narrow on purpose. `echo`, `grep` and a commit message are NOT here, which is
 * what keeps prose that names the verb off the push path; and an interpreter
 * (`python3 -c`) is not here either, because reading its payload as a shell
 * command line is the backstop refusal's job, not this predicate's.
 */
const PAYLOAD_RUNNERS = new Set(["eval", "script", "make"]);

/** A `NAME=value` operand (`make run CMD="git push"`), which may be quoted. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The first word bash would exec as this argv's program, after options and assignments. */
function programWord(argv: readonly string[]): string | undefined {
  const head = argv.find((w) => !w.startsWith("-") && !w.includes(" ") && !ASSIGNMENT_WORD.test(w));
  return head === undefined ? undefined : path.basename(head);
}

/**
 * What a non-git runner program hands to a shell, per {@link PAYLOAD_RUNNERS}.
 * Empty for every other program, so a command whose words name no runner adds
 * nothing to the question this predicate asks.
 */
function runnerPayloads(argv: readonly string[]): string[] {
  const base = programWord(argv);
  if (base === undefined || !PAYLOAD_RUNNERS.has(base)) return [];
  if (base === "script") {
    const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    const body = c >= 0 ? argv[c + 1] : undefined;
    return body === undefined ? [] : [body];
  }
  const operands = argv.slice(1).filter((w) => !w.startsWith("-"));
  if (base === "make") {
    return operands.filter((w) => ASSIGNMENT_WORD.test(w)).map((w) => w.slice(w.indexOf("=") + 1));
  }
  return operands.length === 0 ? [] : [operands.join(" ")];
}

/**
 * Does this command run `git push` at all (including inside a shell body)?
 *
 * Two readers, one question, and the WORD READER'S VERDICT DECIDES only when it
 * actually read git. The word reader ({@link commandCarriesPushVerb}) walks the
 * command through the same segmenter every other publish reader uses, and requires
 * the verb at the position git would read it as its verb. The regex
 * (`pushesRemote`) is scan-not-anchor over the raw text: it sees a push inside a
 * `bash -c` body or past an `oo` prefix, and it also sees the verb ANYWHERE —
 * including inside text the command merely MENTIONS.
 *
 * The union of the two was the first defect this ordering replaces. `commandPushes`
 * used to answer yes when EITHER said so, so `echo "git push origin x"` — a line
 * that publishes nothing — went down the push path, and from a non-repository cwd
 * came back refused with the push directory sentence for a command that pushes
 * nothing. A commit message or a comment that names the verb paid the same refusal.
 *
 * Silencing the regex for every command that merely PARSED was the second defect,
 * and it fails in the expensive direction. The gate is not "the segmenter produced
 * words": it is "some segment's PROGRAM WORD is git", which is exactly the test the
 * word reader itself applies ({@link isGitProgramWord} on the basename after the
 * last `/`, plus no space). A program the wrapper table does not strip — `eval`,
 * `script -c`, `make VAR=` — leaves its payload as ONE opaque word, so no git argv
 * was ever produced to read; a reader that decided anyway answered `no` for
 * `eval "git push origin main"`, a real push. `no` from a reader that never saw git
 * is not an answer, it is the absence of one, and silence is never a pass.
 *
 * So the regex half decides every case where no segment ran git, and those are
 * exactly the shapes that over-matching buys cheaply:
 *
 * - no segment ran git at all (`busybox git push`, an `eval`/`script`/`make` payload
 *   that runs one) — the word reader refuses to strip a word it was not told to
 *   strip, so it saw no git and gave no verdict, and the regex catches the push;
 * - a push a shell body will execute (`bash -c 'git push'`) — the segmenter hands the
 *   payload back as ONE opaque word, so no git argv was ever produced to read;
 * - the command could not be parsed into words at all (an unbalanced quote, a
 *   heredoc body, an `env -S` payload the stripper emptied) — no words, no verdict.
 *
 * Where a git segment really did run, its own words are the evidence and the word
 * reader's `no` stands: `echo "git push x" && git status` is judged by the git
 * segment that produced no verb, so it is not a push.
 *
 * And the fail-closed rule is intact: absent a git segment the regex is asked, and
 * it is asked of the payloads the segmenter kept opaque — an `eval`/`script -c`/
 * `make VAR=` operand the shell will execute — as well as the raw text. So an
 * unparsable command, or a push whose only spelling is such a payload, is treated
 * as a push. "I could not read it" is never "it is not a push".
 */
export function commandPushes(command: string): boolean {
  const words = publishCommandLines(command);
  // Did any segment actually RUN git? Both halves of this test are the word
  // reader's own definition of a git argv: a quoted run survives the segmenter as
  // ONE word (`echo "git push"` → the single word `git push`), which ENDS in the
  // program name without being it, and bash never execs a word carrying an unquoted
  // space as a program. Requiring the basename match plus no space is what keeps
  // prose that mentions `git` from counting as "git was read"; requiring it of the
  // PROGRAM word (not any word) is what keeps `eval "git push …"` from counting
  // either — that push has no git argv to read, so the regex stays in charge.
  const runsGit =
    words.length > 0 &&
    words.every((argv) => argv.length > 0) &&
    words.some((argv) => isGitProgramWord(argv[0]) && !(argv[0] ?? "").includes(" "));
  if (runsGit) return commandCarriesPushVerb(command, PUSH_VERB);
  // The fallback reads the payloads the opaque words were hiding, as well as the
  // raw text: `eval "git push origin main"` is a push that BOTH readers used to
  // deny — the word reader saw no git, and the regex saw only `eval …` after the
  // quoted runs were stripped.
  const payloads = words.flatMap(runnerPayloads);
  return (
    pushesRemote(command) !== undefined ||
    payloads.some((payload) => pushesRemote(payload) !== undefined) ||
    commandCarriesPushVerb(command, PUSH_VERB)
  );
}
