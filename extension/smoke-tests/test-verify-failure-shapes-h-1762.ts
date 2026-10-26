#!/usr/bin/env bun
/**
 * #1762 round 6 — the tally harvest's OWN cost and bound, and the exhaustive
 * consumer of the shape union.
 *
 * Split out of `test-verify-failure-shapes-g-1762.ts` for the 500-line gate
 * (AGENTS.md §12); the shared fixtures live in
 * `lib/verify-failure-shapes-fixtures.ts` so neither half re-types them.
 *
 * Two defects #1808's review found, both of the "a gate can make the reader cost
 * what it reports" family:
 *
 *   - The harvest walked a tally's printed `N` with no bound on what it read or
 *     joined. A gate that prints `failed checks (999999)` above a million indented
 *     tokens made the reader walk them all and build a million-name line, and an
 *     8000-character "name" was classified before anything looked at its length.
 *     The bounds are {@link harvestConsolidatedTallies}'s length guard, its name
 *     cap and its join cap; the disclosure ` (+K more)` keeps the evidence honest
 *     about what the cap dropped.
 *   - `FailureShape` had no consumer the compiler checked. A shape added to the
 *     union and to the table was compile-clean, and its "may this line be the
 *     specific assertion" answer came from whatever `namesTest` value was typed
 *     beside it. `SHAPE_NAMES_A_CHECK` is a `Record<FailureShape, boolean>`, so a
 *     missing mapping is a build error — and the loop below is what makes its
 *     VALUES, not just its KEYS, a checked fact.
 *
 * Every fixture is synthetic gate output; none of it is this repo's own
 * `verify-loop.sh` dialect.
 */

import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { consolidatedAssertionLines } from "../src/work-driver-verify-record.ts";
import { harvestConsolidatedTallies } from "../src/work-driver-verify-tally.ts";
import {
  CHECKS_BLOCK,
  CMD,
  EXAMPLE_STREAM,
  FAIL_HEADER,
  PAYLOAD_MARKER,
  TALLY_LINE,
  TALLY_NAMES,
  WT,
  makeAssert,
} from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 1. the harvest's cost and bound ──────────────────────────────────────────
{
  // An 8000-char candidate line stops the harvest. The assertion is on the RESULT
  // (nothing harvested), not on elapsed time: a timing assertion on a smoke-test
  // budget is a flake, and the length guard's whole job is to make the result
  // independent of the line's length anyway.
  const huge = "x".repeat(8000);
  assert(
    harvestConsolidatedTallies(`${TALLY_LINE}\n    ${huge}\n    ${TALLY_NAMES[0]}`).length === 0,
    "harvest: an over-long candidate name line stops it — a name is never a document",
  );
  // The guard is what stopped the previous case, not some property of the stream:
  // the same shape with the SHORT name first still harvests it.
  assert(
    harvestConsolidatedTallies(
      `${TALLY_LINE}\n    ${TALLY_NAMES[0]}\n    ${huge}`,
    ).join("|") === `${TALLY_LINE}: ${TALLY_NAMES[0]} (+1 more)`,
    "harvest: only the over-long line is refused — the short one beside it is kept",
  );
  // The name cap is independent of the printed count, and the cut is disclosed.
  // `count` is the tally's OWN printed N, so the disclosure counts what that N
  // says was omitted — here 999 - 20 = 979.
  const many = Array.from({ length: 30 }, (_, n) => `check_${n}`).join("\n    ");
  const capped = harvestConsolidatedTallies(
    `test.sh: failed checks (999), not run (0)\n    ${many}`,
  );
  const kept = Array.from({ length: 20 }, (_, n) => `check_${n}`).join(", ");
  assert(
    capped.length === 1 &&
      capped[0] === `test.sh: failed checks (999), not run (0): ${kept} (+979 more)`,
    `harvest: a count of 999 joins at most 20 names and discloses (+K more) (got ${JSON.stringify(capped)})`,
  );
  // The 30-name block whose count says 30 — the case the cap exists for — reports
  // (+10 more) rather than silently understating the tally.
  const exactly30 = Array.from({ length: 30 }, (_, n) => `check_${n}`);
  const capped30 = harvestConsolidatedTallies(
    `test.sh: failed checks (30), not run (0)\n    ${exactly30.join("\n    ")}`,
  );
  assert(
    capped30.length === 1 &&
      capped30[0] ===
        `test.sh: failed checks (30), not run (0): ${exactly30.slice(0, 20).join(", ")} (+10 more)`,
    `harvest: a count of 30 joins 20 names and reports (+10 more) (got ${JSON.stringify(capped30)})`,
  );
  // A credential-shaped name stops the harvest: the joined line reaches the
  // corrective-round prompt, the handoff and the forge comment, so it goes through
  // the same veto every other stored verify line does.
  assert(
    harvestConsolidatedTallies(
      `${TALLY_LINE}\n    api_key=zX9cVbNm0pQwErTy\n    ${TALLY_NAMES[0]}`,
    ).length === 0,
    "harvest: a credential-shaped name stops it — nothing credential-shaped is joined",
  );
  // The names half of the joined line is capped at half the record's evidence
  // bound, so the tally prefix and the ` (+K more)` disclosure fit inside the
  // record's own 500-char clip whatever the gate printed as the count. The count
  // here is deliberately absurd relative to the names actually printed (a folded
  // stream does this), which is exactly why the JOIN is bounded and the whole line
  // is clipped by the reader rather than by arithmetic here.
  // Each name is 60 alphanumerics plus a segment separator: long enough to press
  // the join bound, and short enough that the opaque-token rule (24+) leaves it
  // alone — a 120-char blob is a hash, not a test name, and is refused outright.
  const wide = "y".repeat(60);
  const bounded = harvestConsolidatedTallies(
    `test.sh: failed checks (1000000), not run (0)\n${Array.from({ length: 9 }, (_, n) => `    ${wide}_${n}`).join("\n")}`,
  );
  assert(
    bounded.length === 1 && bounded[0].length <= 500,
    `harvest: the joined tally never exceeds the evidence bound (${bounded[0]?.length ?? "none"} chars)`,
  );
  // And the cap is not "one name only": a wide-but-legal set of names harvests
  // more than one before the join bound stops it.
  assert(
    (bounded[0]?.split(", ").length ?? 0) > 1,
    `harvest: the join bound cuts the list, it does not refuse it outright (${bounded[0]?.split(", ").length ?? 0} names kept)`,
  );
}

// ── 3. the harvest reads the READER'S VIEW, not the raw text (#1810) ────────
// `harvestTallies` used to be handed `text` while the per-line loop above it refused
// wrapper lines. A wrapper line that carried a tally block IS the tally line the
// harvest anchors on, so the joined evidence line opened with the harness's own
// sentence — exactly what the per-line loop was written to keep out. Synthetic
// harness prose and synthetic gate output; none of it this repo's own dialect.
{
  const wrappedTally =
    `verify command \`${CMD}\` failed in ${WT}: ${TALLY_LINE}\n` +
    `    ${TALLY_NAMES[0]}\n` +
    `    ${TALLY_NAMES[1]}`;
  const wrapped = consolidatedAssertionLines(wrappedTally);
  assert(
    !wrapped.some((l) => l.includes("verify command")),
    `#1810: a wrapper line inside consolidatedRaw yields no target line with the harness sentence (got ${JSON.stringify(wrapped)})`,
  );
  assert(
    !wrapped.some((l) => l.includes("verify command") && l.includes(`: ${TALLY_NAMES.join(", ")}`)),
    `#1810: the harness sentence is never the tally the names are joined to (got ${JSON.stringify(wrapped)})`,
  );
  // The plain tally plus its indented names still harvests through the same route.
  const plain = consolidatedAssertionLines(EXAMPLE_STREAM);
  assert(
    plain.includes(`${TALLY_LINE}: ${TALLY_NAMES.join(", ")}`),
    `#1810: the plain tally plus names still harvests (got ${JSON.stringify(plain)})`,
  );
  // The joined tally the wrapped stream DOES produce is anchored on the gate's own
  // tally, which is what the reader's view leaves behind once the wrapper is cut —
  // the same line the plain stream produces. The defect was never "no tally when a
  // wrapper carried one"; it was "the harness sentence became the tally".
  const joinedForm = (l: string): boolean =>
    l.startsWith(TALLY_LINE) && l.includes(`: ${TALLY_NAMES.join(", ")}`);
  assert(
    wrapped.some(joinedForm) && plain.some(joinedForm),
    `#1810: both routes anchor the join on the gate's tally, never on harness prose (wrapped ${JSON.stringify(wrapped)})`,
  );
}

// ── 4. the shape union has an exhaustive consumer ────────────────────────────
{
  // #1808 — `FailureShape` used to have no consumer the compiler checked, so a
  // shape added to the union and the table was compile-clean while its answer came
  // from whatever `namesTest` somebody typed. `SHAPE_NAMES_A_CHECK` is a
  // `Record<FailureShape, …>`, so omitting a shape is a build error; this asserts
  // its VALUES agree with what the classifier reports, so flipping one silently
  // fails here.
  const { SHAPE_NAMES_A_CHECK } = await import("../src/work-driver-verify-failures.ts");
  const seen = new Set<string>();
  const probes: Array<[string, keyof typeof SHAPE_NAMES_A_CHECK]> = [
    ["FAILED: smoke-tests/test-x.ts", "failed-marker"],
    [PAYLOAD_MARKER, "failed-marker-payload"],
    ["✗ expected 5 got 6", "assertion-mark"],
    ["error: cannot compile", "diagnostic"],
    [CHECKS_BLOCK, "script-tally"],
    ["scripts/test.sh: 3 failed", "named-file"],
    // #1841 — the anchorless FAIL header, the shape whose absence parked a develop
    // round with no corrective dispatch. Its probe is the last line the union needs.
    [FAIL_HEADER, "fail-header"],
    ["not ok 3 - x", "tap-not-ok"],
    ["FAILED tests/test_a.py::test_login", "pytest-failed"],
    ["ERROR tests/test_a.py::test_login", "pytest-error"],
    ["--- FAIL: TestThing (0.31s)", "go-fail"],
  ];
  for (const [line, shape] of probes) {
    const got = classifyFailureLine(line);
    seen.add(shape);
    assert(
      got?.shape === shape && got.namesTest === SHAPE_NAMES_A_CHECK[shape],
      `exhaustive rule: ${shape} reports namesTest ${SHAPE_NAMES_A_CHECK[shape]} from the classifier too (got ${JSON.stringify(got)})`,
    );
  }
  assert(
    Object.keys(SHAPE_NAMES_A_CHECK).every((s) => seen.has(s)) &&
      seen.size === Object.keys(SHAPE_NAMES_A_CHECK).length,
    `exhaustive rule: every shape of the union is probed (${seen.size} of ${Object.keys(SHAPE_NAMES_A_CHECK).length})`,
  );
}

process.exit(failed() ? 1 : 0);
