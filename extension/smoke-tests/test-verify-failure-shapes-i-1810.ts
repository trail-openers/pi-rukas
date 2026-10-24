#!/usr/bin/env bun
/**
 * #1810 lens round — the tally harvest refuses what it cannot name, and never
 * costs or discloses more than the gate can support.
 *
 * Split out of `test-verify-failure-shapes-h-1762.ts` for the 500-line gate
 * (AGENTS.md §12); the shared fixtures live in `lib/verify-failure-shapes-fixtures.ts`.
 *
 * Four rules the harvest did not have:
 *
 *   - **An opaque run is not a name.** `NAME_LINE_RE` accepts `_` and `.`, so a
 *     32-character hex digest, a glued `ghp_…` key and a PEM body fragment all
 *     passed the bare-token test and reached the joined evidence line — the
 *     separator-aware secret arms never see a name with no separator to anchor on.
 *     A run of 24+ alphanumerics, or any name `redactSecrets` would alter, stops
 *     the harvest.
 *   - **` (+K more)` prints a number the gate actually claimed.** K comes from the
 *     tally's own digits, so it is capped at 999 and printed as `(+999+ more)`
 *     past that; `scriptTallyCount` refuses a count that is not a safe integer, so
 *     K is never negative or fractional.
 *   - **The whole emitted line is bounded, and so is the harvest.** A tally whose
 *     own text runs past {@link TALLY_LINE_MAX} is skipped, and the harvest stops
 *     at the corrective round's own line cap rather than building evidence the
 *     reader is certain to slice away.
 *   - **One owner for the record's evidence bound.** `ASSERTION_LINE_MAX` is
 *     exported from the record and imported here; a mirrored literal is a bound
 *     that can drift.
 *
 * Every fixture is synthetic; none of it is this repo's own gate dialect.
 */

import { scriptTallyCount } from "../src/work-driver-verify-failures.ts";
import { ASSERTION_LINE_MAX } from "../src/work-driver-verify-record.ts";
import { harvestConsolidatedTallies } from "../src/work-driver-verify-tally.ts";
import { TALLY_LINE, TALLY_NAMES, makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 1. token-shaped names are refused, not joined ────────────────────────────
{
  const hex32 = "0123456789abcdef0123456789abcdef";
  const glued = "ghp_" + "a".repeat(36);
  const pem = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw";
  for (const [label, name] of [
    ["a 32-hex-char digest", hex32],
    ["a glued ghp_-style token", glued],
    ["a PEM header fragment", pem],
  ] as Array<[string, string]>) {
    assert(
      harvestConsolidatedTallies(`${TALLY_LINE}\n    ${name}\n    ${TALLY_NAMES[0]}`).length === 0,
      `opaque run: ${label} stops the harvest — a name is a path, never a token`,
    );
  }
  // The refusal is the run rule, not the total length: a legal long name with a
  // separator every few characters still harvests.
  const dotted = "a".repeat(40) + "_" + "b".repeat(40) + "_" + "c".repeat(40);
  assert(
    harvestConsolidatedTallies(`${TALLY_LINE}\n    ${dotted}\n    ${TALLY_NAMES[0]}`).length === 1,
    "opaque run: a long name that carries separators is still a name (got the harvest)",
  );
  // A name the redactor would alter is refused even below the 24-char run length:
  // the run rule cannot see it (a separator breaks the run every few characters)
  // and neither can the credential shape test, so the redactor is the third veto.
  const altered = harvestConsolidatedTallies(
    `${TALLY_LINE}\n    sk_live_AKIAABCDEFGHIJKLMNOP
    ${TALLY_NAMES[0]}`,
  );
  assert(
    !altered.some((l) => l.includes("sk_live_")),
    `redactor veto: a name redactSecrets would change is never joined (got ${JSON.stringify(altered)})`,
  );
}

// ── 2. the disclosure prints what the gate claimed, under a cap ──────────────
{
  const names = Array.from({ length: 20 }, (_, n) => `check_${n}`);
  const huge = harvestConsolidatedTallies(
    `test.sh: failed checks (5000), not run (0)\n    ${names.join("\n    ")}`,
  );
  assert(
    huge.length === 1 && huge[0].includes("(+999+ more)") && !huge[0].includes("(+4980 more)"),
    `disclosure: a count of 5000 prints (+999+ more), never the raw K (got ${JSON.stringify(huge)})`,
  );
  // A count beyond float precision is not a count, so K cannot be fractional or
  // negative and the tally contributes nothing at all.
  assert(
    scriptTallyCount("test.sh: failed checks (99999999999999999999), not run (0)") === undefined,
    "disclosure: a count that is not a safe integer is refused by the one count reader",
  );
  assert(
    harvestConsolidatedTallies(
      "test.sh: failed checks (99999999999999999999), not run (0)\n    lint",
    ).length === 0,
    "disclosure: such a tally harvests no line, so no negative or fractional K is printed",
  );
  // A well-formed count still reports its honest K.
  const ten = Array.from({ length: 30 }, (_, n) => `check_${n}`);
  const honest = harvestConsolidatedTallies(
    `test.sh: failed checks (30), not run (0)\n    ${ten.join("\n    ")}`,
  );
  assert(
    (honest[0] ?? "").endsWith("(+10 more)") && !honest[0].includes("999"),
    `disclosure: a count of 30 with 20 names reports (+10 more) exactly (got ${JSON.stringify(honest)})`,
  );
}

// ── 3. the whole line is bounded, and the harvest has an output cap ──────────
{
  const longTally = `test.sh: failed checks (1), not run (0) ${"z".repeat(300)}`;
  assert(
    harvestConsolidatedTallies(`${longTally}\n    ${TALLY_NAMES[0]}`).length === 0,
    "line bound: a tally whose own text runs past the bound is skipped, not clipped",
  );
  const manyTallies = Array.from(
    { length: 12 },
    (_, n) => `s${n}.sh: failed checks (1), not run (0)\n    check_${n}`,
  ).join("\n");
  const out = harvestConsolidatedTallies(manyTallies);
  assert(
    out.length > 1 && out.length <= 6,
    `output cap: the harvest stops at the corrective round's line cap (got ${out.length})`,
  );
  // Every emitted line fits inside the record's own bound with room the reader uses.
  assert(
    out.every((l) => l.length <= ASSERTION_LINE_MAX),
    `output cap: no joined line can outrun the record's bound (${ASSERTION_LINE_MAX}) (max ${Math.max(...out.map((l) => l.length))})`,
  );
}

process.exit(failed() ? 1 : 0);
