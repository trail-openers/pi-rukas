#!/usr/bin/env bun
/**
 * The lens prompt carries its skill INLINE — issue #1847 (inverting #995).
 *
 * #995 established the opposite contract. Pi's `--skill <path>` advertises a
 * skill (name, description, location) and does NOT inline the SKILL.md body —
 * only the `/skill:name` slash command expands a body, and `--skill` never
 * calls it. So `lensPromptFor` told the child to open the file itself and
 * defined `Skill Load Status` in terms of that read. The child obeyed: across
 * four PRs on v0.14.22–v0.14.25 at least one lens per round announced "I'll
 * load my assigned skill" and then spent 150–500 turns and 20–80 M tokens
 * doing it, frequently through codemode or bash — where the #1827 re-read cap
 * could not even see the reads.
 *
 * #1847 deletes the instruction by deleting the need: the parent reads the
 * body and the prompt carries it. So this file is the OLD test inverted — the
 * same pure-function shape (no spawn, no mock, the composed prompt string),
 * asserting the body IS present, inside the delimiter, and that no sentence
 * telling the child to read a file survives anywhere in the prompt.
 *
 * **The absent-body branch matters as much as the present one.** When no body
 * is threaded (a pure-function caller), the section is omitted so the prompt
 * stays byte-identical to its pre-#995 output — the contract `lens-review-child.ts`
 * relies on for any caller that has not read a skill.
 */

import { lensPromptFor } from "../src/lens-review-format.ts";
import { skillCloseTag, skillOpenTag, wrapSkillBody } from "../src/lens-skill-inline.ts";
import { LENS_ROSTER, type RosterEntry } from "../src/lens-roster.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Every spelling of the read instruction the old prompt carried. None may
 * survive: the sentence, the "not inlined" claim that made it necessary, and
 * the self-report the driver no longer asks for. */
const FORBIDDEN = [
  "use the `read` tool to load your assigned skill file",
  "NOT inlined in your context",
  "Skill Load Status: SUCCESS",
  "Skill Load Status: FAILED",
  "you must read it explicitly",
];

const NONCE = "0123456789abcdef0123456789abcdef";
const SKILL_BODY = [
  "# SECURITY lens",
  "",
  "Check the auth boundary first.",
  "",
  "```markdown",
  "```ts",
  "const x = 1;",
  "```",
  "```",
  "",
  "Report a finding per issue. Inline `code` is fine.",
].join("\n");

{
  const fakePath = "/tmp/skills/code-review-security";
  // The real roster entry type — the same `RosterEntry` `lensPromptFor` is
  // declared against. `LENS_ROSTER[0]` is a genuine entry (the bundled
  // `skill/` dir is the roster's source), so the index is checked rather than
  // asserted: a roster that resolved to nothing has to fail HERE, loudly.
  const lensEntry = LENS_ROSTER[0];
  assert(
    lensEntry !== undefined && typeof lensEntry.skill === "string",
    "(i) the bundled lens roster resolves at least one entry (the fixture this test builds on)",
  );

  const wrapped = wrapSkillBody(SKILL_BODY, NONCE);
  assert(wrapped !== null, "(i) a body carrying backtick fences wraps successfully");
  const withBody = lensPromptFor(
    lensEntry,
    "diff --git a/a b/a",
    "ctx",
    undefined,
    [],
    undefined,
    fakePath,
    wrapped ?? "",
  );

  assert(
    withBody.includes("Check the auth boundary first."),
    "(i) the prompt carries the skill BODY inline",
  );
  assert(
    withBody.includes("const x = 1;"),
    "(i) a fenced line inside the body survives the wrap verbatim",
  );
  assert(
    withBody.includes(skillOpenTag(NONCE)) && withBody.includes(skillCloseTag(NONCE)),
    "(i) the body sits between the opening and closing delimiter tags",
  );
  assert(
    withBody.indexOf(skillOpenTag(NONCE)) < withBody.indexOf("Check the auth boundary"),
    "(i) the body is INSIDE the opening tag, not merely near it",
  );
  assert(
    withBody.indexOf("Check the auth boundary") < withBody.indexOf(skillCloseTag(NONCE)),
    "(i) the body is INSIDE the closing tag",
  );
  for (const phrase of FORBIDDEN) {
    assert(!withBody.includes(phrase), `(i) the read-era phrase is gone: "${phrase}"`);
  }
  assert(
    !withBody.includes(fakePath),
    "(i) the skill PATH never appears in the prompt — there is nothing to open",
  );
  assert(
    /do not open, re-read, `cat` or grep any SKILL\.md/i.test(withBody),
    "(i) the prompt tells the child not to go and fetch the file",
  );
  // The skill must arrive BEFORE the work, not after it — a child that read
  // its doctrine after writing findings was never guided by it. The old test
  // pinned this for the read instruction; the same ordering property now holds
  // of the inlined body itself.
  assert(
    withBody.indexOf("Check the auth boundary") < withBody.indexOf("Diff to review:"),
    "(i) the inlined skill precedes the diff the child is asked to review",
  );
  // And the trailing stop instruction says the skill is inlined, so the two
  // halves of the prompt cannot disagree about whether the child has it.
  assert(
    /your skill is inlined above/i.test(withBody),
    "(i) the closing stop instruction names the skill as already delivered",
  );

  // Without a body: no skill section (byte-identical to the pre-#995 prompt).
  const withoutBody = lensPromptFor(lensEntry, "diff --git a/a b/a", "ctx", undefined, []);
  assert(
    !withoutBody.includes("<lens-skill-body>") &&
      !FORBIDDEN.some((p) => withoutBody.includes(p)),
    "(i) prompt without a body has no skill section (byte-identical to pre-#995)",
  );
  // An empty/whitespace body is not a body: it would emit an empty delimiter
  // and claim a delivery that did not happen.
  const emptyBody = lensPromptFor(
    lensEntry,
    "diff --git a/a b/a",
    "ctx",
    undefined,
    [],
    "",
    "/tmp/skills/x",
    "   \n  ",
  );
  assert(
    !emptyBody.includes("<lens-skill-body>"),
    "(i) a whitespace-only body does not turn on the skill section",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
