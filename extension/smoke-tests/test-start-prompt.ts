#!/usr/bin/env bun
/**
 * #390 — `/start` must see what `/work` left behind, and must stay runnable.
 *
 * Two separate things are checked here, and the second is the one that rots.
 *
 * `/start` reads git status, issues, PRs and CI at session open, and until
 * #390 it never read `.pi/work-state/`. So the most actionable state in the
 * repo — the cycles that stopped last night waiting on a human — was
 * invisible at exactly the moment the operator decides what to do. Groups
 * that never started are worse: they leave no state file and no PR, so
 * `queue-summary.json` (#382) is the only record they existed.
 *
 * The second check is the file's own bash rule. `permission-guard` DENIES any
 * command containing `&&`, `||`, `;`, `|`, `>`, backticks or `$(…)`, and a
 * denied command does not fail loudly — it falls through, and the step
 * silently produces nothing. So a future edit that innocently writes
 * `cat x | head` would disable that step with no visible symptom. This test
 * is the only thing that would catch it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = path.join(__dirname, "..", "..", "pi-prompts", "start.md");
const EXPLORE = path.join(
  __dirname,
  "..",
  "..",
  "agents-base",
  "explore.md",
);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const body = await fs.readFile(START, "utf8");
const exploreBody = await fs.readFile(EXPLORE, "utf8");

// ------------------------------------------------- it looks at the driver

assert(
  body.includes(".pi/work-state/queue-summary.json"),
  "/start reads the queue summary — the only record of groups that never started",
);
assert(
  /ls\s+\.pi\/work-state\//.test(body),
  "...and lists the state dir, so parked cycles are visible at session open",
);
assert(
  /humanAction/.test(body) && /notStarted/.test(body),
  "it is told which fields matter: the action for each park, and what never ran",
);
assert(
  /Absence is silent/i.test(body),
  "a repo that never ran /work must not have a missing file reported as a finding",
);
assert(
  /parked/i.test(body.slice(body.indexOf("## Output"))),
  "the readiness line surfaces parks — carrying the data and not reporting it would be pointless",
);

// ------------------------------- every bash command stays permission-legal

/**
 * The characters `permission-guard` refuses. A denied command falls through
 * silently rather than erroring, so violations are invisible at runtime —
 * which is exactly why they are checked here instead.
 */
const FORBIDDEN = /&&|\|\||;|\||>|`|\$\(/;

// Bullet lines holding a single backticked command, which is the shape every
// runnable step in this file uses.
const commandBullets = body
  .split("\n")
  .filter((l) => /^\s*-\s+`[^`]+`\s*$/.test(l))
  .map((l) => l.replace(/^\s*-\s+`/, "").replace(/`\s*$/, ""));

assert(
  commandBullets.length >= 8,
  `found ${commandBullets.length} command bullets — enough that this test is not vacuous`,
);

const violations = commandBullets.filter((c) => FORBIDDEN.test(c));
assert(
  violations.length === 0,
  `no /start command chains or pipes (would be silently DENIED, not failed): ${violations.join(" | ") || "none"}`,
);

{
  // Anti-vacuity: the matcher must actually reject the thing it exists to
  // reject. Without this, a broken regex would make the check above pass
  // forever on any input at all.
  assert(
    FORBIDDEN.test("cat .pi/work-state/queue-summary.json | head -20"),
    "the forbidden-character matcher does reject a piped command",
  );
  assert(
    FORBIDDEN.test("cd extension && bun test") && FORBIDDEN.test("echo $(pwd)"),
    "...and chained or substituted ones",
  );
  assert(
    !FORBIDDEN.test("cat .pi/work-state/queue-summary.json"),
    "...while passing the plain command /start actually runs",
  );
}

// The `oo` prefix and `cd` rule are load-bearing conventions in this file;
// a step that violates them fails the same silent way.
assert(
  !commandBullets.some((c) => /^cd\s/.test(c)),
  "no /start command starts with `cd` — Pi's bash tool already runs in the project cwd",
);

// ------------------- #712 — the /start dispatch is synthesis-tier, not 8-field

// The retired eight-field contract must be gone from start.md in its entirety:
// a lingering second occurrence would silently re-impose it (step 3 and the
// step-6 fallback both used to name it, and both had to be rewritten together).
assert(
  !/eight-field/i.test(body),
  "no 'eight-field' wording remains in /start — the retired 8-field contract is gone",
);
assert(
  !/Structured Summary Contract/.test(body),
  "/start no longer quotes the /work-side Structured Summary Contract by name",
);

// Step 3 dispatches the synthesis sweep, and the step-6 fallback re-dispatches
// on the same synthesis-tier shape — the two occurrences are the pair that
// must agree.
assert(
  /\/start synthesis sweep/.test(body),
  "step 3 names the new /start synthesis sweep section in the dispatch prompt",
);
assert(
  /synthesis tier/i.test(body.slice(body.indexOf("6. **End your turn"))),
  "the step-6 re-dispatch fallback references the synthesis tier, not the old 8-field summary",
);

// R2 — the AGENTS.md staleness check lives in the step 4/5 area: the command
// bullet reuses data already read (single non-chained git log, so the
// permission-legal scan above passes it), and on firing it points at the
// sibling /agents-md command — check-and-pointer only, never a regenerate.
assert(
  commandBullets.some((c) => c === "git log -1 --format=%cd -- AGENTS.md"),
  "R2 staleness signal is its own non-chained command bullet (git log -1 -- AGENTS.md)",
);
assert(
  /AGENTS\.md/.test(body) && /agents-md/.test(body),
  "the R2 readiness note points at the sibling /agents-md command (check-and-pointer only)",
);
assert(
  !/(regenerate|regen)\s+(AGENTS\.md)/i.test(body),
  "/start never inlines an AGENTS.md regenerate — that belongs to /agents-md",
);

// R3 — the budget is advisory prompt text in the explore section (no code can
// verify token counts; this is the assertion surface). It must NOT name any
// truncation or re-dispatch-on-overflow mechanism.
const synthesisSection = exploreBody.slice(
  exploreBody.indexOf("## /start synthesis sweep"),
  exploreBody.indexOf("## Delegation After Research"),
);
assert(
  /Budget/i.test(synthesisSection) && /advisory/i.test(synthesisSection),
  "R3: the /start synthesis sweep section carries an explicit advisory token budget",
);
assert(
  !/(truncat|re-dispatch on overflow|re-dispatch-on-overflow)/i.test(synthesisSection),
  "R3: the budget stays advisory — no truncation or re-dispatch-on-overflow mechanism named",
);

// The new section must sit in a distinct section, and the /work-side contract
// (which this ticket must not touch) must survive verbatim in the source.
assert(
  exploreBody.includes("## Structured Summary Contract"),
  "regression guard: the /work-side Structured Summary Contract heading still exists",
);
const contractFields = [
  "project:",
  "maturity:",
  "current_state:",
  "conventions:",
  "quality_gates:",
  "gotchas:",
  "open_work:",
  "ci_health:",
];
const contractBlock = exploreBody.slice(
  exploreBody.indexOf("## Structured Summary Contract"),
  exploreBody.indexOf("### vipune flag exploitation"),
);
assert(
  contractFields.every((f) => contractBlock.includes(f)),
  "regression guard: the 8-field Required fields block is still verbatim in the source",
);
assert(
  exploreBody.indexOf("## /start synthesis sweep") >
    exploreBody.indexOf("## Structured Summary Contract"),
  "the /start synthesis sweep section is a distinct section alongside, not a replacement",
);

// The two coverage gaps the ticket had to close honestly: the step-6 end-turn
// discipline and the step-7 vipune closing were previously asserted by no test.
assert(
  /Never spin on `dispatch_status`/.test(body),
  "step 6 keeps the end-the-turn, don't-poll discipline (now test-covered)",
);
assert(
  /vipune add `?[\s`<]/.test(body.slice(body.indexOf("7. **Store findings"))) ||
    /vipune add/.test(body.slice(body.indexOf("7. **Store findings"))),
  "step 7 keeps the closing vipune add (now test-covered)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
