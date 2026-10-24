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

import { apiFileOperand, readPublishFile } from "./public-hygiene-files.ts";
import { isAssignment, textFlagValue, valueAfter } from "./public-hygiene-operands.ts";
import { commandPrefixLength } from "./public-hygiene-prefix.ts";
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
  if (argv[i] !== "gh") return undefined;
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
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    for (const [flag, location] of Object.entries(textFlags)) {
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
        scan.texts.push({ location, text: v.value, generic: true });
        i += v.used;
      }
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
export function scanGhApi(argv: string[], cwd: string, scan: PublishScan): void {
  const i = commandPrefixLength(argv);
  if (argv[i] !== "gh" || argv[i + 1] !== "api") return;
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
        // `@path` is a POINTER to text, in either position gh accepts it —
        // `-F @notes.md` and `-F body=@notes.md` both make gh read the file — so
        // the pointer is tested on the whole value and on its `=`-half. A field
        // whose text lives in a file therefore gets the same roots test, size
        // bound and unreadable refusal `--body-file` applies; checking the
        // literal `@notes.md` instead checked prose and let the file's contents
        // publish unchecked.
        const half = fieldValueHalf(v.value);
        const file = apiFileOperand(v.value) ?? apiFileOperand(half);
        const fieldFile = API_FIELD_FILE_FLAGS.has(apiFlagOf(w));
        if (file !== undefined && (fieldFile || file !== v.value)) {
          const read = readPublishFile(file, cwd, "comment");
          if (read.problem) problems.push(read.problem);
          else if (read.text !== undefined)
            texts.push({ location: "comment", text: read.text, generic: true });
        } else {
          // The literal that publishes: the value half, which is what `gh` sends
          // for a `key=value` field (`body=x` publishes `x`, not `body=x`).
          texts.push({ location: "comment", text: half, generic: true });
        }
        k += v.used;
      }
      continue;
    }
    if (w === "--input" || w === "-i") {
      const v = valueAfter(rest, k);
      if (v) {
        // `--input` IS a write. `gh api` with `--input` sends the file as the
        // request body, so it POSTs exactly as a `-f`/`-F` does — counting it
        // only as text and leaving `fields` at 0 meant an
        // `gh api …/comments --input notes.md` with no method and no field flag
        // fell through the `writes` gate below and published the file's
        // contents unchecked, including the fail-closed unreadable refusal.
        inputs++;
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
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] ?? "";
    for (const flag of COMMIT_MESSAGE_FLAGS) {
      // Same reader as the gh text flags: `-msecret` carries the message in the
      // flag word, and reading the NEXT word instead scanned a one-word commit
      // message as nothing while the term sat in `-msecret` itself.
      const v = textFlagValue(argv, i, flag);
      if (v !== undefined) {
        scan.texts.push({ location: "commit message", text: v.value, generic: true });
        i += v.used;
      }
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
