#!/usr/bin/env bun
/**
 * #911 — pi-prompts/do.md must stay permission-legal in its CLI spans.
 *
 * Same silent-failure shape test-start-prompt.ts guards for start.md:
 * `permission-guard` DENIES any command containing `&&`, `||`, `;`, `|`, `>`,
 * backticks or `$(…)`, and a denied command does not fail loudly — it falls
 * through and the step silently produces nothing. So a future edit that
 * innocently writes `cat x | head` into do.md would disable that step with no
 * visible symptom.
 *
 * do.md's backticked bullets are tool names (dispatch_specialist, …), not
 * runnable bash, so the bullet-based scan test-start-prompt.ts uses would be
 * vacuous here. Instead: every INLINE backticked span whose first word is a
 * CLI (git, gh, glab, bun, vipune, oo, cd, timeout) is treated as a command
 * and held to the FORBIDDEN rule.
 *
 * Anti-vacuity: the scanner itself is unit-tested on a small fixture string
 * containing one legal and one forbidden CLI span, so the check cannot pass
 * vacuously even if do.md currently has few (or zero) CLI spans.
 */

// oo-residue:exempt — this file names the retired oo mechanism to assert its absence

import fs from "node:fs/promises";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DO = path.join(__dirname, "..", "..", "pi-prompts", "do.md");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FORBIDDEN = /&&|\|\||;|\||>|`|\$\(/;
const CLI_FIRST_WORD = /^(git|gh|glab|bun|vipune|cd|timeout)\s/; // (no `oo` — retired in #1029)

/**
 * Extract every inline backticked span from a string, then keep the ones that
 * read as CLI commands (first word is a CLI, followed by at least one arg).
 */
function cliSpans(body: string): string[] {
  return [...body.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((span) => CLI_FIRST_WORD.test(span));
}

// ------------------------------------------- the scanner is not vacuous

{
  const fixture =
    "use `gh pr view 12` and never `git log -1 || git diff x` or `cd ext && bun test`";
  const spans = cliSpans(fixture);
  assert(spans.length === 3, `scanner finds all 3 CLI spans in the fixture (got ${spans.length})`);
  const bad = spans.filter((s) => FORBIDDEN.test(s));
  assert(
    bad.length === 2,
    `scanner + FORBIDDEN flag exactly the 2 illegal spans (got ${bad.length})`,
  );
  assert(
    spans.some((s) => s === "gh pr view 12" && !FORBIDDEN.test(s)),
    "the scanner passes the plain legal command",
  );
  assert(
    !CLI_FIRST_WORD.test("dispatch_specialist") &&
      !CLI_FIRST_WORD.test("dispatch_lens_review") &&
      !CLI_FIRST_WORD.test("cat"),
    "non-CLI tool names and non-CLI verbs are not treated as commands (do.md's 6 toolkit bullets stay out of scope)",
  );
}

// ------------------------------------------------- do.md itself

{
  const body = await fs.readFile(DO, "utf8");
  const spans = cliSpans(body);
  const violations = spans.filter((s) => FORBIDDEN.test(s));
  assert(
    violations.length === 0,
    `no do.md CLI span chains or pipes (would be silently DENIED, not failed): ${violations.join(" | ") || "none"}`,
  );
  assert(
    !spans.some((s) => /^cd\s/.test(s)),
    "no do.md CLI span starts with `cd` — the bash tool already runs in the project cwd",
  );
}

// --------------------------------------- do.md worktree step (#1007)

{
  const body = await fs.readFile(DO, "utf8");
  // The worktree step must name all four dispatch types with their cwd/workCwd
  // parameters, so a future regression that drops one of the threads fails the
  // gate rather than silently regressing to the process cwd.
  const worktreeStepMatch = body.match(
    /\*\*Create the worktree\.?\*\*[\s\S]*?(?=\n\d+\.\s+\*\*)/,
  );
  assert(
    worktreeStepMatch !== null,
    "do.md contains the worktree step (Create the worktree)",
  );
  if (worktreeStepMatch) {
    const step = worktreeStepMatch[0];
    const fourDispatches = [
      "dispatch_specialist",
      "dispatch_parallel",
      "adversarial_loop",
      "dispatch_lens_review",
    ];
    for (const tool of fourDispatches) {
      assert(
        step.includes(tool),
        `do.md worktree step names ${tool}`,
      );
    }
    assert(
      step.includes("workCwd"),
      "do.md worktree step names workCwd (adversarial_loop parameter)",
    );
    assert(
      step.includes("cwd"),
      "do.md worktree step names cwd (dispatch parameter)",
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
