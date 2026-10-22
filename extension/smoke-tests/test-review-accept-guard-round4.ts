#!/usr/bin/env bun
/**
 * #1764 fix round 4 — the MONOTONE invariant, asserted against the frozen base guard.
 *
 * The guard's clause (5) is base's command-wide refusal restored as the DEFAULT, and
 * `review-accept-exempt.ts` is the only thing that may lift it. This suite pins both
 * halves:
 *
 *  - the round-4 corpus (prefix words, assignment ambiguity, shell segments) refuses,
 *    each row by the recorded clause, and its must-stay-allowed neighbours do not move;
 *  - THE PROPERTY: for every row of every corpus table — the halo harvest, the round-3
 *    tables, the #1125 case tables and this round's own — if the FROZEN BASE guard
 *    refuses, the head guard refuses TOO, unless the exemption module positively
 *    understands every segment. Base refusing + head allowing + exemption NOT proven
 *    is the shape of every under-refusal the three review rounds found, and it is the
 *    shape this round makes unrepresentable.
 *
 * The base guard is the byte-frozen copy of the guard at 52a81946 under
 * `accept-guard-base/` — the property runs the REAL base verdicts, not a paraphrase.
 */
import { commandFullyUnderstood } from "../src/review-accept-exempt.ts";
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import { runsReviewAccept as baseRefuses } from "./accept-guard-base/review-accept-guard.ts";
import {
  ALLOWANCES,
  DENY_BY_DEFAULT_REFUSALS,
  MANDATED_REFUSALS,
  ORDINARY_AGENT_COMMANDS,
  OUT_OF_SCOPE_ALLOWED,
  OVER_REFUSALS,
  SIBLING_REFUSALS,
  SPELLING_REFUSALS,
} from "./review-accept-guard-cases.ts";
import {
  HALO_RED_TO_GREEN,
  HALO_STILL_REFUSED_BY_CLAUSE,
} from "./review-accept-guard-halo-cases.ts";
import {
  HALO_ALREADY_ALLOWED_AT_BASE,
  HALO_KEEP_REFUSED,
} from "./review-accept-guard-halo-refusals.ts";
import {
  ROUND3_ASSIGNMENTS,
  ROUND3_OPTION_VALUES,
  ROUND3_REDIRECTIONS,
  ROUND3_STILL_ALLOWED,
} from "./review-accept-guard-round3-cases.ts";
import {
  ROUND4_ASSIGNMENTS,
  ROUND4_PREFIX,
  ROUND4_SHELLS,
  ROUND4_STILL_ALLOWED,
} from "./review-accept-guard-round4-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The frozen base refusing is a fact about the base copy; a base crash counts as a
 * refusal (the base guard failed closed on its own throw, and a property may not be
 * satisfied by a base that answered nothing). */
function baseRefused(c: string): boolean {
  try {
    return baseRefuses(c) !== undefined;
  } catch {
    return true;
  }
}

// ── 1. the round-4 corpus ───────────────────────────────────────────────────────
const TABLES = [
  ["prefix word", ROUND4_PREFIX],
  ["assignment", ROUND4_ASSIGNMENTS],
  ["shell segment", ROUND4_SHELLS],
] as const;

assert(ROUND4_PREFIX.length === 10, `corpus: exactly 10 prefix-word rows (got ${ROUND4_PREFIX.length})`);
assert(
  ROUND4_ASSIGNMENTS.length === 4,
  `corpus: exactly 4 assignment rows (got ${ROUND4_ASSIGNMENTS.length})`,
);
assert(ROUND4_SHELLS.length === 2, `corpus: exactly 2 shell rows (got ${ROUND4_SHELLS.length})`);
assert(
  ROUND4_STILL_ALLOWED.length === 10,
  `corpus: exactly 10 must-stay-allowed rows (got ${ROUND4_STILL_ALLOWED.length})`,
);

for (const [label, table] of TABLES) {
  for (const t of table) {
    const v = reviewAcceptVerdict(t.c);
    assert(
      v?.clause === t.clause && baseRefused(t.c),
      `${label} refused by ${t.clause} — ${t.why}${
        v ? ` [got ${v.clause}]` : " [it is ALLOWED]"
      }${baseRefused(t.c) ? "" : " [BASE ALLOWED IT TOO]"}`,
    );
  }
}

for (const t of ROUND4_STILL_ALLOWED) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v === undefined,
    `must stay allowed — ${t.why}${v ? ` [refused by clause ${v.clause}]` : ""}`,
  );
  // And not by accident: an allowed row must be one the exemption PROVED.
  assert(
    commandFullyUnderstood(t.c.toLowerCase()),
    `exemption proves it — ${t.why}`,
  );
}

// ── 2. THE PROPERTY over every corpus table ─────────────────────────────────────
type Row = { readonly c: string; readonly why: string };
const ALL: ReadonlyArray<readonly Row[]> = [
  ALLOWANCES,
  ORDINARY_AGENT_COMMANDS,
  OUT_OF_SCOPE_ALLOWED,
  MANDATED_REFUSALS,
  DENY_BY_DEFAULT_REFUSALS,
  OVER_REFUSALS,
  SIBLING_REFUSALS,
  SPELLING_REFUSALS,
  HALO_RED_TO_GREEN,
  HALO_ALREADY_ALLOWED_AT_BASE,
  HALO_KEEP_REFUSED,
  HALO_STILL_REFUSED_BY_CLAUSE,
  ROUND3_REDIRECTIONS,
  ROUND3_OPTION_VALUES,
  ROUND3_ASSIGNMENTS,
  ROUND3_STILL_ALLOWED,
  ROUND4_PREFIX,
  ROUND4_ASSIGNMENTS,
  ROUND4_SHELLS,
  ROUND4_STILL_ALLOWED,
];

let rows = 0;
let monotonePass = 0;
let exempted = 0;
for (const table of ALL) {
  for (const r of table) {
    rows++;
    const b = baseRefused(r.c);
    const h = reviewAcceptVerdict(r.c) !== undefined;
    if (!b) {
      monotonePass++; // base allowed: head may allow or refuse more — both are monotone.
      continue;
    }
    if (h) {
      monotonePass++;
      continue;
    }
    // Base refused and head allowed: the ONE admissible reason is a completed
    // exemption proof. An unproven exemption is the round-4 defect class.
    if (commandFullyUnderstood(r.c.toLowerCase())) exempted++;
    else
      assert(
        false,
        `MONOTONICITY VIOLATION — base refused, head allowed, exemption NOT proven: ${r.c.slice(0, 90)}`,
      );
  }
}
assert(rows >= 300, `property: ran every corpus row through base and head (${rows} rows)`);
assert(
  monotonePass + exempted === rows,
  `property: base-refusing rows are head-refused (${monotonePass}) or exemption-proven (${exempted}) — all ${rows}`,
);

console.log(
  `round 4: ${ROUND4_PREFIX.length + ROUND4_ASSIGNMENTS.length + ROUND4_SHELLS.length} under-refusals pinned, ${ROUND4_STILL_ALLOWED.length} neighbours held, ${rows} corpus rows checked against the frozen base (${exempted} exemption-proven)`,
);
process.exit(exit);
