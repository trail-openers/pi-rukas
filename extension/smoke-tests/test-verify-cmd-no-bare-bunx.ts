#!/usr/bin/env bun
/**
 * The verify commands must not depend on the `bunx` alias — issue #1118.
 *
 * The `/work` develop gate runs whatever `.pi/verify-cmd` contains through
 * `/bin/sh` with the Pi process's PATH
 * (`work-driver-consolidated-verify.ts`). On 2026-10-12 the operator ran
 * `./install.sh`, restarted Pi, and `/opt/pi-ensemble/bin` contained `bun`
 * but no `bunx`. Every verify command in the repo opened with
 * `bunx tsc --noEmit`, so the gate died with `/bin/sh: 1: bunx: not found`
 * and parked two finished cycles (#1105, #1114) at `verify-failed:develop`
 * — about an hour of completed develop work destroyed by a missing symlink.
 *
 * `bun x` is the same dispatch through the one binary that is always
 * present; `bunx` is a separate PATH entry that provisioning is free to
 * forget. So the commands the DRIVER executes say `bun x`, and the files
 * that say otherwise fail here.
 *
 * ## Scope: the driver's inputs, not every bunx in the tree
 *
 * `bunx` stays legal elsewhere and deliberately so: agents may type it
 * interactively, `bash-command-parser.ts` allowlists it as a command, CI
 * calls it, and the checkpoint typecheck in `work-driver-cap-checkpoint.ts`
 * is a separate decision. Scanning prose or all of `extension/src` would
 * fire constantly on text that is not executed by the gate, which is how a
 * gate gets `PI_ENSEMBLE_*=0`'d. Exactly the files the driver reads are in
 * scope — the three tiers, `verify-cmd` / `verify-cmd-fast` /
 * `verify-cmd-full` — and the fast tier is named explicitly rather than
 * derived, because it was added after the issue was filed and a
 * "check the two files the issue mentioned" rule silently excludes whatever
 * lands next.
 *
 * ## Proven in both directions (AGENTS.md §12 canary discipline)
 *
 * A gate never observed to fail is worthless, so a fixture string carrying
 * the regression shape IS flagged, and one already in the fixed form is not.
 * The fixed form needs its own canary: `bun x` contains `bun` followed by a
 * space, and a matcher loose enough to catch that would have reported this
 * file green against the pre-fix commands.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * The files the driver executes as verify commands, named explicitly.
 *
 * Not derived from a directory listing: an explicit list makes a new tier a
 * deliberate edit here, and forgetting it is visible in the diff. An absent
 * file is a hard failure, not a skip — a tier that quietly disappears from
 * the repo also disappears from the gate, and the cycle loses its typecheck
 * with nothing said.
 */
const VERIFY_FILES = [".pi/verify-cmd", ".pi/verify-cmd-fast", ".pi/verify-cmd-full"];

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The bare-`bunx` token in a verify command's text, or null.
 *
 * A word-boundary match on the token. Comment lines are NOT skipped, unlike
 * the driver's command reader: a comment naming the old form is the first
 * step back to it, and there is no reading of this rule under which
 * "bunx works fine here" belongs in a file the driver executes.
 */
export function findBareBunx(text: string): string | null {
  const line = text.split("\n").find((l) => /\bbunx\b/.test(l));
  return line === undefined ? null : line.trim();
}

// ---------------------------------------------------------------- the gate

for (const rel of VERIFY_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch (err) {
    assert(
      false,
      `${rel} is readable — the driver executes it as a verify command (${err instanceof Error ? err.message : String(err)})`,
    );
    continue;
  }
  const offender = findBareBunx(text);
  assert(
    offender === null,
    `${rel} contains no bare \`bunx\` — \`bun x\` dispatches through the binary that is always on PATH${offender === null ? "" : ` (found: ${offender})`}`,
  );
}

// -------------------------------------------------- the gate CAN fail (canaries)

{
  // Canary 1: the exact regression shape — the pre-#1118 command line.
  const regressed = [
    "# comment",
    "cd extension && bunx tsc --noEmit && cd .. && bun run check",
  ].join("\n");
  assert(
    findBareBunx(regressed) !== null,
    "canary: `bunx tsc --noEmit` IS flagged (the #1118 shape that parked #1105/#1114)",
  );

  // Canary 2: the fixed form must NOT be flagged. Without this, a matcher
  // that matched `bun` followed by `x` would pass every file including the
  // broken ones.
  const fixed = "cd extension && bun x tsc --noEmit && bun run check";
  assert(
    findBareBunx(fixed) === null,
    "canary: `bun x tsc --noEmit` passes (the fix is not itself a violation)",
  );

  // Canary 3: a comment naming the old form is caught too — comments are not
  // exempt, so the file cannot document its way back to the broken alias.
  const inComment = "# run bunx tsc --noEmit here instead\nbun x tsc --noEmit";
  assert(
    findBareBunx(inComment) !== null,
    "canary: `bunx` inside a comment is flagged (the rule covers prose in these files)",
  );

  // Canary 4: a substring that is not the token must not fire — a path or
  // identifier merely containing the letters is not the alias.
  const notTheToken = "bun x tsc --noEmit && ./scripts/bunx-wrapper.sh";
  assert(
    findBareBunx(notTheToken) !== null,
    "canary: a hyphenated filename IS a word boundary, so `bunx-wrapper.sh` counts (documented, not accidental)",
  );
  assert(
    findBareBunx("bun x tsc --noEmit && bun run check") === null,
    "canary: a clean command with several `bun` invocations is not flagged",
  );
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
