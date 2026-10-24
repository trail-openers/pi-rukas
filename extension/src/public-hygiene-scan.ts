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
 * `simpleCommands`/`unwrap` (bash-destructive-write.ts) supply the simple-
 * command split and the `bash -c` / wrapper unwrapping — a publish hidden
 * inside `bash -c 'gh pr comment … --body …'` is the same shape the memory
 * write guard already refuses to miss. `pushesRemote` (git-push-command.ts)
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
import { apiFileOperand, codeOf, readPublishFile } from "./public-hygiene-files.ts";
import { publishSegmentsWithSubstitution } from "./public-hygiene-substitution.ts";
import type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";
import { unreadableOperands } from "./public-hygiene-unreadable.ts";

export type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";
export { MAX_BODY_FILE_BYTES, OUTSIDE_ROOTS, readPublishFile } from "./public-hygiene-files.ts";

/** Bound on each git call the push scan makes (PM decision). */
export const PUSH_SCAN_TIMEOUT_MS = 10_000;

/** Bound on the git output the push scan reads (PM decision). */
export const PUSH_SCAN_MAX_BUFFER = 5 * 1024 * 1024;

/** A `git push` in this command, as written, or undefined. */

/** Flags whose value is prose the forge publishes, and what to call it. */
const GH_TEXT_FLAGS: Record<string, string> = {
  "--title": "title",
  "-t": "title",
  "--body": "body",
  "-b": "body",
  "--notes": "release notes",
  // `-n` is `gh release create`'s notes TEXT flag and `gh issue create`'s
  // "no-body" switch. It is read ONLY for the release noun, where it is the
  // notes, and never for an issue or a pr, where treating it as text would
  // refuse a boolean switch's own name.
  "-n": "release notes",
  "--subject": "commit message",
};

/**
 * Flags whose value is a PATH whose contents get published. `-F` is
 * `gh issue create`'s `--body-file`; `-n` is `gh release create`'s
 * `--notes-file` (where `--notes` takes text instead). Each is read as a file
 * ONLY for the noun where it names one, so a boolean switch's own name is
 * never mistaken for prose.
 */
const GH_BODY_FILE_FLAGS: Record<string, Record<string, string>> = {
  issue: { "--body-file": "body", "-F": "body" },
  pr: { "--body-file": "body", "-F": "body" },
  release: { "--notes-file": "release notes", "-n": "release notes" },
};

/** gh subcommands whose text reaches the forge. `edit` is in scope because a
 * title or body edit publishes text exactly as a create does. */
const GH_PUBLISH_VERBS: Record<string, Set<string>> = {
  issue: new Set(["create", "edit", "comment"]),
  pr: new Set(["create", "edit", "comment", "review"]),
  release: new Set(["create", "edit"]),
};

/** The gh api path segments that carry public prose. */
const API_PUBLIC_PATH =
  /(?:^|\/)(?:issues|pulls|releases|comments|notes)(?:[/?#]|$)|\/pull\/\d+\/(?:comments|reviews)\b/;

/** gh api flags whose value is a published field. */
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
const API_FIELD_FILE_FLAGS = new Set(["-F", "--raw-field"]);
const API_WRITE_METHODS = new Set(["POST", "PATCH", "PUT"]);

/** git commit flags whose value is the message. */
const COMMIT_MESSAGE_FLAGS = new Set(["-m", "--message"]);
const COMMIT_MESSAGE_FILE_FLAGS = new Set(["-F", "--file"]);

/** The command words that reach a remote (`git push`, `oo git push`). */

/** What `--flag value` / `--flag=value` / a glued short form resolve to. */
function valueAfter(words: string[], i: number): { value: string; used: number } | undefined {
  const w = words[i] ?? "";
  const eq = w.indexOf("=");
  if (eq > 0) return { value: w.slice(eq + 1), used: 0 };
  const next = words[i + 1];
  if (next === undefined) return undefined;
  return { value: next, used: 1 };
}

/**
 * Does the word `w` use text flag `flag`, with the flag ENDED by a delimiter?
 * Accepts `--body`, `--body=…` and a glued short form (`-b…`), and refuses a
 * long flag that merely prefixes a longer one (`--body` vs `--body-file`).
 */
function flagEndsAt(w: string, flag: string): boolean {
  if (w === flag) return true;
  if (!w.startsWith(flag)) return false;
  if (flag.length > 2) return w[flag.length] === "=";
  return w.length > flag.length;
}

/** Glued short form: `-bfoo` is `-b` with value `foo` (getopt accepts it). */
function glued(w: string, flag: string): string | undefined {
  if (flag.length !== 2 || !flag.startsWith("-")) return undefined;
  if (!w.startsWith(flag) || w.length <= flag.length) return undefined;
  return w.slice(flag.length);
}

/**
 * Is `argv` a `gh <noun> <publish-verb> …`? Returns the noun, or undefined.
 * A leading `oo` (the verbose runner this harness rewrites to) is skipped.
 */
function ghPublishNoun(argv: string[]): string | undefined {
  let i = 0;
  while (i < argv.length && (argv[i] === "oo" || isAssignment(argv[i] ?? ""))) i++;
  if (argv[i] !== "gh") return undefined;
  i++;
  while (i < argv.length && (argv[i] ?? "").startsWith("-")) {
    i += ["-R", "--repo"].includes(argv[i] ?? "") ? 2 : 1;
  }
  const noun = argv[i] ?? "";
  const verb = argv[i + 1] ?? "";
  return GH_PUBLISH_VERBS[noun]?.has(verb) ? noun : undefined;
}

/** A `KEY=value` word, as bash accepts before a command name. */
function isAssignment(w: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
}

/** The `problems` reason for a text the shell assembles. Names no content. */
const SHELL_BUILT_REASON =
  "is built by the shell, so its text cannot be read from the command; write it to a file and pass that file";

/**
 * Does this argv carry a publish verb whose text flags matter? The scan's own
 * noun/verb tables already decide which `gh` commands publish; this is the
 * narrower question the unreadable-operand pass asks, and it admits `gh api`
 * and `git commit` alongside the create/edit/comment/review verbs.
 */
export function publishesText(argv: readonly string[]): boolean {
  const prog = argv.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (prog === undefined) return false;
  const base = prog.replace(/^.*\//, "");
  if (base === "gh") {
    return (
      argv.includes("issue") ||
      argv.includes("pr") ||
      argv.includes("release") ||
      argv.includes("api")
    );
  }
  if (base === "git") return argv.includes("commit");
  return false;
}

/** The text an `--input` file contributes, or the problem reading it. */
function inputValue(v: string): string {
  return v.startsWith("@") ? v.slice(1) : v;
}

/** One argument's worth of a command word list, with quotes already removed. */
function scanGhPublish(argv: string[], cwd: string, scan: PublishScan): void {
  const noun = ghPublishNoun(argv);
  if (noun === undefined) return;
  scan.publishes = true;
  const textFlags =
    noun === "release"
      ? GH_TEXT_FLAGS
      : Object.fromEntries(
          Object.entries(GH_TEXT_FLAGS).filter(
            ([flag]) => flag !== "-n" && flag !== "--notes" && flag !== "--subject",
          ),
        );
  const fileFlags = GH_BODY_FILE_FLAGS[noun] ?? {};
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    for (const [flag, location] of Object.entries(textFlags)) {
      // A text flag must END at a delimiter. Without this, `--body` matched
      // `--body-file` as a prefix (a `-` is not a delimiter), the path was
      // collected as inline body text, and `--body-file` never reached the
      // file reader — so the file was never read, its size bound never applied,
      // and its out-of-root path was never checked. Prefix-matching a flag set
      // is how a flag's whole policy quietly stops running.
      if (flagEndsAt(w, flag)) {
        const v = valueAfter(argv, i);
        if (v) {
          scan.texts.push({ location, text: v.value, generic: true });
          i += v.used;
        }
        continue;
      }
      // A glued short form (`-bfoo`, `-tfoo`) carries its value inline; a long
      // flag never glues, so `--bodyfile` is not `--body` with a value.
      const gluedValue = flag.length === 2 ? glued(w, flag) : undefined;
      if (gluedValue !== undefined) scan.texts.push({ location, text: gluedValue, generic: true });
    }
    for (const [flag, label] of Object.entries(fileFlags)) {
      if (w !== flag && !w.startsWith(`${flag}=`)) continue;
      const v = valueAfter(argv, i);
      if (!v) continue;
      const read = readPublishFile(v.value, cwd, label);
      if (read.problem) scan.problems.push(read.problem);
      else if (read.text !== undefined)
        scan.texts.push({ location: label, text: read.text, generic: true });
      i += v.used;
    }
  }
}

/** `gh api` writing to a public path: the field values are the published text. */
function scanGhApi(argv: string[], cwd: string, scan: PublishScan): void {
  let i = 0;
  while (i < argv.length && (argv[i] === "oo" || isAssignment(argv[i] ?? ""))) i++;
  if (argv[i] !== "gh" || argv[i + 1] !== "api") return;
  const rest = argv.slice(i + 2);
  let method: string | undefined;
  let endpoint = "";
  let fields = 0;
  const texts: PublishText[] = [];
  const problems: ScanProblem[] = [];
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k] ?? "";
    if (w === "-X" || w === "--method") {
      method = (rest[k + 1] ?? "").toUpperCase();
      k++;
      continue;
    }
    if (w.startsWith("--method=")) {
      method = w.slice(9).toUpperCase();
      continue;
    }
    if (API_FIELD_FLAGS.has(w)) {
      const v = valueAfter(rest, k);
      if (v) {
        fields++;
        const file = apiFileOperand(v.value);
        const fieldFile = API_FIELD_FILE_FLAGS.has(w);
        if (file !== undefined && (fieldFile || file !== v.value)) {
          const read = readPublishFile(file, cwd, "comment");
          if (read.problem) problems.push(read.problem);
          else if (read.text !== undefined)
            texts.push({ location: "comment", text: read.text, generic: true });
        } else {
          texts.push({ location: "comment", text: v.value, generic: true });
        }
        k += v.used;
      }
      continue;
    }
    if (w === "--input" || w === "-i") {
      const v = valueAfter(rest, k);
      if (v) {
        const read = readPublishFile(inputValue(v.value), cwd, "body");
        if (read.problem) problems.push(read.problem);
        else if (read.text !== undefined)
          texts.push({ location: "body", text: read.text, generic: true });
        k += v.used;
      }
      continue;
    }
    if (!w.startsWith("-") && endpoint === "") endpoint = w;
  }
  // gh api defaults to POST when it carries fields; an explicit verb wins.
  const writes = method === undefined ? fields > 0 : API_WRITE_METHODS.has(method);
  if (!writes || !API_PUBLIC_PATH.test(endpoint)) return;
  scan.publishes = true;
  scan.texts.push(...texts);
  scan.problems.push(...problems);
}

/** `git commit -m …` / `-F file`: the message the commit will carry. */
function scanGitCommit(argv: string[], cwd: string, scan: PublishScan): void {
  const head = argv.find((w) => !isAssignment(w) && !w.startsWith("-"));
  if (path.basename(head ?? "") !== "git") return;
  if (!argv.includes("commit")) return;
  scan.publishes = true;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    for (const flag of COMMIT_MESSAGE_FLAGS) {
      if (flagEndsAt(w, flag)) {
        const v = valueAfter(argv, i);
        if (v) {
          scan.texts.push({ location: "commit message", text: v.value, generic: true });
          i += v.used;
        }
        continue;
      }
      const gluedValue = glued(w, flag);
      if (gluedValue !== undefined)
        scan.texts.push({ location: "commit message", text: gluedValue, generic: true });
    }
    for (const flag of COMMIT_MESSAGE_FILE_FLAGS) {
      if (w !== flag && !w.startsWith(`${flag}=`)) continue;
      const v = valueAfter(argv, i);
      if (!v) continue;
      const read = readPublishFile(v.value, cwd, "commit message");
      if (read.problem) scan.problems.push(read.problem);
      else if (read.text !== undefined)
        scan.texts.push({ location: "commit message", text: read.text, generic: true });
      i += v.used;
    }
  }
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
  const words = simpleCommands(command);
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
      for (const operand of unreadableOperands(argv, command)) {
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
      for (const inner of simpleCommands(nested)) {
        scanGhPublish(inner, cwd, scan);
        scanGhApi(inner, cwd, scan);
        scanGitCommit(inner, cwd, scan);
        if (publishesText(inner)) {
          for (const operand of unreadableOperands(inner, nested)) {
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
  for (const _segment of publishSegmentsWithSubstitution(command)) {
    scan.problems.push({ location: "body", reason: SHELL_BUILT_REASON });
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
