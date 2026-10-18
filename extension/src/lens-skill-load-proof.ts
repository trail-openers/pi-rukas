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
 * SHADOW MODE (`runLensChild`). Round 3 of the #1530 review found a residual
 * class of false refutations that the abstentions above do not cover, so
 * `unproven` is currently **traced, not enforced** — the child's own marker
 * decides, exactly as it did before this check existed (`git revert` of #995's
 * consumer half restores the enforced behaviour byte-for-byte). Promoting
 * `unproven` back to a block is the follow-up, and its precondition is the
 * shadow log showing no false refutations, per the repo's rule that a new
 * judgement seam starts in shadow and earns enforce.
 *
 * KNOWN LIMITATION the enforce follow-up must settle first — the two
 * `observedToolCalls` abstentions above are WEAKER than they look. The spawn
 * layer only stamps the live count when the replay carried NOTHING
 * (`reconcileObservedCounts` in `spawn-support.ts` gates on
 * `result.toolUses.length === 0`), so for any non-empty `toolUses` the second
 * guard is dead code and the first never fires: an under-recovered-but-non-empty
 * replay (live 5, recovered 2, the read among the 3 dropped) reaches `unproven`.
 * Shadow mode is what makes that survivable — it only ever warns. Enforcing
 * needs either the live count for every replay, or a rule that never refutes on
 * a partial array.
 *
 * This module reads paths as DATA and performs no shell parsing of anything it
 * executes: the bash branch tokenises a command string purely to compare paths,
 * never to run it.
 */

import path from "node:path";
import {
  SKILL_FILE_NAME,
  candidateDirs,
  lexical,
  resolveSkillDir,
  sameFileAsAny,
  skillFileCandidates,
} from "./lens-skill-path.ts";

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
 *
 * A reader verb is not sufficient on its own: the segment must also be a
 * READING segment. `cat x > <skill>/SKILL.md` truncates the skill and `sed -i`
 * rewrites it, and neither puts the file's content in the child's context — so
 * `REDEDIRECT` / `-i` disqualify the segment (see `segmentReadsFile`).
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

/** The name of the file that holds a skill lives with the path logic that
 * resolves it (`SKILL_FILE_NAME`, lens-skill-path.ts) — the pre-filter below and
 * the matcher there must not disagree about it.
 *
 * What the prompt hands the child is a skill DIRECTORY (`path.join(skillsDir,
 * lens.skill)`), and the thing inside it that holds the skill is always this
 * file — and only this file counts (see `matchesSkillFile`). Matching "anything
 * under the directory" would let a read of a sibling — `references/cheatsheet.md`,
 * another skill's notes dropped in the same dir — stand in for the skill itself,
 * and crediting the bare directory let a read that opened nothing pass. */

/** Shell separators that begin a new segment, so a reader verb and the path it
 * opens are judged within ONE command. Longest first: `&&` must be cut before
 * `&` or the second half arrives as a lone `&` token.
 *
 * `>` and `>>` are deliberately NOT separators, even though a shell treats them
 * as such: this matcher reads the redirect form to *disqualify* the segment (see
 * `isWriteToken`), and splitting on them would hand `&>` to the verb rule as a
 * bare `>` segment and leave the append/combined forms invisible to the write
 * rule — the `&` arm of `REDIRECT_TOKEN` would then be dead code that no test can
 * observe. They stay inside one segment so both judgements see the same text. */
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;

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

/** A token that sends a command's output somewhere: `>`, `>>`, `2>`, `2>>`,
 * `&>`, `&>>`. A segment carrying one WRITES, so whatever else it names, it is
 * not evidence the child read the file — `cat x > <skill>/SKILL.md` destroys it.
 * The three optional arms each cover a real spelling and each is pinned by a
 * case, because a matcher missing one silently credits that write as a read:
 *   - leading digits — the fd form (`2>`), tested by 1am;
 *   - the doubled `>` — append (`>>`), tested by 1ag;
 *   - a leading `&` — the combined stdout+stderr form (`&>`), tested by 1ap.
 * `&` is grouped with the digits rather than appended after the `>` because the
 * shell spells the combined form `&>`, not `>&`; a `?` in the wrong position
 * here matches nothing and no test notices unless one pins it. The prefix group
 * is optional as a whole — a bare `>` is the plain truncate form and the common
 * case, so a regex that required a prefix would let every ordinary redirect
 * through as a read.
 * A false `unproven` on a genuinely-reading command is a judgement the shadow log
 * has to clear, so erring toward "this is a write" is the safe direction. */
const REDIRECT_TOKEN = /^(?:\d+|&)?>>?/;

/** `sed`'s in-place flag, in either of the two spellings that reach a shell
 * (`-i`, `--in-place`). Bare `sed` prints; `sed -i` rewrites the file. */
const SED_IN_PLACE = /^-i$|^--in-place(?:=|$)/;

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
  // Every spelling of the skill FILE this check will accept, all of them built
  // by THIS process from the driver's `skillPath` (`path.join(skillsDir,
  // lens.skill)`) — never from anything a child wrote. A child-supplied path is
  // compared against this list lexically, and `realpathSync` is never called on
  // it (see `canonicalSkillFiles`).
  const wants = skillFileCandidates(dir);
  // The directory form of each accepted spelling, so a command that named the
  // DIRECTORY (an error, not a load) is rejected explicitly.
  const dirs = candidateDirs(wants);

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
    if (isSkillRead(name, args, dirs, wants)) return "proven";
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
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  if (READ_TOOLS.has(toolName)) {
    const v = args[PATH_KEY];
    // SKILL.md ONLY. The prompt hands the child a DIRECTORY, but the read it
    // asks for is `<dir>/SKILL.md`, and crediting the bare directory was the
    // round-3 finding: it let a read that named the directory and opened
    // nothing stand in for the file.
    return typeof v === "string" ? matchesSkillFile(v, dirs, wants) : false;
  }
  if (toolName !== "bash") return false;
  const command = typeof args[COMMAND_KEY] === "string" ? (args[COMMAND_KEY] as string) : "";
  if (command === "") return false;
  // Cheap substring pre-filter over every spelling the child may have used
  // (the prompt's own path, or the symlink target it opened), and a mutation
  // trap. Without it, a matcher that tested only `command.includes(want)` would
  // pass the positive cases AND the negative ones, because the segment / verb /
  // whole-token judgements below would never be reached — so the suite stays
  // green with the parser deleted. With it, deleting any one of them is
  // observable.
  // Cheap pre-filter, and a mutation trap. Without it, a matcher that tested
  // only `command.includes(want)` would pass the positive cases AND the negative
  // ones, because the segment / verb / whole-token judgements below would never
  // be reached — so the suite stays green with the parser deleted. With it,
  // deleting any one of them is observable.
  //
  // It tests the FILE NAME only, for three reasons, and the third is the one that
  // makes it a correctness fix rather than a shortcut:
  //   1. a child may reach the same file by a `..` detour (`<skill>/../<skill>/
  //      SKILL.md`, case 1ag) or through a symlink whose canonical prefix the
  //      driver never spells, and a filter demanding the driver's exact spelling
  //      would drop those before the matcher ran — which is how the directory
  //      rejection in `tokenMatches` became untestable;
  //   2. a command that never mentions `SKILL.md` cannot have opened it, so the
  //      file name is the cheapest sound necessary condition;
  //   3. it keeps every real judgement in `commandReadsSkillFile` reachable, so
  //      each of the verb / write / whole-token rules below can actually be
  //      violated by a mutation and caught by a test.
  if (!command.includes(SKILL_FILE_NAME)) return false;
  return commandReadsSkillFile(command, dirs, wants);
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
function commandReadsSkillFile(
  command: string,
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const tokens = segment
      .split(/\s+/)
      .map(stripQuotes)
      .filter((t) => t !== "");
    if (tokens.length < 2) continue;
    // The verb itself is skipped when looking for a path — `cat cat` names no
    // file — so every predicate below is over `tokens.slice(1)` except the
    // verb check, which is index 0.
    const verb = tokens[0];
    if (verb === undefined || !READER_VERBS.has(verb.toLowerCase())) continue;
    const operands = tokens.slice(1);
    // A segment that WRITES is not a read, even when it names the file.
    if (operands.some(isWriteToken)) continue;
    // Each token is compared WHOLE after resolution, never as a substring, so
    // `cat <skill>-x/SKILL.md` (a sibling directory whose name starts with
    // this one) and `FOO=<skill>-x cat noop` (an assignment that merely
    // CONTAINS the path) both resolve to something that is not the skill file.
    if (operands.some((token) => tokenMatches(token, dirs, wants))) return true;
  }
  return false;
}

/** Does this token make the segment a WRITE? See `REDIRECT_TOKEN` /
 * `SED_IN_PLACE`. Judged on the raw (quote-stripped) token, so `-i` and
 * `--in-place` are matched as whole words, not as substrings of a longer flag. */
function isWriteToken(token: string): boolean {
  return REDIRECT_TOKEN.test(token) || SED_IN_PLACE.test(token);
}

/** Does a token inside a bash command name the skill file? Compared WHOLE —
 * never as a substring — against the driver's own spellings of the file, with
 * the same inode-identity fallback `matchesSkillFile` uses. */
function tokenMatches(token: string, dirs: readonly string[], wants: readonly string[]): boolean {
  const got = lexical(token);
  if (!got) return false;
  // A directory naming inside a reader command is not a read of the file: a
  // `cat <dir>` on a directory is an error, not a load. Every dir spelling is
  // rejected, not just one.
  if (dirs.includes(got)) return false;
  if (wants.includes(got)) return true;
  return sameFileAsAny(got, wants);
}

/**
 * Is this `read` path value the lens's skill FILE?
 *
 * Exactly ONE shape counts, and it is the one the prompt can produce: the file
 * itself. The directory the prompt hands the child is a directory, not a file —
 * crediting it (the pre-round-3 rule) accepted a read that opened nothing — and
 * any other value is not the skill file: a sibling inside the directory, a
 * nested reference doc, a prefix-sharing directory, or a directory whose name
 * merely ENDS with this skill's.
 *
 * Two ways to be the file, and they are deliberately asymmetric in cost:
 *
 *   1. the fast, lexical one — the whole normalised path equals one of the
 *      driver's own spellings. Total, deterministic, no syscall, and it settles
 *      every case where the child quoted the prompt's path back.
 *   2. the identity one — the path's inode is the skill file's inode. This is
 *      the ONLY place a child-supplied string reaches the filesystem, and it is
 *      gated so it can only ever CONFIRM, never refute: it runs after (1) misses
 *      and only adds a `proven`. Without it a child that read the symlink target
 *      under a prefix the driver never spells (`/var` → `/private/var` on macOS
 *      is the everyday one) is refuted for telling the truth — the false-downgrade
 *      class that made this check shadow-only.
 *
 * Containment is the point of BOTH arms: a bare `basename === "SKILL.md"` proved
 * `/tmp/zzz/SKILL.md` for a lens whose skill lives elsewhere, so the identity arm
 * compares against the driver's resolved file, not against a file name.
 */
function matchesSkillFile(
  candidate: string,
  dirs: readonly string[],
  wants: readonly string[],
): boolean {
  const got = lexical(candidate);
  if (!got) return false;
  if (dirs.includes(got)) return false;
  if (wants.includes(got)) return true;
  return sameFileAsAny(got, wants);
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

/** Test-only surface: a decision input a behavioural assertion cannot reach,
 * because the `read` branch short-circuits before a rejected key is ever
 * consulted. Declared last so it can name a constant defined above; nothing
 * outside the smoke test reads it. */
export const __tests__ = { PATH_KEY };
