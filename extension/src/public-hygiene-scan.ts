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
 * Realpath must sit inside the tool call's cwd tree or the OS temp dir, and be
 * at most 1 MiB. Both bounds exist because the path is agent-named input. The
 * temp dir is admissible because that is where the forge adapter legitimately
 * writes a body (`forge.ts`'s `withBodyFile` → `mkdtempSync`), so a rule that
 * refused it would refuse a normal call.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleCommands } from "./bash-destructive-write.ts";
import { pushesRemote } from "./git-push-command.ts";
import type {
  PublishScan,
  PublishText,
  ScanProblem,
} from "./public-hygiene-types.ts";

export type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";

/** A body file this large is not a body. */
export const MAX_BODY_FILE_BYTES = 1024 * 1024;

/** Bound on each git call the push scan makes (PM decision). */
export const PUSH_SCAN_TIMEOUT_MS = 10_000;

/** Bound on the git output the push scan reads (PM decision). */
export const PUSH_SCAN_MAX_BUFFER = 5 * 1024 * 1024;

/** A `git push` in this command, as written, or undefined. */
export function pushVerbOf(command: string): string | undefined {
  return pushesRemote(command);
}

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

/**
 * Is this simple command a `git … push`? Delegates to `pushesRemote`, which
 * already handles git's global-option positions, the `oo` runner prefix, the
 * positional `-C <path>` and a push hidden in a shell body — a second push
 * matcher here would be a second answer to one question, and the two would
 * drift exactly as #1002's two `cat-file` readers did.
 */
function isGitPush(argv: string[]): boolean {
  return pushesRemote(argv.join(" ")) !== undefined;
}

/**
 * Read a file the agent named, if it may be read. `undefined` means "no
 * problem, nothing to scan" is NOT an option here — a refusal reason is
 * returned instead, so an unreadable file never reads as clean.
 */
function readPublishFile(
  file: string,
  cwd: string,
  location: string,
): { text?: string; problem?: ScanProblem } {
  if (file === "") return { problem: { location, reason: "named an empty file" } };
  const abs = path.resolve(cwd, file);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    return {
      problem: { location, reason: `could not read the named file (${codeOf(err)})` },
    };
  }
  const roots = admissibleRoots(cwd);
  if (!roots.some((root) => within(root, real))) {
    return {
      problem: {
        location,
        reason: "names a file outside this directory tree and the system temp dir",
      },
    };
  }
  let size: number;
  try {
    size = statSync(real).size;
  } catch (err) {
    return { problem: { location, reason: `could not read the named file (${codeOf(err)})` } };
  }
  if (size > MAX_BODY_FILE_BYTES) {
    return {
      problem: {
        location,
        reason: `names a file larger than ${MAX_BODY_FILE_BYTES} bytes`,
      },
    };
  }
  try {
    return { text: readFileSync(real, "utf8") };
  } catch (err) {
    return { problem: { location, reason: `could not read the named file (${codeOf(err)})` } };
  }
}

/** The directories a named body file may live in: the cwd tree and /tmp. */
export function admissibleRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (const dir of [cwd, tmpdir()]) {
    try {
      roots.push(realpathSync(dir));
    } catch {
      roots.push(path.resolve(dir)); // a temp dir that cannot be resolved is still a root
    }
  }
  return roots;
}

/** Is `target` `root` itself or below it? Compares realpaths, so `..` cannot escape. */
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `@file` and `file=@path` are gh api's ways of taking a field from a file. */
function apiFileOperand(v: string): string | undefined {
  if (v.startsWith("@")) return v.slice(1);
  const at = v.indexOf("=@");
  return at > 0 ? v.slice(at + 2) : undefined;
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
      if (w === flag || (w.startsWith(`${flag}=`) && w.length > flag.length + 1)) {
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
          else if (read.text !== undefined) texts.push({ location: "comment", text: read.text, generic: true });
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
        else if (read.text !== undefined) texts.push({ location: "body", text: read.text, generic: true });
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
      if (w === flag || (w.startsWith(`${flag}=`) && w.length > flag.length + 1)) {
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


/** An exec/fs error's `code`, for a refusal that names why without quoting content. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return err instanceof Error && err.message ? "unreadable" : "unknown error";
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
      }
    }
  }
  return scan;
}

/** The script a `bash -c`/`sh -lc`/`eval` word list hands to a shell, if any. */
function shellBody(argv: string[]): string | undefined {
  const head = argv.find((w) => !isAssignment(w) && !w.startsWith("-"));
  const base = head === undefined ? undefined : path.basename(head);
  if (base === "eval") return argv.slice(1).join(" ");
  if (base === undefined || !SHELLS.has(base)) return undefined;
  const c = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  return c >= 0 ? argv[c + 1] : undefined;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Does this command run `git push` at all (including inside a shell body)? */
export function commandPushes(command: string): boolean {
  return pushesRemote(command) !== undefined;
}

/** Whether a file exists — used by the push scan's remote-branch probe. */
export function fileReadable(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}
