#!/usr/bin/env bun
/**
 * #1113 — the PM must not be told that @developer has "no git write access".
 *
 * That sentence sat at `agents-base/project-manager.md:16` while
 * `agents-base/developer.md` told the developer to `git add` and `git commit`
 * in its worktree, the develop dispatch prompt (`work-driver-prompts-early.ts`)
 * demanded it, and `work-driver-verify-develop.ts` REJECTED a worktree with no
 * commit ahead of base SHA. #621 fixed the developer's own side of that
 * three-way contradiction (`test-developer-commit-doctrine.ts` pins it); PM's
 * copy of the doctrine never followed, so a PM reading its own prompt wrote
 * briefs telling a developer to leave work uncommitted — and, in the same
 * breath, had no rule stopping it writing "and push it".
 *
 * On 2026-10-11 that second half went live: PM briefs told developers to
 * rebase and `git push --force-with-lease` on PRs #1063 / #1109 / #1110, and
 * the developers complied. The enforcement gap is closed by
 * `developer-push-guard.ts`; this file closes the wording gap, because a
 * prompt that gets the boundary wrong is how the wrong brief gets written.
 *
 * Three assertions, each of which fails on the pre-#1113 file:
 *   1. PM doctrine no longer claims @developer has no git WRITE access;
 *   2. it states the real boundary — developer commits locally, never pushes;
 *   3. the sticky preamble PM is re-handed EVERY turn carries the same rule
 *      (a rule only in the long doctrine is a rule PM forgets mid-session).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PM_DOC = path.join(ROOT, "agents-base", "project-manager.md");
const COMMANDS = path.join(ROOT, "extension", "src", "commands.ts");
const BUILT_PM = path.join(ROOT, "dist", "prompts", "standard", "project-manager.md");

for (const [label, p] of [
  ["agents-base/project-manager.md", PM_DOC],
  ["extension/src/commands.ts", COMMANDS],
] as const) {
  assert(existsSync(p), `non-vacuity: ${label} exists`);
}

const pm = readFileSync(PM_DOC, "utf8");

// ------------------------------------------- 1. the false claim is gone
// "no git write access" is the exact phrase that contradicts developer.md and
// the develop gate. Matched loosely enough to catch a paraphrase that keeps
// the meaning ("cannot write to git", "no git write") — all three are the same
// wrong claim, and a re-wording that preserves it is the drift this canary
// exists to catch.
const FALSE_CLAIMS = [/no git write access/i, /no git write\b/i, /cannot (write|commit) to git/i];
const offenders = pm
  .split("\n")
  .map((line, i) => [i + 1, line] as const)
  .filter(([, line]) => {
    if (!/@developer|developer/i.test(line)) return false;
    return FALSE_CLAIMS.some((re) => re.test(line));
  });
assert(
  offenders.length === 0,
  offenders.length === 0
    ? "project-manager.md: no claim that @developer lacks git write access"
    : `project-manager.md still denies developer git write access: ${offenders
        .map(([n, l]) => `line ${n}: ${l.trim().slice(0, 120)}`)
        .join(" | ")}`,
);

// ------------------------------------------- 2. the real boundary is stated
// Positive, not just the absence of a lie: the doctrine has to say BOTH halves
// or a model fills the gap by guessing (which is what happened).
assert(
  /@developer commits locally/i.test(pm) || /developer.*commits locally/i.test(pm),
  "project-manager.md: states that @developer commits locally in its worktree",
);
assert(
  /never pushes|not nothing reaches the remote|nothing reaches the remote/i.test(pm),
  "project-manager.md: states that a developer never pushes",
);
assert(
  /push.*@ops|@ops.*push/i.test(pm),
  "project-manager.md: routes the push to @ops",
);
// The brief-level rule — the shape PM actually emits. Without it PM can accept
// both sentences above and still write "commit and push" in a dispatch.
assert(
  /brief[^.\n]*end[^.\n]*commit|ends? at a local commit|end the brief at/i.test(pm),
  "project-manager.md: tells PM to end a developer dispatch brief at a local commit",
);

// The built artefact is what PM reads at runtime, so the source canary alone
// is not enough — a build that drops the section would pass it. Skipped (not
// failed) when the build has not run, the same convention as
// test-developer-commit-doctrine.ts.
if (existsSync(BUILT_PM)) {
  const built = readFileSync(BUILT_PM, "utf8");
  assert(
    !FALSE_CLAIMS.some((re) => re.test(built)),
    "built project-manager.md: the false claim is absent from what PM actually reads",
  );
  assert(
    /commits locally/i.test(built),
    "built project-manager.md: carries the commit-locally rule",
  );
} else {
  console.log(`- built project-manager.md not found at ${BUILT_PM} — run 'bun run build'`);
}

// ------------------------------------------- 3. the sticky preamble carries it
// The preamble is re-injected on EVERY PM turn; the doctrine above is read once
// at /start. A rule that lives only in the long document is the rule that gets
// violated on turn 40.
const cmds = readFileSync(COMMANDS, "utf8");
const preamble = cmds.slice(cmds.indexOf("PM_STICKY_PREAMBLE"));
const preambleBody = preamble.slice(0, preamble.indexOf("`;", preamble.indexOf("`")));
assert(
  preambleBody.length > 500,
  `canary: the sticky preamble body was located (${preambleBody.length} chars) — a canary over a slice that fell through to empty would pass vacuously`,
);
assert(
  /never tell one to push|never.*push/i.test(preambleBody),
  "PM_STICKY_PREAMBLE: tells PM never to tell a developer to push",
);
assert(
  /LOCAL COMMIT|local commit/i.test(preambleBody),
  "PM_STICKY_PREAMBLE: tells PM a developer brief ends at a local commit",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
