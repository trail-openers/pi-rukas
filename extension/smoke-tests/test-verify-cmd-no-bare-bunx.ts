#!/usr/bin/env bun
/**
 * The commands the `/work` verify gate executes must not depend on the
 * `bunx` alias — issue #1118.
 *
 * Non-obvious, in short: the gate runs `.pi/verify-cmd*` through `/bin/sh`
 * with the Pi process's PATH (`work-driver-consolidated-verify.ts`), and on
 * 2026-10-12 provisioning shipped `/opt/pi-ensemble/bin` with `bun` but no
 * `bunx`. `bun x` is the same dispatch through the one binary that is always
 * there; `bunx` is a second PATH entry provisioning is free to forget. Two
 * finished cycles (#1105, #1114) parked at `verify-failed:develop` over the
 * missing symlink, so a tier that opens with `bunx` fails here.
 *
 * Scope is the driver's own inputs — the `kind: "command"` entries of
 * `HEADLESS_FILES` — derived, not hand-listed, so a tier added there is
 * covered without anyone remembering this file. `bunx` stays legal anywhere
 * else: agents type it, `bash-command-parser.ts` allowlists it, CI calls it.
 * One site is known-uncovered and tracked separately:
 * `work-driver-cap-checkpoint.ts:85` runs `bunx tsc --no-emit` in driver
 * code, which is a driver-code decision rather than a host contract, so it
 * is not changed by this gate.
 *
 * Each rule is also run against a planted fixture — a gate never observed to
 * fail is worthless (AGENTS.md §12).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FILES } from "../src/headless/inputs.ts";
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** The driver's command inputs — every `kind: "command"` file it reads. */
const COMMAND_FILES = HEADLESS_FILES.filter((f) => f.kind === "command").map((f) => f.path);

/**
 * The gate's own membership, asserted rather than trusted: a `kind:
 * "command"` entry dropped from HEADLESS_FILES would silently shrink the
 * scope, and a filter bug would report a clean repo over tiers it never read.
 */
const EXPECTED_COMMAND_FILES = [
  ".pi/smoke-cmd",
  ".pi/verify-cmd",
  ".pi/verify-cmd-fast",
  ".pi/verify-cmd-full",
];

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A canary that has stopped meaning something: the gate itself is broken. */
function assertCanary(cond: boolean, msg: string) {
  assert(cond, `GATE-BROKEN: ${msg}`);
}

/**
 * The bare-`bunx` token in a verify command's text, or null.
 *
 * Comment lines are NOT skipped, unlike the driver's command reader: a
 * comment naming the old form is the first step back to it, and there is no
 * reading of this rule under which "bunx works fine here" belongs in a file
 * the driver executes.
 */
function findBareBunx(text: string): string | null {
  const line = text.split("\n").find((l) => /\bbunx\b/.test(l));
  return line === undefined ? null : line.trim();
}

// ---------------------------------------------------------------- the gate

assertCanary(
  COMMAND_FILES.join(",") === EXPECTED_COMMAND_FILES.join(","),
  `the gate's scope equals HEADLESS_FILES' command entries (derived [${COMMAND_FILES.join(", ")}], expected [${EXPECTED_COMMAND_FILES.join(", ")}])`,
);

for (const rel of COMMAND_FILES) {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    // `.pi/smoke-cmd` is genuinely optional (`whenAbsent: "no product smoke
    // gate"`) so its absence is not a failure; every other command input the
    // driver reads is a file this repo ships. An unreadable one — EACCES,
    // EISDIR — is NOT ENOENT and fails: a tier the driver cannot read at
    // runtime is the same broken gate as a tier with the wrong command.
    if (rel === ".pi/smoke-cmd" && missing) {
      console.log(`· ${rel} absent — no product smoke gate, nothing to check`);
      continue;
    }
    assert(
      false,
      `${rel} is readable — the driver executes it as a verify command (${missing ? "ENOENT" : String(err)})`,
    );
    continue;
  }

  // The line the driver would actually run must exist and be non-empty. A
  // file of nothing but comments yields `undefined` to the gate, which then
  // silently falls back to derivation — an empty tier is as broken as a
  // broken one, and reads green on a bare token scan.
  const command = readFirstConfigLine(text);
  assert(
    command !== undefined && command.length > 0,
    `${rel} has a non-empty first non-comment line — that is the command the driver runs`,
  );

  const offender = findBareBunx(text);
  assert(
    offender === null,
    `${rel} contains no bare \`bunx\` — \`bun x\` dispatches through the binary that is always on PATH${offender === null ? "" : ` (found: ${offender})`}`,
  );
}

// -------------------------------------------------- the gate CAN fail (canaries)

{
  // The exact regression shape — the pre-#1118 command line.
  const regressed = [
    "# comment",
    "cd extension && bunx tsc --noEmit && cd .. && bun run check",
  ].join("\n");
  assertCanary(
    findBareBunx(regressed) !== null,
    "`bunx tsc --noEmit` IS flagged (the #1118 shape that parked #1105/#1114)",
  );

  // The fixed form must NOT be flagged. Without this, a matcher loose enough
  // to match `bun` followed by `x` would have passed the broken commands too.
  assertCanary(
    findBareBunx("cd extension && bun x tsc --noEmit && bun run check") === null,
    "`bun x tsc --noEmit` passes (the fix is not itself a violation)",
  );

  // A comment naming the old form is caught too — comments are not exempt.
  assertCanary(
    findBareBunx("# run bunx tsc --noEmit here instead\nbun x tsc --noEmit") !== null,
    "`bunx` inside a comment is flagged (the rule covers prose in these files)",
  );

  // A hyphen is a word boundary, so a hyphenated name counts as the token.
  // Deliberate: this rule errs toward flagging, and a filename carrying the
  // alias is worth a conversation, not a silent pass.
  const hyphenIsBoundary = "bun x tsc --noEmit && ./scripts/bunx-wrapper.sh";
  assertCanary(
    findBareBunx(hyphenIsBoundary) !== null,
    "a hyphenated filename IS a word boundary, so `bunx-wrapper.sh` counts (documented, not accidental)",
  );

  // And the empty-tier shape the token scan cannot see on its own.
  assertCanary(
    readFirstConfigLine("# only a comment\n\n   \n") === undefined,
    "a file with no command line is detected as empty (the driver would get undefined)",
  );
  assertCanary(
    readFirstConfigLine("# comment\n\nbun x tsc --noEmit && bun run check") ===
      "bun x tsc --noEmit && bun run check",
    "the reader skips comments and blank lines to the real command",
  );
}

console.log(exit === 0 ? "\nAll verify-cmd bunx checks passed." : "\nFAILED");
process.exit(exit);
