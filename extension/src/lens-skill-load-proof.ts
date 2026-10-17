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
 * Two directions of error, and they are not symmetric. A false `proven` lets a
 * fake SUCCESS through to a merge gate. A false `unproven` — which is what a
 * refutation becomes in the caller — blocks a lens that did the work, and a
 * check that blocks honest lenses on a parsing artifact is a check every review
 * starts losing. Round 2 of the #1530 review found the first version producing
 * exactly that second failure, so the rule now is: prove only what is
 * positively there, and abstain whenever the evidence itself is suspect.
 *
 * ABSTAIN (`unverifiable`) rather than refute when:
 *   - the replay under-recovered tool calls (`observedToolCalls` — the live
 *     count — exceeds `toolUses.length`), so a real read may simply be absent
 *     from the array the decision is made from;
 *   - the live count is absent AND no tool call was recorded at all (a child
 *     killed mid-flight: `agent_end.messages` holds only the last retry
 *     segment, which is why `observedToolCalls` exists at all).
 *
 * `runLensChild` treats a refutation as FAILED and an unverifiable claim as
 * absent. This module reads paths as DATA and performs no shell parsing of
 * anything it executes: the bash branch tokenises a command string purely to
 * compare paths, never to run it.
 */

import fs from "node:fs";
import path from "node:path";

/** The three outcomes of checking a claimed SUCCESS against the tool calls. */
export type SkillLoadProof = "proven" | "unproven" | "unverifiable";

/**
 * What counts as loading the skill file: Pi's `read` tool, or a bash reader
 * verb over the same file. The bash forms are accepted because `read` is not
 * the only way the child can honestly have the file's content in context, and
 * rejecting a lens whose child used `cat` would trade a false positive for a
 * false negative.
 *
 * `grep` / `rg` / `ls` / `echo` deliberately absent: those name the path
 * without opening it. A grep proves a line was seen, not that the file was
 * loaded. The verb is judged as the FIRST word of a command segment, so
 * `grep x cat <skill>` — `cat` as an argument, not a verb — does not read as
 * a file being opened.
 */
const READ_TOOLS = new Set(["read"]);
const READER_VERBS = new Set(["cat", "sed", "head", "tail", "nl", "less"]);

/**
 * The only argument key that carries a path to Pi's `read` tool.
 *
 * Verified against the pinned package (AGENTS.md §4): `readSchema` in
 * `@earendil-works/pi-coding-agent/dist/core/tools/read.js` declares
 * `path: Type.String(...)` and `execute` destructures `{ path, offset, limit }`.
 * The renderers also accept `file_path` — but a renderer reads back an
 * argument the MODEL already wrote, so accepting it here would widen the proof
 * to a spelling the tool cannot consume: `read { file_path }` fails with a
 * required-parameter error and no file was opened.
 *
 * A LIST is not a harmless widening: the `read` branch returns on the first
 * key that matches, so `["path", "file_path"]` keeps every behavioural
 * assertion green while crediting a call the tool itself rejects. That is why
 * the constant is pinned by name through `__tests__` at the bottom of this
 * file — the one decision input a behavioural test cannot reach.
 */
const PATH_KEY = "path";

/** Pi's bash tool declares a single string argument named `command`. */
const COMMAND_KEY = "command";

/** What the prompt hands the child is a skill DIRECTORY (`path.join(skillsDir,
 * lens.skill)`), and the thing inside it that holds the skill is always this
 * file. Matching "anything under the directory" would let a read of a sibling
 * — `references/cheatsheet.md`, another skill's notes dropped in the same dir —
 * stand in for the skill itself. */
const SKILL_FILE_NAME = "SKILL.md";

/** Shell separators that begin a new segment, so a reader verb and the path it
 * opens are judged within ONE command. Longest first: `&&` must be cut before
 * `&` or the second half arrives as a lone `&` token. */
const SEGMENT_SPLIT = /&&|\|\||[;&|\n]/;

/** Surrounding quote characters the shell removes before the command runs.
 * Stripped as a pair-wise wrap, not globally — a path carrying an interior
 * quote is not a path claim. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
];

/** Backslash escapes, removed after quote-stripping (a shell strips them too).
 * Only a trailing one matters — an escaped final space or quote. */
const TRAILING_ESCAPES = /\\+$/;

/**
 * Did any recorded tool call actually open this lens's skill file?
 *
 * `observedToolCalls` is the live count the spawn layer recovered even where
 * the replay did not (`spawn-support.ts` `reconcileObservedCounts`); pass it
 * through from the `DispatchResult` so under-recovery reads as absence of
 * evidence rather than as a refutation.
 *
 * `toolUses` is `unknown[]` by contract (`types.ts`) — the blocks are Pi's,
 * shape not ours — so every field is read defensively and a malformed entry is
 * skipped, never trusted.
 */
export function skillLoadProof(
  toolUses: readonly unknown[],
  skillPath: string,
  observedToolCalls?: number,
): SkillLoadProof {
  const calls = (toolUses ?? []).filter(
    (tu): tu is Record<string, unknown> => !!tu && typeof tu === "object",
  );
  const dir = resolveSkillDir(skillPath);
  // The dir cannot be resolved at all — nothing to match, and a check that
  // could not run is not a refutation of the child.
  if (!dir) return "unverifiable";
  const want = path.posix.join(dir, SKILL_FILE_NAME);

  // A positive match is a POSITIVE: the read is in the array, so it happened,
  // and no gap elsewhere in the replay un-happens it. Proving first is what
  // keeps an under-recovered replay from throwing away the one lens in a
  // review that did record its read.
  for (const tu of calls) {
    const name = typeof tu.name === "string" ? tu.name.toLowerCase() : "";
    const args =
      tu.arguments && typeof tu.arguments === "object"
        ? (tu.arguments as Record<string, unknown>)
        : {};
    if (isSkillRead(name, args, dir, want)) return "proven";
  }
  // No match. NOW the completeness of the evidence decides what absence means.
  // The child made calls the replay did not carry, so the read may simply be
  // among the calls we never saw — absence proves nothing.
  if (typeof observedToolCalls === "number" && observedToolCalls > calls.length) {
    return "unverifiable";
  }
  if (calls.length === 0) return "unverifiable";
  return "unproven";
}

function isSkillRead(
  toolName: string,
  args: Record<string, unknown>,
  dir: string,
  want: string,
): boolean {
  if (READ_TOOLS.has(toolName)) {
    const v = args[PATH_KEY];
    return typeof v === "string" ? matchesSkillFile(v, dir, want) : false;
  }
  if (toolName !== "bash") return false;
  const command = typeof args[COMMAND_KEY] === "string" ? (args[COMMAND_KEY] as string) : "";
  if (command === "") return false;
  // Cheap substring pre-filter, and a mutation trap. Without it, a matcher
  // that tested only `command.includes(want)` would pass the positive cases
  // AND the negative ones, because the segment / verb / whole-token judgements
  // below would never be reached — so the suite stays green with the parser
  // deleted. With it, deleting any one of them is observable.
  if (!command.includes(want) && !command.includes(dir)) return false;
  return commandReadsSkillFile(command, dir, want);
}

/**
 * Does this bash command open `want`?
 *
 * Split into segments on the shell separators, then within each segment: the
 * FIRST word must be a reader verb and some token in that same segment must
 * resolve to the skill file. Both judgements are per-segment, which is what
 * keeps `echo <skill>/SKILL.md` (no verb) and `grep x cat <skill>` (`cat` as
 * an argument, not a verb) from reading as a file being opened, while
 * `ls -la; cat <skill>/SKILL.md` still counts.
 *
 * The tokeniser is deliberately coarse — whitespace and separators only. It is
 * a matcher over data, not a shell: it can be fooled by quoting that hides a
 * path from the split, and the cost of that is one unproven claim, not a
 * wrong merge.
 */
function commandReadsSkillFile(command: string, dir: string, want: string): boolean {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const tokens = segment
      .split(/\s+/)
      .map(stripQuotes)
      .filter((t) => t !== "");
    if (tokens.length < 2) continue;
    // `tokens.length < 2` above makes index 0 safe; the explicit check is what
    // lets noUncheckedIndexedAccess see it.
    const verb = tokens[0];
    if (verb === undefined || !READER_VERBS.has(verb.toLowerCase())) continue;
    // The verb itself is skipped — `cat cat` names no file.
    //
    // Each token is compared WHOLE after resolution, never as a substring, so
    // `cat <skill>-x/SKILL.md` (a sibling directory whose name starts with
    // this one) and `FOO=<skill>-x cat noop` (an assignment that merely
    // CONTAINS the path) both resolve to something that is not the skill file.
    if (tokens.slice(1).some((token) => matchesSkillFile(token, dir, want))) return true;
  }
  return false;
}

function stripQuotes(token: string): string {
  let out = token.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(1, -1).trim();
    }
  }
  return out.replace(TRAILING_ESCAPES, "");
}

/**
 * Does this path value name the lens's skill file?
 *
 * Two spellings count, and they are exactly the two the prompt can produce:
 * the file itself, and the directory the prompt names — which is a directory,
 * not a file, so the read the prompt asks for is always `<dir>/SKILL.md` and
 * naming the directory can only ever mean that file. Anything else is not the
 * skill file: a sibling inside the directory, a nested reference doc, a
 * prefix-sharing directory, or a directory whose name merely ENDS with this
 * skill's.
 */
function matchesSkillFile(candidate: string, dir: string, want: string): boolean {
  const got = resolvePath(candidate);
  if (!got) return false;
  if (got === want) return true;
  if (got === dir) return true;
  return path.posix.basename(got) === SKILL_FILE_NAME && path.posix.dirname(got) === dir;
}

/** Test-only surface: a decision input a behavioural assertion cannot reach,
 * because the `read` branch short-circuits before a rejected key is ever
 * consulted. Declared last so it can name a constant defined above; nothing
 * outside the smoke test reads it. */
export const __tests__ = { PATH_KEY };

/** The skill DIRECTORY the proof is about, canonicalised — or "" when the
 * driver handed us nothing to match, in which case no tool call can prove it. */
function resolveSkillDir(skillPath: string): string {
  return resolvePath(skillPath ?? "");
}

/**
 * Best-effort canonical form of a path a CHILD reported (or that the driver
 * built).
 *
 * `realpathSync` FIRST, because the skills directory install.sh populates is
 * symlinks into the repo's `skill/` tree — so the path the driver built and
 * the path the child opened are two different strings for the same file. A
 * check that compared the strings would refute every honest child.
 *
 * Then `path.posix.normalize`, which collapses `.` / `..` / duplicate
 * separators without touching the filesystem. Both steps are best-effort:
 * `realpathSync` throws on a path that does not exist (a unit-test fixture, a
 * skill uninstalled between the pre-spawn stat and this check), and this module
 * must never throw its way into blocking a review.
 */
function resolvePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  try {
    return fs.realpathSync(trimmed);
  } catch {
    // Fall through to the lexical form.
  }
  return path.posix.normalize(trimmed.replace(/\\/g, "/").replace(/\/+$/, ""));
}
