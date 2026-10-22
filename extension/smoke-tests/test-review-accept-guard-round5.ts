#!/usr/bin/env bun
/**
 * #1764 fix round 5 — the exemption proof reads ONLY the text the shell receives.
 *
 * Rounds 3 and 4 landed the same CRITICAL in the same place: the proof that lifts the
 * command-wide floor asked its questions of a text `withSameCommandAssignmentsApplied` had
 * rewritten, so an operator expansion (`${F//zz/}`) had its reference pasted away before
 * the guard looked, and an operand the guard could name was handed to bash still carrying
 * the substitution that would print the findings store. The fix is not another matcher —
 * `commandFullyUnderstood` / `segmentUnderstood` / `operandWords` / `patternIsProse` now run
 * on RAW text, and the only view the guard may consult a substituted text for is the
 * store-NAME test, where a substitution can only ever ADD a refusal.
 *
 * So each row here is refused BY A CLAUSE and by the clause that says the guard understood
 * nothing (`unreadable-word`), never by the name test — the rows assemble the store path
 * through an expansion the guard deliberately cannot evaluate, so the raw text carries
 * `.git/` + `zz` + the name and no protected token to match.
 *
 * `ROUND5_ACCEPTED_COSTS` is the other side of the same rule and the reason it is a
 * security boundary rather than a narrowing: `F=notes.md; cat $F` resolves fine in bash and
 * the guard used to read that resolution. It no longer trusts its own guess about what the
 * shell will do, so those rows are refused.
 */
import { commandFullyUnderstood } from "../src/review-accept-exempt.ts";
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import { runsReviewAccept as baseRefuses } from "./accept-guard-base/review-accept-guard.ts";
import {
  ROUND5_ACCEPTED_COSTS,
  ROUND5_ASSIGNED_ARG,
  ROUND5_KEEP_ALLOWED,
  ROUND5_OPERATORS,
  ROUND5_PATTERN_FLAG_VALUE,
  ROUND5_QUOTES,
  ROUND5_WHICH,
} from "./review-accept-guard-round5-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function baseRefused(c: string): boolean {
  try {
    return baseRefuses(c) !== undefined;
  } catch {
    return true;
  }
}

/** A head verdict that THROWS is a failed row, reported with the row — never a silent pass
 * through a comparison against `undefined`. */
function head(c: string): { clause?: string; threw?: string } {
  try {
    const v = reviewAcceptVerdict(c);
    return v ? { clause: v.clause } : {};
  } catch (e) {
    return { threw: e instanceof Error ? e.message : String(e) };
  }
}

const REFUSAL_TABLES = [
  ["operator expansion", ROUND5_OPERATORS],
  ["quote kind", ROUND5_QUOTES],
  ["pattern-flag value", ROUND5_PATTERN_FLAG_VALUE],
  ["which", ROUND5_WHICH],
  ["assigned argv", ROUND5_ASSIGNED_ARG],
] as const;

let refusalRows = 0;
for (const [label, table] of REFUSAL_TABLES) {
  for (const t of table) {
    refusalRows++;
    const v = head(t.c);
    assert(
      v.clause === t.clause && v.threw === undefined,
      `${label} refused by ${t.clause} — ${t.why}${
        v.threw !== undefined
          ? ` [THREW: ${v.threw}]`
          : v.clause
            ? ` [got ${v.clause}]`
            : " [IT IS ALLOWED]"
      }`,
    );
    // The classification is pinned too: `atBase: true` rows are monotonicity violations the
    // base already caught; `atBase: false` rows are ABSOLUTE under-refusals the base never
    // asked, which the raw-text rule closes on its own.
    assert(
      baseRefused(t.c) === t.atBase,
      `${label} row's base classification holds (${t.atBase ? "refused" : "allowed"} at 52a81946) — ${t.why}`,
    );
    // The exemption must NOT have proven this command.
    assert(
      !commandFullyUnderstood(t.c.toLowerCase()),
      `${label} row is not exemption-proven — ${t.why}`,
    );
  }
}

assert(
  // 8 operator forms + 2 quote kinds + 2 consumed pattern-flag values + 2 `which` rows +
  // 1 assignment-handed-to-a-program row.
  refusalRows === 15,
  `corpus: 15 under-refusal rows across the five round-5 classes (got ${refusalRows})`,
);

// ── the accepted costs: refused, and refused BECAUSE the proof abstained ─────────
for (const t of ROUND5_ACCEPTED_COSTS) {
  const v = head(t.c);
  assert(
    v.clause !== undefined,
    `accepted cost refused — ${t.why}${v.threw ? ` [THREW: ${v.threw}]` : ""}`,
  );
  assert(
    !commandFullyUnderstood(t.c.toLowerCase()),
    `accepted cost is a row the exemption abstains on, not one it mis-reads — ${t.why}`,
  );
}
assert(
  ROUND5_ACCEPTED_COSTS.length === 3,
  `corpus: exactly 3 accepted-cost rows (got ${ROUND5_ACCEPTED_COSTS.length})`,
);

// ── the neighbours that must not have moved ──────────────────────────────────────
for (const t of ROUND5_KEEP_ALLOWED) {
  const v = head(t.c);
  assert(
    v.clause === undefined && v.threw === undefined,
    `neighbour stays allowed — ${t.why}${v.threw ? ` [THREW: ${v.threw}]` : ` [refused by ${v.clause}]`}`,
  );
  assert(
    commandFullyUnderstood(t.c.toLowerCase()) || !baseRefused(t.c),
    `an allowed row is exemption-proven, or the base allowed it too — ${t.why}`,
  );
}
assert(
  ROUND5_KEEP_ALLOWED.length === 6,
  `corpus: exactly 6 must-not-move rows (got ${ROUND5_KEEP_ALLOWED.length})`,
);

// ── the invariant itself, asserted as behaviour ──────────────────────────────────
// The round-4 CRITICAL, and the proof may not read the substituted text even when the
// substitution is the one thing that would have made the row legible.
const CRITICAL = "F=.git/zz\u0072eview-findings.json; cat \u0024{F//zz/}";
assert(
  reviewAcceptVerdict(CRITICAL)?.clause === "unreadable-word",
  "the round-4 CRITICAL stays refused",
);
// The name test still sees through a substitution that ADDS a name — the one direction the
// view is allowed to work in. This command's RAW text names nothing protected; only the
// resolved value carries the store, and clause (1) catching it is what proves the view is
// still wired to the name test and not to the exemption.
const ADDITIVE = 'A=.git/rev; B=iew-findings.json; cat "$A$B"';
const add = head(ADDITIVE);
assert(
  add.clause === "store-name",
  `a substitution may only ever ADD a refusal — the name test still reads the resolved value [got ${add.clause ?? "allowed"}]`,
);

console.log(
  `round 5: ${refusalRows} under-refusals pinned by clause, ${ROUND5_ACCEPTED_COSTS.length} accepted costs, ${ROUND5_KEEP_ALLOWED.length} neighbours held`,
);
process.exit(exit);
