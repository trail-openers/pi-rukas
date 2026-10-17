#!/usr/bin/env bun
/**
 * The lens prompt tells the child to `read` its skill — issue #995.
 *
 * Pi's `--skill <path>` advertises a skill (name, description, location); it
 * does NOT inline the SKILL.md body into the child's context. Pi's own
 * `formatSkillsForPrompt` emits the instruction "Use the read tool to load a
 * skill's file", and only the `/skill:name` slash command expands a body —
 * which `--skill` never calls. So a lens child spawned with
 * `--no-skills --skill <path>` sees a location and nothing else.
 *
 * That makes the `Skill Load Status` marker (#882) meaningful only if the
 * prompt defines it in terms of a `read` the child actually performs:
 * SUCCESS = the read returned content, FAILED = the read errored. Before #995
 * `lensPromptFor` said nothing about loading the skill at all, and the child's
 * only guidance was a role prompt that named a `skill` tool Pi does not
 * register — so FAILED could be raised for calling a nonexistent tool, and a
 * lens blocked on a phantom.
 *
 * These are the pure-function cases: no spawn, no mock, just the composed
 * prompt string. They live apart from `test-lens-skill-wiring.ts`, which owns
 * the spawn-path cases (a/b/c/d) and the marker-parsing cases (e/f/g/h), and
 * was heading for the 500-line cap with these in it.
 *
 * **The absent-path branch matters as much as the present one.** When
 * `skillPath` is not threaded (a pure-function caller), the section is omitted
 * so the prompt stays byte-identical to its pre-#995 output. That is the
 * contract `lens-review-child.ts` depends on when it passes the path it
 * already computed for `--skill`.
 */

import { lensPromptFor } from "../src/lens-review-format.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const READ_SENTENCE = "use the `read` tool to load your assigned skill file";
const NOT_INLINED = "NOT inlined in your context";

{
  const fakePath = "/tmp/skills/code-review-security";
  const lensEntry = LENS_ROSTER[0] as never as { name: string; skill: string };
  const withPath = lensPromptFor(
    lensEntry,
    "diff --git a/a b/a",
    "ctx",
    undefined,
    [],
    undefined,
    fakePath,
  );
  assert(
    withPath.includes(READ_SENTENCE),
    "(i) prompt with skillPath instructs the child to use the `read` tool",
  );
  assert(
    withPath.includes(fakePath),
    "(i) the absolute skill path is embedded in the read instruction",
  );
  assert(
    withPath.includes(NOT_INLINED),
    "(i) prompt states the skill file is NOT inlined in context",
  );
  assert(
    withPath.includes("Skill Load Status: SUCCESS"),
    "(i) prompt defines SUCCESS = the read returned content",
  );
  assert(
    withPath.includes("Skill Load Status: FAILED"),
    "(i) prompt defines FAILED = the read failed",
  );
  // The instruction must come BEFORE the review work, not after it — a child
  // that reads the skill after writing findings was never guided by it.
  assert(
    withPath.indexOf(READ_SENTENCE) < withPath.indexOf("Diff to review:"),
    "(i) the read instruction precedes the diff the child is asked to review",
  );
  // Without skillPath: no read section (byte-identical to pre-#995).
  const withoutPath = lensPromptFor(lensEntry, "diff --git a/a b/a", "ctx", undefined, []);
  assert(
    !withoutPath.includes(READ_SENTENCE) && !withoutPath.includes(NOT_INLINED),
    "(i) prompt without skillPath has no read instruction (byte-identical to pre-#995)",
  );
  // An empty string is not a path: it would embed a blank code fence and tell
  // the child to read nothing. Only a non-empty path turns the section on.
  const emptyPath = lensPromptFor(lensEntry, "diff --git a/a b/a", "ctx", undefined, [], "", "");
  assert(
    !emptyPath.includes(READ_SENTENCE),
    "(i) an empty skillPath does not turn on the read instruction",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
