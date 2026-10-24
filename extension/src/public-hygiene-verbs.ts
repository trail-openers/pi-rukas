/**
 * public-hygiene-verbs — the per-verb publish readers (#1788), split out of
 * `public-hygiene-scan.ts` along the seam AGENTS.md §12 asks for: the scan owns
 * the word split and the aggregate verdict, this module owns what each command
 * SHAPE contributes to it.
 *
 * Each reader sets `scan.publishes` and `scan.publishKind` BEFORE it reads a
 * single operand, so the scan's substitution rule still has a surface to name
 * when the word splitter cut an operand in half — a location derived from the
 * collected texts would report no surface for a publish that plainly carries one.
 */

import {
  REUSED_MESSAGE_REASON,
  STDIN_MESSAGE_REASON,
  commitCluster,
  commitMessageReuse,
  namesCommitMessageFlag,
} from "./public-hygiene-commit-flags.ts";
import { apiFileOperand, readPublishFile } from "./public-hygiene-files.ts";
import {
  STDIN_TEXT_REASON,
  isAssignment,
  textFlagValue,
  valueAfter,
} from "./public-hygiene-operands.ts";
import { commandPrefixLength, commandWord } from "./public-hygiene-prefix.ts";
import type { PublishScan, PublishText, ScanProblem } from "./public-hygiene-types.ts";

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

/**
 * Is `argv` a `gh <noun> <publish-verb> …`? Returns the noun, or undefined.
 * The caller hands words that have already been wrapper-stripped (`sudo`, `env`,
 * `timeout`, … by `unwrap`) and had their `oo`/`KEY=value` prefix skipped, by
 * `publishArgv` — the one place that rule lives.
 */
function ghPublishNoun(argv: string[]): string | undefined {
  const i = commandPrefixLength(argv);
  // The program word is path-stripped (`/usr/local/bin/gh` IS `gh`) so a
  // path-prefixed gh is SCANNED rather than falling to the backstop unreadable.
  if (commandWord(argv) !== "gh") return undefined;
  let k = i + 1;
  // `oo`/`KEY=value` are a runner prefix and already skipped above, so they can
  // never be consumed as a gh flag here.
  while (k < argv.length && (argv[k] ?? "").startsWith("-")) {
    k += ["-R", "--repo"].includes(argv[k] ?? "") ? 2 : 1;
  }
  const noun = argv[k] ?? "";
  const verb = argv[k + 1] ?? "";
  return GH_PUBLISH_VERBS[noun]?.has(verb) ? noun : undefined;
}

/**
 * Does `w` use a gh api field flag? Accepts the separate form (`-F`, `--field`),
 * the glued LONG form (`--field=body=x`, delimited by `=` so `--fieldx` is not a
 * flag) and the glued SHORT form (`-Fbody=x`, where anything after the flag is
 * the value). Treating only the bare flag as a field is how `-Fbody=@notes.md`
 * stopped counting as a publish at all.
 */
function isApiFieldWord(w: string): boolean {
  if (API_FIELD_FLAGS.has(w)) return true;
  const longEq = w.indexOf("=");
  if (longEq > 0 && API_FIELD_FLAGS.has(w.slice(0, longEq))) return true;
  return w.length > 2 && API_FIELD_FLAGS.has(w.slice(0, 2));
}

/**
 * The field flag a word uses, glued or not — for the file-flags lookup (`-F` and
 * `--raw-field` read `@path`, `-f` and `--field` take a literal).
 */
function apiFlagOf(w: string): string {
  const eq = w.indexOf("=");
  if (eq > 0 && API_FIELD_FLAGS.has(w.slice(0, eq))) return w.slice(0, eq);
  if (w.length > 2 && API_FIELD_FLAGS.has(w.slice(0, 2))) return w.slice(0, 2);
  return w;
}

/**
 * The value a field word carries: after `=` for a long form, after the two-
 * character flag for a glued short one, else the next word.
 */
function apiFieldValue(
  w: string,
  rest: string[],
  k: number,
): { value: string; used: number } | undefined {
  const eq = w.indexOf("=");
  if (eq > 0 && API_FIELD_FLAGS.has(w.slice(0, eq))) return { value: w.slice(eq + 1), used: 0 };
  if (w.length > 2 && API_FIELD_FLAGS.has(w.slice(0, 2))) return { value: w.slice(2), used: 0 };
  return valueAfter(rest, k);
}

/**
 * The value half of a gh api `key=value` field operand (`body=@notes.md` →
 * `@notes.md`); a word with no `=` is its own value.
 */
function fieldValueHalf(v: string): string {
  const eq = v.indexOf("=");
  return eq > 0 ? v.slice(eq + 1) : v;
}

/** The text an `--input` file contributes, or the problem reading it. */
function inputValue(v: string): string {
  return v.startsWith("@") ? v.slice(1) : v;
}

/** One argument's worth of a command word list, with quotes already removed. */
export function scanGhPublish(argv: string[], cwd: string, scan: PublishScan): void {
  const noun = ghPublishNoun(argv);
  if (noun === undefined) return;
  scan.publishes = true;
  scan.publishKind ??= noun === "release" ? "release notes" : "body";
  const textFlags =
    noun === "release"
      ? GH_TEXT_FLAGS
      : Object.fromEntries(
          Object.entries(GH_TEXT_FLAGS).filter(
            ([flag]) => flag !== "-n" && flag !== "--notes" && flag !== "--subject",
          ),
        );
  const fileFlags = GH_BODY_FILE_FLAGS[noun] ?? {};
  // `-n` means two things to `gh release`: the NOTES text for
  // `release create`, and the NOTES FILE for `release edit`. Which one it is
  // decides who reads the word, so it is settled here from the verb — a word
  // claimed by neither reader would publish its notes unchecked, and one claimed
  // by both would read a PATH as prose and never open the file.
  const verb = argv[commandPrefixLength(argv) + 2] ?? "";
  const notesIsFile = noun === "release" && verb === "edit";
  const readFileFlags = notesIsFile
    ? fileFlags
    : Object.fromEntries(Object.entries(fileFlags).filter(([flag]) => flag !== "-n"));
  const readTextFlags = notesIsFile
    ? Object.fromEntries(
        Object.entries(textFlags).filter(([flag]) => flag !== "-n" && flag !== "--notes-file"),
      )
    : textFlags;
  // A FILE flag's word is claimed FIRST and read as a FILE. The text reader
  // below consumes a glued short word (`-Fsecret`) as inline prose, and letting it
  // do that for a FILE flag (`-Fnotes.md`, `--body-file=notes.md`) published the
  // file's contents unchecked — the roots test, the 1 MiB bound and the
  // fail-closed unreadable refusal all belong to `readPublishFile`, and none of
  // them ran while the PATH was matched as text (#1792 follow-up, item 1).
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    const fileFlag = fileFlagOf(w, readFileFlags);
    if (fileFlag !== undefined) {
      scan.textSurfaceNamed = true;
      const v = flagValueOf(w, fileFlag, argv, i);
      if (!v) continue;
      const label = fileFlags[fileFlag] ?? "body";
      const read = readPublishFile(v.value, cwd, label);
      if (read.problem) scan.problems.push(read.problem);
      else if (read.text !== undefined)
        scan.texts.push({ location: label, text: read.text, generic: true });
      i += v.used;
      continue;
    }
    for (const [flag, location] of Object.entries(readTextFlags)) {
      // A text flag must END at a delimiter. Without this, `--body` matched
      // `--body-file` as a prefix (a `-` is not a delimiter), the path was
      // collected as inline body text, and `--body-file` never reached the
      // file reader — so the file was never read, its size bound never applied,
      // and its out-of-root path was never checked. Prefix-matching a flag set
      // is how a flag's whole policy quietly stops running.
      //
      // `textFlagValue` (not `flagEndsAt` + `valueAfter`) is the reader: a
      // glued short flag (`-bsecret`, `-tsecret`, `-nsecret`) carries its value
      // in the SAME word, and `valueAfter` of that word returns the word AFTER
      // it — which scanned `gh pr comment 3 -bsecret` as a body of nothing while
      // the term sat unexamined in the flag word, and consumed an unrelated
      // argument as the text.
      const v = textFlagValue(argv, i, flag);
      if (v !== undefined) {
        scan.textSurfaceNamed = true;
        // `-` is not the text: gh takes the operand from standard input, so the
        // literal `-` is a stand-in for bytes this scan never sees. Pushing it as
        // text would let a stdin publish PASS on a one-character body.
        if (v.value === "-") scan.problems.push({ location, reason: STDIN_TEXT_REASON });
        else scan.texts.push({ location, text: v.value, generic: true });
        i += v.used;
      }
    }
  }
}

/**
 * Which file flag (if any) this word uses: the bare flag, the glued LONG form
 * (`--body-file=x`), or the glued SHORT form (`-Fnotes.md`). A glued LONG form is
 * recognised only by its own name, so `--body-file` never matches `--body`.
 */
function fileFlagOf(w: string, fileFlags: Record<string, string>): string | undefined {
  for (const flag of Object.keys(fileFlags)) {
    if (w === flag || w.startsWith(`${flag}=`)) return flag;
    if (flag.length === 2 && w.startsWith(flag) && w.length > flag.length) return flag;
  }
  return undefined;
}

/**
 * The value a flag word carries, in all three shapes: glued LONG (`--flag=x`,
 * `=`-delimited so a longer flag name is never mistaken for a prefix), glued
 * SHORT (`-Fnotes.md`, `-am<msg>` — everything after the flag characters) and
 * separate (the next word). One reader for every flag whose operand may name a
 * file, so no form reaches a matcher as prose.
 */
function flagValueOf(
  w: string,
  flag: string,
  words: string[],
  i: number,
): { value: string; used: number } | undefined {
  if (w === flag) return valueAfter(words, i);
  // A `=`-delimited long form (`--body-file=x`, `--input=@f`) is read by name;
  // a word that merely starts with the flag's name is a DIFFERENT flag, so the
  // `=`-cut is taken only when the prefix really is this flag.
  const eq = w.indexOf("=");
  if (eq > 0 && w.startsWith(`${flag}=`)) return { value: w.slice(eq + 1), used: 0 };
  // Glued SHORT (getopt): everything after the two flag characters is the value.
  if (flag.length === 2 && w.startsWith(flag) && w.length > flag.length)
    return { value: w.slice(flag.length), used: 0 };
  return undefined;
}

/** `gh api` writing to a public path: the field values are the published text. */
export function scanGhApi(argv: string[], cwd: string, scan: PublishScan): void {
  const i = commandPrefixLength(argv);
  if (commandWord(argv) !== "gh" || argv[i + 1] !== "api") return;
  const rest = argv.slice(i + 2);
  let method: string | undefined;
  let endpoint = "";
  let fields = 0;
  let inputs = 0;
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
    if (isApiFieldWord(w)) {
      // A glued form (`--field=body=x`, `-Fbody=x`) carries its value in the same
      // word, so the flag itself is what names the operand.
      const v = apiFieldValue(w, rest, k);
      if (v) {
        fields++;
        scan.textSurfaceNamed = true;
        // A FILE field is read by `readPublishFile` and nothing else — not the
        // `@`-pointer test alone, which checked the literal `@path` as prose for
        // the glued `-Fbody=@notes.md` form and published the file unchecked
        // (#1792 follow-up, item 1). `-F`/`--raw-field` are the file-taking
        // field flags; a `-f`/`--field` whose value is `@path` is a POINTER too
        // (gh reads the file for both positions), so it gets the same reading.
        const half = fieldValueHalf(v.value);
        const file = apiFileOperand(v.value) ?? apiFileOperand(half);
        const fieldFile = API_FIELD_FILE_FLAGS.has(apiFlagOf(w));
        if (file !== undefined && (fieldFile || file !== v.value)) {
          const read = readPublishFile(file, cwd, "comment");
          if (read.problem) problems.push(read.problem);
          else if (read.text !== undefined)
            texts.push({ location: "comment", text: read.text, generic: true });
        } else if (half === "-") {
          // `-F body=-` / `-Fbody=-`: gh reads the field's value from standard
          // input, so the literal `-` would be scanned as a one-character comment
          // and PASS. Same rule as the text flags and the file flags.
          problems.push({ location: "comment", reason: STDIN_TEXT_REASON });
        } else {
          // The literal that publishes: the value half, which is what `gh` sends
          // for a `key=value` field (`body=x` publishes `x`, not `body=x`).
          texts.push({ location: "comment", text: half, generic: true });
        }
        k += v.used;
      }
      continue;
    }
    if (
      w === "--input" ||
      w === "-i" ||
      w.startsWith("--input=") ||
      (w.startsWith("-i") && w.length > 2)
    ) {
      // All three shapes of `--input`: separate, glued LONG (`--input=@f.json`)
      // and glued SHORT (`-i@f.json`). Each is a WRITE whose body is a file, so
      // each is read by `readPublishFile` — a glued form that matched no flag was
      // a POST whose body nobody read (#1792 follow-up, item 1).
      const v =
        flagValueOf(w, w.startsWith("--input") ? "--input" : "-i", rest, k) ?? valueAfter(rest, k);
      if (v) {
        // `--input` IS a write. `gh api` with `--input` sends the file as the
        // request body, so it POSTs exactly as a `-f`/`-F` does — counting it
        // only as text and leaving `fields` at 0 meant an
        // `gh api …/comments --input notes.md` with no method and no field flag
        // fell through the `writes` gate below and published the file's
        // contents unchecked, including the fail-closed unreadable refusal.
        inputs++;
        scan.textSurfaceNamed = true;
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
  // gh api defaults to POST when it carries fields or an input body; an
  // explicit verb wins.
  const writes = method === undefined ? fields > 0 || inputs > 0 : API_WRITE_METHODS.has(method);
  if (!writes || !API_PUBLIC_PATH.test(endpoint)) return;
  scan.publishes = true;
  scan.publishKind ??= "comment";
  scan.texts.push(...texts);
  scan.problems.push(...problems);
}

/** `git commit -m …` / `-F file`: the message the commit will carry. */
export function scanGitCommit(argv: string[], cwd: string, scan: PublishScan): void {
  const head = argv.find((w) => !isAssignment(w) && !w.startsWith("-"));
  const base = head === undefined ? "" : (head.split("/").pop() ?? "");
  if (base !== "git") return;
  if (!argv.includes("commit")) return;
  scan.publishes = true;
  scan.publishKind ??= "commit message";
  // `--amend` alone and a plain `git commit` take their message from the editor
  // or from the commit being amended: the guard was never given a text, so there
  // is no surface to refuse and the command stays ordinary. The scan's
  // fail-closed invariant reads this flag (#1792 follow-up, item 2).
  scan.textSurfaceNamed = scan.textSurfaceNamed === true || namesCommitMessageFlag(argv);
  // A message lifted from another commit is a publish this reader cannot read at
  // all, and it is asked BEFORE the flags below: an `-am` cluster and a `-c`
  // ref in the same command both describe one commit whose text nobody has seen.
  if (commitMessageReuse(argv)) {
    scan.problems.push({ location: "commit message", reason: REUSED_MESSAGE_REASON });
    return;
  }
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    const cluster = commitCluster(w);
    if (cluster !== undefined) {
      scan.textSurfaceNamed = true;
      // A cluster carrying a reuse letter (`-ac HEAD`, `-qc HEAD`, `-amc`) takes
      // its message from ANOTHER commit, so the tail is not prose and no text this
      // guard can read is in the command — the same refusal as a bare `-c`/`-C`,
      // asked BEFORE the file/text branches so a bundled `-amc` is never read as
      // a message of `c`.
      if (cluster.reuses === true) {
        scan.problems.push({ location: "commit message", reason: REUSED_MESSAGE_REASON });
        continue;
      }
      // A bundled cluster (`-am`, `-qmx`, `-aF<file>`, `-F=x.md`) carries its
      // value in the rest of the word after the last `m`/`F`, or in the next word
      // when that tail is empty. Everything after the letter belongs to the VALUE
      // — with at most one `=` consumed as getopt's argument separator — which is
      // why `-amq SECRET` publishes `q SECRET` and `-F=x.md` opens `x.md`.
      if (cluster.kind === "commit message file") {
        const file = cluster.tail === "" ? (argv[i + 1] ?? "") : cluster.tail;
        if (cluster.tail === "") i++;
        if (file === "-") {
          scan.problems.push({ location: "commit message", reason: STDIN_MESSAGE_REASON });
          continue;
        }
        const read = readPublishFile(file, cwd, "commit message");
        if (read.problem) scan.problems.push(read.problem);
        else if (read.text !== undefined)
          scan.texts.push({ location: "commit message", text: read.text, generic: true });
        continue;
      }
      if (cluster.tail !== "") {
        if (cluster.tail === "-") {
          scan.problems.push({ location: "commit message", reason: STDIN_TEXT_REASON });
          continue;
        }
        scan.texts.push({ location: "commit message", text: cluster.tail, generic: true });
        continue;
      }
      const next = argv[i + 1];
      if (next === "-")
        scan.problems.push({ location: "commit message", reason: STDIN_TEXT_REASON });
      else if (next !== undefined)
        scan.texts.push({ location: "commit message", text: next, generic: true });
      i++;
      continue;
    }
    for (const flag of COMMIT_MESSAGE_FLAGS) {
      // Same reader as the gh text flags: `-msecret` carries the message in the
      // flag word, and reading the NEXT word instead scanned a one-word commit
      // message as nothing while the term sat in `-msecret` itself.
      const v = textFlagValue(argv, i, flag);
      if (v !== undefined) {
        scan.textSurfaceNamed = true;
        // `-m -` / `-m=-`: git reads the message from standard input, so the
        // literal `-` is no message at all and scanning it would be a pass.
        if (v.value === "-")
          scan.problems.push({ location: "commit message", reason: STDIN_TEXT_REASON });
        else scan.texts.push({ location: "commit message", text: v.value, generic: true });
        i += v.used;
      }
    }
    for (const flag of COMMIT_MESSAGE_FILE_FLAGS) {
      if (w !== flag && !w.startsWith(`${flag}=`)) continue;
      scan.textSurfaceNamed = true;
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
