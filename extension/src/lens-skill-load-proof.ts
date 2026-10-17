/**
 * lens-skill-load-proof — was the skill actually read, or only claimed?
 *
 * The lens child self-reports `Skill Load Status: SUCCESS` in its closing
 * reply. Since #995 the prompt defines that word in terms of an action the
 * child takes — `read <skillPath>` before reviewing — but until now the word
 * was all the parent had: the marker was matched against the child's prose and
 * nothing else. A child that never called `read` (or called it on a different
 * path) got the same SUCCESS as one that loaded its skill, and the review was
 * credited with a guided lens it never had. That is the SECURITY finding on PR
 * #1530: an unverified claim feeding an APPROVED verdict.
 *
 * So SUCCESS is now corroborated against the child's recorded tool calls. The
 * evidence source is `DispatchResult.toolUses` — the `toolCall` content blocks
 * of the child's own event stream (`spawn-collapse-events.ts`) — executed
 * evidence, not narration. It is read as DATA and never executed: nothing here
 * reaches a shell.
 *
 * Absence is not a refutation. `toolUses` is empty for a child killed
 * mid-flight (`agent_end.messages` holds only the last retry segment; that is
 * why `observedToolCalls` exists at all), so a SUCCESS with no recorded tool
 * calls is `unverifiable`, and the caller — not this module — decides what that
 * means. `runLensChild` treats a refutation as FAILED and an unverifiable claim
 * as absent.
 */

/** The three outcomes of checking a claimed SUCCESS against the tool calls. */
export type SkillLoadProof = "proven" | "unproven" | "unverifiable";

/**
 * What counts as loading a skill file: Pi's `read` tool, or a bash read of the
 * same file (`cat` / `sed` / `head` / `tail` / `nl`). The bash forms are
 * accepted because `read` is not the only way the child can honestly have the
 * file's content in context, and rejecting a lens whose child used `cat` would
 * trade a false positive for a false negative.
 *
 * `grep` / `rg` deliberately absent: a grep proves a line was seen, not that
 * the file was loaded. The verb is anchored to the start of the command or to
 * a shell separator, so `grep x cat <skill>` — `cat` as an argument, not a
 * verb — does not read as a file being opened.
 */
const READ_TOOLS = new Set(["read"]);
const READER_VERBS = ["cat", "sed", "head", "tail", "nl"];
const SEPARATORS = [";", "&&", "||", "|", "\n"];

/** True when `command` starts with (or follows a shell separator with) one of
 * the reader verbs — the anchored form, so a verb appearing as an argument of
 * another command does not qualify. */
function startsWithReaderVerb(command: string): boolean {
  for (const verb of READER_VERBS) {
    if (command.startsWith(`${verb} `)) return true;
    for (const sep of SEPARATORS) {
      if (command.includes(`${sep} ${verb} `)) return true;
    }
  }
  return false;
}

/**
 * What may sit immediately BEFORE a path so that the path starts here.
 *
 * A path run is maximal over word characters, `.`, `/` and `-`, so a match
 * that begins mid-run is a substring hit, not a path hit: without a leading
 * delimiter, `FOO=/skills/x` and `/opt/skills/x` both "contain" `/skills/x`.
 * `=`/`<`/`>` are in the set for the assignments and redirects that put a path
 * after them; a `/` may NOT be, since every absolute path begins with one.
 */
const PATH_HEAD = [" ", "\t", "\n", '"', "'", "=", "<", ">"];

/**
 * What may sit immediately AFTER a complete path.
 *
 * Deliberately different from `PATH_HEAD`, in both directions:
 *
 *   - `/` IS a tail delimiter even though it is a path character, because the
 *     claim the prompt makes is about the skill DIRECTORY and the child reads
 *     a file inside it (`<skillPath>/SKILL.md`). Requiring the path to end
 *     there would reject the exact behaviour the marker describes, and
 *     `stripPathNoise` cannot fix it because the separator sits mid-string.
 *     A `/` at the END is handled by the strip instead, so `cat <path>/` reads
 *     as the same argument as `cat <path>`.
 *   - `=`/`<`/`>` are NOT tail delimiters although they head ones: they are
 *     path characters and an assignment or redirect can only put a path AFTER
 *     them, never after a path.
 *
 * `-` and `.` stay out in both directions: `code-review-security-x` and
 * `code-review-security.md` are different files, and a check that called them
 * matches would be a check that approves an unverified claim.
 */
const PATH_TAIL = [" ", "\t", "\n", '"', "'", "/"];

/** Tool-call argument keys that can carry a file path (`command` is bash's own
 * spelling; the read tool's is `path`). */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target_file"] as const;

/** Everything a tool call can spell as text, for the bash-command scan. */
const TEXT_KEYS = [...PATH_KEYS, "command", "cmd", "script"] as const;

/** Quote characters a shell removes before the command sees the argument, plus
 * the backtick. The ASCII double quote is load-bearing: an argument arrives as
 * `cat "<path>"` about as often as bare, and a surviving quote would sit
 * exactly where the tail delimiter has to match. */
const QUOTE_CHARS = ['"', "'", "`", "\\", "“", "”"];

/**
 * Did any recorded tool call actually open `skillPath`?
 *
 * `toolUses` is `unknown[]` by contract (`types.ts`) — the blocks are Pi's,
 * shape not ours — so every field is read defensively and a malformed entry is
 * skipped, never trusted.
 */
export function skillLoadProof(toolUses: readonly unknown[], skillPath: string): SkillLoadProof {
  const calls = (toolUses ?? []).filter(
    (tu): tu is Record<string, unknown> => !!tu && typeof tu === "object",
  );
  if (calls.length === 0) return "unverifiable";
  const want = normalisePath(skillPath);
  if (!want) return "unproven";
  for (const tu of calls) {
    const name = typeof tu.name === "string" ? tu.name.toLowerCase() : "";
    const args =
      tu.arguments && typeof tu.arguments === "object"
        ? (tu.arguments as Record<string, unknown>)
        : {};
    if (isSkillRead(name, args, textFields(args), want)) return "proven";
  }
  return "unproven";
}

function isSkillRead(
  toolName: string,
  args: Record<string, unknown>,
  strings: string[],
  want: string,
): boolean {
  // A `read` whose path argument resolves to the skill file — or to a file
  // INSIDE that directory. The second form is not a loosening: the prompt
  // hands the child the skill DIRECTORY, which is a directory, so the read it
  // performs is `<skillPath>/SKILL.md`. A check demanding byte equality with
  // the directory would refute every honest child and block every lens.
  // Path-shaped values only — prose is not a path claim. Every path-shaped key
  // is tried: stopping at the first one that merely exists would reject a call
  // that spells the path under another accepted key.
  if (READ_TOOLS.has(toolName)) {
    for (const key of PATH_KEYS) {
      const v = args[key];
      if (typeof v !== "string") continue;
      const got = normalisePath(v);
      if (got === want || (got.startsWith(`${want}/`) && got.length > want.length + 1)) {
        return true;
      }
    }
    return false;
  }
  if (toolName !== "bash") return false;
  const joined = strings.join(" ");
  if (!startsWithReaderVerb(joined)) return false;
  return strings.some((s) => mentionsPath(stripPathNoise(s), want));
}

/** Quotes and a path's optional trailing separator — spelling noise around an
 * otherwise exact path. A `/` INSIDE a path is left alone, which is what keeps
 * `/opt<skillPath>` from ever lining up with `skillPath`. */
function stripPathNoise(text: string): string {
  let out = text;
  for (const q of QUOTE_CHARS) out = out.replaceAll(q, "");
  return out.replace(/\/+(?=\s|$)/g, "").replace(/\\+(?=\s|$)/g, "");
}

/** Does `text` contain `want` as a whole path token — delimited at the front
 * by something that cannot be part of a path, and at the end by the same (or
 * the end of the string)? */
function mentionsPath(text: string, want: string): boolean {
  if (!text.includes(want)) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(want, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text.charAt(at - 1);
    const afterIndex = at + want.length;
    const after = afterIndex >= text.length ? "" : text.charAt(afterIndex);
    if (PATH_HEAD.includes(before) && (after === "" || PATH_TAIL.includes(after))) return true;
    from = at + 1;
  }
}

function textFields(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of TEXT_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
}

/** Absolute, forward-slashed, trailing separator gone, `.` / `..` collapsed —
 * so `/skills/./x/` and `/skills/x` are the same path on any platform. */
function normalisePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return resolvePosix(trimmed.replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** `path.resolve` against a fixed root rather than the process cwd: these are
 * paths a CHILD reported, and the parent's cwd must not decide whether
 * `skills/x` means the same thing as `/skills/x`. A relative path stays
 * relative under a marker root, so it can only ever equal another relative
 * spelling of itself — never a real absolute path. */
const MARKER_ROOT = "/";
function resolvePosix(p: string): string {
  const absolute = p.startsWith("/");
  const segments: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(seg);
  }
  return (absolute ? MARKER_ROOT : "") + segments.join("/");
}
