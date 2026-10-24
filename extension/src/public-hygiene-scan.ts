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
 * ## Reuse over new parsers
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
 * the scratch convention in AGENTS.md §7 puts the driver's own body files there —
 * a rule that admitted only the temp dir refused a normal handoff comment. A path
 * outside every root is refused on its PATH alone and never opened. The roots are
 * owned by `public-hygiene-cwd.ts` (`admissibleRoots`), which is also what decides
 * which directory a chained command's push runs in.
 */

import path from "node:path";
import { simpleCommands } from "./bash-destructive-write.ts";
import { pushesRemote } from "./git-push-command.ts";
import { publishArgv, publishCommandLines } from "./public-hygiene-command.ts";
import { codeOf } from "./public-hygiene-files.ts";
import { isAssignment, operandlessTextFlag, unpairedQuote } from "./public-hygiene-operands.ts";
import { commandPrefixLength } from "./public-hygiene-prefix.ts";
import { containsShellExpansion, shellExpansionProblem } from "./public-hygiene-substitution.ts";
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
 * The reason an operand that never survived the word split is refused. Kept
 * separate from `SHELL_BUILT_REASON` because it names a different cause: there
 * the shell assembles the text, here the guard's own reader could not finish
 * reading it.
 */
const UNSPLIT_OPERAND_REASON =
  "could not be read (an unmatched quote leaves the operand's text unknown); pass the text with --body-file (or, for gh api, -F field=@file)";

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
  // An UNMATCHED QUOTE is the other shape of "the guard could not read it".
  // `simpleCommands` closes an unterminated quote at end of input, so the quote
  // does not drop the operand — it ABSORBS every word after it, flags included:
  // in `--body 'oops --title "x $(cat f)"` the reader saw one operand and lost the
  // title and its substituted value, while bash publishes both. That is an
  // unreadable publish and this guard's rule for one has never changed — a
  // refusal, never a pass. It is a parity count over the quotes, not a word
  // model (`unpairedQuote`), and a closed quoted body (`--body 'cost 100
  // dollars'`) pairs up and is judged as prose.
  if (scan.publishes && (operandlessTextFlag(words) || unpairedQuote(command))) {
    scan.problems.push({
      location: scan.publishKind ?? "publish",
      reason: UNSPLIT_OPERAND_REASON,
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
 * Does this command run `git push` at all (including inside a shell body)?
 */
export function commandPushes(command: string): boolean {
  return pushesRemote(command) !== undefined;
}
