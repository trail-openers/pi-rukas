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

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const body = await fs.readFile(START, "utf8");

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

console.log(`\nexit ${exit}`);
process.exit(exit);
